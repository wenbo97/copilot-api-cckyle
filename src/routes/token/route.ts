import { Hono, type Context } from "hono"

import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.options("/", localAccessOnly)

tokenRoute.get("/", (c) => {
  const host = c.req.header("host")
  if (c.req.header("origin") || !host || !isLoopbackHost(host))
    return localAccessOnly(c)

  try {
    c.header("Cache-Control", "no-store")
    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    console.error("Error fetching token:", error)
    return c.json({ error: "Failed to fetch token", token: null }, 500)
  }
})

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  const hostname =
    normalized.startsWith("[") ?
      normalized.slice(1, normalized.indexOf("]"))
    : normalized.split(":", 1)[0]
  return hostname === "127.0.0.1" || hostname === "localhost"
}

function localAccessOnly(c: Context) {
  return c.json(
    {
      error: {
        message:
          "The token endpoint is available only to local non-browser clients.",
        type: "invalid_request_error",
        code: "local_access_only",
      },
    },
    403,
  )
}
