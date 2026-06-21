/**
 * Trace-tag oracle for the headless acceptance suite (spec §7.0).
 *
 * The proxy tags every request trace with the egress leg it took, written as the
 * top-level `type` field of `<traceDir>/<timestamp>.req`:
 *   anthropic-passthrough   — CC → /v1/messages native passthrough
 *   anthropic-via-responses — CC → /responses bridge (Messages⇄Responses)
 *   responses-passthrough   — Codex → /responses native passthrough
 *   responses               — Responses handler → translate-down to /chat/completions
 *   anthropic               — Messages handler → translate-down to /chat/completions
 *   chat                    — raw /chat/completions (NO type field; see note below)
 *
 * The oracle asserts the TAG (which egress was chosen), not merely that a reply
 * arrived — that is what proves *routing* correctness rather than "a reply came back".
 *
 * Note: the /chat/completions handler traces the raw payload with no wrapper, so a
 * pure chat request's `.req` has no `.type`. None of the §7 matrix cells expect a
 * `chat` tag, so reading `.type` is sufficient for the suite; such a file reads as
 * an undefined tag and is reported verbatim rather than guessed.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

export type TraceTag =
  | "anthropic-passthrough"
  | "anthropic-via-responses"
  | "responses-passthrough"
  | "responses"
  | "anthropic"
  | "chat"

export interface TraceInfo {
  /** Absolute path to the newest .req file. */
  file: string
  /** The parsed top-level `.type`, or undefined when absent (e.g. raw chat). */
  tag: string | undefined
  /** The full parsed request JSON, for extra assertions (effort, agent tags…). */
  body: unknown
  /** mtime in ms, for ordering / "newer than" checks. */
  mtimeMs: number
}

/** List `.req` files in `traceDir` newest-first by mtime. */
async function listReqFiles(traceDir: string): Promise<Array<TraceInfo>> {
  let names: Array<string>
  try {
    names = await readdir(traceDir)
  } catch {
    return []
  }
  const reqs = names.filter((n) => n.endsWith(".req"))
  const infos: Array<TraceInfo> = []
  for (const name of reqs) {
    const file = path.join(traceDir, name)
    try {
      const s = await stat(file)
      infos.push({ file, tag: undefined, body: undefined, mtimeMs: s.mtimeMs })
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }
  infos.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return infos
}

/** Parse a single .req file, filling in `tag` and `body`. */
async function parseReq(info: TraceInfo): Promise<TraceInfo> {
  const raw = await readFile(info.file, "utf8")
  const body = JSON.parse(raw) as { type?: unknown }
  const tag = typeof body.type === "string" ? body.type : undefined
  return { ...info, tag, body }
}

/**
 * Return the newest `.req` in `traceDir`, fully parsed.
 * @param afterMtimeMs if given, only consider files strictly newer than this
 *   (used to attribute a trace to the request just made, ignoring prior runs).
 */
export async function latestTrace(
  traceDir: string,
  afterMtimeMs = 0,
): Promise<TraceInfo | null> {
  const infos = await listReqFiles(traceDir)
  const candidate = infos.find((i) => i.mtimeMs > afterMtimeMs)
  if (!candidate) return null
  return parseReq(candidate)
}

/**
 * Convenience: the trace tag (`.type`) of the newest `.req`, or undefined.
 * This is the primary oracle read used by the matrix runner.
 */
export async function latestTraceTag(
  traceDir: string,
  afterMtimeMs = 0,
): Promise<string | undefined> {
  const trace = await latestTrace(traceDir, afterMtimeMs)
  return trace?.tag
}

/**
 * Poll for a fresh trace to appear (strictly newer than `afterMtimeMs`) and return
 * its tag. Traces are written asynchronously after the response begins, so a short
 * poll avoids a race between the client returning and the `.req` hitting disk.
 */
export async function waitForTraceTag(
  traceDir: string,
  options: { afterMtimeMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<{ tag: string | undefined; trace: TraceInfo | null }> {
  const { afterMtimeMs = 0, timeoutMs = 5_000, pollMs = 100 } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const trace = await latestTrace(traceDir, afterMtimeMs)
    if (trace) return { tag: trace.tag, trace }
    if (Date.now() >= deadline) return { tag: undefined, trace: null }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Every `.req` in `traceDir` strictly newer than `afterMtimeMs`, newest-first,
 * fully parsed. Used by multi-trace oracles (subagent / agent-team rows) that must
 * assert "≥N agent-tagged traces appeared" rather than just the single newest one.
 */
export async function tracesSince(
  traceDir: string,
  afterMtimeMs = 0,
): Promise<Array<TraceInfo>> {
  const infos = await listReqFiles(traceDir)
  const fresh = infos.filter((i) => i.mtimeMs > afterMtimeMs)
  const parsed: Array<TraceInfo> = []
  for (const info of fresh) {
    try {
      parsed.push(await parseReq(info))
    } catch {
      // unparseable / partially-written file — skip
    }
  }
  return parsed
}

export interface TagAssertion {
  ok: boolean
  expected: string
  actual: string | undefined
  message: string
}

/** Compare an observed tag to the expected one and produce a structured verdict. */
export function assertTag(
  expected: TraceTag,
  actual: string | undefined,
): TagAssertion {
  const ok = actual === expected
  return {
    ok,
    expected,
    actual,
    message:
      ok ?
        `tag == ${expected}`
      : `expected tag ${expected} but got ${actual ?? "<none>"}`,
  }
}
