import { test, expect, mock, beforeEach, describe } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"

import { state } from "../src/lib/state"
import {
  createResponses,
  sanitizeReasoningItem,
  stripEncryptedContentParts,
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

// Regression: a Codex sub-agent (skill) turn replays as an `agent_message` item
// carrying an `encrypted_content` content part. Copilot accepts it at schema
// level, fails to decrypt it, and kills the response with a bare
// `response.failed` (error: null) — Codex reports "stream disconnected before
// completion". Verified against the live backend: the same request goes green
// once the part is removed, and red again with a 3-byte ciphertext, so it is the
// part TYPE that is fatal, not its size.
describe("stripEncryptedContentParts", () => {
  const agentMessage = {
    type: "agent_message",
    id: "amsg_1",
    author: "/root/command_skills",
    recipient: "/root",
    content: [
      { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAABqar7I..." },
    ],
  }

  test("drops the encrypted part but keeps the item and its other fields", () => {
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [agentMessage],
    } as unknown as ResponsesPayload)

    const [item] = out.input as unknown as Array<Record<string, unknown>>
    expect(item.content).toEqual([
      { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
    ])
    expect(item.type).toBe("agent_message")
    expect(item.author).toBe("/root/command_skills")
  })

  test("drops an item whose only content part was the ciphertext", () => {
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [
        { ...agentMessage, content: [agentMessage.content[1]] },
        { role: "user", content: "hi" },
      ],
    } as unknown as ResponsesPayload)

    expect(out.input).toEqual([{ role: "user", content: "hi" }])
  })

  test("leaves the top-level encrypted_content FIELD on reasoning items alone", () => {
    const reasoning = {
      type: "reasoning",
      id: "r",
      encrypted_content: "COPILOT_BLOB",
      summary: [],
    }
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [reasoning],
    } as unknown as ResponsesPayload)

    expect(out.input).toEqual([
      reasoning,
    ] as unknown as ResponsesPayload["input"])
  })

  test("returns the payload untouched when no encrypted part is present", () => {
    const payload = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hi" }],
    } as unknown as ResponsesPayload

    expect(stripEncryptedContentParts(payload)).toBe(payload)
  })

  test("createResponses never puts an encrypted_content part on the wire", async () => {
    await createResponses({
      model: "gpt-5.6-sol",
      input: [agentMessage, { role: "user", content: "hi" }],
    } as unknown as ResponsesPayload)

    const [, opts] = callArgs()
    expect(opts.body).not.toContain("encrypted_content")
  })
})
