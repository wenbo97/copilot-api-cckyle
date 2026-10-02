import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { BudgetLedger, type Reservation } from "./local-budget"
import { openBudget } from "./local-continuation"
import {
  buildE2eAuthorization,
  E2E_MODELS,
  readE2eAuthorization,
} from "./local-e2e-authorization"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture(stage: "matrix" | "legacy" = "matrix") {
  const directory = mkdtempSync(path.join(tmpdir(), "e2e-authorization-"))
  directories.push(directory)
  const ledger = new BudgetLedger(path.join(directory, "ledger.jsonl"))
  const old: Reservation = {
    caseId: "claude-tool",
    phase: "clients",
    model: "gpt-5.6-luna",
    endpoint: "/responses",
    inputTokens: 1000,
    outputTokens: 100,
    effort: "low",
    limitApplied: false,
  }
  ledger.reserve(old)
  ledger.halt("Bounded cache round completed")
  ledger.enableCheckpoint()
  writeFileSync(
    path.join(directory, "result.json"),
    JSON.stringify({ budget: ledger.summary() }),
  )
  writeFileSync(path.join(directory, "source-manifest.json"), "{}")
  writeFileSync(
    path.join(directory, "live-time.json"),
    JSON.stringify({ elapsedMs: 1000 }),
  )
  const priorContract = JSON.stringify({
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 0,
    additionalCredits: 30,
    additionalAttempts: 20,
    additionalMinutes: 15,
  })
  for (const name of ["followup-budget.json", "followup-origin.json"])
    writeFileSync(path.join(directory, name), priorContract)
  const prefix = readFileSync(ledger.file)
  const saved = buildE2eAuthorization({
    stage,
    roundId: `e2e-test-${stage}`,
    budgetDirectory: directory,
    approvalReference: "Synthetic bounded authorization",
    priorLedgerBytes: prefix.length,
    priorLedgerSha256: createHash("sha256").update(prefix).digest("hex"),
    baseAttempts: 1,
    baseCredits: ledger.summary().reservedCredits,
    baseElapsedMs: 1000,
    executionSha256: "a".repeat(64),
    phaseBaselines: {
      functional: { attempts: 0, credits: 0 },
      clients: { attempts: 1, credits: ledger.summary().reservedCredits },
      operations: { attempts: 0, credits: 0 },
      comparison: { attempts: 0, credits: 0 },
      recheck: { attempts: 0, credits: 0 },
    },
    legacyManifestSha256: stage === "legacy" ? "b".repeat(64) : undefined,
  })
  return { ledger, prefix, saved }
}

function request(caseId: string, model = "gpt-5.6-luna"): Reservation {
  return {
    caseId,
    phase: "functional",
    model,
    endpoint: "/responses",
    inputTokens: 1000,
    outputTokens: 100,
    effort: "low",
    limitApplied: false,
  }
}

test("v4 binds all eight models and exactly 176 matrix attempt slots", () => {
  const { saved } = fixture()
  const contract = readE2eAuthorization(saved)
  expect(E2E_MODELS).toHaveLength(8)
  expect(Object.keys(contract.cases)).toHaveLength(88)
  expect(
    Object.values(contract.cases).reduce(
      (sum, cap) => sum + (cap?.attempts ?? 0),
      0,
    ),
  ).toBe(176)
  expect(contract.prices["gpt-6.1-sol"]).toBeDefined()
  expect(contract.prices["gpt-5.6-sol-fast"]).toBeUndefined()
})

test("a v4 controller resumes from a stopped historical budget without resetting it", () => {
  const { ledger, prefix, saved } = fixture()
  const directory = mkdtempSync(path.join(tmpdir(), "e2e-round-"))
  directories.push(directory)
  const authorizationFile = path.join(directory, "authorization.json")
  writeFileSync(authorizationFile, JSON.stringify(saved))
  const options = {
    budgetDirectory: path.dirname(ledger.file),
    authorizationFile,
    additionalCredits: 1000,
    additionalAttempts: 176,
    additionalMinutes: 90,
  }
  const open = () =>
    openBudget({ directory, maxCredits: 1000, previous: [], options })
  const active = open()
  expect(active.ledger.stopReason).toBeUndefined()
  expect(
    active.ledger.reserve(request("e2e-gpt-5.6-luna-responses-json")).roundId,
  ).toBe(String(saved.roundId))
  active.release()
  const resumed = open()
  expect(resumed.ledger.grants).toHaveLength(2)
  expect(resumed.ledger.summary().reservedCredits).toBeGreaterThan(
    ledger.summary().reservedCredits,
  )
  expect(
    readFileSync(ledger.file).subarray(0, prefix.length).equals(prefix),
  ).toBe(true)
  expect(() =>
    resumed.ledger.reserve(request("e2e-gpt-5.6-luna-responses-json")),
  ).toThrow("scenario attempt limit")
  resumed.release()
})

test("v4 rejects changed caps, fake rates and an unapproved round", () => {
  const { saved } = fixture()
  for (const change of [
    { approved: false },
    { additionalCredits: 1001 },
    { prices: {} },
    { executionSha256: "not-a-digest" },
  ])
    expect(() => readE2eAuthorization({ ...saved, ...change })).toThrow()
})

test("v4 reservations reload without changing any historical bytes or prices", () => {
  const { ledger, saved, prefix } = fixture()
  ledger.activateAuthorization(String(saved.roundId), JSON.stringify(saved))
  const grant = ledger.reserve(request("e2e-gpt-5.6-luna-responses-json"))
  expect(grant.reservedCredits).toBe(0.057)
  const reloaded = new BudgetLedger(ledger.file)
  expect(reloaded.grants).toEqual(ledger.grants)
  expect(
    readFileSync(ledger.file).subarray(0, prefix.length).equals(prefix),
  ).toBe(true)
  expect(() =>
    reloaded.reserve(request("e2e-gpt-5.6-luna-responses-stream")),
  ).toThrow()
  reloaded.activateAuthorization(String(saved.roundId), JSON.stringify(saved))
  expect(
    reloaded.reserve(request("e2e-gpt-5.6-luna-responses-stream"))
      .reservedCredits,
  ).toBe(0.057)
  expect(() =>
    reloaded.reserve(request("e2e-gpt-5.6-luna-responses-stream")),
  ).toThrow()
})

test("an unpriced model cannot acquire a paid reservation", () => {
  const { ledger, saved } = fixture()
  ledger.activateAuthorization(String(saved.roundId), JSON.stringify(saved))
  expect(() =>
    ledger.reserve(
      request("e2e-gpt-5.6-sol-fast-responses-json", "gpt-5.6-sol-fast"),
    ),
  ).toThrow()
  expect(ledger.grants).toHaveLength(1)
})

test("large history uses long-context prices and only its two authorized slots", () => {
  const { ledger, saved } = fixture("legacy")
  ledger.activateAuthorization(String(saved.roundId), JSON.stringify(saved))
  const history: Reservation = {
    ...request("e2e-legacy-astra-fork", "gpt-6-astra"),
    phase: "recheck",
    inputTokens: 763696,
    outputTokens: 512,
  }
  expect(ledger.reserve(history).reservedCredits).toBe(3440.472)
  ledger.reserve({ ...history, caseId: "e2e-legacy-astra-resume" })
  expect(new BudgetLedger(ledger.file).grants).toHaveLength(3)
  expect(() =>
    ledger.reserve({ ...history, caseId: "e2e-legacy-astra-resume" }),
  ).toThrow()
})

test("legacy history remains capped at 8000 credits even with two legal-sized requests", () => {
  const { ledger, saved } = fixture("legacy")
  ledger.activateAuthorization(String(saved.roundId), JSON.stringify(saved))
  const history: Reservation = {
    ...request("e2e-legacy-astra-fork", "gpt-6-astra"),
    phase: "recheck",
    inputTokens: 1000000,
    outputTokens: 512,
  }
  ledger.reserve(history)
  expect(() =>
    ledger.reserve({ ...history, caseId: "e2e-legacy-astra-resume" }),
  ).toThrow()
  expect(ledger.grants).toHaveLength(2)
})
