import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import * as token from "~/lib/token"
import { server } from "~/server"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const encoder = new TextEncoder()
let ensureToken: ReturnType<typeof createTokenSpy>
let upstream: ReturnType<typeof Bun.serve> | undefined
let calls = 0
let statuses = [400]
let bodyMode: "delayed" | "plain" | "oversized" | "stalled" = "delayed"
let requestSignal: AbortSignal | null | undefined
const bodyTimers = new Set<ReturnType<typeof setTimeout>>()

function createTokenSpy() {
  return spyOn(token, "ensureCopilotToken")
}

function catalog(endpoint: string): ModelsResponse {
  return {
    object: "list",
    data: [
      {
        id: "gpt-5.6-luna",
        name: "Synthetic loopback model",
        object: "model",
        version: "synthetic",
        vendor: "synthetic",
        preview: false,
        model_picker_enabled: true,
        supported_endpoints: [endpoint],
        capabilities: {
          object: "model_capabilities",
          family: "gpt-5.6-luna",
          type: "chat",
          tokenizer: "o200k_base",
          limits: { max_prompt_tokens: 131072, max_output_tokens: 2048 },
          supports: {
            streaming: true,
            tool_calls: true,
            reasoning_effort: ["low"],
          },
        },
      },
    ],
  }
}

beforeEach(() => {
  ensureToken = createTokenSpy().mockResolvedValue(undefined)
  state.copilotToken = "synthetic-only"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  state.accountType = "individual"
  state.manualApprove = false
  state.traceEnabled = false
  state.rateLimitSeconds = undefined
  state.models = catalog("/responses")
  calls = 0
  statuses = [400]
  bodyMode = "delayed"
  requestSignal = undefined
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const status = statuses[Math.min(calls++, statuses.length - 1)]
      let timer: ReturnType<typeof setTimeout> | undefined
      let closed = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const plain = bodyMode === "plain"
          controller.enqueue(encoder.encode(plain ? "synthetic " : '{"error":'))
          if (bodyMode === "stalled") return
          timer = setTimeout(() => {
            if (timer) bodyTimers.delete(timer)
            if (closed) return
            controller.enqueue(
              encoder.encode(
                plain ?
                  `upstream failure ${status}`
                : JSON.stringify({
                    message:
                      bodyMode === "oversized" ?
                        "x".repeat(20_000)
                      : `synthetic upstream failure ${status}`,
                    code: "synthetic_upstream_error",
                  }) + "}",
              ),
            )
            closed = true
            controller.close()
          }, 30)
          bodyTimers.add(timer)
        },
        cancel() {
          closed = true
          if (timer) {
            clearTimeout(timer)
            bodyTimers.delete(timer)
          }
        },
      })
      return new Response(body, {
        status,
        headers: {
          "content-type":
            bodyMode === "plain" ? "text/plain" : "application/json",
        },
      })
    },
  })
  globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const address = input instanceof Request ? input.url : String(input)
      const pathname = new URL(address).pathname
      if (
        !["/chat/completions", "/responses", "/v1/messages"].includes(pathname)
      )
        throw new Error("Unexpected non-fixture network request")
      requestSignal = init?.signal
      return originalFetch(
        `http://127.0.0.1:${upstream?.port}${pathname}`,
        init,
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  ensureToken.mockRestore()
  await upstream?.stop(true)
  for (const timer of bodyTimers) clearTimeout(timer)
  bodyTimers.clear()
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

function request(route: string, stream: boolean) {
  const body =
    route === "/v1/responses" ?
      { model: "gpt-5.6-luna", input: "Synthetic request", stream }
    : {
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "Synthetic request" }],
        max_tokens: 32,
        stream,
      }
  return server.request(`http://localhost${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json()
  if (typeof body !== "object" || body === null || !("error" in body))
    throw new Error("Expected an error response envelope")
  const error = body.error
  if (
    typeof error !== "object"
    || error === null
    || !("message" in error)
    || typeof error.message !== "string"
  )
    throw new Error("Expected a string error message")
  return error.message
}

test.each([false, true])(
  "native Responses HTTP errors retain status and body (stream=%s)",
  async (stream) => {
    const response = await request("/v1/responses", stream)
    expect(response.status).toBe(400)
    expect(await errorMessage(response)).toContain(
      "synthetic upstream failure 400",
    )
    expect(calls).toBe(1)
    expect(ensureToken).toHaveBeenCalledTimes(1)
    if (stream) expect(requestSignal?.aborted).toBe(true)
  },
)

test.each([
  ["/v1/messages", "/responses"],
  ["/v1/responses", "/chat/completions"],
  ["/v1/chat/completions", "/chat/completions"],
  ["/v1/messages", "/v1/messages"],
])(
  "streaming route %s via %s preserves upstream HTTP 400",
  async (route, endpoint) => {
    state.models = catalog(endpoint)
    const response = await request(route, true)
    expect(response.status).toBe(400)
    expect(await errorMessage(response)).toContain(
      "synthetic upstream failure 400",
    )
    expect(calls).toBe(1)
    expect(requestSignal?.aborted).toBe(true)
  },
)

test.each([429, 503])(
  "streaming upstream status %s is preserved without an extra attempt",
  async (status) => {
    statuses = [status]
    const response = await request("/v1/responses", true)
    expect(response.status).toBe(status)
    expect(await errorMessage(response)).toContain(
      `synthetic upstream failure ${status}`,
    )
    expect(calls).toBe(1)
  },
)

test("an authentication retry retains the second response's HTTP status and body", async () => {
  statuses = [401, 503]
  const response = await request("/v1/responses", true)
  expect(response.status).toBe(503)
  expect(await errorMessage(response)).toContain(
    "synthetic upstream failure 503",
  )
  expect(calls).toBe(2)
  expect(ensureToken).toHaveBeenCalledWith(true)
})

test("non-JSON error bodies remain readable after streaming cleanup", async () => {
  bodyMode = "plain"
  const response = await request("/v1/responses", true)
  expect(response.status).toBe(400)
  expect(await errorMessage(response)).toBe("synthetic upstream failure 400")
})

test.each(["oversized", "stalled"] as const)(
  "an %s error body stays bounded without masking the upstream status",
  async (mode) => {
    bodyMode = mode
    const response = await request("/v1/responses", true)
    expect(response.status).toBe(400)
    expect(await errorMessage(response)).toBe("Failed request to /responses")
    expect(calls).toBe(1)
    expect(requestSignal?.aborted).toBe(true)
  },
)

test("caller cancellation interrupts a pending error body with the original reason", async () => {
  bodyMode = "stalled"
  const caller = new AbortController()
  const reason = new DOMException("synthetic client left", "AbortError")
  const result = copilotFetch("/responses", { signal: caller.signal }).catch(
    (error: unknown) => error,
  )
  await Bun.sleep(30)
  caller.abort(reason)
  expect(await result).toBe(reason)
  expect(calls).toBe(1)
  expect(requestSignal?.aborted).toBe(true)
})
