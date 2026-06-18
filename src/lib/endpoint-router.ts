import { state } from "./state"

/**
 * Decide which Copilot egress endpoint a model accepts, from the live catalog.
 *
 * The Copilot `/models` catalog carries a `supported_endpoints` array per model.
 * Some models (e.g. `gpt-5.3-codex`, `gpt-5.5`) are `/responses`-ONLY and 400 with
 * `unsupported_api_for_model` on `/chat/completions`. Inbound handlers call this to
 * pick the egress verb (native `/responses` passthrough vs translate-down to
 * `/chat/completions`) instead of unconditionally translating everything down.
 *
 * This is a pure capability check against `state.models` — each handler applies its
 * own preference. Endpoints are matched exactly, with the leading slash as the
 * catalog stores them (e.g. `"/responses"`, NOT `"responses"`).
 */
export function modelSupportsEndpoint(
  modelId: string,
  endpoint: string,
): boolean {
  return (
    state.models?.data
      .find((model) => model.id === modelId)
      ?.supported_endpoints?.includes(endpoint) ?? false
  )
}

// Effort ordering, weakest to strongest. The catalog advertises a per-model
// subset of these in `capabilities.supports.reasoning_effort`.
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const

/**
 * Clamp a requested reasoning effort to what the target model actually allows.
 *
 * Effort sets differ per model: gpt-5.3-codex tops out at `xhigh` (no `max`),
 * opus-4.8 has the full `max`, the gpt-5.x line adds `none`. Sending `max` to
 * codex 400s. When the requested level is not offered, fall back to the highest
 * allowed level that does not exceed it (so `max`->`xhigh` for codex, never up).
 * Returns the input unchanged if the model advertises no effort set, and
 * `undefined` passes through (no effort requested).
 */
export function clampReasoningEffort(
  modelId: string,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined

  const model = state.models?.data.find((m) => m.id === modelId)
  // Catalog data is external and looser than the Model type declares — a model
  // may carry no `capabilities` at all — so probe defensively. The type claims
  // these are non-optional, hence the eslint suppression; the optional chains
  // guard against a real runtime crash on capability-less catalog entries.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const allowed = model?.capabilities?.supports?.reasoning_effort
  // No advertised set -> nothing to clamp against; pass through unchanged.
  if (!allowed || allowed.length === 0) return effort
  if (allowed.includes(effort)) return effort

  const requestedRank = EFFORT_ORDER.indexOf(
    effort as (typeof EFFORT_ORDER)[number],
  )
  // Unknown effort string -> leave as-is rather than guess.
  if (requestedRank === -1) return effort

  // Highest allowed level that does not exceed the request.
  let best: string | undefined
  let bestRank = -1
  for (const level of allowed) {
    const rank = EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number])
    if (rank !== -1 && rank <= requestedRank && rank > bestRank) {
      best = level
      bestRank = rank
    }
  }
  // If every allowed level is stronger than the request, take the weakest allowed.
  return best ?? allowed[0]
}
