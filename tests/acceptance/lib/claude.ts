/**
 * `claude -p` headless driver for the acceptance suite.
 *
 * Spawns the real Claude Code CLI in print/headless mode pointed at the proxy
 * under test (ANTHROPIC_BASE_URL=:4143, dummy auth). Used by the matrix runner to
 * exercise the Messages-handler egress (passthrough / responses-bridge / chat) for
 * every target model, plus the subagent (`--agents`) and MCP (`--mcp-config`) rows
 * of spec §7.3–§7.4.
 *
 * The CLI is invoked with `--allow-dangerously-skip-permissions` so it never blocks
 * on an interactive permission prompt in CI.
 */
import { ACCEPTANCE_PORT } from "./proxy"

const DEFAULT_TIMEOUT_MS = 120_000

export type ClaudeOutputFormat = "text" | "json" | "stream-json"

export interface RunClaudeOptions {
  /** The user prompt (single-shot). */
  prompt: string
  /** Model id sent to the proxy (e.g. claude-opus-4.8, gpt-5.5). */
  model: string
  /** Extra env vars merged over the base proxy-pointing env. */
  env?: Record<string, string>
  /** JSON string for `--agents` (custom subagent definitions). */
  agentsJson?: string
  /** One or more `--mcp-config` arguments (file path or inline JSON). */
  mcpConfig?: string | Array<string>
  /** Output format (default "text"). stream-json yields NDJSON events. */
  outputFormat?: ClaudeOutputFormat
  /** Base URL of the proxy (default http://localhost:4143). */
  baseUrl?: string
  /** Kill the run after this many ms (default 120s). */
  timeoutMs?: number
  /** Extra raw CLI args appended verbatim (escape hatch for one-off rows). */
  extraArgs?: Array<string>
}

export interface RunClaudeResult {
  /** Process exit code (null if killed by the timeout). */
  exitCode: number | null
  /** Whether the run was terminated by the timeout guard. */
  timedOut: boolean
  /** Raw stdout. */
  stdout: string
  /** Raw stderr. */
  stderr: string
  /** Best-effort final assistant text, normalized across output formats. */
  lastText: string
  /** The argv used (for diagnostics / RESULTS evidence). */
  argv: Array<string>
}

/** Resolve the claude executable; throw a clear error if it isn't on PATH. */
function resolveClaudeBin(): string {
  const bin = Bun.which("claude")
  if (!bin) {
    throw new Error(
      "claude CLI not found on PATH (expected `claude` / claude.exe). "
        + "Install Claude Code or add it to PATH before running the acceptance suite.",
    )
  }
  return bin
}

/**
 * Extract the final assistant text from whatever output format was requested.
 * - text:        the stdout is already the assistant text.
 * - json:        a single object with a `.result` string.
 * - stream-json: NDJSON; the terminal `{type:"result", result:"…"}` line wins,
 *                else the concatenation of assistant text deltas/messages.
 */
export function extractLastText(
  stdout: string,
  outputFormat: ClaudeOutputFormat,
): string {
  if (outputFormat === "text") return stdout.trim()

  if (outputFormat === "json") {
    try {
      const obj = JSON.parse(stdout) as { result?: unknown }
      if (typeof obj.result === "string") return obj.result.trim()
    } catch {
      // fall through to returning the raw stdout
    }
    return stdout.trim()
  }

  return extractFromStreamJson(stdout)
}

/** Pull the final assistant text out of a Claude `stream-json` NDJSON transcript. */
function extractFromStreamJson(stdout: string): string {
  let resultText: string | undefined
  const assistantChunks: Array<string> = []

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let evt: {
      type?: string
      result?: unknown
      message?: { content?: unknown }
      delta?: { text?: unknown }
    }
    try {
      evt = JSON.parse(trimmed) as typeof evt
    } catch {
      continue
    }
    if (evt.type === "result" && typeof evt.result === "string") {
      resultText = evt.result
    } else if (typeof evt.delta?.text === "string") {
      assistantChunks.push(evt.delta.text)
    } else if (
      evt.type === "assistant"
      && Array.isArray(evt.message?.content)
    ) {
      collectTextBlocks(evt.message.content, assistantChunks)
    }
  }

  if (resultText !== undefined) return resultText.trim()
  return assistantChunks.join("").trim()
}

/** Append the `text` of any `{type:"text"}` content blocks to `out`. */
function collectTextBlocks(content: unknown, out: Array<string>): void {
  if (!Array.isArray(content)) return
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push(block.text)
    }
  }
}

/** Build the claude argv from options (exported for unit testing). */
export function buildClaudeArgs(options: RunClaudeOptions): Array<string> {
  const outputFormat = options.outputFormat ?? "text"
  const args = [
    "-p",
    options.prompt,
    "--model",
    options.model,
    "--output-format",
    outputFormat,
    "--allow-dangerously-skip-permissions",
  ]
  if (options.agentsJson) args.push("--agents", options.agentsJson)
  if (options.mcpConfig) {
    const configs =
      Array.isArray(options.mcpConfig) ? options.mcpConfig : [options.mcpConfig]
    for (const cfg of configs) args.push("--mcp-config", cfg)
  }
  if (options.extraArgs) args.push(...options.extraArgs)
  return args
}

/**
 * Run `claude -p` against the proxy and return the captured result.
 * Never throws on a non-zero exit — the caller (matrix runner) judges exitCode.
 */
export async function runClaude(
  options: RunClaudeOptions,
): Promise<RunClaudeResult> {
  const bin = resolveClaudeBin()
  const baseUrl = options.baseUrl ?? `http://localhost:${ACCEPTANCE_PORT}`
  const outputFormat = options.outputFormat ?? "text"
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = buildClaudeArgs({ ...options, outputFormat })

  const proc = Bun.spawn([bin, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      // Keep CC from making non-essential side calls that would muddy the traces.
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Race the process against a timeout sentinel; if the timer wins we kill the
  // process and report timedOut. (A timer-set boolean would defeat the linter's
  // flow analysis, so the verdict comes from which branch of the race resolved.)
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
    return {
      exitCode: timedOut ? null : await proc.exited,
      timedOut,
      stdout,
      stderr,
      lastText: extractLastText(stdout, outputFormat),
      argv: [bin, ...args],
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
