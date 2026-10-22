import { expect, test } from "bun:test"

import type {
  ResponseObject,
  ResponseStreamEvent,
} from "~/routes/responses/responses-types"

import { createToolNameMap, truncateToolName } from "~/routes/_shared/tool-name"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "~/routes/messages/responses-stream-translation"
import { translateResponsesToAnthropic } from "~/routes/messages/responses-translation"

const originalName = `mcp__refusal__${"name_boundary_".repeat(6)}`
const names = createToolNameMap({
  model: "offline",
  max_tokens: 20,
  tools: [{ name: originalName, input_schema: { type: "object" } }],
  messages: [],
})
const message = {
  type: "message",
  id: "msg_refusal",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "before", annotations: [] },
    { type: "refusal", refusal: "cannot" },
  ],
}
const tool = {
  type: "function_call",
  id: "fc_refusal",
  call_id: "call_refusal",
  name: truncateToolName(originalName),
  arguments: "{}",
  status: "completed",
}

function snapshot(status: string, reason?: string): ResponseObject {
  return {
    id: "resp_refusal",
    object: "response",
    created_at: 1,
    model: "offline",
    status,
    output: [message, tool],
    ...(reason ? { incomplete_details: { reason } } : {}),
    ...(status === "failed" ?
      { error: { code: "broken", message: "independent upstream failure" } }
    : {}),
  } as unknown as ResponseObject
}

function stream(status: string, reason?: string) {
  const state = createResponsesToAnthropicState("offline", names)
  const frames: Array<unknown> = [
    {
      type: "response.created",
      response: { ...snapshot("in_progress"), output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "before",
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "before",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: message.content[0],
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 1,
      part: { type: "refusal", refusal: "" },
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      content_index: 1,
      delta: "can",
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      content_index: 1,
      delta: "not",
    },
    {
      type: "response.refusal.done",
      output_index: 0,
      content_index: 1,
      refusal: "cannot",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 1,
      part: message.content[1],
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...tool, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: "{}",
    },
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: `response.${status}`, response: snapshot(status, reason) },
    { type: `response.${status}`, response: snapshot(status, reason) },
  ]
  return frames.flatMap((frame) =>
    translateResponsesEventToAnthropicEvents(
      frame as ResponseStreamEvent,
      state,
    ),
  )
}

test.each([
  { status: "completed", reason: undefined, stop: "refusal" as const },
  {
    status: "incomplete",
    reason: "max_output_tokens",
    stop: "max_tokens" as const,
  },
  { status: "incomplete", reason: "content_filter", stop: "refusal" as const },
])(
  "independent refusal JSON/SSE parity and terminal precedence: $status/$reason",
  ({ status, reason, stop }) => {
    const json = translateResponsesToAnthropic(
      snapshot(status, reason),
      "offline",
      names,
    )
    expect(json.stop_reason).toBe(stop)
    expect(json.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "cannot" },
      { type: "tool_use", id: "call_refusal", name: originalName, input: {} },
    ])
    const events = stream(status, reason)
    const starts = events.filter(
      (event) => event.type === "content_block_start",
    )
    expect(starts).toHaveLength(3)
    expect(starts.map((event) => event.index)).toEqual([0, 1, 2])
    expect(
      events
        .filter((event) => event.type === "content_block_stop")
        .map((event) => event.index),
    ).toEqual([0, 1, 2])
    const text = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          [event.delta.text]
        : [],
      )
      .join("")
    expect(text).toBe("beforecannot")
    expect(starts[2].content_block).toMatchObject({ name: originalName })
    const terminal = events.filter((event) => event.type === "message_delta")
    expect(terminal).toHaveLength(1)
    expect(terminal[0].delta.stop_reason).toBe(stop)
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("message_stop")
  },
)

test("independent refusal never masks upstream failure in JSON or SSE", () => {
  expect(() =>
    translateResponsesToAnthropic(snapshot("failed"), "offline", names),
  ).toThrow("independent upstream failure")
  const events = stream("failed")
  expect(events.filter((event) => event.type === "error")).toHaveLength(1)
  expect(events.some((event) => event.type === "message_stop")).toBe(false)
  expect(events.some((event) => event.type === "message_delta")).toBe(false)
})

test.each(["refusal.done", "content_part.done", "terminal-only"])(
  "independent refusal fallback emits missing text once: %s",
  (source) => {
    const state = createResponsesToAnthropicState("offline")
    const response = {
      ...snapshot("completed"),
      output: [
        { ...message, content: [{ type: "refusal", refusal: "cannot" }] },
      ],
    }
    const frames: Array<unknown> = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
    ]
    if (source === "refusal.done")
      frames.push({
        type: "response.refusal.done",
        output_index: 0,
        content_index: 0,
        refusal: "cannot",
      })
    if (source === "content_part.done")
      frames.push({
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "refusal", refusal: "cannot" },
      })
    frames.push({ type: "response.completed", response })
    const events = frames.flatMap((frame) =>
      translateResponsesEventToAnthropicEvents(
        frame as ResponseStreamEvent,
        state,
      ),
    )
    expect(events[0].type).toBe("message_start")
    expect(
      events
        .flatMap((event) =>
          (
            event.type === "content_block_delta"
            && event.delta.type === "text_delta"
          ) ?
            [event.delta.text]
          : [],
        )
        .join(""),
    ).toBe("cannot")
    expect(
      events.filter((event) => event.type === "content_block_start"),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "content_block_stop"),
    ).toHaveLength(1)
    expect(
      events
        .filter((event) => event.type === "message_delta")
        .map((event) => event.delta.stop_reason),
    ).toEqual(["refusal"])
    expect(events.at(-1)?.type).toBe("message_stop")
  },
)
