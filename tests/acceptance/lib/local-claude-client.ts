import { randomUUID, createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { record, type Json } from "./local-budget"
import { claudeIsolationArgs } from "./local-client-config"
import { capture } from "./local-clients"
import { assert, childEnvironment } from "./local-runtime"

export function createClaudeFixture(root: string, model: string) {
  // Keep the deliberately failing fixture outside Bun's repository test discovery.
  const temporaryBase =
    process.platform === "win32" && process.env.LOCALAPPDATA ?
      path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir()
  const temporary = mkdtempSync(path.join(temporaryBase, "claude-proxy-"))
  const directory = path.join(temporary, "project")
  const home = path.join(temporary, "home")
  const evidenceDirectory = path.join(root, "fixtures", model)
  mkdirSync(directory, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(evidenceDirectory, { recursive: true })
  const marker = `TOOL_${randomUUID()}`
  const sessionId = randomUUID()
  writeFileSync(path.join(directory, "marker.txt"), marker)
  writeFileSync(
    path.join(directory, "sum.ts"),
    "export function sumPositive(values: number[]): number {\n  return values.filter(value => value > 0).length\n}\n",
  )
  const tests = `import { test, expect } from "bun:test"\nimport { sumPositive } from "./sum"\ntest("positive values are summed, others ignored", () => {\n  for (const [values, result] of [[[2,3,-1,0],5], [[],0], [[-2,-3],0], [[0.5,1.25],1.75], [[100],100], [[1,1,1],3]] as const) expect(sumPositive([...values])).toBe(result)\n})\n`
  writeFileSync(path.join(directory, "sum.test.ts"), tests)
  writeFileSync(path.join(evidenceDirectory, "sum.test.ts.txt"), tests)
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "claude-proxy-fixture",
      private: true,
      type: "module",
    }),
  )
  return {
    directory,
    home,
    evidenceDirectory,
    marker,
    sessionId,
    testDigest: digest(tests),
    originalSource: readFileSync(path.join(directory, "sum.ts"), "utf8"),
    packageDigest: digest(
      readFileSync(path.join(directory, "package.json"), "utf8"),
    ),
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function invokeClaude(input: {
  fixture: ReturnType<typeof createClaudeFixture>
  model: string
  baseUrl: string
  prompt: string
  rawFile: string
  session?: "start" | "resume"
  guardReason?: () => string | undefined
  tools?: boolean
  appendSystem?: string
  mcpConfig?: string
}) {
  const { fixture, model, baseUrl } = input
  const env = {
    CLAUDE_CONFIG_DIR: fixture.home,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "acceptance-dummy",
    ANTHROPIC_API_KEY: "acceptance-dummy",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_SIMPLE: "0",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  }
  const settings = path.join(fixture.home, "acceptance-settings.json")
  writeFileSync(settings, JSON.stringify({ env }))
  const isolationArgs = claudeIsolationArgs.filter(
    (arg) => arg !== "--no-session-persistence",
  )
  if (input.mcpConfig)
    isolationArgs[isolationArgs.indexOf("--mcp-config") + 1] = input.mcpConfig
  const args = [
    ...isolationArgs,
    "-p",
    input.prompt,
    "--model",
    model,
    "--effort",
    "high",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    settings,
    "--permission-mode",
    "dontAsk",
    "--tools",
    input.tools ? "Read,Edit,Bash" : "",
    ...(input.tools ?
      ["--allowedTools", "Read", "Edit", "Bash(bun test*)"]
    : []),
    ...(input.mcpConfig ? ["--allowedTools", "mcp__acceptance__*"] : []),
    ...(input.session === "start" ? ["--session-id", fixture.sessionId] : []),
    ...(input.session === "resume" ? ["--resume", fixture.sessionId] : []),
    ...(!input.session ? ["--no-session-persistence"] : []),
    ...(input.appendSystem ?
      ["--append-system-prompt", input.appendSystem]
    : []),
  ]
  const events = await capture(Bun.which("claude") ?? "claude", args, {
    cwd: fixture.directory,
    env: childEnvironment(env),
    rawFile: input.rawFile,
    timeoutMs: 600000,
    guardReason: input.guardReason,
  })
  const final = events.findLast((event) => event.type === "result")
  assert(
    final && final.is_error === false && final.subtype === "success",
    "Claude did not complete successfully",
  )
  return { events, final: String(final.result), sessionId: final.session_id }
}

export function verifyCodingEvidence(events: Array<Json>) {
  const calls = new Map<string, string>()
  const completed = new Set<string>()
  for (const event of events) {
    const content = record(event.message).content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      const block = record(item)
      if (block.type === "tool_use") {
        const name = String(block.name)
        if (name === "Bash")
          assert(
            String(record(block.input).command).trim() === "bun test",
            "Unexpected shell command",
          )
        calls.set(String(block.id), name)
      }
      if (block.type === "tool_result" && !block.is_error) {
        const name = calls.get(String(block.tool_use_id))
        if (name) completed.add(name)
      }
    }
  }
  for (const name of ["Read", "Edit", "Bash"])
    assert(completed.has(name), `Missing successful ${name} tool evidence`)
  return [...completed]
}

export async function verifyFixture(
  fixture: ReturnType<typeof createClaudeFixture>,
) {
  assert(
    readdirSync(fixture.directory).sort().join(",")
      === ["marker.txt", "package.json", "sum.test.ts", "sum.ts"].join(","),
    "Unexpected fixture/configuration file",
  )
  assert(
    digest(readFileSync(path.join(fixture.directory, "package.json"), "utf8"))
      === fixture.packageDigest,
    "Fixture package configuration changed",
  )
  assert(
    readFileSync(path.join(fixture.directory, "marker.txt"), "utf8")
      === fixture.marker,
    "Fixture marker changed",
  )
  const changedSource = readFileSync(
    path.join(fixture.directory, "sum.ts"),
    "utf8",
  )
  assert(
    changedSource !== fixture.originalSource,
    "Fixture source was not modified",
  )
  writeFileSync(
    path.join(fixture.evidenceDirectory, "source-change.json"),
    JSON.stringify(
      { before: fixture.originalSource, after: changedSource },
      null,
      2,
    ),
  )
  assert(
    digest(readFileSync(path.join(fixture.directory, "sum.test.ts"), "utf8"))
      === fixture.testDigest,
    "Fixture tests were modified",
  )
  const child = Bun.spawn([process.execPath, "test", "sum.test.ts"], {
    cwd: fixture.directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  writeFileSync(path.join(fixture.home, "fixture-tests.log"), stdout + stderr)
  assert(code === 0, "Independent fixture tests failed")
}
