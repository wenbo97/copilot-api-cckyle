import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { createToolNameMap } from "~/routes/_shared/tool-name"
import { translateAnthropicToResponses } from "~/routes/messages/responses-translation"

const ephemeral = { type: "ephemeral" } as const
const tools = [
  {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
]
const system = [
  { type: "text", text: "billing header" },
  { type: "text", text: "You are Claude Code.", cache_control: ephemeral },
] as AnthropicMessagesPayload["system"]

const assistantTurn = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "plan", signature: "sig-1" },
    { type: "text", text: "Reading." },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.ts" } },
  ],
} as const

function egress(payload: AnthropicMessagesPayload) {
  return translateAnthropicToResponses(payload, createToolNameMap(payload))
}

// Claude Code moves its trailing cache_control marker to the newest message
// every turn. The bridge must still emit an append-only history.
test("Messages→Responses egress for turn N is a prefix of turn N+1", () => {
  const turnN = {
    model: "gpt-5.3-codex",
    max_tokens: 1000,
    system,
    tools,
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix a.ts" }] },
      assistantTurn,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file body",
            cache_control: ephemeral,
          },
        ],
      },
    ],
  } as AnthropicMessagesPayload
  const turnNext = {
    ...turnN,
    messages: [
      ...turnN.messages.slice(0, 2),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      {
        role: "user",
        content: [{ type: "text", text: "Thanks", cache_control: ephemeral }],
      },
    ],
  } as AnthropicMessagesPayload

  const first = egress(turnN)
  const second = egress(turnNext)
  expect(second.instructions).toEqual(first.instructions)
  expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
  const before = first.input as Array<unknown>
  const after = second.input as Array<unknown>
  expect(after.length).toBeGreaterThan(before.length)
  expect(JSON.stringify(after.slice(0, before.length))).toBe(
    JSON.stringify(before),
  )
})
