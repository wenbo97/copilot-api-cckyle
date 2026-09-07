import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import * as token from "~/lib/token"
import { server } from "~/server"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const ownershipMessage = "input item does not belong to this connection"
let ensureToken: ReturnType<typeof createTokenSpy>

function createTokenSpy() {
  return spyOn(token, "ensureCopilotToken")
}

beforeEach(() => {
  ensureToken = createTokenSpy().mockResolvedValue(undefined)
  state.copilotToken = "offline-test-token"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  state.accountType = "individual"
  state.manualApprove = false
  state.traceEnabled = false
  state.rateLimitSeconds = undefined
  state.models = {
    object: "list",
    data: [{ id: "gpt-5.6-sol-fast", supported_endpoints: ["/responses"] }],
  } as unknown as ModelsResponse
})

afterEach(() => {
  globalThis.fetch = originalFetch
  ensureToken.mockRestore()
  Object.assign(
    state,
    {
      copilotToken: undefined,
      copilotTokenExpiresAt: undefined,
      models: undefined,
    },
    originalState,
  )
})

describe("Responses input connection rejection", () => {
  test.each([false, true])(
    "does not refresh authentication or replay rejected input (stream=%s)",
    async (stream) => {
      const upstream = mock(() =>
        Promise.resolve(
          Response.json(
            { error: { message: ownershipMessage, code: "" } },
            { status: 401 },
          ),
        ),
      )
      globalThis.fetch = upstream as unknown as typeof fetch

      const response = await server.request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol-fast",
          stream,
          input: [
            {
              type: "reasoning",
              id: "opaque-history-item",
              encrypted_content: "opaque-reasoning-fixture",
              summary: [],
            },
            { role: "user", content: "Continue the task" },
          ],
        }),
      })

      expect(upstream).toHaveBeenCalledTimes(1)
      expect(ensureToken.mock.calls.some(([force]) => force === true)).toBe(
        false,
      )
      expect(response.status).toBe(400)
      const errorBody: unknown = await response.json()
      expect(errorBody).toMatchObject({
        error: {
          type: "invalid_request_error",
          code: "copilot_input_connection_mismatch",
          param: "input",
        },
      })
      expect(JSON.stringify(errorBody)).toContain(ownershipMessage)
    },
  )

  test("preserves input and cache fields when an ownership error is rejected", async () => {
    const payload = JSON.stringify({
      model: "gpt-5.6-sol-fast",
      prompt_cache_key: "session-fixture",
      input: [{ type: "reasoning", id: "r1", encrypted_content: "opaque" }],
    })
    let sentBody: unknown
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      sentBody = init?.body
      return Promise.resolve(ownershipResponse())
    }) as unknown as typeof fetch

    const error = await copilotFetch("/responses", { body: payload }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({
      code: "copilot_input_connection_mismatch",
    })
    expect(sentBody).toBe(payload)
  })

  test("classifies an ownership rejection after a genuine auth refresh", async () => {
    const upstream = mock()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Token expired" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(ownershipResponse())
    globalThis.fetch = upstream as unknown as typeof fetch

    const error = await copilotFetch("/responses").catch(
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({
      code: "copilot_input_connection_mismatch",
    })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(
      ensureToken.mock.calls.filter(([force]) => force === true),
    ).toHaveLength(1)
  })
})

describe("authentication retry remains bounded", () => {
  test.each([
    JSON.stringify({ error: { message: "Token expired" } }),
    JSON.stringify({ error: { message: `Unrelated: ${ownershipMessage}` } }),
    "not JSON",
    "x".repeat(20_000),
  ])("refreshes once for an ordinary or unreadable 401", async (body) => {
    const upstream = mock()
      .mockResolvedValueOnce(new Response(body, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    globalThis.fetch = upstream as unknown as typeof fetch

    expect((await copilotFetch("/responses")).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(
      ensureToken.mock.calls.filter(([force]) => force === true),
    ).toHaveLength(1)
  })

  test("does not reclassify the same text from another endpoint", async () => {
    const upstream = mock()
      .mockResolvedValueOnce(ownershipResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }))
    globalThis.fetch = upstream as unknown as typeof fetch

    expect((await copilotFetch("/chat/completions")).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(ensureToken).toHaveBeenCalledWith(true)
  })

  test("preserves the final ordinary 401 response body", async () => {
    const body = JSON.stringify({ error: { message: "Token expired" } })
    const upstream = mock(() =>
      Promise.resolve(new Response(body, { status: 401 })),
    )
    globalThis.fetch = upstream as unknown as typeof fetch

    const error = await copilotFetch("/responses").catch(
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({ response: { status: 401 } })
    if (
      !(error instanceof Error)
      || !("response" in error)
      || !(error.response instanceof Response)
    )
      throw new Error("Expected an HTTP error response")
    expect(await error.response.text()).toBe(body)
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  test("bounds inspection of a stalled 401 body", async () => {
    let cancelled = false
    const stalled = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 401 },
    )
    const upstream = mock()
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce(Response.json({ ok: true }))
    globalThis.fetch = upstream as unknown as typeof fetch

    expect((await copilotFetch("/responses")).status).toBe(200)
    expect(cancelled).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(2)
  }, 3000)

  test("honors cancellation while inspecting a 401 body without retrying", async () => {
    const caller = new AbortController()
    const { promise: reading, resolve: bodyRead } =
      Promise.withResolvers<boolean>()
    const upstream = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              bodyRead(true)
            },
          }),
          { status: 401 },
        ),
      ),
    )
    globalThis.fetch = upstream as unknown as typeof fetch

    const request = copilotFetch("/responses", { signal: caller.signal })
    const error = request.catch((cause: unknown) => cause)
    await reading
    caller.abort()
    expect(await error).toMatchObject({ name: "AbortError" })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(ensureToken).not.toHaveBeenCalledWith(true)
  })
})

function ownershipResponse(): Response {
  return Response.json(
    { error: { message: ownershipMessage, code: "" } },
    { status: 401 },
  )
}
