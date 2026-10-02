import { expect, test } from "bun:test"

import type { Grant, Observation } from "./local-budget"

import { summarizeE2eCoverage } from "./local-e2e-coverage"

const grant = (id: string, model: string): Grant => ({
  kind: "reserve",
  id,
  model,
  roundId: "round",
  pricingTier: "default",
  phase: "functional",
  caseId: `e2e-${model}-responses-json`,
  endpoint: "/responses",
  effort: "low",
  inputTokens: 1000,
  outputTokens: 512,
  limitApplied: false,
  at: "2026-09-30T00:00:00Z",
  reservedCredits: 1,
})

test("per-model coverage distinguishes observed zero usage from missing usage", () => {
  const observations = new Map<string, Observation>([
    [
      "known",
      {
        outcome: "completed",
        status: 200,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    ],
    ["unknown", { outcome: "cancelled", status: 200, usage: null }],
  ])
  const [luna, sol] = summarizeE2eCoverage({
    grants: [
      grant("known", "gpt-5.6-luna"),
      grant("unknown", "gpt-5.6-luna"),
      grant("other", "gpt-6-sol"),
    ],
    observations,
    models: ["gpt-5.6-luna", "gpt-6-sol"],
    roundId: "round",
    stage: "matrix",
    cases: [{ id: "e2e-gpt-5.6-luna-responses-json", status: "pass" }],
  })
  expect(luna.usageCoverage).toBe("1/2")
  expect(luna.cacheCoverage).toBe("1/2")
  expect(luna.knownInputTokens).toBe(0)
  expect(luna.knownCachedInputTokens).toBe(0)
  expect(sol.usageCoverage).toBe("0/1")
  expect(sol.casesPassed).toBe(0)
})

test("regular Sol does not count fast-model cases even when fast is not selected", () => {
  const cases = [
    { id: "e2e-gpt-5.6-sol-responses-json", status: "pass" },
    { id: "e2e-gpt-5.6-sol-fast-responses-json", status: "blocked" },
  ]
  const input = {
    grants: [],
    observations: new Map<string, Observation>(),
    cases,
    roundId: "round",
    stage: "matrix" as const,
  }
  const [sol, fast] = summarizeE2eCoverage({
    ...input,
    models: ["gpt-5.6-sol", "gpt-5.6-sol-fast"],
  })
  expect(sol.casesTotal).toBe(1)
  expect(sol.casesPassed).toBe(1)
  expect(fast.casesTotal).toBe(1)
  expect(fast.casesPassed).toBe(0)
  expect(
    summarizeE2eCoverage({ ...input, models: ["gpt-5.6-sol"] })[0].casesTotal,
  ).toBe(1)
})

test("legacy Astra coverage includes only its exact authorized historical cases", () => {
  const [astra] = summarizeE2eCoverage({
    grants: [],
    observations: new Map<string, Observation>(),
    models: ["gpt-6-astra"],
    roundId: "round",
    stage: "legacy",
    cases: [
      { id: "e2e-legacy-astra-fork", status: "pass" },
      { id: "e2e-legacy-astra-resume", status: "skipped" },
      { id: "e2e-legacy-astra-not-an-authorized-case", status: "pass" },
    ],
  })
  expect(astra.casesTotal).toBe(2)
  expect(astra.casesPassed).toBe(1)
})
