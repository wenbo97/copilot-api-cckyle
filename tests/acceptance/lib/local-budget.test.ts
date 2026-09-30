import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { BudgetLedger, prepareGeneration } from "./local-budget"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function ledger(credits = 1000, attempts = 120) {
  const directory = mkdtempSync(path.join(tmpdir(), "accept-budget-"))
  directories.push(directory)
  return new BudgetLedger(
    path.join(directory, "ledger.jsonl"),
    credits,
    attempts,
  )
}

const reservation = {
  caseId: "test",
  phase: "functional" as const,
  model: "gpt-5.6-luna",
  endpoint: "/responses",
  inputTokens: 1000,
  outputTokens: 1024,
  effort: "low",
  limitApplied: false,
}

test("concurrent reservations cannot overspend the shared allowance", async () => {
  const budget = ledger(1)
  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => budget.reserve(reservation)),
    ),
  )
  expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true)
  expect(budget.summary().reservedCredits).toBeLessThanOrEqual(0.9)
})

test("retry attempts count separately and persist across ledger reloads", () => {
  const budget = ledger(1000, 2)
  budget.reserve(reservation)
  const reloaded = new BudgetLedger(budget.file, 1000, 2)
  reloaded.reserve(reservation)
  expect(() => reloaded.reserve(reservation)).toThrow("attempt")
  expect(reloaded.summary().attempts).toBe(2)
})

test("cancelled and unknown usage never refund reserved credits", () => {
  const budget = ledger()
  const grant = budget.reserve(reservation)
  const before = budget.summary().reservedCredits
  budget.observe(grant.id, { outcome: "cancelled", usage: null })
  expect(budget.summary().reservedCredits).toBe(before)
  expect(budget.summary().unknownUsageAttempts).toBe(1)
})

test("unpriced models, invalid counts, and non-low effort fail closed", () => {
  const budget = ledger()
  expect(() =>
    budget.reserve({ ...reservation, model: "gpt-6-astra" }),
  ).toThrow()
  expect(() =>
    budget.reserve({ ...reservation, inputTokens: Number.NaN }),
  ).toThrow()
  expect(() => budget.reserve({ ...reservation, effort: "high" })).toThrow()
  expect(budget.summary().attempts).toBe(0)
})

test("preparation bounds client output and preserves low effort", () => {
  const prepared = prepareGeneration("/responses", {
    model: "gpt-5.6-luna",
    reasoning: { effort: "low" },
    input: "Reply OK",
  })
  expect(prepared.body.max_output_tokens).toBe(2048)
  expect(prepared.limitApplied).toBe(true)
  expect(prepared.inputTokens).toBeGreaterThan(0)
  expect(() =>
    prepareGeneration("/responses", { model: "gpt-5.6-luna" }),
  ).toThrow("low")
})

test("explicit output limits and media reserves cannot evade the guard", () => {
  expect(() =>
    prepareGeneration("/responses", {
      model: "gpt-5.6-luna",
      reasoning: { effort: "low" },
      max_output_tokens: -1,
    }),
  ).toThrow()
  const media = prepareGeneration("/responses", {
    model: "gpt-5.6-luna",
    reasoning: { effort: "low" },
    input: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    max_output_tokens: 100,
  })
  expect(media.inputTokens).toBe(65536)
})

test("Terra is restricted to comparison and phase limits survive reload", () => {
  const budget = ledger()
  expect(() =>
    budget.reserve({ ...reservation, model: "gpt-5.6-terra" }),
  ).toThrow("comparison")
  for (let index = 0; index < 4; index++)
    budget.reserve({
      ...reservation,
      model: "gpt-5.6-terra",
      phase: "comparison",
    })
  const reloaded = new BudgetLedger(budget.file, 1000)
  expect(() =>
    reloaded.reserve({
      ...reservation,
      model: "gpt-5.6-terra",
      phase: "comparison",
    }),
  ).toThrow("Terra")
})

test("inherited object keys cannot bypass the priced model allowlist", () => {
  const budget = ledger()
  for (const model of ["constructor", "toString", "__proto__"])
    expect(() => budget.reserve({ ...reservation, model })).toThrow("allowlist")
  expect(budget.summary().reservedCredits).toBe(0)
})

test("budget guard preserves Chat wire fields and rejects multiplied completions", () => {
  const chat = { model: "gpt-5-mini", reasoning_effort: "low", max_tokens: 100 }
  const prepared = prepareGeneration("/chat/completions", chat)
  expect(prepared.body.max_tokens).toBe(100)
  expect(prepared.body.max_completion_tokens).toBeUndefined()
  expect(() =>
    prepareGeneration("/chat/completions", { ...chat, n: 2 }),
  ).toThrow("one completion")
  expect(() =>
    prepareGeneration("/chat/completions", {
      ...chat,
      max_completion_tokens: 100,
    }),
  ).toThrow("Ambiguous")
})
