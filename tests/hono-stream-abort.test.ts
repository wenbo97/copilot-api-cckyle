import { expect, test } from "bun:test"
import { StreamingApi } from "hono/utils/stream"

test("Hono contains async stream abort listener failures", async () => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const stream = new StreamingApi(writable, readable)
  const unhandled: Array<unknown> = []
  const captureUnhandled = (reason: unknown) => unhandled.push(reason)

  process.on("unhandledRejection", captureUnhandled)
  try {
    stream.onAbort(() => {
      const error = new Error("The connection was closed.")
      error.name = "AbortError"
      return Promise.reject(error)
    })

    stream.abort()
    await Bun.sleep(0)

    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", captureUnhandled)
  }
})
