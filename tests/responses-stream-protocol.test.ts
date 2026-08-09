import { describe, expect, test } from "bun:test"

import {
  NativeResponsesStreamTracker,
  parseChatCompletionSseData,
  parseNativeResponsesSseData,
} from "../src/routes/responses/stream-protocol"

describe("Responses upstream SSE protocol guard", () => {
  test("accepts a valid Chat chunk and rejects malformed JSON or shape", () => {
    expect(
      parseChatCompletionSseData(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
      ).choices[0].delta.content,
    ).toBe("hello")

    expect(() => parseChatCompletionSseData("{")).toThrow("invalid JSON")
    expect(() => parseChatCompletionSseData('{"type":"not-a-chunk"}')).toThrow(
      "invalid Chat Completions chunk",
    )
    expect(() =>
      parseChatCompletionSseData(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4.1",
          choices: [{ index: 0, delta: {}, finish_reason: "unknown_reason" }],
        }),
      ),
    ).toThrow("invalid Chat Completions chunk")
  })

  test("accepts Copilot Chat chunks that omit object and non-terminal finish_reason", () => {
    expect(
      parseChatCompletionSseData(
        JSON.stringify({
          id: "chatcmpl_copilot",
          created: 1,
          model: "gpt-4.1",
          choices: [],
          prompt_filter_results: [],
        }),
      ).choices,
    ).toEqual([])

    const chunk = parseChatCompletionSseData(
      JSON.stringify({
        id: "chatcmpl_copilot",
        created: 1,
        model: "gpt-4.1",
        choices: [{ index: 0, delta: { content: "hello" } }],
      }),
    )
    expect(chunk.object).toBeUndefined()
    expect(chunk.choices[0].finish_reason).toBeUndefined()
    expect(chunk.choices[0].delta.content).toBe("hello")
  })

  test("emits one official error event when a native stream fails before creation", () => {
    const tracker = new NativeResponsesStreamTracker()
    expect(
      parseNativeResponsesSseData('{"type":"response.reasoning.delta"}'),
    ).toEqual({ type: "response.reasoning.delta" })

    expect(tracker.fail("Native stream truncated.")).toEqual([
      {
        type: "error",
        sequence_number: 1,
        code: "invalid_upstream_response",
        message: "Native stream truncated.",
        param: null,
      },
    ])
    expect(tracker.fail("duplicate")).toEqual([])
  })

  test("rejects malformed native JSON and known events missing required shape", () => {
    expect(() => parseNativeResponsesSseData("{")).toThrow("invalid JSON")
    expect(() =>
      parseNativeResponsesSseData('{"type":"response.completed"}'),
    ).toThrow("invalid Responses event")
    expect(() =>
      parseNativeResponsesSseData(
        '{"type":"response.output_text.delta","output_index":0,"delta":"x"}',
      ),
    ).toThrow("invalid Responses event")
  })

  test("passes through native output item types outside the local translation union", () => {
    expect(
      parseNativeResponsesSseData(
        JSON.stringify({
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: {
            id: "ws_1",
            type: "web_search_call",
            status: "in_progress",
          },
        }),
      ),
    ).toMatchObject({
      type: "response.output_item.added",
      item: { id: "ws_1", type: "web_search_call" },
    })
  })

  test("turns a truncated native stream into response.failed with accumulated output", () => {
    const tracker = new NativeResponsesStreamTracker()
    tracker.observe({
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "gpt-5.6-sol",
        status: "in_progress",
        output: [],
        error: null,
        incomplete_details: null,
      },
    })
    tracker.observe({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })
    tracker.observe({
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      delta: "partial",
    })

    expect(
      tracker.fail("Native stream ended before a terminal event."),
    ).toEqual([
      {
        type: "response.failed",
        sequence_number: 4,
        response: {
          id: "resp_1",
          object: "response",
          created_at: 1,
          model: "gpt-5.6-sol",
          status: "failed",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [
                {
                  type: "output_text",
                  text: "partial",
                  annotations: [],
                },
              ],
            },
          ],
          error: {
            code: "invalid_upstream_response",
            type: "server_error",
            message: "Native stream ended before a terminal event.",
            param: null,
          },
          incomplete_details: null,
        },
      },
    ])
  })
})
