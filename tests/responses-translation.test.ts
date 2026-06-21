import { describe, test, expect, afterEach } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type {
  ResponseObject,
  ResponseStreamState,
} from "../src/routes/responses/responses-types"
import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "../src/routes/messages/responses-stream-translation"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "../src/routes/messages/responses-translation"
import { translateToOpenAI } from "../src/routes/responses/non-stream-translation"
import { translateChunkToResponseEvents } from "../src/routes/responses/stream-translation"

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

  test("encodes assistant text as output_text and user text as input_text (multi-turn)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.5",
      max_tokens: 50,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello there" }],
        },
        { role: "user", content: [{ type: "text", text: "who are you?" }] },
      ],
    }
    const out = translateAnthropicToResponses(payload)
    const items = out.input as Array<{
      role: string
      content: Array<{ type: string; text: string }>
    }>
    // Responses API rule: user/system/developer content parts use input_text;
    // assistant content parts must use output_text (input_text -> 400). This is
    // why every conversation past the first turn failed before the fix.
    expect(items[0].content[0].type).toBe("input_text")
    expect(items[1].content[0].type).toBe("output_text")
    expect(items[2].content[0].type).toBe("input_text")
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

// =============================================================================
// CHARACTERIZATION TESTS (T1) — lock CURRENT behavior before the de-dup (T3).
//
// These pin the exact output of translateTools / translateToolChoice (both the
// Anthropic->Responses copy and the Responses->Chat copy) and deriveStopReason
// (both the non-stream and the stream copy). They MUST keep passing verbatim
// through the de-dup so we can prove it is behavior-preserving. Do NOT relax
// them when wiring the shared primitives.
// =============================================================================

const charToolsOf = (tools: AnthropicMessagesPayload["tools"]) =>
  translateAnthropicToResponses({
    model: "gpt-5.5",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tools,
  }).tools

const charChoiceOf = (tc: AnthropicMessagesPayload["tool_choice"]) =>
  translateAnthropicToResponses({
    model: "gpt-5.5",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: tc,
  }).tool_choice

const charRespCompleted = (
  status: ResponseObject["status"],
): ResponseObject => ({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-5.5",
  status,
  output: [],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  error: null,
})

const charStopReasonFromStream = (
  events: ReturnType<typeof translateResponsesEventToAnthropicEvents>,
) => {
  const delta = events.find((e) => e.type === "message_delta") as
    | { type: "message_delta"; delta: { stop_reason?: string } }
    | undefined
  return delta?.delta.stop_reason
}

describe("CHARACTERIZATION: translateTools (Anthropic -> Responses)", () => {
  afterEach(() => {
    state.models = undefined
  })

  const toolsOf = charToolsOf

  test("name/description/input_schema -> function/name/description/parameters", () => {
    expect(
      toolsOf([
        {
          name: "get_weather",
          description: "d",
          input_schema: { type: "object" },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "d",
        parameters: { type: "object" },
      },
    ])
  })

  test("undefined tools -> undefined", () => {
    expect(toolsOf(undefined)).toBeUndefined()
  })

  test("empty tools array -> undefined", () => {
    expect(toolsOf([])).toBeUndefined()
  })

  test("missing description is carried through as undefined", () => {
    expect(toolsOf([{ name: "t", input_schema: { type: "object" } }])).toEqual([
      {
        type: "function",
        name: "t",
        description: undefined,
        parameters: { type: "object" },
      },
    ])
  })
})

describe("CHARACTERIZATION: translateToolChoice (Anthropic -> Responses)", () => {
  afterEach(() => {
    state.models = undefined
  })

  const choiceOf = charChoiceOf

  test("undefined -> undefined", () => {
    expect(choiceOf(undefined)).toBeUndefined()
  })
  test("auto -> auto", () => {
    expect(choiceOf({ type: "auto" })).toBe("auto")
  })
  test("any -> required", () => {
    expect(choiceOf({ type: "any" })).toBe("required")
  })
  test("none -> none", () => {
    expect(choiceOf({ type: "none" })).toBe("none")
  })
  test("tool with name -> { type: function, name }", () => {
    expect(choiceOf({ type: "tool", name: "x" })).toEqual({
      type: "function",
      name: "x",
    })
  })
  test("tool without name -> auto (fallback)", () => {
    expect(choiceOf({ type: "tool" })).toBe("auto")
  })
})

describe("CHARACTERIZATION: deriveStopReason (non-stream, via translateResponsesToAnthropic)", () => {
  const base = {
    id: "resp_1",
    object: "response" as const,
    created_at: 0,
    model: "gpt-5.5",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    error: null,
  }
  const stopReasonFor = (
    status: ResponseObject["status"],
    output: ResponseObject["output"],
  ) =>
    translateResponsesToAnthropic({ ...base, status, output }, "gpt-5.5")
      .stop_reason

  test("plain completed text -> end_turn", () => {
    expect(
      stopReasonFor("completed", [
        {
          type: "message",
          id: "m",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
      ]),
    ).toBe("end_turn")
  })
  test("has function_call -> tool_use (wins over status)", () => {
    expect(
      stopReasonFor("incomplete", [
        {
          type: "function_call",
          id: "fc",
          call_id: "c",
          name: "f",
          arguments: "{}",
          status: "completed",
        },
      ]),
    ).toBe("tool_use")
  })
  test("incomplete, no tool -> max_tokens", () => {
    expect(
      stopReasonFor("incomplete", [
        {
          type: "message",
          id: "m",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "x", annotations: [] }],
        },
      ]),
    ).toBe("max_tokens")
  })
})

describe("CHARACTERIZATION: deriveStopReason (stream, via Responses->Anthropic events)", () => {
  const respCompleted = charRespCompleted
  const stopReasonFromStream = charStopReasonFromStream

  test("no tool call, completed -> end_turn", () => {
    const st = createResponsesToAnthropicState("gpt-5.5")
    const events = translateResponsesEventToAnthropicEvents(
      { type: "response.completed", response: respCompleted("completed") },
      st,
    )
    expect(stopReasonFromStream(events)).toBe("end_turn")
  })

  test("no tool call, incomplete -> max_tokens", () => {
    const st = createResponsesToAnthropicState("gpt-5.5")
    const events = translateResponsesEventToAnthropicEvents(
      { type: "response.completed", response: respCompleted("incomplete") },
      st,
    )
    expect(stopReasonFromStream(events)).toBe("max_tokens")
  })

  test("function_call seen earlier -> tool_use (wins over status)", () => {
    const st = createResponsesToAnthropicState("gpt-5.5")
    translateResponsesEventToAnthropicEvents(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc",
          call_id: "c",
          name: "f",
          arguments: "",
          status: "completed",
        },
      },
      st,
    )
    const events = translateResponsesEventToAnthropicEvents(
      { type: "response.completed", response: respCompleted("incomplete") },
      st,
    )
    expect(stopReasonFromStream(events)).toBe("tool_use")
  })
})

describe("CHARACTERIZATION: translateToOpenAI tools/tool_choice (Responses -> Chat)", () => {
  test("Responses-shape tool (name/parameters) -> Chat function tool", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "d",
          parameters: { type: "object" },
        },
      ],
    })
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ])
  })

  test("already-Chat-shape tool ({ function: { name } }) passes through as-is", () => {
    const passthrough = {
      type: "function",
      function: { name: "f", parameters: { type: "object" } },
    }
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: "hi",
      tools: [passthrough as never],
    })
    expect(out.tools).toEqual([passthrough as never])
  })

  test("undefined tools -> undefined; empty list -> undefined", () => {
    expect(
      translateToOpenAI({ model: "claude-opus-4.8", input: "hi" }).tools,
    ).toBeUndefined()
    expect(
      translateToOpenAI({ model: "claude-opus-4.8", input: "hi", tools: [] })
        .tools,
    ).toBeUndefined()
  })

  test("tool_choice: string required passes; object -> { type: function, function: { name } }", () => {
    expect(
      translateToOpenAI({
        model: "claude-opus-4.8",
        input: "hi",
        tool_choice: "required",
      }).tool_choice,
    ).toBe("required")
    expect(
      translateToOpenAI({
        model: "claude-opus-4.8",
        input: "hi",
        tool_choice: { type: "function", name: "x" },
      }).tool_choice,
    ).toEqual({ type: "function", function: { name: "x" } })
  })
})

describe("CHARACTERIZATION: translateToOpenAI message routing (stable parts, pre-T4)", () => {
  test("instructions -> leading system message; string input -> user message", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: "hello",
      instructions: "be terse",
    })
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" })
    expect(out.messages[1]).toEqual({ role: "user", content: "hello" })
  })

  test("function_call_output -> role:tool message (unchanged by T4)", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: [
        { type: "function_call_output", call_id: "c1", output: "ok" } as never,
      ],
    })
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ])
  })

  test("developer role -> system; user/assistant text preserved", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: [
        { role: "developer", content: "dev note" },
        { role: "user", content: [{ type: "input_text", text: "q" }] },
        { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      ],
    })
    expect(out.messages[0]).toEqual({ role: "system", content: "dev note" })
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "q" }],
    })
    expect(out.messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "a" }],
    })
  })
})

// =============================================================================
// T4: function_call vs function_call_output disambiguation.
//
// Both Responses input items carry `call_id`, so the old `"call_id" in item`
// discriminator misrouted an assistant `function_call` (a tool *invocation*) as
// a `role: "tool"` result. A function_call must become an assistant message with
// `tool_calls`; only the function_call_output becomes a `role: "tool"` message.
// =============================================================================

describe("translateToOpenAI: function_call vs function_call_output (T4)", () => {
  test("function_call input item is NOT misrouted as a tool result", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "f",
          arguments: "{}",
        } as never,
        { type: "function_call_output", call_id: "c1", output: "ok" } as never,
      ],
    })
    // Exactly one role:tool message (the output), never two.
    const toolMsgs = out.messages.filter((m) => m.role === "tool")
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
    })
  })

  test("function_call becomes an assistant tool_calls message", () => {
    const out = translateToOpenAI({
      model: "claude-opus-4.8",
      input: [
        {
          type: "function_call",
          call_id: "call_42",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        } as never,
      ],
    })
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_42",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ])
  })
})

// =============================================================================
// T8: Chat-Completions stream -> Responses stream P2 fixes.
//
// (a) A tool call must emit a terminal `response.output_item.done` so strict
//     Responses clients can close the function_call item.
// (b) When the turn produced NO assistant text, we must NOT emit empty
//     `response.output_text.done` / `response.content_part.done` frames — they
//     reference an output item / content part that was never opened.
// =============================================================================

const freshStreamState = (): ResponseStreamState => ({
  responseId: "",
  model: "",
  outputItemIndex: 0,
  contentPartIndex: 0,
  messageStarted: false,
  toolCalls: {},
})

const chunkOf = (
  choice: Partial<ChatCompletionChunk["choices"][number]>,
): ChatCompletionChunk =>
  ({
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    created: 0,
    model: "claude-opus-4.8",
    choices: [
      { index: 0, delta: {}, finish_reason: null, logprobs: null, ...choice },
    ],
  }) as ChatCompletionChunk

describe("translateChunkToResponseEvents: tool-call done + empty .done (T8)", () => {
  test("a tool call emits response.output_item.done on finish", () => {
    const state = freshStreamState()
    const events = [
      ...translateChunkToResponseEvents(
        chunkOf({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
        }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunkOf({ delta: {}, finish_reason: "tool_calls" }),
        state,
      ),
    ]

    const done = events.filter((e) => e.type === "response.output_item.done")
    expect(done.length).toBe(1)
    const item = (
      done[0] as {
        item: { type: string; call_id: string; arguments: string }
      }
    ).item
    expect(item.type).toBe("function_call")
    expect(item.call_id).toBe("call_1")
    // The done item carries the FULL accumulated arguments (not empty).
    expect(item.arguments).toBe('{"city":"NYC"}')
  })

  test("no empty output_text.done / content_part.done when there was no text", () => {
    const state = freshStreamState()
    const events = [
      ...translateChunkToResponseEvents(
        chunkOf({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
        }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunkOf({ delta: {}, finish_reason: "tool_calls" }),
        state,
      ),
    ]

    expect(events.some((e) => e.type === "response.output_text.done")).toBe(
      false,
    )
    expect(events.some((e) => e.type === "response.content_part.done")).toBe(
      false,
    )
  })

  test("a text turn still emits its output_text.done + content_part.done", () => {
    const state = freshStreamState()
    const events = [
      ...translateChunkToResponseEvents(
        chunkOf({ delta: { content: "hello" } }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunkOf({ delta: {}, finish_reason: "stop" }),
        state,
      ),
    ]
    expect(events.some((e) => e.type === "response.output_text.done")).toBe(
      true,
    )
    expect(events.some((e) => e.type === "response.content_part.done")).toBe(
      true,
    )
    // ...and the message item is closed.
    expect(events.some((e) => e.type === "response.output_item.done")).toBe(
      true,
    )
  })
})
