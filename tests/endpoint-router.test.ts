import { describe, test, expect, afterEach } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import {
  clampReasoningEffort,
  modelSupportsEndpoint,
} from "../src/lib/endpoint-router"
import { state } from "../src/lib/state"

// Minimal fixture-shaped catalog (mirrors the real /models shape for the fields
// the router reads). Endpoints carry the leading slash, as the catalog stores them.
const fixtureModels = {
  object: "list",
  data: [
    {
      id: "gpt-5.3-codex",
      supported_endpoints: ["/responses", "ws:/responses"],
      capabilities: {
        supports: {
          // codex tops out at xhigh — no `max`.
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        },
      },
    },
    {
      id: "gpt-5.5",
      supported_endpoints: ["/responses", "ws:/responses"],
      capabilities: {
        supports: {
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
        },
      },
    },
    {
      id: "gpt-5.4",
      supported_endpoints: ["/responses", "/chat/completions", "ws:/responses"],
    },
    {
      id: "claude-opus-4.8",
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      capabilities: {
        supports: {
          reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    },
    { id: "no-endpoints" }, // model with the field absent entirely
  ],
} as unknown as ModelsResponse

describe("modelSupportsEndpoint", () => {
  afterEach(() => {
    state.models = undefined
  })

  test("returns true for a /responses-only model", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/responses")).toBe(true)
    expect(modelSupportsEndpoint("gpt-5.5", "/responses")).toBe(true)
  })

  test("returns true for a dual-endpoint model (canary)", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("gpt-5.4", "/responses")).toBe(true)
    expect(modelSupportsEndpoint("gpt-5.4", "/chat/completions")).toBe(true)
  })

  test("returns false for a Claude model with no /responses", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("claude-opus-4.8", "/responses")).toBe(false)
  })

  test("matches the leading slash exactly (no bare 'responses')", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("gpt-5.3-codex", "responses")).toBe(false)
  })

  test("returns false when the model is unknown", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("does-not-exist", "/responses")).toBe(false)
  })

  test("returns false when supported_endpoints is absent", () => {
    state.models = fixtureModels
    expect(modelSupportsEndpoint("no-endpoints", "/responses")).toBe(false)
  })

  test("returns false when the catalog has not loaded yet", () => {
    state.models = undefined
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/responses")).toBe(false)
  })
})

describe("clampReasoningEffort", () => {
  afterEach(() => {
    state.models = undefined
  })

  test("clamps max -> xhigh for codex (no max allowed)", () => {
    state.models = fixtureModels
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("xhigh")
  })

  test("passes through an allowed level unchanged", () => {
    state.models = fixtureModels
    expect(clampReasoningEffort("gpt-5.3-codex", "high")).toBe("high")
    expect(clampReasoningEffort("gpt-5.5", "xhigh")).toBe("xhigh")
    expect(clampReasoningEffort("claude-opus-4.8", "max")).toBe("max")
  })

  test("clamps DOWN to the highest allowed not exceeding the request", () => {
    state.models = fixtureModels
    // codex allows up to xhigh; a hypothetical request above it lands on xhigh.
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("xhigh")
  })

  test("returns undefined when no effort is requested", () => {
    state.models = fixtureModels
    expect(clampReasoningEffort("gpt-5.3-codex", undefined)).toBeUndefined()
  })

  test("passes effort through when the model advertises no effort set", () => {
    state.models = fixtureModels
    // gpt-5.4 has no reasoning_effort in the fixture -> nothing to clamp against.
    expect(clampReasoningEffort("gpt-5.4", "max")).toBe("max")
  })

  test("passes effort through for an unknown model", () => {
    state.models = fixtureModels
    expect(clampReasoningEffort("does-not-exist", "max")).toBe("max")
  })

  test("leaves an unrecognized effort string as-is", () => {
    state.models = fixtureModels
    expect(clampReasoningEffort("gpt-5.3-codex", "ludicrous")).toBe("ludicrous")
  })
})
