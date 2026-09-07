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
  await ensureCopilotToken()
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
    await ensureCopilotToken(true)
    // Token refresh is deliberately process-scoped and is not tied to one
    // client's signal. Check cancellation only after refresh, before retrying
    // this request.
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
