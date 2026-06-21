import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { state } from "~/lib/state"

// Effort ordering, weakest to strongest (moved from endpoint-router.ts). The
// catalog advertises a per-model subset of these in
// `capabilities.supports.reasoning_effort`.
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const

// Budget→effort thresholds (named for clarity; values preserved from the original
// mapThinkingToReasoningEffort in non-stream-translation.ts).
const MAX_BUDGET_RATIO = 0.95 // budget ≥ ratio×max_tokens ⇒ "max" (no-constraint signal)
const LOW_BUDGET = 2048
const MEDIUM_BUDGET = 8192
const HIGH_BUDGET = 24576

/**
 * Claude Code conveys its effort level on /v1/messages as an Anthropic
 * `thinking.budget_tokens` value. The GitHub Copilot backend accepts OpenAI-style
 * `reasoning_effort` in {low, medium, high, xhigh, max} (an out-of-range value
 * 400s with "supported values: [low medium high xhigh max]", verified 2026-06-17).
 * Map the Anthropic budget to the nearest Copilot effort level so the effort
 * signal reaches the model instead of being dropped. Without this the backend
 * falls back to its own default (high for Opus 4.8), so effort / `/effort` /
 * frontmatter effort are all inert.
 *
 * `max` means "deepest reasoning with NO token-spend constraint" (Claude Code
 * docs). Claude Code expresses it as a budget at/near the response's max_tokens
 * ceiling (observed: budget_tokens 31999 with max_tokens 32000, ratio ~1.0).
 * The lower levels are absolute budget bands. We detect `max` first by the
 * near-ceiling ratio, then fall back to absolute bands for low..xhigh.
 *
 * Returns undefined when thinking is absent/disabled so no field is sent and the
 * backend default is preserved (no behavior change for non-thinking calls).
 */
export function mapThinkingToReasoningEffort(
  thinking: AnthropicMessagesPayload["thinking"],
  maxTokens?: number,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  // Guard against absent or non-enabled thinking. `type` is widened to string
  // before comparison because a client may send "disabled" at runtime even
  // though the payload type only declares "enabled".
  if (!thinking || (thinking.type as string) !== "enabled") return undefined
  const budget = thinking.budget_tokens
  // thinking enabled but no concrete budget -> backend default tier.
  // typeof guard covers both undefined (per type) and a defensive null.
  if (typeof budget !== "number") return "high"
  // `max` = no-constraint: Claude Code sends a budget at/above the max_tokens
  // ceiling. Detect by ratio so it is not confused with a large absolute xhigh.
  if (maxTokens && maxTokens > 0 && budget >= maxTokens * MAX_BUDGET_RATIO)
    return "max"
  if (budget <= LOW_BUDGET) return "low"
  if (budget <= MEDIUM_BUDGET) return "medium"
  if (budget <= HIGH_BUDGET) return "high"
  return "xhigh"
}

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
