import type { ResponsesDiagnosticOrigin } from "~/lib/responses-diagnostics"

import {
  type CopilotStreamTimeouts,
  readCopilotHeaderTimeoutMs,
  readCopilotStreamTimeouts,
} from "./stream-lifecycle"

export interface CopilotRequestOptions {
  responsesDiagnostics?: ResponsesDiagnosticOrigin
  signal?: AbortSignal
  headerTimeoutMs?: number
  streamTimeouts?: CopilotStreamTimeouts
}

export interface CopilotRequestScope extends CopilotRequestOptions {
  signal: AbortSignal
  abort: () => void
}

export function copilotRequestOptions(
  signal: AbortSignal,
): CopilotRequestScope {
  const downstream = new AbortController()
  return {
    signal: AbortSignal.any([signal, downstream.signal]),
    abort: () =>
      downstream.abort(
        new DOMException("Downstream stream closed", "AbortError"),
      ),
    headerTimeoutMs: readCopilotHeaderTimeoutMs(),
    streamTimeouts: readCopilotStreamTimeouts(),
  }
}
