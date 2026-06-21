import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { ensureCopilotToken } from "~/lib/token"

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
  } = {},
): Promise<Response> {
  await ensureCopilotToken()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const makeRequest = () =>
    fetch(`${copilotBaseUrl(state)}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...copilotHeaders(state),
        ...options.extraHeaders,
      },
      ...(options.body ? { body: options.body } : {}),
    })

  const response = await makeRequest()

  if (response.status === 401) {
    consola.warn(`Got 401 from ${path}, refreshing Copilot token and retrying`)
    await ensureCopilotToken(true)
    if (!state.copilotToken) {
      throw new HTTPError("Copilot token refresh failed", response)
    }
    const retryResponse = await makeRequest()
    if (!retryResponse.ok) {
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
