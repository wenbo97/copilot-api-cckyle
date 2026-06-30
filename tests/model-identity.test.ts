import { describe, test, expect, afterEach } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import {
  resolveModelId,
  validateModelMappings,
} from "../src/lib/model-identity"
import { clearModelMappingsCache } from "../src/lib/model-mapping"
import { state } from "../src/lib/state"

const catalog = {
  object: "list",
  data: [
    { id: "claude-opus-4.8" },
    { id: "claude-sonnet-4.6" },
    { id: "gpt-5.5" },
  ],
} as unknown as ModelsResponse

afterEach(() => {
  state.models = undefined
  delete process.env.MODEL_MAPPINGS
  clearModelMappingsCache()
})

describe("resolveModelId", () => {
  test("exact catalog id passes through (zero-config Copilot id)", () => {
    state.models = catalog
    expect(resolveModelId("claude-opus-4.8")).toBe("claude-opus-4.8")
  })
  test("MODEL_MAPPINGS alias resolves", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "claude-opus-4-8:claude-opus-4.8"
    expect(resolveModelId("claude-opus-4-8")).toBe("claude-opus-4.8")
  })
  test("[1m] suffix stripped then resolved", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "claude-opus-4-8:claude-opus-4.8"
    expect(resolveModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4.8")
  })
  test("suffix strip → exact catalog id (no mapping needed)", () => {
    state.models = catalog
    expect(resolveModelId("claude-opus-4.8[1m]")).toBe("claude-opus-4.8")
  })
  test("unknown id returned as-is (handler decides)", () => {
    state.models = catalog
    expect(resolveModelId("nonexistent")).toBe("nonexistent")
  })
})

describe("validateModelMappings", () => {
  test("warns for target absent from catalog (returns the bad targets)", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "a:claude-opus-4.8,b:ghost-model"
    expect(validateModelMappings()).toEqual(["ghost-model"])
  })
})
