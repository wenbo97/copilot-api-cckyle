import { describe, test, expect, afterEach } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  mapThinkingToReasoningEffort,
  clampReasoningEffort,
} from "../src/routes/_shared/reasoning-policy"

afterEach(() => {
  state.models = undefined
})

describe("mapThinkingToReasoningEffort (preserved behavior)", () => {
  test("absent thinking → undefined", () => {
    expect(mapThinkingToReasoningEffort(undefined, 1000)).toBeUndefined()
  })
  test("enabled, no budget → high", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled" }, 1000)).toBe("high")
  })
  test("budget ≥ 0.95×max_tokens → max", () => {
    expect(
      mapThinkingToReasoningEffort(
        { type: "enabled", budget_tokens: 950 },
        1000,
      ),
    ).toBe("max")
  })
  test("budget ≤2048 → low", () => {
    expect(
      mapThinkingToReasoningEffort(
        { type: "enabled", budget_tokens: 2048 },
        100000,
      ),
    ).toBe("low")
  })
  test("budget ≤8192 → medium", () => {
    expect(
      mapThinkingToReasoningEffort(
        { type: "enabled", budget_tokens: 8192 },
        100000,
      ),
    ).toBe("medium")
  })
  test("budget ≤24576 → high", () => {
    expect(
      mapThinkingToReasoningEffort(
        { type: "enabled", budget_tokens: 24576 },
        100000,
      ),
    ).toBe("high")
  })
  test("budget >24576 → xhigh", () => {
    expect(
      mapThinkingToReasoningEffort(
        { type: "enabled", budget_tokens: 30000 },
        100000,
      ),
    ).toBe("xhigh")
  })
})

describe("clampReasoningEffort (preserved behavior)", () => {
  test("undefined → undefined", () => {
    expect(clampReasoningEffort("gpt-5.3-codex", undefined)).toBeUndefined()
  })
  test("no catalog → passthrough", () => {
    state.models = undefined
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("max")
  })
  test("max clamped to xhigh for codex", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.3-codex",
          capabilities: {
            supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
          },
        },
      ],
    } as unknown as ModelsResponse
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("xhigh")
  })
  test("allowed effort passes unchanged", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "claude-opus-4.8",
          capabilities: {
            supports: {
              reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
            },
          },
        },
      ],
    } as unknown as ModelsResponse
    expect(clampReasoningEffort("claude-opus-4.8", "max")).toBe("max")
  })
  test("a mid-range allowed level passes through unchanged", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.3-codex",
          capabilities: {
            supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
          },
        },
        {
          id: "gpt-5.5",
          capabilities: {
            supports: {
              reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
            },
          },
        },
      ],
    } as unknown as ModelsResponse
    expect(clampReasoningEffort("gpt-5.3-codex", "high")).toBe("high")
    expect(clampReasoningEffort("gpt-5.5", "xhigh")).toBe("xhigh")
  })
  test("passes effort through when the model advertises no effort set", () => {
    state.models = {
      object: "list",
      data: [{ id: "gpt-5.4" }],
    } as unknown as ModelsResponse
    // No reasoning_effort in the catalog entry -> nothing to clamp against.
    expect(clampReasoningEffort("gpt-5.4", "max")).toBe("max")
  })
  test("passes effort through for an unknown model", () => {
    state.models = {
      object: "list",
      data: [{ id: "gpt-5.4" }],
    } as unknown as ModelsResponse
    expect(clampReasoningEffort("does-not-exist", "max")).toBe("max")
  })
  test("leaves an unrecognized effort string as-is", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-5.3-codex",
          capabilities: {
            supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
          },
        },
      ],
    } as unknown as ModelsResponse
    expect(clampReasoningEffort("gpt-5.3-codex", "ludicrous")).toBe("ludicrous")
  })
})
