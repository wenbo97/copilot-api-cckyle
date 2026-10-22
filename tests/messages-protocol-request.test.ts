import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateAnthropicToResponses } from "~/routes/messages/responses-translation"

const image = {
  type: "image" as const,
  source: {
    type: "base64" as const,
    media_type: "image/png" as const,
    data: "aGVsbG8=",
  },
}

function translate(content: unknown) {
  return translateAnthropicToResponses({
    model: "gpt-5.5",
    max_tokens: 100,
    messages: [{ role: "user", content }],
  } as AnthropicMessagesPayload).input
}

describe("Messages tool result protocol", () => {
  test("rejects unsupported blocks and image sources instead of losing data", () => {
    for (const block of [
      { type: "document", source: {} },
      { type: "future_block", text: "lost" },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/a.png" },
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/svg+xml",
          data: "PHN2Zz4=",
        },
      },
    ]) {
      expect(() =>
        translate([
          { type: "tool_result", tool_use_id: "c", content: [block] },
        ]),
      ).toThrow("Unsupported tool_result")
    }
  })
  test("flushes preceding messages around both tool calls and tool results", () => {
    const result = translateAnthropicToResponses({
      model: "gpt-5.5",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", id: "c", name: "f", input: {} },
            { type: "text", text: "b" },
          ],
        },
        {
          role: "user",
          content: [
            image,
            { type: "tool_result", tool_use_id: "c", content: "result" },
            { type: "text", text: "c" },
          ],
        },
      ],
    }).input
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      { role: "assistant", content: [{ type: "output_text", text: "b" }] },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
      { type: "function_call_output", call_id: "c", output: "result" },
      { role: "user", content: [{ type: "input_text", text: "c" }] },
    ])
  })
  test("preserves tool result text and images in their original order", () => {
    expect(
      translate([{ type: "tool_result", tool_use_id: "c", content: [image] }]),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "c",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ])
    expect(
      translate([
        {
          type: "tool_result",
          tool_use_id: "c",
          content: [
            { type: "text", text: "before" },
            image,
            { type: "text", text: "after" },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "c",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          { type: "input_text", text: "after" },
        ],
      },
    ])
  })
  test("missing and empty tool results produce empty output", () => {
    for (const content of [undefined, "", []]) {
      expect(
        translate([{ type: "tool_result", tool_use_id: "c", content }]),
      ).toEqual([{ type: "function_call_output", call_id: "c", output: "" }])
    }
  })
})
