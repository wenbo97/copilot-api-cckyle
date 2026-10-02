export type FetchAttemptCause = "initial" | "auth_refresh"
export type ResponsesAttemptCause = FetchAttemptCause | "history_recovery"

export interface CopilotFetchObserver {
  start(cause: FetchAttemptCause): void
  headers(status: number): void
  failure(error: unknown): void
}

export interface ResponsesAttemptObserver {
  requestId: string
  start(serializedBody: string, cause: ResponsesAttemptCause): void
  headers(status: number): void
  value(value: unknown): void
  failure(error: unknown): void
}

/** Isolate optional observations only, never business or budget callbacks. */
export function observeRequest(action: () => void): void {
  try {
    action()
  } catch {
    // Diagnostic failures must not mask an upstream result or cause a retry.
  }
}
