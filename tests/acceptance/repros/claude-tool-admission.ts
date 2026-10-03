import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record, stringValue } from "../lib/local-budget"
import { claudeIsolationArgs } from "../lib/local-client-config"
import {
  clientVerdict,
  projectClientEvents,
} from "../lib/local-client-evidence"
import { capture, prepareClientFixtures } from "../lib/local-clients"
import { assert, childEnvironment, MODEL } from "../lib/local-runtime"

const fixture = prepareClientFixtures()
const markerPath = path.join(fixture.directory, "marker.txt")
const marker = readFileSync(markerPath, "utf8").trim()
let requests = 0
const observed = { resultSeen: false }
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    const body = record(await request.json())
    requests++
    if (requests > 2)
      return Response.json(
        { error: { message: "Synthetic request cap" } },
        { status: 400 },
      )
    if (requests === 2)
      observed.resultSeen = JSON.stringify(body.messages).includes(marker)
    const tool = requests === 1
    const events = [
      {
        type: "message_start",
        message: {
          id: `synthetic_${requests}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block:
          tool ?
            { type: "tool_use", id: "read_marker", name: "Read", input: {} }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta:
          tool ?
            {
              type: "input_json_delta",
              partial_json: JSON.stringify({ file_path: markerPath }),
            }
          : { type: "text_delta", text: marker },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const settingsFile = path.join(fixture.claudeHome, "acceptance-settings.json")
const settings = record(JSON.parse(readFileSync(settingsFile, "utf8")))
record(settings.env).ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`
writeFileSync(settingsFile, JSON.stringify(settings))
try {
  const events = await capture(
    Bun.which("claude") ?? "claude",
    [
      ...claudeIsolationArgs,
      "-p",
      "Read marker.txt using Read. Return only its content.",
      "--model",
      MODEL,
      "--effort",
      "low",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--permission-mode",
      "dontAsk",
      "--settings",
      path.join(fixture.claudeHome, "acceptance-settings.json"),
    ],
    {
      cwd: fixture.directory,
      timeoutMs: 60000,
      env: childEnvironment({
        CLAUDE_CONFIG_DIR: fixture.claudeHome,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
        ANTHROPIC_AUTH_TOKEN: "synthetic-only",
        ANTHROPIC_API_KEY: "synthetic-only",
        ANTHROPIC_MODEL: MODEL,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_SIMPLE: "0",
      }),
    },
  )
  const verdict = clientVerdict("claude", projectClientEvents(events))
  const final = events.findLast((event) => event.type === "result")
  assert(
    requests === 2
      && observed.resultSeen
      && verdict.validArguments
      && verdict.toolExecution
      && verdict.exactFinal
      && stringValue(final?.result).trim() === marker,
    "Claude offline tool admission failed",
  )
  console.log(
    JSON.stringify({
      status: "pass",
      requests,
      resultSeen: observed.resultSeen,
      verdict,
    }),
  )
} finally {
  await upstream.stop(true)
}
