import { describe, test, expect, afterEach } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import {
  clampReasoningEffort,
  modelSupportsEndpoint,
  pickEgress,
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
    { id: "gpt-5.7" }, // gpt-5 family; catalog omits supported_endpoints (enterprise reality)
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

  test("returns false when a model omits the supported_endpoints field", () => {
    state.models = fixtureModels
    // `no-endpoints` advertises no endpoint set, so the pure-catalog read reports
    // false (modelSupportsEndpoint never guesses from the id).
    expect(modelSupportsEndpoint("no-endpoints", "/responses")).toBe(false)
  })

  test("returns false when a gpt-5 model omits the field (no regex inference)", () => {
    state.models = fixtureModels
    // The catalog is the single source of truth: a model that advertises no
    // supported_endpoints is treated as supporting none here. (pickEgress applies
    // a same-protocol fallback for these; modelSupportsEndpoint does not guess.)
    expect(modelSupportsEndpoint("gpt-5.7", "/responses")).toBe(false)
    expect(modelSupportsEndpoint("gpt-5.7", "/chat/completions")).toBe(false)
  })

  test("returns false for any model when the catalog has not loaded yet", () => {
    state.models = undefined
    // No catalog -> no advertised endpoints -> false (no id-pattern inference).
    expect(modelSupportsEndpoint("gpt-5.3-codex", "/responses")).toBe(false)
  })

  test("returns false for an unknown model when the catalog has not loaded yet", () => {
    state.models = undefined
    expect(modelSupportsEndpoint("does-not-exist", "/responses")).toBe(false)
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

describe("pickEgress (per-handler, catalog-truth)", () => {
  afterEach(() => {
    state.models = undefined
  })

  test("Codex+gpt-5.4 → /responses (same-protocol)", () => {
    state.models = fixtureModels
    expect(pickEgress("responses", "gpt-5.4")).toBe("/responses")
  })
  test("CC+gpt-5.4 → /responses (no messages; nearest cross)", () => {
    state.models = fixtureModels
    expect(pickEgress("messages", "gpt-5.4")).toBe("/responses")
  })
  test("OpenAI+gpt-5.4 → /chat/completions (same-protocol)", () => {
    state.models = fixtureModels
    expect(pickEgress("chat", "gpt-5.4")).toBe("/chat/completions")
  })
  test("OpenAI+gpt-5.5 (responses-only) → unsupported", () => {
    state.models = fixtureModels
    expect(pickEgress("chat", "gpt-5.5")).toBe("unsupported")
  })
  test("CC+claude-opus-4.8 → /v1/messages (passthrough)", () => {
    state.models = fixtureModels
    expect(pickEgress("messages", "claude-opus-4.8")).toBe("/v1/messages")
  })
  test("Codex+claude-opus-4.8 → /chat/completions (translate-down)", () => {
    state.models = fixtureModels
    expect(pickEgress("responses", "claude-opus-4.8")).toBe("/chat/completions")
  })
  test("model with NO supported_endpoints → same-protocol fallback (logged)", () => {
    state.models = {
      object: "list",
      data: [{ id: "mystery-model" }],
    } as unknown as ModelsResponse
    expect(pickEgress("messages", "mystery-model")).toBe("/v1/messages")
    expect(pickEgress("responses", "mystery-model")).toBe("/responses")
    expect(pickEgress("chat", "mystery-model")).toBe("/chat/completions")
  })
})
