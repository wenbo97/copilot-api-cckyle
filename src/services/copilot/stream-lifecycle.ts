import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

export interface CopilotStreamTimeouts {
  firstEventMs?: number
  idleMs?: number
  totalMs?: number
}

const STREAM_CLOSED = new DOMException(
  "Copilot SSE stream consumer closed",
  "AbortError",
)

/**
 * Owns the abort and timeout lifecycle for one Copilot streaming request.
 *
 * The controller signal aborts `fetch()` and is checked between SSE frames. This is
 * important because fetch-event-stream does not cancel its locked reader when a
 * consumer leaves a `for await` loop early. Aborting here in `finally` releases
 * the network body in every success, failure, timeout, and downstream-cancel
 * path.
 */
export class CopilotStreamLifecycle {
  readonly signal: AbortSignal

  private readonly controller = new AbortController()
  private readonly parentSignal?: AbortSignal
  private readonly timeouts: CopilotStreamTimeouts
  private firstEventTimer?: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private totalTimer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    parentSignal?: AbortSignal,
    timeouts: CopilotStreamTimeouts = {},
  ) {
    this.signal = this.controller.signal
    this.parentSignal = parentSignal
    this.timeouts = timeouts

    if (parentSignal?.aborted) {
      this.controller.abort(parentSignal.reason)
    } else if (parentSignal) {
      parentSignal.addEventListener("abort", this.onParentAbort, { once: true })
    }

    if (timeouts.totalMs !== undefined) {
      const timeoutMs = timeouts.totalMs
      this.totalTimer = setTimeout(
        () => this.abortForTimeout("total", timeoutMs),
        timeoutMs,
      )
    }
  }

  async *iterate(response: Response): AsyncGenerator<ServerSentEventMessage> {
    this.startFirstEventTimer()

    try {
      this.signal.throwIfAborted()
      // Fetch aborts the body. Do not also ask the parser to cancel its reader:
      // canceling an already-errored reader between yielded frames can reject.
      for await (const event of events(response)) {
        this.signal.throwIfAborted()
        // Activity means every parsed upstream SSE frame, including reasoning,
        // usage, and tool frames. It is deliberately not limited to visible
        // text tokens.
        this.noteActivity()
        yield event
      }
      this.signal.throwIfAborted()
    } finally {
      this.dispose()
    }
  }

  dispose(reason: unknown = STREAM_CLOSED): void {
    if (this.disposed) return
    this.disposed = true

    this.clearTimers()
    this.parentSignal?.removeEventListener("abort", this.onParentAbort)
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private readonly onParentAbort = (): void => {
    if (!this.controller.signal.aborted)
      this.controller.abort(this.parentSignal?.reason)
  }

  private startFirstEventTimer(): void {
    if (this.signal.aborted || this.timeouts.firstEventMs === undefined) return
    const timeoutMs = this.timeouts.firstEventMs
    this.firstEventTimer = setTimeout(
      () => this.abortForTimeout("first SSE event", timeoutMs),
      timeoutMs,
    )
  }

  private noteActivity(): void {
    if (this.firstEventTimer !== undefined) {
      clearTimeout(this.firstEventTimer)
      this.firstEventTimer = undefined
    }

    if (this.timeouts.idleMs === undefined || this.signal.aborted) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    const timeoutMs = this.timeouts.idleMs
    this.idleTimer = setTimeout(
      () => this.abortForTimeout("SSE idle", timeoutMs),
      timeoutMs,
    )
  }

  private abortForTimeout(label: string, timeoutMs: number): void {
    if (this.controller.signal.aborted) return
    this.controller.abort(
      new DOMException(
        `Copilot ${label} timeout after ${timeoutMs} ms`,
        "TimeoutError",
      ),
    )
  }

  private clearTimers(): void {
    if (this.firstEventTimer !== undefined) clearTimeout(this.firstEventTimer)
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    if (this.totalTimer !== undefined) clearTimeout(this.totalTimer)
    this.firstEventTimer = undefined
    this.idleTimer = undefined
    this.totalTimer = undefined
  }
}

export function readCopilotStreamTimeouts(): CopilotStreamTimeouts {
  return {
    firstEventMs: readOptionalTimeout(
      "COPILOT_FIRST_EVENT_TIMEOUT_MS",
      300_000,
    ),
    idleMs: readOptionalTimeout("COPILOT_STREAM_IDLE_TIMEOUT_MS", 300_000),
    totalMs: readOptionalTimeout("COPILOT_TOTAL_TIMEOUT_MS"),
  }
}

export function readCopilotHeaderTimeoutMs(): number | undefined {
  return readOptionalTimeout("COPILOT_HEADER_TIMEOUT_MS", 60_000)
}

function readOptionalTimeout(
  name: string,
  fallback?: number,
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = raw.trim()
  if (value === "0") return
  const parsed = Number(value)
  if (
    /^\d+$/.test(value)
    && Number.isSafeInteger(parsed)
    && parsed > 0
    && parsed <= 2_147_483_647
  )
    return parsed
  consola.warn(
    `Invalid ${name}=${JSON.stringify(raw)}; expected 0 or an integer from 1 to 2147483647 milliseconds. Using ${fallback === undefined ? "no deadline" : `${fallback} ms`}.`,
  )
  return fallback
}
