import { afterEach, beforeEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponseInputReasoning,
  ResponseObject,
} from "~/routes/responses/responses-types"

import { stripBridgeReasoning } from "~/routes/messages/bridge-reasoning"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "~/routes/messages/responses-translation"

const previous = process.env.COPILOT_BRIDGE_REASONING
beforeEach(() => {
  process.env.COPILOT_BRIDGE_REASONING = "1"
})
afterEach(() => {
  if (previous === undefined) delete process.env.COPILOT_BRIDGE_REASONING
  else process.env.COPILOT_BRIDGE_REASONING = previous
})

const reasoning: ResponseInputReasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "opaque-cipher",
}

function response(): ResponseObject {
  return {
    id: "resp_1",
    object: "response",
    model: "gpt-6.1-sol",
    status: "completed",
    output: [
      reasoning,
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "Read",
        arguments: "{}",
      },
    ],
  } as unknown as ResponseObject
}

test("encrypted reasoning round-trips through Claude Code history", () => {
  const anthropic = translateResponsesToAnthropic(response(), "gpt-6.1-sol")
  expect(anthropic.content[0].type).toBe("redacted_thinking")

  const next = translateAnthropicToResponses({
    model: "gpt-6.1-sol",
    max_tokens: 100,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: anthropic.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }],
      },
    ],
  })
  expect(next.input[1]).toEqual(reasoning)
  expect(next.input[2]).toMatchObject({
    type: "function_call",
    call_id: "call_1",
  })
})

test("stream emits reasoning as a complete redacted_thinking block", () => {
  const state = createResponsesToAnthropicState("gpt-6.1-sol")
  const events = translateResponsesEventToAnthropicEvents(
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoning, id: "rs_1", content: [] },
    },
    state,
  )
  expect(events).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "redacted_thinking",
        data: expect.stringContaining("opaque-cipher") as unknown as string,
      },
    },
    { type: "content_block_stop", index: 0 },
  ])
})

test("reasoning is on by default and dropped when the env flag is off", () => {
  delete process.env.COPILOT_BRIDGE_REASONING
  expect(
    translateResponsesToAnthropic(response(), "gpt-6.1-sol").content.map(
      (block) => block.type,
    ),
  ).toEqual(["redacted_thinking", "tool_use"])
  process.env.COPILOT_BRIDGE_REASONING = "0"
  const anthropic = translateResponsesToAnthropic(response(), "gpt-6.1-sol")
  expect(anthropic.content.map((block) => block.type)).toEqual(["tool_use"])
})

test("non-Responses egress strips only bridge reasoning blocks", () => {
  const [bridge] = translateResponsesToAnthropic(
    response(),
    "gpt-6.1-sol",
  ).content
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    max_tokens: 100,
    messages: [
      {
        role: "assistant",
        content: [
          bridge,
          { type: "redacted_thinking", data: "anthropic-native" },
          { type: "text", text: "hi" },
        ],
      },
    ],
  }
  expect(stripBridgeReasoning(payload).messages[0].content).toEqual([
    { type: "redacted_thinking", data: "anthropic-native" },
    { type: "text", text: "hi" },
  ])
})
