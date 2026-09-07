import { describe, expect, test } from "bun:test"

import type {
  ResponseStreamEvent,
  ResponseStreamState,
} from "../src/routes/responses/responses-types"
import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"

import { translateToResponses } from "../src/routes/responses/non-stream-translation"
import {
  translateChunkToResponseEvents,
  translateStreamFailureToResponseEvents,
} from "../src/routes/responses/stream-translation"

const freshState = (): ResponseStreamState => ({
  responseId: "",
  model: "gpt-4.1",
  outputItemIndex: 0,
  contentPartIndex: 0,
  messageStarted: false,
  toolCalls: {},
})

const chunk = (
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: "chatcmpl_state",
  object: "chat.completion.chunk",
  created: 1_700_000_000,
  model: "gpt-4.1",
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
      logprobs: null,
    },
  ],
})

const findTerminal = (
  events: Array<ResponseStreamEvent>,
): Extract<
  ResponseStreamEvent,
  {
    type: "response.completed" | "response.incomplete" | "response.failed"
  }
> => {
  const terminal = events.find((event) =>
    ["response.completed", "response.failed", "response.incomplete"].includes(
      event.type,
    ),
  )
  if (
    terminal?.type !== "response.completed"
    && terminal?.type !== "response.incomplete"
    && terminal?.type !== "response.failed"
  ) {
    throw new Error("expected terminal event")
  }
  return terminal
}

describe("synthetic Responses stream state machine", () => {
  test("buffers split tool metadata and argument deltas without crashing", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { arguments: '{"city"' },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { name: "get_weather", arguments: ':"Paris"}' },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const added = events.find(
      (event) => event.type === "response.output_item.added",
    )
    expect(added?.type).toBe("response.output_item.added")
    if (added?.type !== "response.output_item.added")
      throw new Error("missing output item")
    expect(added.item).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      status: "in_progress",
    })

    const deltas = events.filter(
      (event) => event.type === "response.function_call_arguments.delta",
    )
    expect(deltas.map((event) => event.delta)).toEqual(['{"city"', ':"Paris"}'])
    expect(deltas.every((event) => event.item_id === added.item.id)).toBe(true)

    const terminal = findTerminal(events)
    expect(terminal.type).toBe("response.completed")
    expect(terminal.response.output).toEqual([
      {
        type: "function_call",
        id: added.item.id,
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
        status: "completed",
      },
    ])
  })

  test("joins a function name split across tool-call frames", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "get_" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { name: "weather", arguments: "{}" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const added = events.find(
      (event) => event.type === "response.output_item.added",
    )
    expect(added).toMatchObject({
      item: { type: "function_call", name: "get_weather" },
    })
    expect(findTerminal(events).type).toBe("response.completed")
  })

  test("emits argument deltas that arrive after the tool item is open", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "lookup", arguments: "{" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"query":"weather"}' },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const deltas = events.filter(
      (event) => event.type === "response.function_call_arguments.delta",
    )
    expect(deltas.map((event) => event.delta)).toEqual([
      "{",
      '"query":"weather"}',
    ])
  })

  test("keeps distinct identity and output for multiple tool calls", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "first", arguments: '{"a":1}' },
            },
            {
              index: 1,
              id: "call_2",
              function: { name: "second", arguments: '{"b":2}' },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const added = events.filter(
      (event) => event.type === "response.output_item.added",
    )
    expect(added.map((event) => [event.output_index, event.item.id])).toEqual([
      [0, "fc_call_1"],
      [1, "fc_call_2"],
    ])
    expect(findTerminal(events).response.output).toMatchObject([
      { call_id: "call_1", name: "first", arguments: '{"a":1}' },
      { call_id: "call_2", name: "second", arguments: '{"b":2}' },
    ])
  })
})

describe("synthetic Responses output ordering", () => {
  test("preserves first-seen output order when a tool precedes text", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({ content: "after" }), state),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const addedIndexes = events
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => event.output_index)
    expect(addedIndexes).toEqual([0, 1])
    expect(
      findTerminal(events).response.output.map((item) => item.type),
    ).toEqual(["function_call", "message"])
  })

  test("preserves first-seen output order when text precedes a tool", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(chunk({ content: "before" }), state),
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    expect(
      findTerminal(events).response.output.map((item) => item.type),
    ).toEqual(["message", "function_call"])
  })

  test("assigns output indexes when items open, not when partial tool data appears", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { arguments: "{}" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({ content: "first" }), state),
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { name: "lookup" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const added = events.filter(
      (event) => event.type === "response.output_item.added",
    )
    expect(added.map((event) => [event.output_index, event.item.type])).toEqual(
      [
        [0, "message"],
        [1, "function_call"],
      ],
    )
    expect(
      findTerminal(events).response.output.map((item) => item.type),
    ).toEqual(["message", "function_call"])
  })
})

describe("synthetic Responses stream terminal state", () => {
  test.each([
    { finishReason: "length", reason: "max_output_tokens" },
    { finishReason: "content_filter", reason: "content_filter" },
  ] as const)(
    "maps finish reason to response.incomplete",
    ({ finishReason, reason }) => {
      const state = freshState()
      const events = [
        ...translateChunkToResponseEvents(chunk({ content: "partial" }), state),
        ...translateChunkToResponseEvents(chunk({}, finishReason), state),
      ]

      const terminal = findTerminal(events)
      expect(terminal.type).toBe("response.incomplete")
      expect(terminal.response.status).toBe("incomplete")
      expect(terminal.response.incomplete_details).toEqual({ reason })
      expect(terminal.response.output[0]).toMatchObject({
        type: "message",
        status: "incomplete",
      })
    },
  )

  test("emits one terminal event even if finish is repeated", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(chunk({ content: "done" }), state),
      ...translateChunkToResponseEvents(chunk({}, "stop"), state),
      ...translateChunkToResponseEvents(chunk({}, "stop"), state),
    ]

    expect(
      events.filter((event) =>
        [
          "response.completed",
          "response.failed",
          "response.incomplete",
        ].includes(event.type),
      ),
    ).toHaveLength(1)
  })

  test("turns incomplete tool identity into response.failed", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_missing_name",
              function: { arguments: "{}" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToResponseEvents(chunk({}, "tool_calls"), state),
    ]

    const terminal = findTerminal(events)
    expect(terminal.type).toBe("response.failed")
    expect(terminal.response.status).toBe("failed")
    expect(terminal.response.error?.code).toBe("invalid_upstream_response")
  })

  test("turns an unknown finish reason into response.failed", () => {
    const state = freshState()
    const malformed = chunk({ content: "partial" }) as unknown as {
      choices: Array<{ finish_reason: string }>
    }
    malformed.choices[0].finish_reason = "future_reason"

    const terminal = findTerminal(
      translateChunkToResponseEvents(malformed as ChatCompletionChunk, state),
    )
    expect(terminal.type).toBe("response.failed")
    expect(terminal.response.error?.code).toBe("invalid_upstream_response")
  })

  test("uses every integer sequence number once", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(chunk({ content: "a" }), state),
      ...translateChunkToResponseEvents(chunk({ content: "b" }), state),
      ...translateChunkToResponseEvents(chunk({}, "stop"), state),
    ]
    const sequenceNumbers = events.map((event) => event.sequence_number)
    expect(sequenceNumbers).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    )
  })
})

describe("synthetic non-streaming Responses terminal state", () => {
  test.each([
    { finishReason: "length", reason: "max_output_tokens" },
    { finishReason: "content_filter", reason: "content_filter" },
  ] as const)(
    "maps finish reason to an incomplete response",
    ({ finishReason, reason }) => {
      const response = translateToResponses({
        id: "chatcmpl_non_stream",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "partial" },
            logprobs: null,
            finish_reason: finishReason,
          },
        ],
      })

      expect(response.status).toBe("incomplete")
      expect(response.incomplete_details).toEqual({ reason })
      expect(response.output[0]).toMatchObject({
        type: "message",
        status: "incomplete",
      })
    },
  )

  test("maps an unknown upstream finish reason to a failed response", () => {
    const response = translateToResponses({
      id: "chatcmpl_non_stream",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-4.1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "partial" },
          logprobs: null,
          finish_reason: "future_reason",
        },
      ],
    } as never)

    expect(response.status).toBe("failed")
    expect(response.error).toMatchObject({
      code: "invalid_upstream_response",
      type: "server_error",
    })
    expect(response.output[0]).toMatchObject({ status: "incomplete" })
  })

  test("maps a missing upstream choice to a failed response", () => {
    const response = translateToResponses({
      id: "chatcmpl_non_stream",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-4.1",
      choices: [],
    })

    expect(response).toMatchObject({
      status: "failed",
      output: [],
      error: { code: "invalid_upstream_response" },
    })
  })
})

describe("synthetic Responses transport failures", () => {
  test("emits an official error event when failure happens before response.created", () => {
    const events = translateStreamFailureToResponseEvents(
      "Malformed upstream SSE JSON.",
      freshState(),
    )

    expect(events).toEqual([
      {
        type: "error",
        sequence_number: 1,
        code: "invalid_upstream_response",
        message: "Malformed upstream SSE JSON.",
        param: null,
      },
    ])
  })

  test("closes accumulated output and emits one response.failed after creation", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(chunk({ content: "partial" }), state),
      ...translateStreamFailureToResponseEvents(
        "Upstream stream truncated.",
        state,
      ),
      ...translateStreamFailureToResponseEvents("duplicate", state),
    ]

    const terminals = events.filter((event) => event.type === "response.failed")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      response: {
        status: "failed",
        output: [
          {
            type: "message",
            status: "incomplete",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
        error: {
          code: "invalid_upstream_response",
          message: "Upstream stream truncated.",
        },
      },
    })
  })
})
