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

const SAME_PROTOCOL: Record<HandlerKind, Egress> = {
  responses: "/responses",
  messages: "/v1/messages",
  chat: "/chat/completions",
}

/**
 * Pick the Copilot egress endpoint for an inbound handler + model, from the live
 * catalog. Each inbound handler ("messages" = Claude Code, "responses" = Codex,
 * "chat" = OpenAI clients) prefers its same-protocol egress, then falls back to
 * the nearest implemented cross-protocol leg the model advertises.
 *
 * Returns "unsupported" when the model advertises an endpoint set that contains
 * none of this handler's preferences (the handler maps that to a clean 4xx).
 * When the model advertises NO set at all, falls back to same-protocol (the prior
 * default) and logs once.
 */
export function pickEgress(kind: HandlerKind, modelId: string): EgressChoice {
  const model = state.models?.data.find((m) => m.id === modelId)
  const endpoints = model?.supported_endpoints

  // No advertised set at all → same-protocol fallback (previous default), logged once.
  if (!endpoints || endpoints.length === 0) {
    consola.debug(
      `[router] ${modelId} advertises no supported_endpoints; falling back to same-protocol ${SAME_PROTOCOL[kind]}`,
    )
    return SAME_PROTOCOL[kind]
  }

  for (const ep of PREFERENCE[kind]) {
    if (endpoints.includes(ep)) return ep
  }
  return "unsupported"
}
