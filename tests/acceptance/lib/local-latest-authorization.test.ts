import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"

import {
  buildLatestAuthorization,
  LATEST_KINDS,
  LATEST_MODELS,
  readLatestAuthorization,
} from "./local-latest-authorization"

function fixture() {
  return buildLatestAuthorization({
    roundId: "latest-test",
    budgetDirectory: "synthetic",
    approvalReference: "Synthetic test approval; no live account",
    executionSha256: "a".repeat(64),
    fixtureSalt: randomUUID(),
    models: [...LATEST_MODELS],
    credits: 500,
    attempts: 60,
    minutes: 45,
  })
}
test("latest profile authorizes exactly the six models and 52 nominal attempts", () => {
  const auth = readLatestAuthorization(fixture())
  expect(Object.keys(auth.cases)).toHaveLength(34)
  const nominal = Object.keys(auth.cases).reduce((sum, id) => {
    const kind = (
      Object.keys(LATEST_KINDS) as Array<keyof typeof LATEST_KINDS>
    ).find((value) => id.endsWith(`-${value}`))
    if (!kind) throw new Error("Missing authorized scenario kind")
    return sum + LATEST_KINDS[kind].nominal
  }, 0)
  expect(nominal).toBe(52)
  expect(auth.cumulative.admissionCredits).toBe(450)
  expect(auth.cumulative.phases.clients.credits).toBe(450)
})
test("latest rejects model substitution, wider budgets, source and price tampering", () => {
  const saved = fixture()
  for (const patch of [
    { models: ["gpt-5.6-sol"] },
    { credits: 501 },
    { attempts: 61 },
    { minutes: 46 },
    { approved: false },
    { executionSha256: "bad" },
    { prices: {} },
    { cases: {} },
    { baseAttempts: 1 },
    { priorLedgerSha256: "a".repeat(64) },
  ])
    expect(() => readLatestAuthorization({ ...saved, ...patch })).toThrow()
})

test("latest snapshot binds reuse to an owned synthetic native sandbox fixture", () => {
  const saved = {
    ...fixture(),
    codexFixtureDirectory: path.resolve(
      import.meta.dir,
      "../../_runlog/client-fixtures/copilot-codex-admission-ABC123",
    ),
  }
  expect(readLatestAuthorization(saved).codexFixtureDirectory).toBe(
    saved.codexFixtureDirectory,
  )
  expect(() =>
    readLatestAuthorization({
      ...saved,
      codexFixtureDirectory: path.resolve(import.meta.dir, "../../private"),
    }),
  ).toThrow()
})

test("approval references are explicit and historical references remain readable", () => {
  const saved = fixture()
  expect(() =>
    readLatestAuthorization({ ...saved, approvalReference: "" }),
  ).toThrow()
  const historic = {
    ...saved,
    approvalReference: "Historical operator approval on 2026-10-02",
  }
  expect(readLatestAuthorization(historic).approvalReference).toBe(
    historic.approvalReference,
  )
})

test("authorization price snapshots cannot mutate the canonical tariff", () => {
  const saved = fixture()
  const price = saved.prices["gpt-6-astra"].default
  if (!price) throw new Error("Expected Astra tariff in synthetic snapshot")
  price.input = 0
  expect(() => readLatestAuthorization(saved)).toThrow("prices")
  expect(
    readLatestAuthorization(fixture()).prices["gpt-6-astra"]?.default.input,
  ).toBe(10)
})
