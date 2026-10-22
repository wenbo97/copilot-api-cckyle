import { expect, test } from "bun:test"

import { createToolNameMap, truncateToolName } from "~/routes/_shared/tool-name"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "~/routes/messages/responses-translation"

const originalName = "mcp__server__" + "long_tool_name_".repeat(6)

test("shortens history tool names even when their definition is absent", () => {
  const payload = translateAnthropicToResponses({
    model: "gpt-5.5",
    max_tokens: 100,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c", name: originalName, input: {} }],
      },
    ],
  })
  expect(payload.input).toEqual([
    {
      type: "function_call",
      call_id: "c",
      name: truncateToolName(originalName),
      arguments: "{}",
    },
  ])
})

test("restores original JSON and streaming tool names using only the current request", () => {
  const map = createToolNameMap({
    model: "gpt-5.5",
    max_tokens: 100,
    tools: [{ name: originalName, input_schema: {} }],
    messages: [],
  })
  const tool = {
    type: "function_call" as const,
    id: "f",
    call_id: "c",
    name: truncateToolName(originalName),
    arguments: "{}",
    status: "completed" as const,
  }
  const result = translateResponsesToAnthropic(
    {
      id: "r",
      object: "response",
      created_at: 0,
      model: "gpt-5.5",
      status: "completed",
      output: [tool],
    },
    "gpt-5.5",
    map,
  )
  expect(result.content).toEqual([
    { type: "tool_use", id: "c", name: originalName, input: {} },
  ])
  const state = createResponsesToAnthropicState("gpt-5.5", map)
  expect(
    translateResponsesEventToAnthropicEvents(
      { type: "response.output_item.added", output_index: 0, item: tool },
      state,
    ),
  ).toContainEqual({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "c", name: originalName, input: {} },
  })
  const separate = createResponsesToAnthropicState("gpt-5.5")
  expect(
    translateResponsesEventToAnthropicEvents(
      { type: "response.output_item.added", output_index: 0, item: tool },
      separate,
    ),
  ).toContainEqual({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "c", name: tool.name, input: {} },
  })
})
