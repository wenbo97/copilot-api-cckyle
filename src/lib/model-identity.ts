import consola from "consola"

import { getModelMappings } from "./model-mapping"
import { state } from "./state"

const SUFFIX = /\[[^\]]*\]$/ // trailing [1m] etc.

export const REQUIRED_RESPONSES_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const

function inCatalog(id: string): boolean {
  return Boolean(state.models?.data.some((m) => m.id === id))
}

/**
 * Normalize a client-sent model id to a Copilot catalog id, ONCE, at handler entry.
 * Order: exact catalog hit → MODEL_MAPPINGS alias → strip trailing [..] suffix and retry.
 * Returns the input unchanged if nothing matches (the handler/router then decides).
 */
export function resolveModelId(requested: string): string {
  if (inCatalog(requested)) return requested

  const mappings = getModelMappings()
  const mapped = mappings.get(requested)
  if (mapped) return mapped

  const stripped = requested.replace(SUFFIX, "")
  if (stripped !== requested) {
    if (inCatalog(stripped)) return stripped
    const m2 = mappings.get(stripped)
    if (m2) return m2
  }
  return requested
}

/** Startup check: MODEL_MAPPINGS targets that aren't in the loaded catalog. */
export function validateModelMappings(): Array<string> {
  const bad: Array<string> = []
  for (const target of getModelMappings().values()) {
    if (!inCatalog(target)) bad.push(target)
  }
  if (bad.length > 0) {
    consola.warn(`MODEL_MAPPINGS targets not in catalog: ${bad.join(", ")}`)
  }
  return bad
}

/** Startup check for the Responses-native model set this proxy guarantees. */
export function validateRequiredResponsesModels(): Array<string> {
  const missing = REQUIRED_RESPONSES_MODELS.filter((id) => !inCatalog(id))
  if (missing.length > 0) {
    consola.warn(
      `Required Responses models missing from live catalog: ${missing.join(", ")}`,
    )
  }
  return missing
}
