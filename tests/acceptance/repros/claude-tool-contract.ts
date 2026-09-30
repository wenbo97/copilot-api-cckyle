import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record, stringValue, type Json } from "../lib/local-budget"
import { claudeIsolationArgs } from "../lib/local-client-config"
import { projectClientEvents, textEvidence } from "../lib/local-client-evidence"
import { prepareClientFixtures } from "../lib/local-clients"
import { childEnvironment, MODEL } from "../lib/local-runtime"

type Mode = "bare" | "isolated-standard"

function scriptedResponse(turn: number, markerPath: string, final: string) {
  const tool = turn < 2
  const block =
    tool ?
      { type: "tool_use", id: `read_${turn}`, name: "Read", input: {} }
    : { type: "text", text: "" }
  const delta =
    tool ?
      {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          file_path: markerPath,
          offset: 0,
          limit: 100,
          pages: turn === 0 ? "" : "1",
        }),
      }
    : { type: "text_delta", text: final }
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${turn}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
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
}

function relevant(text: string) {
  return text
    .split(/\n/u)
    .filter((line) => /line.number|cat -n|PDF|pages|prefix/iu.test(line))
    .map((line) => line.slice(0, 600))
    .slice(0, 12)
}

function instructionEvidence(payload: Json): Json {
  let system = ""
  if (typeof payload.system === "string") system = payload.system
  else if (Array.isArray(payload.system))
    system = payload.system
      .map((item) => stringValue(record(item).text))
      .join("\n")
  const tools =
    Array.isArray(payload.tools) ?
      payload.tools.map((item) => record(item))
    : []
  const read = tools.find((item) => item.name === "Read")
  const description = stringValue(read?.description)
  return {
    systemCharacters: system.length,
    systemSha256: createHash("sha256").update(system).digest("hex"),
    systemRelevant: relevant(system),
    readDescriptionCharacters: description.length,
    readDescription: description.slice(0, 10000),
    readSchema: read?.input_schema,
  }
}

function returnedTools(payload: Json): Array<Json> {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const last = record(messages.at(-1))
  if (!Array.isArray(last.content)) return []
  return last.content
    .map((item) => record(item))
    .filter((item) => item.type === "tool_result")
    .map((item) => {
      const text =
        typeof item.content === "string" ?
          item.content
        : JSON.stringify(item.content)
      return {
        callId: item.tool_use_id,
        isError: item.is_error === true,
        result: textEvidence(item.content),
        markerLines: text
          .split(/\n/u)
          .filter((line) => line.includes("LOCAL_TOOL_42"))
          .map((line) => line.slice(0, 200)),
      }
    })
}

function startResponder(fixtureDirectory: string, final: string) {
  const requests: Array<Json> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 200 })
      if (!new URL(request.url).pathname.endsWith("/messages"))
        return Response.json({ input_tokens: 1 })
      const payload = record(await request.json())
      const turn = requests.length
      requests.push({
        turn,
        model: payload.model,
        maxTokens: payload.max_tokens,
        effort: record(payload.output_config).effort,
        ...(turn === 0 ? instructionEvidence(payload) : {}),
        toolResults: returnedTools(payload),
      })
      if (turn >= 3)
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Synthetic probe request cap",
            },
          },
          { status: 400 },
        )
      return scriptedResponse(
        turn,
        path.join(fixtureDirectory, "marker.txt"),
        final,
      )
    },
  })
  return { server, requests }
}

function configure(
  fixture: ReturnType<typeof prepareClientFixtures>,
  baseUrl: string,
) {
  const settings = path.join(fixture.claudeHome, "acceptance-settings.json")
  const settingsEnv = record(
    record(JSON.parse(readFileSync(settings, "utf8"))).env,
  )
  settingsEnv.ANTHROPIC_BASE_URL = baseUrl
  writeFileSync(settings, JSON.stringify({ env: settingsEnv }))
  const env = childEnvironment({
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "synthetic-only",
    ANTHROPIC_AUTH_TOKEN: "synthetic-only",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
    MAX_THINKING_TOKENS: "1024",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  })
  env.CLAUDE_CODE_SIMPLE = "0"
  return { settings, env }
}

async function probe(mode: Mode, final: string) {
  const fixture = prepareClientFixtures()
  const { server, requests } = startResponder(fixture.directory, final)
  const { settings, env } = configure(
    fixture,
    `http://127.0.0.1:${server.port}`,
  )
  const isolation = mode === "bare" ? ["--bare"] : claudeIsolationArgs
  const child = Bun.spawn(
    [
      Bun.which("claude") ?? "claude",
      ...isolation,
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
  const deadline = { expired: false }
  const timeout = setTimeout(() => {
    deadline.expired = true
    if (process.platform === "win32")
      void Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    else child.kill()
  }, 25000)
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const events = stdout.split(/\r?\n/u).flatMap((line) => {
      try {
        return [record(JSON.parse(line))]
      } catch {
        return []
      }
    })
    const projected = projectClientEvents(events)
    const result = events.find((event) => event.type === "result")
    if (
      exitCode !== 0
      || deadline.expired
      || requests.length !== 3
      || result?.result !== final
    )
      throw new Error(
        `Synthetic tool probe failed: mode=${mode}, exit=${exitCode}, timeout=${deadline.expired}, requests=${requests.length}, finalPreserved=${result?.result === final}`,
      )
    if (
      mode === "isolated-standard"
      && !String(requests[0].readDescription).includes("line numbers")
    )
      throw new Error("Read tool display semantics missing")
    return {
      mode,
      scriptedFinal: textEvidence(final),
      finalPreserved: result.result === final,
      exitCode,
      fixtureDirectory: fixture.directory,
      requests,
      clientEvents: projected,
    }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await server.stop(true)
  }
}

const output = []
for (const mode of ["bare", "isolated-standard"] as const) {
  for (const final of ["LOCAL_TOOL_42", "0\tLOCAL_TOOL_42\n1\t"])
    output.push(await probe(mode, final))
}
const filename = process.argv[2]
if (filename) {
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(output, null, 2))
}
console.log(JSON.stringify(output, null, 2))
