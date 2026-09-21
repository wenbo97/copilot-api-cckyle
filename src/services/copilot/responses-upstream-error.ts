const OWNERSHIP_MESSAGE = "input item does not belong to this connection"

export class ResponsesUpstreamError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = "upstream_error") {
    super(message)
    this.name = "ResponsesUpstreamError"
    this.status = status
    this.code = code
  }

  get isHistoryOwnershipError(): boolean {
    return this.status === 401 && this.message === OWNERSHIP_MESSAGE
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

export function parseResponsesJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function extractError(
  outer: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body =
    typeof outer.body === "string" ?
      record(parseResponsesJson(outer.body))
    : record(outer.body)
  const response = record(outer.response)
  return (
    record(body?.error)
    ?? record(outer.error)
    ?? record(response?.error)
    ?? (outer.type === "error" ? outer : undefined)
  )
}

// Some Copilot relays put an HTTP failure inside an otherwise successful SSE
// stream. Decode that envelope before the Responses protocol guard discards its
// status and message. Never classify a generic 401 as a history failure.
export function responsesUpstreamError(
  value: unknown,
  httpStatus?: number,
): ResponsesUpstreamError | undefined {
  const outer = record(value)
  if (!outer) return
  const status = typeof outer.status === "number" ? outer.status : httpStatus
  const error = extractError(outer)
  if (!error || typeof error.message !== "string") return
  const message = error.message.trim().slice(0, 2048)
  const effectiveStatus = status ?? (message === OWNERSHIP_MESSAGE ? 401 : 502)
  if (
    !Number.isInteger(effectiveStatus)
    || effectiveStatus < 400
    || effectiveStatus > 599
  )
    return
  return new ResponsesUpstreamError(
    effectiveStatus,
    message,
    typeof error.code === "string" && error.code ?
      error.code
    : "upstream_error",
  )
}
