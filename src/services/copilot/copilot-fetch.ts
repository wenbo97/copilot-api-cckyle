import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { ensureCopilotToken } from "~/lib/token"
import { rejectInputConnectionMismatch } from "~/services/copilot/input-connection-error"

/**
 * Make a fetch request to the Copilot API with automatic token refresh on 401.
 * All Copilot API calls should go through this function.
 */
export async function copilotFetch(
  path: string,
  options: {
    method?: string
    body?: string
    extraHeaders?: Record<string, string>
    signal?: AbortSignal
    headerTimeoutMs?: number
    onAttempt?: () => void
  } = {},
): Promise<Response> {
  options.signal?.throwIfAborted()
  await waitForAuthentication(ensureCopilotToken(), options.signal)
  options.signal?.throwIfAborted()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const makeRequest = () => {
    options.onAttempt?.()
    return fetchWithHeaderTimeout(path, options)
  }

  const response = await makeRequest()

  if (response.status === 401) {
    await rejectInputConnectionMismatch(path, response, options.signal)
    consola.warn(`Got 401 from ${path}, refreshing Copilot token and retrying`)
    await response.body?.cancel()
    options.signal?.throwIfAborted()
    await waitForAuthentication(ensureCopilotToken(true), options.signal)
    options.signal?.throwIfAborted()
    if (!state.copilotToken) {
      throw new HTTPError("Copilot token refresh failed", response)
    }
    const retryResponse = await makeRequest()
    if (!retryResponse.ok) {
      await rejectInputConnectionMismatch(path, retryResponse, options.signal)
      throw new HTTPError(
        `Failed request to ${path} after token refresh`,
        retryResponse,
      )
    }
    return retryResponse
  }

  if (!response.ok) {
    throw new HTTPError(`Failed request to ${path}`, response)
  }

  return response
}

/** Detach one caller without canceling the process-scoped refresh. */
async function waitForAuthentication(
  refresh: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return refresh
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    // AbortSignal permits arbitrary reasons; propagate the caller's exact value.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([refresh, cancelled])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function fetchWithHeaderTimeout(
  path: string,
  options: {
    method?: string
    body?: string
    extraHeaders?: Record<string, string>
    signal?: AbortSignal
    headerTimeoutMs?: number
  },
): Promise<Response> {
  const timeoutMs = options.headerTimeoutMs
  const timeoutController = new AbortController()
  const timeout =
    timeoutMs === undefined ? undefined : (
      setTimeout(() => {
        timeoutController.abort(
          new DOMException(
            `Copilot response header timeout after ${timeoutMs} ms`,
            "TimeoutError",
          ),
        )
      }, timeoutMs)
    )

  const signal =
    options.signal ?
      AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal

  try {
    return await fetch(`${copilotBaseUrl(state)}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...copilotHeaders(state),
        ...options.extraHeaders,
      },
      ...(options.body ? { body: options.body } : {}),
      signal,
    })
  } finally {
    // The header deadline must not become a body/stream deadline after fetch()
    // has resolved with response headers.
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
