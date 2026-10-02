import type { MatrixAuthorization } from "./local-matrix-authorization"

import { record } from "./local-budget"

export const CACHE_CASE_IDS = [
  "cache-control-initial",
  "cache-control-repeat",
  "cache-control-suffix",
  "cache-prefix-initial",
  "cache-prefix-repeat",
  "cache-prefix-suffix",
] as const

const cacheCaseIds = new Set<string>(CACHE_CASE_IDS)

export const CACHE_CUMULATIVE = {
  maxCredits: 1000,
  admissionCredits: 900,
  attempts: 129,
  activeMs: 4733444,
  phases: {
    functional: { credits: 200, attempts: 27 },
    clients: { credits: 850, attempts: 46 },
    operations: { credits: 150, attempts: 32 },
    comparison: { credits: 100, attempts: 16 },
    recheck: { credits: 200, attempts: 24 },
  },
}

/** A separate bounded experiment; it cannot expand inherited matrix ceilings. */
export function readCacheAuthorization(
  saved: Record<string, unknown>,
): MatrixAuthorization {
  if (
    saved.version !== 3
    || saved.approved !== true
    || saved.model !== "gpt-5.6-luna"
    || saved.effort !== "low"
    || saved.additionalAttempts !== 6
    || saved.additionalCredits !== 5
    || saved.additionalMinutes !== 8
  )
    throw new Error("Explicit bounded cache authorization required")
  validateCumulative(saved)
  const entries = Object.entries(record(saved.cases))
  if (
    entries.length !== CACHE_CASE_IDS.length
    || entries.some(([id]) => !cacheCaseIds.has(id))
  )
    throw new Error("Cache round requires exactly six cache cases")
  const cases: MatrixAuthorization["cases"] = {}
  for (const [id, value] of entries) cases[id] = readCase(value)
  return { cases, cumulative: CACHE_CUMULATIVE }
}

function validateCumulative(saved: Record<string, unknown>) {
  const cumulative = record(saved.cumulative)
  for (const [key, value] of Object.entries(CACHE_CUMULATIVE)) {
    if (key === "phases") continue
    if (cumulative[key] !== value)
      throw new Error("Cache round cannot change cumulative ceilings")
  }
  const phases = record(cumulative.phases)
  if (Object.keys(phases).length !== 5)
    throw new Error("Cache round requires inherited phase ceilings")
  for (const [phase, cap] of Object.entries(CACHE_CUMULATIVE.phases)) {
    const inherited = record(phases[phase])
    if (
      inherited.attempts !== cap.attempts
      || inherited.credits !== cap.credits
    )
      throw new Error("Cache round cannot change inherited phase ceilings")
  }
}

function readCase(
  value: unknown,
): NonNullable<MatrixAuthorization["cases"][string]> {
  const cap = record(value)
  if (
    cap.model !== "gpt-5.6-luna"
    || cap.phase !== "clients"
    || cap.endpoint !== "/responses"
    || cap.effort !== "low"
    || cap.attempts !== 1
    || cap.inputTokens !== 16384
    || cap.outputTokens !== 256
  )
    throw new Error("Invalid cache case scope")
  return {
    model: "gpt-5.6-luna",
    phase: "clients",
    endpoint: "/responses",
    effort: "low",
    attempts: 1,
    inputTokens: 16384,
    outputTokens: 256,
  }
}
