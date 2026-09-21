import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { ResponsesUpstreamError } from "~/services/copilot/responses-upstream-error"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  if (error instanceof ResponsesUpstreamError) {
    consola.warn(
      `[Responses] Upstream failure status=${error.status}, code=${error.code}`,
    )
    return c.json(
      {
        error: {
          message: error.message,
          type: "upstream_error",
          code: error.code,
        },
      },
      error.status as ContentfulStatusCode,
    )
  }
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
