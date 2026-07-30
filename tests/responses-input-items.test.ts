import { describe, test, expect } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"

import { translateToOpenAI } from "../src/routes/responses/non-stream-translation"

// Codex replays input items that Chat Completions cannot express. Verified
// against the live Copilot backend BEFORE the fix, on gpt-4o, claude-sonnet-5
// and gemini-3.6-flash:
//   - a bare `reasoning` item           -> proxy 500, "undefined is not an
//                                          object (evaluating 'content.map')"
//   - `agent_message` + encrypted part  -> backend 400
//   - `agent_message` (carries no role) -> backend 400 on gpt-4o and gemini
//
// Semantics follow litellm's Responses -> Completions transform: skip items with
// no content, default a missing role to "user", keep images explicitly, coerce
// unknown parts to text and drop them when they carry none.
describe("translateToOpenAI: items Chat Completions cannot express", () => {
  test("skips a reasoning item instead of crashing on its absent content", () => {
    const out = translateToOpenAI({
      model: "gpt-4o",
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "BLOB",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("defaults a missing role to user (agent_message carries none)", () => {
    const out = translateToOpenAI({
      model: "gpt-4o",
      input: [
        {
          type: "agent_message",
          author: "/root/command_skills",
          content: [{ type: "input_text", text: "from sub-agent" }],
        },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages[0].role).toBe("user")
  })

  test("drops an encrypted_content part rather than shaping it into an image", () => {
    const out = translateToOpenAI({
      model: "gpt-4o",
      input: [
        {
          type: "agent_message",
          content: [
            { type: "input_text", text: "envelope" },
            { type: "encrypted_content", encrypted_content: "gAAAA" },
          ],
        },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages[0].content).toEqual([
      { type: "text", text: "envelope" },
    ])
  })

  // Guard rail. `input_image` used to be handled by the `else` fallback, so a
  // naive "drop every unknown part" fix would silently kill vision on this path.
  // Live check: claude-sonnet-5 reads a solid-red PNG through this translation.
  test("PRESERVES input_image parts so vision keeps working", () => {
    const out = translateToOpenAI({
      model: "claude-sonnet-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what colour?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAA",
              detail: "auto",
            },
          ],
        },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages[0].content).toEqual([
      { type: "text", text: "what colour?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAA", detail: "auto" },
      },
    ])
  })

  test("keeps an unknown part when it carries text", () => {
    const out = translateToOpenAI({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "summary_text", text: "a summary" }],
        },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages[0].content).toEqual([
      { type: "text", text: "a summary" },
    ])
  })

  test("still routes function_call / function_call_output correctly", () => {
    const out = translateToOpenAI({
      model: "gpt-4o",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "42" },
      ],
    } as unknown as ResponsesPayload)

    expect(out.messages[0].role).toBe("assistant")
    expect(out.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "42",
    })
  })
})
