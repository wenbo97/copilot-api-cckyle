interface BunTimeoutRequest extends Request {
  runtime?: {
    bun?: { server: { timeout(request: Request, seconds: number): void } }
  }
}

/** Keep a streaming request alive through admission waits and upstream silence. */
export function preserveStreamingRequest(
  request: Request,
  payload: { stream?: unknown },
): void {
  if (payload.stream !== true) return
  // srvx attaches Bun's server to the original native Request. A cloned request
  // cannot be passed to server.timeout(), and Hono-only tests have no runtime.
  const bun = (request as BunTimeoutRequest).runtime?.bun
  bun?.server.timeout(request, 0)
}
