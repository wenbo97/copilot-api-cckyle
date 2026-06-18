import { describe, test, expect, afterEach } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type { ResponseObject } from "../src/routes/responses/responses-types"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "../src/routes/messages/responses-translation"

// Catalog so clampReasoningEffort has effort sets to clamp against.
const fixtureModels = {
  object: "list",
  data: [
    {
      id: "gpt-5.3-codex",
      supported_endpoints: ["/responses"],
      capabilities: {
        supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
      },
    },
    {
      id: "gpt-5.5",
      supported_endpoints: ["/responses"],
      capabilities: {
        supports: {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
        },
      },
    },
  ],
} as unknown as ModelsResponse

describe("translateAnthropicToResponses (request)", () => {
  afterEach(() => {
    state.models = undefined
  })

  test("maps system -> instructions and string message -> input item", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 100,
      system: "You are terse.",
      messages: [{ role: "user", content: "hi" }],
    }
    const out = translateAnthropicToResponses(payload)
    expect(out.instructions).toBe("You are terse.")
    expect(out.max_output_tokens).toBe(100)
    expect(out.input).toEqual([{ role: "user", content: "hi" }])
  })

  test("flattens an array system prompt with blank lines", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      system: [
        { type: "text", text: "Line A" },
        { type: "text", text: "Line B" },
      ],
      messages: [{ role: "user", content: "hi" }],
    }
    expect(translateAnthropicToResponses(payload).instructions).toBe(
      "Line A\n\nLine B",
    )
  })

  test("maps tools (input_schema -> parameters) and tool_choice any -> required", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          input_schema: { type: "object", properties: { city: {} } },
        },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "hi" }],
    }
    const out = translateAnthropicToResponses(payload)
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Weather",
        parameters: { type: "object", properties: { city: {} } },
      },
    ])
    expect(out.tool_choice).toBe("required")
  })

  test("maps tool_result -> function_call_output and tool_use -> function_call", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "f", input: { a: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "result!" },
          ],
        },
      ],
    }
    const out = translateAnthropicToResponses(payload)
    const items = out.input as unknown as Array<Record<string, unknown>>
    expect(items[0]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "f",
      arguments: JSON.stringify({ a: 1 }),
    })
    expect(items[1]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "result!",
    })
  })

  test("maps thinking budget -> clamped reasoning.effort (codex max -> xhigh)", () => {
    state.models = fixtureModels
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.3-codex",
      max_tokens: 4000,
      // budget >= 95% of max_tokens => "max", which codex cannot accept.
      thinking: { type: "enabled", budget_tokens: 3900 },
      messages: [{ role: "user", content: "hi" }],
    }
    expect(translateAnthropicToResponses(payload).reasoning).toEqual({
      effort: "xhigh",
    })
  })

  test("omits reasoning when no thinking is requested", () => {
    state.models = fixtureModels
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    }
    expect(translateAnthropicToResponses(payload).reasoning).toBeUndefined()
  })

  test("drops thinking blocks (no replayed reasoning text)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "visible answer" },
          ],
        },
      ],
    }
    const out = translateAnthropicToResponses(payload)
    const items = out.input as Array<{ content?: Array<{ text?: string }> }>
    // Only the text survives; no item carries the thinking text.
    expect(JSON.stringify(out.input)).not.toContain("secret reasoning")
    expect(items[0].content?.[0].text).toBe("visible answer")
  })
})

describe("translateResponsesToAnthropic (response)", () => {
  const base = {
    id: "resp_1",
    object: "response" as const,
    created_at: 0,
    model: "gpt-5.5",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    error: null,
  }

  test("maps output_text -> text block, skips reasoning items", () => {
    const resp: ResponseObject = {
      ...base,
      status: "completed",
      output: [
        // reasoning item with encrypted/empty content -> must be skipped
        { type: "reasoning", id: "enc", content: [] } as never,
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
      ],
    }
    const out = translateResponsesToAnthropic(resp, "gpt-5.5")
    expect(out.content).toEqual([{ type: "text", text: "Hello" }])
    expect(out.stop_reason).toBe("end_turn")
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  test("maps function_call -> tool_use block and sets stop_reason tool_use", () => {
    const resp: ResponseObject = {
      ...base,
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_42",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        },
      ],
    }
    const out = translateResponsesToAnthropic(resp, "gpt-5.5")
    expect(out.content).toEqual([
      {
        type: "tool_use",
        id: "call_42",
        name: "get_weather",
        input: { city: "Paris" },
      },
    ])
    expect(out.stop_reason).toBe("tool_use")
  })

  test("maps incomplete status -> max_tokens stop reason", () => {
    const resp: ResponseObject = {
      ...base,
      status: "incomplete",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "partial", annotations: [] }],
        },
      ],
    }
    expect(translateResponsesToAnthropic(resp, "gpt-5.5").stop_reason).toBe(
      "max_tokens",
    )
  })
})
