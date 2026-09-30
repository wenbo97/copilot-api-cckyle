import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record } from "../lib/local-budget"
import {
  codexSandboxArgs,
  createClientDirectory,
} from "../lib/local-client-config"
import { textEvidence } from "../lib/local-client-evidence"
import { childEnvironment } from "../lib/local-runtime"

const directory = createClientDirectory("copilot-codex-admission-")
const codexHome = path.join(directory, "codex")
mkdirSync(codexHome)
writeFileSync(path.join(directory, "marker.txt"), "LOCAL_TOOL_42\n")
const command =
  process.argv.slice(2).find((argument) => argument !== "--legacy-no-sandbox")
  ?? String.raw`Get-Content -Raw .\marker.txt`
const input = `// @exec: {"yield_time_ms": 60000}\nconst r = await tools.exec_command(${JSON.stringify({ cmd: command, login: false })}); text(JSON.stringify(r));`
let requests = 0
const toolOutputs: Array<unknown> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] })
    const body = record(await request.json())
    requests++
    if (requests > 2)
      return Response.json(
        { error: { message: "Synthetic request limit" } },
        { status: 400 },
      )
    if (Array.isArray(body.input))
      for (const raw of body.input) {
        const item = record(raw)
        if (
          ["custom_tool_call_output", "function_call_output"].includes(
            String(item.type),
          )
        )
          toolOutputs.push(item.output)
      }
    const item =
      requests === 1 ?
        {
          type: "custom_tool_call",
          id: "ctc_synthetic",
          call_id: "call_synthetic",
          name: "exec",
          input,
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_synthetic",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "PROBE_COMPLETE", annotations: [] },
          ],
        }
    const response = {
      id: `resp_synthetic_${requests}`,
      object: "response",
      created_at: 0,
      model: "gpt-5.6-luna",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
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
const sandbox =
  process.argv.includes("--legacy-no-sandbox") ? [] : codexSandboxArgs
const child = Bun.spawn(
  [
    Bun.which("codex") ?? "codex",
    "-a",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    ...sandbox,
    "--disable",
    "hooks",
    "-m",
    "gpt-5.6-luna",
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'model_provider="synthetic"',
    "-c",
    'model_providers.synthetic.name="Synthetic loopback"',
    "-c",
    `model_providers.synthetic.base_url="http://127.0.0.1:${server.port}/v1"`,
    "-c",
    'model_providers.synthetic.wire_api="responses"',
    "-c",
    'model_providers.synthetic.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.synthetic.request_max_retries=0",
    "-c",
    "model_providers.synthetic.stream_max_retries=0",
    "Read marker.txt and return its exact content.",
  ],
  {
    cwd: directory,
    env: childEnvironment({
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "synthetic-only",
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
)
const deadline = { expired: false }
async function stopChild() {
  if (child.exitCode !== null) return
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  } else child.kill()
}
const timer = setTimeout(() => {
  deadline.expired = true
  void stopChild()
}, 60000)
try {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const serialized = JSON.stringify(toolOutputs)
  console.log(
    JSON.stringify(
      {
        directory,
        command,
        requests,
        exitCode,
        timedOut: deadline.expired,
        toolOutputs,
        blocked: serialized.includes("blocked by policy"),
        markerRead: serialized.includes("LOCAL_TOOL_42"),
        stderr: stderr.slice(-1200),
        events: stdout
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => {
            try {
              return record(JSON.parse(line)).type
            } catch {
              return "non-json"
            }
          }),
      },
      null,
      2,
    ),
  )
  const evidence = textEvidence(toolOutputs)
  if (
    exitCode !== 0
    || deadline.expired
    || requests !== 2
    || !evidence.markerPresent
    || !evidence.exitCodeZero
    || evidence.blocked
  )
    process.exitCode = 1
} finally {
  clearTimeout(timer)
  await stopChild()
  await child.exited
  await server.stop(true)
}
