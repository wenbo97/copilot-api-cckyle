import { test, expect, mock, beforeEach } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { createMessages } from "../src/services/copilot/create-messages"

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
    json: () => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
    }),
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

test("POSTs to the /v1/messages endpoint", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  expect(fetchMock).toHaveBeenCalled()
  const [url, opts] = callArgs()
  expect(url).toEndWith("/v1/messages")
  expect(opts.method).toBe("POST")
})

test("forwards the payload body unchanged", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 100,
    temperature: 0.5,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(JSON.parse(opts.body)).toEqual(payload)
})

test("defaults the anthropic-version header", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(opts.headers["anthropic-version"]).toBe("2023-06-01")
})

test("forwards the client anthropic-version + anthropic-beta headers", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, {
    anthropicVersion: "2025-01-01",
    anthropicBeta: "interleaved-thinking-2025-05-14",
  })
  const [, opts] = callArgs()
  expect(opts.headers["anthropic-version"]).toBe("2025-01-01")
  expect(opts.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
})

test("sets X-Initiator to user for a plain user prompt", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when an assistant turn is present", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "earlier turn" },
    ],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to agent when a tool_result block is present", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
      },
    ],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

test("sets copilot-vision-request when an image block is present", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAA",
            },
          },
        ],
      },
    ],
  }
  await createMessages(payload)
  const [, opts] = callArgs()
  expect(opts.headers["copilot-vision-request"]).toBe("true")
})
