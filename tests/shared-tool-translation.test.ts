import { describe, test, expect } from "bun:test"

import type { AnthropicTool } from "../src/routes/messages/anthropic-types"

import { deriveAnthropicStopReason } from "../src/routes/_shared/stop-reason"
import {
  anthropicToolsToResponses,
  anthropicToolChoiceToResponses,
} from "../src/routes/_shared/tool-translation"

describe("anthropicToolsToResponses", () => {
  test("maps name/description/input_schema -> parameters", () => {
    expect(
      anthropicToolsToResponses([
        { name: "t", description: "d", input_schema: { type: "object" } },
      ] as Array<AnthropicTool>),
    ).toEqual([
      {
        type: "function",
        name: "t",
        description: "d",
        parameters: { type: "object" },
        strict: false,
      },
    ])
  })
  test("undefined/empty -> undefined", () => {
    expect(anthropicToolsToResponses(undefined)).toBeUndefined()
    expect(anthropicToolsToResponses([])).toBeUndefined()
  })

  test("preserves a caller's explicit strict mode", () => {
    expect(
      anthropicToolsToResponses([
        {
          name: "t",
          strict: true,
          input_schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ])?.[0],
    ).toHaveProperty("strict", true)
  })

  test("applies 64-char tool-name truncation (T5 wiring)", () => {
    const long = "z".repeat(80)
    const out = anthropicToolsToResponses([
      { name: long, input_schema: { type: "object" } },
    ] as Array<AnthropicTool>)
    expect(out?.[0].name.length).toBe(64)
  })
})

describe("anthropicToolChoiceToResponses", () => {
  test("auto/any/none/tool map correctly", () => {
    expect(anthropicToolChoiceToResponses({ type: "auto" })).toBe("auto")
    expect(anthropicToolChoiceToResponses({ type: "any" })).toBe("required")
    expect(anthropicToolChoiceToResponses({ type: "none" })).toBe("none")
    expect(anthropicToolChoiceToResponses({ type: "tool", name: "x" })).toEqual(
      {
        type: "function",
        name: "x",
      },
    )
  })
  test("undefined -> undefined; tool without name -> auto", () => {
    expect(anthropicToolChoiceToResponses(undefined)).toBeUndefined()
    expect(anthropicToolChoiceToResponses({ type: "tool" })).toBe("auto")
  })

  test("truncates a forced tool name symmetrically with the tool list", () => {
    const long = "z".repeat(80)
    const choice = anthropicToolChoiceToResponses({ type: "tool", name: long })
    const tools = anthropicToolsToResponses([
      { name: long, input_schema: { type: "object" } },
    ] as Array<AnthropicTool>)
    // The forced choice must reference the SAME (truncated) name as the tool def,
    // else the backend can't resolve it. Both go through truncateToolName.
    expect((choice as { name: string }).name).toBe(tools?.[0].name as string)
    expect((choice as { name: string }).name.length).toBe(64)
  })
})

describe("deriveAnthropicStopReason", () => {
  const response = {
    id: "resp_test",
    object: "response" as const,
    created_at: 1,
    model: "test",
    output: [],
  }
  test("completed tools are executable, truncated tools are not", () => {
    expect(
      deriveAnthropicStopReason(true, { ...response, status: "completed" }),
    ).toBe("tool_use")
    expect(
      deriveAnthropicStopReason(true, {
        ...response,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toBe("max_tokens")
    expect(
      deriveAnthropicStopReason(false, { ...response, status: "completed" }),
    ).toBe("end_turn")
  })
  test("content filtering maps to refusal and unknown termination fails", () => {
    expect(
      deriveAnthropicStopReason(true, {
        ...response,
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      }),
    ).toBe("refusal")
    expect(() =>
      deriveAnthropicStopReason(false, { ...response, status: "incomplete" }),
    ).toThrow("unknown incomplete")
    expect(() =>
      deriveAnthropicStopReason(true, {
        ...response,
        status: "failed",
        error: { code: "broken", message: "specific cause" },
      }),
    ).toThrow("specific cause")
  })
})
