import consola from "consola"

import { state } from "./state"

/**
 * Whether a model accepts a given Copilot egress endpoint, per the live catalog.
 *
 * Pure capability check against `state.models`: the `/models` catalog carries a
 * `supported_endpoints` array per model. Endpoints are matched exactly, with the
 * leading slash as the catalog stores them (e.g. `"/responses"`, NOT
 * `"responses"`). Returns false when the model is unknown or advertises no
 * endpoint set — the catalog is the single source of truth (no id-pattern
 * guessing).
 */
export function modelSupportsEndpoint(
  modelId: string,
  endpoint: string,
): boolean {
  const endpoints = state.models?.data.find(
    (model) => model.id === modelId,
  )?.supported_endpoints
  return Boolean(endpoints?.includes(endpoint))
}

export type HandlerKind = "messages" | "responses" | "chat"
export type Egress = "/v1/messages" | "/responses" | "/chat/completions"
export type EgressChoice = Egress | "unsupported"

// Same-protocol first, then the nearest EXISTING cross-leg. Each list only names
// egress legs that are actually implemented on this branch (see spec §4 Rule B).
const PREFERENCE: Record<HandlerKind, Array<Egress>> = {
  responses: ["/responses", "/chat/completions"],
  messages: ["/v1/messages", "/responses", "/chat/completions"],
  chat: ["/chat/completions"],
}

// Fallback egress when a catalog entry advertises NO supported_endpoints at all
// (20 of 36 enterprise models, e.g. gpt-4o, gpt-4.1, gemini-2.5-pro). The TRUE
// pre-branch default for every handler was the translate-down /chat/completions
// path (both the messages and responses handlers fell through to it when the
// model matched no native endpoint; the chat handler always used it). Returning
// same-protocol here would route gpt-4o via CC to /v1/messages passthrough and
// via Codex to /responses passthrough, both of which 400 — a regression.
const NO_CATALOG_FALLBACK: Egress = "/chat/completions"

/**
 * Pick the Copilot egress endpoint for an inbound handler + model, from the live
 * catalog. Each inbound handler ("messages" = Claude Code, "responses" = Codex,
 * "chat" = OpenAI clients) prefers its same-protocol egress, then falls back to
 * the nearest implemented cross-protocol leg the model advertises.
 *
 * Returns "unsupported" when the model advertises an endpoint set that contains
 * none of this handler's preferences (the handler maps that to a clean 4xx).
 * When the model advertises NO set at all, falls back to /chat/completions —
 * the universal translate-down path that was the prior default for all handlers.
 */
export function pickEgress(kind: HandlerKind, modelId: string): EgressChoice {
  const model = state.models?.data.find((m) => m.id === modelId)
  const endpoints = model?.supported_endpoints

  // No advertised set at all → translate-down fallback (the true prior default),
  // logged once. NOT same-protocol: gpt-4o et al. are neither Anthropic-native
  // nor /responses-native, so a passthrough would 400 at the backend.
  if (!endpoints || endpoints.length === 0) {
    consola.debug(
      `[router] ${modelId} advertises no supported_endpoints; falling back to ${NO_CATALOG_FALLBACK}`,
    )
    return NO_CATALOG_FALLBACK
  }

  for (const ep of PREFERENCE[kind]) {
    if (endpoints.includes(ep)) return ep
  }
  return "unsupported"
}
