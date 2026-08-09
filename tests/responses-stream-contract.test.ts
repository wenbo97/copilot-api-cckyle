import { describe, expect, test } from "bun:test"

import type { ResponseStreamState } from "../src/routes/responses/responses-types"
import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"

import { translateChunkToResponseEvents } from "../src/routes/responses/stream-translation"

const freshState = (): ResponseStreamState => ({
  responseId: "",
  model: "gpt-4o",
  outputItemIndex: 0,
  contentPartIndex: 0,
  messageStarted: false,
  toolCalls: {},
})

const chunk = (
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: "chatcmpl_contract",
  object: "chat.completion.chunk",
  created: 1_700_000_000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
      logprobs: null,
    },
  ],
})

describe("synthetic Responses streaming contract", () => {
  test("emits an ordered text lifecycle with stable identity and full terminal output", () => {
    const state = freshState()
    const events = [
      ...translateChunkToResponseEvents(chunk({ content: "hello" }), state),
      ...translateChunkToResponseEvents(chunk({}, "stop"), state),
    ]

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events.map((event) => event.sequence_number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])

    const created = events[0]
    expect(created.type).toBe("response.created")
    if (created.type !== "response.created") throw new Error("unexpected event")
    expect(created.response.status).toBe("in_progress")

    const added = events[2]
    expect(added.type).toBe("response.output_item.added")
    if (added.type !== "response.output_item.added")
      throw new Error("unexpected event")
    expect(added.item.status).toBe("in_progress")
    expect(added.item).toMatchObject({ type: "message", content: [] })

    const itemId = added.item.id
    for (const event of events.slice(3, 7)) {
      expect("item_id" in event ? event.item_id : undefined).toBe(itemId)
    }
    const itemDone = events[7]
    expect(itemDone.type).toBe("response.output_item.done")
    if (itemDone.type !== "response.output_item.done")
      throw new Error("unexpected event")
    expect(itemDone.item.id).toBe(itemId)

    const terminal = events.at(-1)
    expect(terminal?.type).toBe("response.completed")
    if (terminal?.type !== "response.completed")
      throw new Error("unexpected terminal event")
    expect(terminal.response.output).toEqual([
      {
        id: itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ])
  })
})
