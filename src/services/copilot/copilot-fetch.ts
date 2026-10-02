import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { ensureCopilotToken } from "~/lib/token"
import { rejectInputConnectionMismatch } from "~/services/copilot/input-connection-error"

import {
  type CopilotFetchObserver,
  type FetchAttemptCause,
  observeRequest,
} from "./request-observer"

const ERROR_BODY_MAX_BYTES = 16 * 1024
const ERROR_BODY_TIMEOUT_MS = 1000

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
    observer?: CopilotFetchObserver
  } = {},
): Promise<Response> {
  options.signal?.throwIfAborted()
  await waitForAuthentication(ensureCopilotToken(), options.signal)
  options.signal?.throwIfAborted()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const makeRequest = async (cause: FetchAttemptCause) => {
    options.onAttempt?.()
    const observer = options.observer
    if (observer) observeRequest(() => observer.start(cause))
    try {
      const result = await fetchWithHeaderTimeout(path, options)
      if (observer) observeRequest(() => observer.headers(result.status))
      return result
    } catch (error) {
      if (observer) observeRequest(() => observer.failure(error))
      throw error
    }
  }

  const response = await makeRequest("initial")

  if (response.status === 401) {
    await rejectInputConnectionMismatch(path, response, options.signal)
    consola.warn(`Got 401 from ${path}, refreshing Copilot token and retrying`)
    await response.body?.cancel()
    options.signal?.throwIfAborted()
    await waitForAuthentication(ensureCopilotToken(true), options.signal)
    options.signal?.throwIfAborted()
    if (!state.copilotToken) {
      throw await createHTTPError(
        "Copilot token refresh failed",
        response,
        options.signal,
      )
    }
    const retryResponse = await makeRequest("auth_refresh")
    if (!retryResponse.ok) {
      await rejectInputConnectionMismatch(path, retryResponse, options.signal)
      throw await createHTTPError(
        `Failed request to ${path} after token refresh`,
        retryResponse,
        options.signal,
      )
    }
    return retryResponse
  }

  if (!response.ok) {
    throw await createHTTPError(
      `Failed request to ${path}`,
      response,
      options.signal,
    )
  }

  return response
}

/** Detach a bounded error body before streaming cleanup aborts its fetch. */
async function createHTTPError(
  message: string,
  response: Response,
  signal?: AbortSignal,
): Promise<HTTPError> {
  signal?.throwIfAborted()
  const reader = response.body?.getReader()
  if (!reader) return new HTTPError(message, response)

  let errorText = message
  const deadline = { expired: false }
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  const timeout = setTimeout(() => {
    deadline.expired = true
    cancel()
  }, ERROR_BODY_TIMEOUT_MS)
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        if (!deadline.expired) errorText = text + decoder.decode()
        break
      }
      bytes += value.byteLength
      if (bytes > ERROR_BODY_MAX_BYTES) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // Keep the known upstream status even if its body cannot be read.
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
  signal?.throwIfAborted()
  return new HTTPError(
    message,
    new Response(errorText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  )
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
