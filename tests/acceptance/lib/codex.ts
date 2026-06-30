/**
 * `codex exec` headless driver for the acceptance suite.
 *
 * Spawns the real Codex CLI non-interactively, pointed at the proxy under test via
 * `-c model_providers.*` overrides (NO mutation of ~/.codex/config.toml). Used by
 * the matrix runner for spec §7.5 (Codex exec + review on the GPT models and Claude
 * via translate-down) and the §7.2 codex single-shot cells.
 *
 * EMPIRICALLY VERIFIED provider wiring (codex-cli 0.141.0), against a local mock of
 * the proxy's /v1/responses egress:
 *   -c model_providers.copilot.name=copilot      ← REQUIRED; codex rejects an
 *                                                   empty provider name otherwise
 *                                                   ("provider name must not be empty")
 *   -c model_providers.copilot.base_url=<proxy>/v1
 *   -c model_providers.copilot.wire_api=responses
 *   -c model_provider=copilot
 * No env_key / API key is needed — the proxy accepts dummy auth, and codex sends a
 * request with no Authorization header without complaint. A throwaway CODEX_HOME is
 * used so the run never reads or writes the user's real Codex state.
 *
 * Mode differences (also verified):
 *   - exec:   positional <prompt> + `--sandbox workspace-write`. Supports --json, -o.
 *   - review: `codex exec review` with `--uncommitted` (or --base/--commit) and NO
 *             positional prompt when a scope flag is used; does NOT take --sandbox.
 *             Supports --json, -o.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { ACCEPTANCE_PORT } from "./proxy"

const DEFAULT_CODEX_BIN = String.raw`C:\Users\IIIII\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`
const DEFAULT_TIMEOUT_MS = 120_000
const PROVIDER_KEY = "copilot"

export type CodexMode = "exec" | "review"

export interface RunCodexOptions {
  /** Task/prompt. For review mode this is optional (omit when using a scope flag). */
  prompt?: string
  /** Model id sent to the proxy (e.g. gpt-5.3-codex, gpt-5.5, gpt-5.4, claude-opus-4.8). */
  model: string
  /** "exec" (agent) or "review" (code review). Default "exec". */
  mode?: CodexMode
  /** File the agent's last message is written to (`-o`). Default: a temp file. */
  lastMsgFile?: string
  /** Base URL of the proxy (default http://localhost:4143). `/v1` is appended for codex. */
  baseUrl?: string
  /** Working directory for the codex process (default cwd). */
  cwd?: string
  /** Review scope when mode==="review" (default { uncommitted: true }). */
  reviewScope?: { uncommitted?: boolean; base?: string; commit?: string }
  /** Sandbox policy for exec mode (default "workspace-write"). */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Override the codex binary path. */
  codexBin?: string
  /** Extra env vars merged over the base env. */
  env?: Record<string, string>
  /** Kill the run after this many ms (default 120s). */
  timeoutMs?: number
  /** Extra raw CLI args appended verbatim. */
  extraArgs?: Array<string>
}

export interface RunCodexResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Contents of the `-o` last-message file (empty string if none written). */
  lastMessage: string
  /** Parsed JSONL events from stdout (--json). */
  events: Array<Record<string, unknown>>
  /** The argv used (for diagnostics / RESULTS evidence). */
  argv: Array<string>
}

/** Resolve the codex executable: explicit override → PATH → the known install path. */
export function resolveCodexBin(override?: string): string {
  if (override) return override
  const onPath = Bun.which("codex")
  if (onPath) return onPath
  return DEFAULT_CODEX_BIN
}

/**
 * The `-c` provider-config overrides that point codex at the proxy.
 * Exported so the matrix runner and unit tests share one source of truth.
 */
export function providerConfigArgs(baseUrl: string): Array<string> {
  const apiBase = `${baseUrl.replace(/\/$/, "")}/v1`
  return [
    "-c",
    `model_providers.${PROVIDER_KEY}.name=${PROVIDER_KEY}`,
    "-c",
    `model_providers.${PROVIDER_KEY}.base_url=${apiBase}`,
    "-c",
    `model_providers.${PROVIDER_KEY}.wire_api=responses`,
    "-c",
    `model_provider=${PROVIDER_KEY}`,
  ]
}

/** Build the codex argv (exported for unit testing). */
export function buildCodexArgs(
  options: RunCodexOptions,
  lastMsgFile: string,
  baseUrl: string,
): Array<string> {
  const mode = options.mode ?? "exec"
  const args: Array<string> = ["exec"]

  if (mode === "review") {
    args.push("review")
    const scope = options.reviewScope ?? { uncommitted: true }
    // A positional prompt cannot be combined with a scope flag (codex rejects it),
    // so when a scope is present we rely on it alone.
    if (scope.base) args.push("--base", scope.base)
    else if (scope.commit) args.push("--commit", scope.commit)
    else args.push("--uncommitted")
  }

  args.push(
    "-m",
    options.model,
    "--json",
    "-o",
    lastMsgFile,
    "--skip-git-repo-check",
  )

  if (mode === "exec") {
    args.push("--sandbox", options.sandbox ?? "workspace-write")
  }

  args.push(...providerConfigArgs(baseUrl))
  if (options.extraArgs) args.push(...options.extraArgs)

  // Positional prompt last. Review mode with a scope flag takes none.
  if (mode === "exec" && options.prompt) args.push(options.prompt)

  return args
}

/** Parse codex `--json` JSONL stdout into an array of events (skips bad lines). */
function parseEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // non-JSON diagnostic line — ignore
    }
  }
  return events
}

/**
 * Run codex (exec or review) against the proxy and return the captured result.
 * Never throws on non-zero exit — the matrix runner judges exitCode + lastMessage.
 */
export async function runCodex(
  options: RunCodexOptions,
): Promise<RunCodexResult> {
  const bin = resolveCodexBin(options.codexBin)
  const baseUrl = options.baseUrl ?? `http://localhost:${ACCEPTANCE_PORT}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lastMsgFile =
    options.lastMsgFile
    ?? path.join(
      mkdtempSync(path.join(tmpdir(), "codex-lastmsg-")),
      "last-message.txt",
    )
  // Throwaway CODEX_HOME so the run never touches the user's real Codex state.
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-home-"))
  const args = buildCodexArgs(options, lastMsgFile, baseUrl)

  const proc = Bun.spawn([bin, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      ...options.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  // Race the process against a timeout sentinel (see claude.ts for the rationale).
  const TIMEOUT = Symbol("timeout")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  try {
    const outcome = await Promise.race([proc.exited, timeout])
    const timedOut = outcome === TIMEOUT
    if (timedOut) proc.kill()
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const lastMessage = await Bun.file(lastMsgFile)
      .text()
      .catch(() => "")
    return {
      exitCode: timedOut ? null : await proc.exited,
      timedOut,
      stdout,
      stderr,
      lastMessage: lastMessage.trim(),
      events: parseEvents(stdout),
      argv: [bin, ...args],
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * `codex doctor` smoke — verifies the local Codex install is healthy before the
 * matrix runs. Returns the raw report; the runner logs it as preamble evidence.
 * (Reachability warnings about the live upstream are expected and not fatal here.)
 */
export async function codexDoctor(
  codexBin?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const bin = resolveCodexBin(codexBin)
  const proc = Bun.spawn([bin, "doctor"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}
