import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { prepareGeneration, record } from "../lib/local-budget"
import { prepareClientFixtures } from "../lib/local-clients"
import { childEnvironment, MODEL } from "../lib/local-runtime"

function syntheticServer(observations: Array<Record<string, unknown>>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 200 })
      const payload = record(await request.json())
      observations.push({
        model: payload.model,
        maxTokens: payload.max_tokens,
        effort: record(payload.output_config).effort,
        thinking: payload.thinking,
      })
      const message = {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }
      const events = [
        { type: "message_start", message },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "LOCAL_TOOL_42" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
}

/** Actual installed Claude CLI against a loopback synthetic responder. No proxy or bridge. */
async function probe(cap?: string) {
  const fixture = prepareClientFixtures()
  const observations: Array<Record<string, unknown>> = []
  const server = syntheticServer(observations)
  const baseUrl = `http://127.0.0.1:${server.port}`
  const settings = path.join(fixture.claudeHome, "acceptance-settings.json")
  const config = record(JSON.parse(readFileSync(settings, "utf8")))
  const settingsEnv = record(config.env)
  settingsEnv.ANTHROPIC_BASE_URL = baseUrl
  delete settingsEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (cap) settingsEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = cap
  writeFileSync(settings, JSON.stringify({ env: settingsEnv }))
  const env = childEnvironment({
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "synthetic-only",
    ANTHROPIC_AUTH_TOKEN: "synthetic-only",
    MAX_THINKING_TOKENS: "1024",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  })
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (cap) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = cap
  const child = Bun.spawn(
    [
      Bun.which("claude") ?? "claude",
      "--bare",
      "-p",
      "Read marker.txt using the Read tool. Reply only with its exact content.",
      "--model",
      MODEL,
      "--effort",
      "low",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      settings,
      "--tools",
      "Read",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
    ],
    {
      cwd: fixture.directory,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === "win32")
      void Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    else child.kill()
  }, 20000)
  try {
    const exitCode = (
      await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    )[2]
    const observed = observations[0]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timer and HTTP callbacks mutate these values while awaiting the client
    if (!observed || observations.length !== 1 || timedOut || exitCode !== 0)
      throw new Error(
        `Synthetic CLI probe failed: count=${observations.length}, timeout=${timedOut}, exit=${exitCode}`,
      )
    const prepared = prepareGeneration("/responses", {
      model: MODEL,
      input: [{ role: "user", content: "synthetic" }],
      max_output_tokens: observed.maxTokens,
      reasoning: { effort: "low" },
    })
    return {
      mode: cap ? "explicit-cap" : "original-default",
      ...observed,
      maxTokens: observed.maxTokens,
      preparedOutputTokens: prepared.outputTokens,
      exitCode,
      loopbackRequests: observations.length,
      fixtureDirectory: fixture.directory,
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await server.stop(true)
  }
}

const original = await probe()
console.log(JSON.stringify(original))
const capped = await probe("2048")
console.log(JSON.stringify(capped))
if (capped.maxTokens !== 2048 || capped.preparedOutputTokens !== 2048)
  throw new Error("Explicit client cap did not reach actual request")
if (typeof original.maxTokens !== "number" || original.maxTokens <= 2048)
  throw new Error("Historical default cap mismatch was not reproduced")
