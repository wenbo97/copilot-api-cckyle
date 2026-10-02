import type { Grant, Observation } from "./local-budget"

import { record } from "./local-budget"
import { e2eCases } from "./local-e2e-authorization"

function count(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

/** Coverage and known values are separate; unknown usage never becomes zero. */
export function summarizeE2eCoverage(input: {
  grants: Array<Grant>
  observations: ReadonlyMap<string, Observation>
  models: Array<string>
  cases: Array<{ id: string; status: string }>
  roundId: string
  stage: "matrix" | "legacy"
}) {
  const { grants, observations, models, cases, roundId, stage } = input
  const authorizedCases: Partial<ReturnType<typeof e2eCases>> = e2eCases(stage)
  return models.map((model) => {
    const selected = grants.filter(
      (grant) => grant.roundId === roundId && grant.model === model,
    )
    const modelCases = cases.filter(
      (result) => authorizedCases[result.id]?.model === model,
    )
    let covered = 0
    let cacheCovered = 0
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    for (const grant of selected) {
      const usage = record(observations.get(grant.id)?.usage)
      const inputCount = count(usage.input_tokens ?? usage.prompt_tokens)
      const outputCount = count(usage.output_tokens ?? usage.completion_tokens)
      const cacheCount = count(
        record(usage.input_tokens_details).cached_tokens
          ?? record(usage.prompt_tokens_details).cached_tokens
          ?? usage.cached_input_tokens,
      )
      if (inputCount !== undefined && outputCount !== undefined) {
        covered++
        inputTokens += inputCount
        outputTokens += outputCount
      }
      if (cacheCount !== undefined) {
        cacheCovered++
        cachedInputTokens += cacheCount
      }
    }
    return {
      model,
      casesPassed: modelCases.filter((result) => result.status === "pass")
        .length,
      casesTotal: modelCases.length,
      attempts: selected.length,
      usageCoverage: `${covered}/${selected.length}`,
      cacheCoverage: `${cacheCovered}/${selected.length}`,
      knownInputTokens: inputTokens,
      knownOutputTokens: outputTokens,
      knownCachedInputTokens: cachedInputTokens,
    }
  })
}
