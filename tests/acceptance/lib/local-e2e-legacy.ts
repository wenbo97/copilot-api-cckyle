import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { record } from "./local-budget"
import { codexSandboxArgs } from "./local-client-config"
import { codex, prepareClientFixtures, type Session } from "./local-clients"
import {
  AcceptanceBlockedError,
  AcceptanceRuntime,
  assert,
  childEnvironment,
  ROOT,
} from "./local-runtime"

const incident = path.join(ROOT, "tests/_runlog/resume-400-20260930")
export const legacyManifest = path.join(incident, "foreign-reasoning.json")
const prefixItems = 559
const expectedCiphertexts = 137
const expectedToolPairs = 149

interface LegacyPreparation {
  fixture: Session
  sourceId: string
  capturedItems: number
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
function sourceSessionId(): string {
  const source = readFileSync(path.join(incident, "capture.ts"), "utf8")
  const id = /'fork',\s*'([a-f0-9-]{36})'/u.exec(source)?.[1]
  if (!id)
    throw new AcceptanceBlockedError(
      "Original diagnostic source session is unavailable",
    )
  return id
}
function findRollout(sessionsRoot: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(id))
    throw new AcceptanceBlockedError("Invalid source session ID")
  const entries = readdirSync(sessionsRoot, {
    recursive: true,
    encoding: "utf8",
  }).filter((relative) => relative.endsWith(`-${id}.jsonl`))
  if (entries.length !== 1)
    throw new AcceptanceBlockedError(
      "Source session has no unique local rollout",
    )
  const candidate = path.resolve(sessionsRoot, entries[0])
  if (!candidate.startsWith(`${path.resolve(sessionsRoot)}${path.sep}`))
    throw new AcceptanceBlockedError("Source session path escaped its home")
  return candidate
}
function copyLineage(fixture: Session, sourceId: string): void {
  const sourceRoot = path.resolve(
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    "sessions",
  )
  if (!existsSync(sourceRoot))
    throw new AcceptanceBlockedError("Source Codex sessions unavailable")
  const copied = new Set<string>()
  let id: string | undefined = sourceId
  for (let depth = 0; id && depth < 8; depth++) {
    if (copied.has(id))
      throw new AcceptanceBlockedError("Cyclic source-session lineage")
    copied.add(id)
    const filename = findRollout(sourceRoot, id)
    const first = readFileSync(filename, "utf8").split(/\r?\n/u, 1)[0]
    const metadata = record(record(JSON.parse(first)).payload)
    if (metadata.session_id !== id && metadata.id !== id)
      throw new AcceptanceBlockedError("Source-session metadata mismatch")
    const relative = path.relative(sourceRoot, filename)
    const copy = path.join(fixture.codexHome, "sessions", relative)
    mkdirSync(path.dirname(copy), { recursive: true })
    copyFileSync(filename, copy)
    const parent = metadata.forked_from_id
    id = typeof parent === "string" && parent ? parent : undefined
    if (id === undefined && metadata.model_provider !== "openai" && depth > 0)
      throw new AcceptanceBlockedError(
        "Source ancestor is not confirmed as OpenAI",
      )
  }
  if (id)
    throw new AcceptanceBlockedError(
      "Source-session lineage exceeded eight levels",
    )
}
function originalHistory(): {
  input: Array<unknown>
  ciphertextSha256: Set<string>
} {
  const captured = record(
    JSON.parse(readFileSync(path.join(incident, "capture.json"), "utf8")),
  )
  const manifest = record(JSON.parse(readFileSync(legacyManifest, "utf8")))
  if (
    !Array.isArray(captured.input)
    || captured.input.length !== 563
    || manifest.sourceProvider !== "openai"
    || !Array.isArray(manifest.ciphertextSha256)
    || manifest.ciphertextSha256.length !== expectedCiphertexts
  )
    throw new AcceptanceBlockedError(
      "Captured historical fixture or manifest changed",
    )
  return {
    input: captured.input,
    ciphertextSha256: new Set<string>(
      (manifest.ciphertextSha256 as Array<unknown>).map(String),
    ),
  }
}
function inspectHistory(
  input: Array<unknown>,
  expected: ReturnType<typeof originalHistory>,
) {
  if (input.length < prefixItems)
    throw new AcceptanceBlockedError(
      `Isolated Codex history has ${input.length} items; expected at least ${prefixItems}`,
    )
  const mismatches = expected.input
    .slice(0, prefixItems)
    .flatMap((item, index) =>
      JSON.stringify(item) === JSON.stringify(input[index]) ? [] : [index],
    )
  if (
    mismatches.some((index) => index > 1)
    || [0, 1].some(
      (index) =>
        record(expected.input[index]).type !== record(input[index]).type,
    )
  )
    throw new AcceptanceBlockedError(
      `Isolated Codex history differs at ${mismatches.length} of ${prefixItems} prefix items; first indexes ${mismatches.slice(0, 8).join(",")}`,
    )
  const reasoning = input
    .map((value) => record(value))
    .filter(
      (value) =>
        value.type === "reasoning"
        && typeof value.encrypted_content === "string",
    )
  const matched = reasoning.filter((value) =>
    expected.ciphertextSha256.has(sha256(String(value.encrypted_content))),
  )
  if (matched.length !== expectedCiphertexts)
    throw new AcceptanceBlockedError(
      "Foreign reasoning ciphertext coverage changed",
    )
  const prefix = input.slice(0, prefixItems).map((value) => record(value))
  const calls = prefix.filter(
    (value) =>
      value.type === "function_call" || value.type === "custom_tool_call",
  )
  const outputs = prefix.filter(
    (value) =>
      value.type === "function_call_output"
      || value.type === "custom_tool_call_output",
  )
  const callIds = new Set(calls.map((value) => value.call_id))
  if (
    calls.length !== expectedToolPairs
    || outputs.length !== expectedToolPairs
    || callIds.size !== expectedToolPairs
    || !outputs.every((value) => callIds.has(value.call_id))
  )
    throw new AcceptanceBlockedError(
      `Historical tool pairs changed: calls=${calls.length}, outputs=${outputs.length}, unique=${callIds.size}, unmatched=${outputs.filter((value) => !callIds.has(value.call_id)).length}`,
    )
  return {
    matched: matched.length,
    calls: calls.length,
    preserved: prefixItems - mismatches.length,
    regenerated: mismatches.length,
  }
}

async function captureOffline(fixture: Session, sourceId: string) {
  let payload: Record<string, unknown> | undefined
  let count = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models")
        return Response.json({ object: "list", data: [] })
      if (url.pathname !== "/v1/responses" || request.method !== "POST")
        return new Response("Not found", { status: 404 })
      count++
      payload = record(await request.json())
      return Response.json(
        { error: { message: "Offline historical capture" } },
        { status: 400 },
      )
    },
  })
  const args = [
    "-a",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    ...codexSandboxArgs,
    "--disable",
    "hooks",
    "--disable",
    "memories",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "-m",
    "gpt-6-astra",
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'model_provider="acceptance"',
    "-c",
    'model_providers.acceptance.name="Offline historical capture"',
    "-c",
    `model_providers.acceptance.base_url="http://127.0.0.1:${server.port}/v1"`,
    "-c",
    'model_providers.acceptance.wire_api="responses"',
    "-c",
    'model_providers.acceptance.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.acceptance.request_max_retries=0",
    "-c",
    "model_providers.acceptance.stream_max_retries=0",
    "fork",
    sourceId,
    "Offline history inspection only. Do not use tools. Reply OK.",
  ]
  const child = Bun.spawn([Bun.which("codex") ?? "codex", ...args], {
    cwd: fixture.directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment({
      CODEX_HOME: fixture.codexHome,
      OPENAI_API_KEY: "offline-diagnostic",
      CODEX_API_KEY: "offline-diagnostic",
    }),
  })
  const deadline = setTimeout(() => child.kill(), 45000)
  try {
    await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    await server.stop(true)
  }
  if (count !== 1 || !payload || !Array.isArray(payload.input))
    throw new AcceptanceBlockedError(
      "Isolated Codex history capture did not reach local upstream once",
    )
  return payload.input as Array<unknown>
}

export async function prepareLegacyHistory(
  directory: string,
): Promise<LegacyPreparation> {
  const sourceId = sourceSessionId()
  const fixture = prepareClientFixtures("gpt-6-astra")
  copyLineage(fixture, sourceId)
  const original = originalHistory()
  const input = await captureOffline(fixture, sourceId)
  const proof = inspectHistory(input, original)
  writeFileSync(
    path.join(directory, "legacy-preflight.json"),
    JSON.stringify(
      {
        sourceSessionSha256: sha256(sourceId),
        capturedItems: input.length,
        preservedPrefixItems: proof.preserved,
        regeneratedClientMetadataItems: proof.regenerated,
        foreignCiphertexts: proof.matched,
        matchedToolPairs: proof.calls,
      },
      null,
      2,
    ),
    "utf8",
  )
  return { fixture, sourceId, capturedItems: input.length }
}

function assertNoToolUse(items: Array<Record<string, unknown>>) {
  assert(
    items.every((item) =>
      ["agent_message", "reasoning"].includes(String(item.type)),
    ),
    "Historical continuation attempted a tool",
  )
}

export async function runLegacyHistory(
  runtime: AcceptanceRuntime,
  preparation: LegacyPreparation,
) {
  const forkId = "e2e-legacy-astra-fork"
  const resumeId = "e2e-legacy-astra-resume"
  if (
    runtime.results.some(
      (result) => result.id === forkId || result.id === resumeId,
    )
  )
    return
  let forkThread: string | undefined
  await runtime.runCase(forkId, "recheck", async () => {
    const result = await codex(runtime, forkId, {
      model: "gpt-6-astra",
      phase: "recheck",
      fixture: preparation.fixture,
      timeoutMs: 180000,
      mode: "fork",
      noTools: true,
      thread: preparation.sourceId,
      prompt:
        "Do not use tools or continue old tasks. Remember this marker: HISTORICAL_42. Reply only with READY.",
    })
    assertNoToolUse(result.items)
    assert(
      result.text === "READY" && typeof result.thread === "string",
      "Full historical fork failed",
    )
    forkThread = result.thread
    return `Complete historical fork retained all ${preparation.capturedItems} source input items`
  })
  if (!forkThread || runtime.halted) {
    runtime.results.push({
      id: resumeId,
      phase: "recheck",
      status: "skipped",
      detail: "Full historical fork did not complete",
      durationMs: 0,
      attempts: 0,
    })
    runtime.save()
    return
  }
  const oldPid = runtime.child?.pid
  await runtime.stopProxy()
  await runtime.startProxy()
  assert(
    oldPid !== runtime.child?.pid,
    "Owned proxy restart did not create a new process",
  )
  await runtime.runCase(resumeId, "recheck", async () => {
    const result = await codex(runtime, resumeId, {
      model: "gpt-6-astra",
      phase: "recheck",
      fixture: preparation.fixture,
      timeoutMs: 180000,
      mode: "resume",
      noTools: true,
      thread: forkThread,
      prompt:
        "Do not use tools or continue old tasks. What marker did I ask you to remember? Reply only with that marker.",
    })
    assertNoToolUse(result.items)
    assert(
      result.text === "HISTORICAL_42",
      "Full historical resume lost marker",
    )
    return "Independent CLI resume after owned-proxy restart retained historical marker"
  })
}
