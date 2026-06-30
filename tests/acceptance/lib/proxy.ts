/**
 * Proxy launcher for the headless acceptance suite.
 *
 * Starts a FRESH copilot-api instance from THIS worktree on :4143 with tracing
 * enabled, so the suite judges the *worktree (fixed)* code. Port 4143 is reserved
 * for acceptance — :4141 (live Claude Code session) and :4142 (other instance)
 * are deliberately never touched (spec §7.0 / §8 "Port contention").
 *
 * Each launch writes traces into a UNIQUE temp folder (via TRACE_OUTPUT_FOLDER)
 * so the oracle can attribute traces to this run only.
 */
import consola from "consola"
import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Worktree root resolved from this file's location (…/tests/acceptance/lib/proxy.ts),
// so the launcher is portable across worktrees rather than pinned to an absolute path.
const WORKTREE_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

export const ACCEPTANCE_PORT = 4143
const READINESS_TIMEOUT_MS = 60_000
const READINESS_POLL_MS = 250
const STOP_TIMEOUT_MS = 10_000
const LOG_TAIL_LIMIT = 64 * 1024 // keep last 64 KiB of proxy output for diagnostics
const DEFAULT_SPAWN_ATTEMPTS = 3 // cold-start catalog fetch can transiently reset
const SPAWN_RETRY_DELAY_MS = 3_000

export interface ProxyHandle {
  /** Port the proxy is listening on. */
  port: number
  /** Base URL, e.g. http://localhost:4143 */
  baseUrl: string
  /** Unique trace folder for this run; every request writes <ts>.req here. */
  traceDir: string
  /** Number of models the catalog advertised at readiness. */
  modelCount: number
  /** Spawned process id. */
  pid: number | undefined
  /** Last chunk of combined stdout+stderr (diagnostics). */
  logTail: () => string
  /** Terminate the proxy and flush its log to <traceDir>/proxy.log. */
  stop: () => Promise<void>
}

export interface StartProxyOptions {
  port?: number
  /** Override the trace folder (default: a fresh temp dir). */
  traceDir?: string
  /** Readiness timeout in ms (default 60s — cold start authenticates + caches models). */
  readinessTimeoutMs?: number
  /** Minimum number of models required before declaring ready (default 1). */
  minModels?: number
  /**
   * How many times to (re)spawn the proxy if it dies before readiness (default 3).
   * The upstream catalog fetch (`GET …/models`) can transiently reset on a cold
   * process; a fresh spawn usually succeeds. A hard, persistent block surfaces as
   * "exhausted N attempts" with the last proxy log attached.
   */
  spawnAttempts?: number
}

/** Probe /v1/models; resolve the model count once it returns a non-empty list. */
async function probeModels(baseUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`)
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<unknown> }
    if (Array.isArray(json.data) && json.data.length > 0)
      return json.data.length
    return null
  } catch {
    return null // connection refused while the server is still booting
  }
}

/**
 * Launch the proxy on `port` and resolve once it is serving models.
 * Retries the spawn up to `spawnAttempts` times if the process dies before
 * readiness (cold-start catalog resets); throws with the last captured proxy log
 * when all attempts are exhausted.
 */
export async function startProxy(
  options: StartProxyOptions = {},
): Promise<ProxyHandle> {
  const port = options.port ?? ACCEPTANCE_PORT
  const traceDir =
    options.traceDir
    ?? mkdtempSync(path.join(tmpdir(), "copilot-accept-trace-"))
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS
  const minModels = options.minModels ?? 1
  const spawnAttempts = options.spawnAttempts ?? DEFAULT_SPAWN_ATTEMPTS

  let lastError: unknown
  for (let attempt = 1; attempt <= spawnAttempts; attempt++) {
    try {
      return await spawnAndWait({
        port,
        traceDir,
        readinessTimeoutMs,
        minModels,
      })
    } catch (err) {
      lastError = err
      if (attempt < spawnAttempts) {
        consola.warn(
          `[proxy] start attempt ${attempt}/${spawnAttempts} failed; retrying in ${SPAWN_RETRY_DELAY_MS}ms`,
        )
        await Bun.sleep(SPAWN_RETRY_DELAY_MS)
      }
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Proxy failed to start after ${spawnAttempts} attempt(s) on port ${port}.\n${detail}`,
  )
}

/** One spawn → drain → readiness-poll cycle. Kills the process on any failure. */
async function spawnAndWait(opts: {
  port: number
  traceDir: string
  readinessTimeoutMs: number
  minModels: number
}): Promise<ProxyHandle> {
  const { port, traceDir, readinessTimeoutMs, minModels } = opts
  const baseUrl = `http://localhost:${port}`

  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "./src/main.ts",
      "start",
      "--port",
      String(port),
      "--account-type",
      "enterprise",
      "--trace",
    ],
    {
      cwd: WORKTREE_ROOT,
      env: { ...process.env, TRACE_OUTPUT_FOLDER: traceDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  // Drain stdout+stderr into a capped ring buffer so a startup failure can be
  // reported with real diagnostics instead of a bare timeout.
  let log = ""
  const append = (s: string) => {
    log += s
    if (log.length > LOG_TAIL_LIMIT)
      log = log.slice(log.length - LOG_TAIL_LIMIT)
  }
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    const reader = stream.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      append(dec.decode(value, { stream: true }))
    }
  }
  void drain(proc.stdout as ReadableStream<Uint8Array> | undefined)
  void drain(proc.stderr as ReadableStream<Uint8Array> | undefined)

  const logTail = () => log

  const stop = async () => {
    try {
      proc.kill()
      await Promise.race([
        proc.exited,
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ])
    } finally {
      // Best-effort: persist the proxy log next to the traces for post-mortem.
      await writeFile(path.join(traceDir, "proxy.log"), log, "utf8").catch(
        () => {},
      )
    }
  }

  // Poll readiness; if the process dies first, surface its log immediately.
  const deadline = Date.now() + readinessTimeoutMs

  while (Date.now() < deadline) {
    // proc.exitCode is null while running, a number once the process has exited.
    if (proc.exitCode !== null) {
      await stop()
      throw new Error(
        `Proxy process exited (code ${proc.exitCode}) before becoming ready (port ${port}).\n--- proxy log ---\n${log}`,
      )
    }
    const count = await probeModels(baseUrl)
    if (count !== null && count >= minModels) {
      return {
        port,
        baseUrl,
        traceDir,
        modelCount: count,
        pid: proc.pid,
        logTail,
        stop,
      }
    }
    await Bun.sleep(READINESS_POLL_MS)
  }

  await stop()
  throw new Error(
    `Proxy did not become ready on port ${port} within ${readinessTimeoutMs}ms.\n`
      + `(Is the port already in use? Acceptance must own :4143.)\n--- proxy log ---\n${log}`,
  )
}
