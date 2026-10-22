import { expect, test } from "bun:test"

import type { ResponseObject } from "~/routes/responses/responses-types"
import type { ResponseStreamEvent } from "~/routes/responses/responses-types"

import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "~/routes/messages/responses-stream-translation"
import { translateResponsesToAnthropic } from "~/routes/messages/responses-translation"
import {
  NativeResponsesStreamTracker,
  parseNativeResponsesSseData,
} from "~/routes/responses/stream-protocol"

const refusal = {
  id: "r",
  object: "response",
  created_at: 0,
  model: "gpt-5.5",
  status: "completed",
  output: [
    {
      type: "message",
      id: "m",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "I cannot help with that." }],
    },
  ],
} as unknown as ResponseObject

test("completed refusal content is visible and has refusal stop reason", () => {
  expect(translateResponsesToAnthropic(refusal, "gpt-5.5")).toMatchObject({
    content: [{ type: "text", text: "I cannot help with that." }],
    stop_reason: "refusal",
  })
})

test("native failure handles a refusal at a later content index without earlier deltas", () => {
  for (const includeEmptyPart of [false, true]) {
    const tracker = new NativeResponsesStreamTracker()
    const source = [
      {
        type: "response.created",
        response: { ...refusal, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "m",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      ...(includeEmptyPart ?
        [
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            item_id: "m",
            part: { type: "output_text", text: "" },
          },
        ]
      : []),
      {
        type: "response.refusal.delta",
        output_index: 0,
        content_index: 1,
        item_id: "m",
        delta: "Cannot ",
      },
      {
        type: "response.refusal.delta",
        output_index: 0,
        content_index: 1,
        item_id: "m",
        delta: "proceed.",
      },
    ]
    for (const event of source)
      tracker.observe(parseNativeResponsesSseData(JSON.stringify(event)))
    const failed = tracker
      .fail("Synthetic EOF")
      .find((event) => event.type === "response.failed")
    const item = failed?.response?.output[0]
    expect(item?.type === "message" ? item.content.at(-1) : undefined).toEqual({
      type: "refusal",
      refusal: "Cannot proceed.",
    })
  }
})

test("native stream failure snapshots retain refusal parts alongside ordinary text", () => {
  const tracker = new NativeResponsesStreamTracker()
  const source = [
    {
      type: "response.created",
      response: { ...refusal, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "m",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "m",
      delta: "Visible. ",
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      content_index: 1,
      item_id: "m",
      delta: "Cannot ",
    },
    {
      type: "response.refusal.done",
      output_index: 0,
      content_index: 1,
      item_id: "m",
      refusal: "Cannot proceed.",
    },
  ]
  for (const event of source)
    tracker.observe(parseNativeResponsesSseData(JSON.stringify(event)))
  const failed = tracker
    .fail("Synthetic EOF")
    .find((event) => event.type === "response.failed")
  expect(failed?.response?.output[0]).toMatchObject({
    content: [
      { type: "output_text", text: "Visible. " },
      { type: "refusal", refusal: "Cannot proceed." },
    ],
  })
})

test("mixed normal text and done-only refusals retain distinct content indices", () => {
  const state = createResponsesToAnthropicState("gpt-5.5")
  const source: Array<ResponseStreamEvent> = [
    {
      type: "response.created",
      response: { ...refusal, status: "in_progress", output: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Visible text. ",
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "Visible text. ",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "Visible text. " },
    },
    {
      type: "response.refusal.done",
      output_index: 0,
      content_index: 1,
      refusal: "Cannot proceed.",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 1,
      part: { type: "refusal", refusal: "Cannot proceed." },
    },
    {
      type: "response.content_part.done",
      output_index: 1,
      content_index: 0,
      part: { type: "refusal", refusal: "Another refusal." },
    },
    { type: "response.completed", response: { ...refusal, output: [] } },
  ]
  const events = source.flatMap((event) =>
    translateResponsesEventToAnthropicEvents(event, state),
  )
  expect(
    events.filter((event) => event.type === "content_block_delta"),
  ).toEqual([
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Visible text. " },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Cannot proceed." },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "Another refusal." },
    },
  ])
  expect(
    events.filter((event) => event.type === "content_block_stop"),
  ).toHaveLength(3)
  expect(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
  ).toBe("refusal")
})

test("failure and output limits override refusal while refusal overrides tools", () => {
  const tool = {
    type: "function_call" as const,
    id: "f",
    call_id: "c",
    name: "f",
    arguments: "{}",
    status: "completed" as const,
  }
  const cases: Array<[ResponseObject, "refusal" | "max_tokens"]> = [
    [{ ...refusal, output: [...refusal.output, tool] }, "refusal"],
    [
      {
        ...refusal,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      "max_tokens",
    ],
    [
      {
        ...refusal,
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
      "refusal",
    ],
  ]
  for (const [response, reason] of cases) {
    expect(translateResponsesToAnthropic(response, "gpt-5.5").stop_reason).toBe(
      reason,
    )
    const state = createResponsesToAnthropicState("gpt-5.5")
    translateResponsesEventToAnthropicEvents(
      {
        type: "response.refusal.delta",
        output_index: 0,
        content_index: 0,
        delta: "Cannot",
      },
      state,
    )
    const terminal = translateResponsesEventToAnthropicEvents(
      {
        type:
          response.status === "incomplete" ?
            "response.incomplete"
          : "response.completed",
        response,
      },
      state,
    )
    expect(
      terminal.find((event) => event.type === "message_delta")?.delta
        .stop_reason,
    ).toBe(reason)
  }
  const failed = {
    ...refusal,
    status: "failed" as const,
    error: { code: "server_error", message: "synthetic failure" },
  }
  expect(() => translateResponsesToAnthropic(failed, "gpt-5.5")).toThrow(
    "synthetic failure",
  )
  const events = translateResponsesEventToAnthropicEvents(
    { type: "response.failed", response: failed },
    createResponsesToAnthropicState("gpt-5.5"),
  )
  expect(events.map((event) => event.type)).toEqual(["error"])
})

test("refusal deltas and done events emit text exactly once before refusal finish", () => {
  const state = createResponsesToAnthropicState("gpt-5.5")
  const events = [
    ...translateResponsesEventToAnthropicEvents(
      {
        type: "response.created",
        response: { ...refusal, status: "in_progress", output: [] },
      },
      state,
    ),
    ...translateResponsesEventToAnthropicEvents(
      {
        type: "response.refusal.delta",
        output_index: 0,
        content_index: 0,
        delta: "I cannot ",
      },
      state,
    ),
    ...translateResponsesEventToAnthropicEvents(
      {
        type: "response.refusal.done",
        output_index: 0,
        content_index: 0,
        refusal: "I cannot help with that.",
      },
      state,
    ),
    ...translateResponsesEventToAnthropicEvents(
      {
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "refusal", refusal: "I cannot help with that." },
      },
      state,
    ),
    ...translateResponsesEventToAnthropicEvents(
      { type: "response.completed", response: refusal },
      state,
    ),
  ]
  expect(
    events
      .filter((event) => event.type === "content_block_delta")
      .map((event) =>
        event.delta.type === "text_delta" ? event.delta.text : "",
      )
      .join(""),
  ).toBe("I cannot help with that.")
  expect(
    events.filter((event) => event.type === "content_block_start"),
  ).toHaveLength(1)
  expect(
    events.filter((event) => event.type === "content_block_stop"),
  ).toHaveLength(1)
  expect(events).toContainEqual({
    type: "message_delta",
    delta: { stop_reason: "refusal", stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: 0 },
  })
})
