import { test, expect, mock, beforeEach, describe } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"

import { state } from "../src/lib/state"
import {
  createResponses,
  sanitizeReasoningItem,
} from "../src/services/copilot/create-responses"

// Mock state so copilotFetch's ensureCopilotToken() short-circuits (valid,
// non-expiring token) and we never hit the real token-refresh path.
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600

const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => ({
    ok: true,
    status: 200,
    json: () => ({ id: "resp_1", object: "response", output: [] }),
    headers: opts.headers,
  }),
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
})

const callArgs = () =>
  fetchMock.mock.calls[0] as unknown as [
    string,
    { headers: Record<string, string>; body: string; method: string },
  ]

test("POSTs to the /responses endpoint", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: "hello",
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const [url, opts] = callArgs()
  expect(url).toEndWith("/responses")
  expect(opts.method).toBe("POST")
})

test("forwards the payload body unchanged", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.5",
    input: "hi",
    temperature: 0.5,
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(JSON.parse(opts.body)).toEqual(payload)
})

test("sets X-Initiator to user for a plain user request", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: [{ role: "user", content: "hi" }],
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when an assistant message is present", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "previous turn" },
    ],
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to agent when a function_call_output is present", async () => {
  const payload = {
    model: "gpt-5.3-codex",
    input: [
      { role: "user", content: "hi" },
      { type: "function_call_output", call_id: "c1", output: "42" },
    ],
  } as ResponsesPayload
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

describe("sanitizeReasoningItem (litellm port)", () => {
  test("preserves encrypted_content; drops status:null", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: null,
      encrypted_content: "BLOB",
      content: [],
    })
    expect(cleaned.encrypted_content).toBe("BLOB")
    expect("status" in cleaned).toBe(false)
  })

  test("keeps a non-null status", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: "completed",
      encrypted_content: "BLOB",
    })
    expect(cleaned.status).toBe("completed")
  })

  test("drops other null fields but keeps non-null ones", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      encrypted_content: "BLOB",
      summary: null,
      content: [{ type: "reasoning_text", text: "x" }],
    })
    expect("summary" in cleaned).toBe(false)
    expect(cleaned.content).toEqual([{ type: "reasoning_text", text: "x" }])
    expect(cleaned.type).toBe("reasoning")
    expect(cleaned.id).toBe("r")
  })

  test("omits encrypted_content when it is absent (does not invent a key)", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: "completed",
    })
    expect("encrypted_content" in cleaned).toBe(false)
  })
})
