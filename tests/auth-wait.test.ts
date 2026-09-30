import { afterEach, expect, spyOn, test } from "bun:test"

import { state } from "~/lib/state"
import { copilotFetch } from "~/services/copilot/copilot-fetch"
import { getCopilotToken } from "~/services/github/get-copilot-token"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const originalTimeout = globalThis.setTimeout
const timers: Array<ReturnType<typeof setTimeout>> = []

function requestUrl(value: string | URL | Request): string {
  return value instanceof Request ? value.url : value.toString()
}

function captureTimers() {
  return spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof setTimeout>) => {
        const timer = originalTimeout(...args)
        timers.push(timer)
        return timer
      },
      { __promisify__: originalTimeout.__promisify__ },
    ) as typeof setTimeout,
  )
}

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(
    state,
    {
      githubToken: undefined,
      copilotToken: undefined,
      copilotTokenExpiresAt: undefined,
    },
    originalState,
  )
  for (const timer of timers.splice(0)) clearTimeout(timer)
})

test.each([false, true])(
  "one caller leaves shared refresh while another succeeds (after401=%s)",
  async (after401) => {
    const timerSpy = captureTimers()
    const exchange = Promise.withResolvers<Response>()
    const entered = Promise.withResolvers<undefined>()
    let exchanges = 0
    let requests = 0
    Object.assign(state, {
      githubToken: "offline-github",
      copilotToken: "old-token",
      copilotTokenExpiresAt:
        Math.floor(Date.now() / 1000) + (after401 ? 3600 : -1),
    })
    globalThis.fetch = Object.assign(
      (url: string | URL | Request) => {
        if (requestUrl(url).endsWith("/copilot_internal/v2/token")) {
          exchanges++
          entered.resolve(undefined)
          return exchange.promise
        }
        if (!requestUrl(url).endsWith("/responses"))
          throw new Error("Unexpected offline request")
        requests++
        return Promise.resolve(
          after401 && requests === 1 ?
            Response.json({ error: { message: "expired" } }, { status: 401 })
          : Response.json({ ok: true }),
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const caller = new AbortController()
    const first = copilotFetch("/responses", { signal: caller.signal }).catch(
      (error: unknown) => error,
    )
    let second: Promise<Response> | undefined
    try {
      await entered.promise
      // The second caller also needs the refresh already in flight.
      // eslint-disable-next-line require-atomic-updates -- controlled concurrent fixture
      state.copilotTokenExpiresAt = 0
      second = copilotFetch("/responses")
      caller.abort(new DOMException("left", "AbortError"))
      expect(await first).toBe(caller.signal.reason)
      exchange.resolve(
        Response.json({
          token: "new-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 3600,
        }),
      )
      expect((await second).status).toBe(200)
      expect(exchanges).toBe(1)
      expect(requests).toBe(after401 ? 2 : 1)
    } finally {
      exchange.resolve(Response.json({ token: "cleanup", expires_at: 0 }))
      await Promise.allSettled([first, second])
      timerSpy.mockRestore()
    }
  },
)

test("an unavailable refresh never sends an expired credential upstream", async () => {
  const timerSpy = captureTimers()
  Object.assign(state, {
    githubToken: undefined,
    copilotToken: "expired",
    copilotTokenExpiresAt: 1,
  })
  let upstreamRequests = 0
  globalThis.fetch = Object.assign(
    (url: string | URL | Request) => {
      if (
        requestUrl(url).startsWith("http://127.0.0.1:")
        && requestUrl(url).endsWith("/token")
      )
        return Promise.resolve(new Response(null, { status: 503 }))
      upstreamRequests++
      throw new Error("Expired credentials must not be sent upstream")
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const failure = await copilotFetch("/responses").catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(
      "no unexpired Copilot credential",
    )
    expect(upstreamRequests).toBe(0)
  } finally {
    timerSpy.mockRestore()
  }
})

test.each([false, true])(
  "token exchange has a service deadline including body reads (body=%s)",
  async (body) => {
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
      deadline.signal,
    )
    const entered = Promise.withResolvers<undefined>()
    globalThis.fetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBe(deadline.signal)
        entered.resolve(undefined)
        if (body) {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  deadline.signal.addEventListener(
                    "abort",
                    () => {
                      controller.error(deadline.signal.reason)
                    },
                    { once: true },
                  )
                },
              }),
            ),
          )
        }
        return new Promise<Response>((_resolve, reject) => {
          deadline.signal.addEventListener(
            "abort",
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mirrors fetch abort semantics
            () => reject(deadline.signal.reason),
            { once: true },
          )
        })
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = getCopilotToken().catch((error: unknown) => error)
    try {
      // Also resolve on assertion failure so a missing signal fails promptly.
      await Promise.race([entered.promise, result])
      deadline.abort(new DOMException("auth deadline", "TimeoutError"))
      expect(await result).toBe(deadline.signal.reason)
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
  },
)
