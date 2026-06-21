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
      },
    ])
  })
  test("undefined/empty -> undefined", () => {
    expect(anthropicToolsToResponses(undefined)).toBeUndefined()
    expect(anthropicToolsToResponses([])).toBeUndefined()
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
})

describe("deriveAnthropicStopReason", () => {
  test("hasToolCall wins -> tool_use", () => {
    expect(deriveAnthropicStopReason(true, "incomplete")).toBe("tool_use")
    expect(deriveAnthropicStopReason(true, "completed")).toBe("tool_use")
  })
  test("incomplete (no tool) -> max_tokens", () => {
    expect(deriveAnthropicStopReason(false, "incomplete")).toBe("max_tokens")
  })
  test("otherwise -> end_turn", () => {
    expect(deriveAnthropicStopReason(false, "completed")).toBe("end_turn")
    expect(deriveAnthropicStopReason(false, undefined)).toBe("end_turn")
  })
})
