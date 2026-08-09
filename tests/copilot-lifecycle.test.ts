import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { copilotFetch } from "../src/services/copilot/copilot-fetch"
import { CopilotStreamLifecycle } from "../src/services/copilot/stream-lifecycle"

const originalFetch = globalThis.fetch
const originalHeaderTimeout = process.env.COPILOT_HEADER_TIMEOUT_MS

beforeEach(() => {
  state.copilotToken = "test-token"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  delete process.env.COPILOT_HEADER_TIMEOUT_MS
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalHeaderTimeout === undefined)
    delete process.env.COPILOT_HEADER_TIMEOUT_MS
  else process.env.COPILOT_HEADER_TIMEOUT_MS = originalHeaderTimeout
})

describe("copilotFetch request lifecycle", () => {
  test("links the caller AbortSignal to the actual fetch", async () => {
    let fetchSignal: AbortSignal | undefined
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        return Promise.resolve(new Response("{}"))
      },
    ) as unknown as typeof fetch

    const caller = new AbortController()
    await copilotFetch("/models", { signal: caller.signal })
    expect(fetchSignal?.aborted).toBe(false)

    caller.abort(new DOMException("client left", "AbortError"))
    expect(fetchSignal?.aborted).toBe(true)
    expect(fetchSignal?.reason).toBe(caller.signal.reason)
  })

  test("aborts a request that does not return headers before the deadline", async () => {
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ?
                  signal.reason
                : new Error("request aborted"),
              ),
            { once: true },
          )
        }),
    ) as unknown as typeof fetch

    const error = await captureError(
      copilotFetch("/models", { headerTimeoutMs: 10 }),
    )
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "Copilot response header timeout after 10 ms",
    })
  })

  test("clears the header deadline once headers arrive", async () => {
    let fetchSignal: AbortSignal | undefined
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        return Promise.resolve(new Response("{}"))
      },
    ) as unknown as typeof fetch

    await copilotFetch("/models", { headerTimeoutMs: 10 })
    await Bun.sleep(25)
    expect(fetchSignal?.aborted).toBe(false)
  })

  test("does not apply Responses timeout configuration to shared callers", async () => {
    process.env.COPILOT_HEADER_TIMEOUT_MS = "10"
    let fetchSignal: AbortSignal | undefined
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        return Promise.resolve(new Response("{}"))
      },
    ) as unknown as typeof fetch

    await copilotFetch("/models")
    await Bun.sleep(25)
    expect(fetchSignal?.aborted).toBe(false)
  })
})

describe("CopilotStreamLifecycle", () => {
  test("propagates downstream cancellation", () => {
    const parent = new AbortController()
    const lifecycle = new CopilotStreamLifecycle(parent.signal, {})
    const reason = new DOMException("downstream disconnected", "AbortError")

    parent.abort(reason)

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.signal.reason).toBe(reason)
  })

  test("aborts the upstream scope when the consumer leaves the loop", async () => {
    const lifecycle = new CopilotStreamLifecycle(undefined, {})
    const response = controlledSseResponse(lifecycle.signal, [
      'data: {"type":"response.created"}\n\n',
    ])
    const iterator = lifecycle.iterate(response)

    expect((await iterator.next()).done).toBe(false)
    await iterator.return(undefined)

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.signal.reason).toMatchObject({ name: "AbortError" })
  })

  test("applies an optional first-event deadline", async () => {
    const lifecycle = new CopilotStreamLifecycle(undefined, {
      firstEventMs: 10,
    })
    const iterator = lifecycle.iterate(
      controlledSseResponse(lifecycle.signal, []),
    )

    const error = await captureError(iterator.next())
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "Copilot first SSE event timeout after 10 ms",
    })
    expect(lifecycle.signal.aborted).toBe(true)
  })

  test("resets the optional idle deadline on every upstream SSE event", async () => {
    const lifecycle = new CopilotStreamLifecycle(undefined, { idleMs: 15 })
    const response = controlledSseResponse(lifecycle.signal, [
      'event: response.reasoning_summary_text.delta\ndata: {"delta":"thinking"}\n\n',
    ])
    const iterator = lifecycle.iterate(response)

    expect((await iterator.next()).done).toBe(false)
    const error = await captureError(iterator.next())
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "Copilot SSE idle timeout after 15 ms",
    })
  })

  test("applies an optional total stream deadline", async () => {
    const lifecycle = new CopilotStreamLifecycle(undefined, { totalMs: 10 })
    const iterator = lifecycle.iterate(
      controlledSseResponse(lifecycle.signal, []),
    )

    const error = await captureError(iterator.next())
    expect(error).toMatchObject({
      name: "TimeoutError",
      message: "Copilot total timeout after 10 ms",
    })
  })
})

function controlledSseResponse(
  signal: AbortSignal,
  initialFrames: Array<string>,
): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of initialFrames)
          controller.enqueue(encoder.encode(frame))
        signal.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    return new Error(String(error))
  }
  throw new Error("Expected promise to reject")
}
