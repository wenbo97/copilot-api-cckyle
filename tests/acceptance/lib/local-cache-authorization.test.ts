import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { cacheBody, cacheEvidence, cacheFixture } from "../cache"
import { BudgetLedger, prepareGeneration } from "./local-budget"
import {
  CACHE_CASE_IDS,
  CACHE_CUMULATIVE,
  readCacheAuthorization,
} from "./local-cache-authorization"
import { openBudget } from "./local-continuation"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), "cache-authorization-"))
  directories.push(directory)
  return directory
}
function fixture() {
  const budgetDirectory = temporary()
  const directory = temporary()
  const ledger = new BudgetLedger(path.join(budgetDirectory, "ledger.jsonl"))
  ledger.halt("Historical stop")
  ledger.enableCheckpoint()
  const prior = readFileSync(ledger.file)
  writeFileSync(
    path.join(budgetDirectory, "result.json"),
    JSON.stringify({ budget: ledger.summary() }),
  )
  writeFileSync(path.join(budgetDirectory, "source-manifest.json"), "{}")
  writeFileSync(
    path.join(budgetDirectory, "live-time.json"),
    JSON.stringify({ elapsedMs: 1000 }),
  )
  const legacy = JSON.stringify({
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 0,
    additionalCredits: 30,
    additionalAttempts: 20,
    additionalMinutes: 15,
  })
  for (const filename of ["followup-budget.json", "followup-origin.json"])
    writeFileSync(path.join(budgetDirectory, filename), legacy)
  const authorization = {
    version: 3,
    approved: true,
    approvalReference: "Synthetic bounded approval",
    roundId: "cache-test",
    budgetDirectory,
    model: "gpt-5.6-luna",
    effort: "low",
    priorLedgerBytes: prior.length,
    priorLedgerSha256: createHash("sha256").update(prior).digest("hex"),
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 1000,
    additionalCredits: 5,
    additionalAttempts: 6,
    additionalMinutes: 8,
    cases: Object.fromEntries(
      CACHE_CASE_IDS.map((id) => [
        id,
        {
          model: "gpt-5.6-luna",
          phase: "clients",
          endpoint: "/responses",
          effort: "low",
          attempts: 1,
          inputTokens: 16384,
          outputTokens: 256,
        },
      ]),
    ),
    cumulative: structuredClone(CACHE_CUMULATIVE),
  }
  const authorizationFile = path.join(directory, "authorization.json")
  const save = () =>
    writeFileSync(authorizationFile, JSON.stringify(authorization))
  save()
  const open = () =>
    openBudget({
      directory,
      maxCredits: 1000,
      previous: [],
      options: {
        budgetDirectory,
        authorizationFile,
        additionalCredits: 5,
        additionalAttempts: 6,
        additionalMinutes: 8,
      },
    })
  return { authorization, save, open, ledger, prior }
}
const request = {
  caseId: CACHE_CASE_IDS[0],
  model: "gpt-5.6-luna",
  phase: "clients" as const,
  endpoint: "/responses",
  effort: "low",
  inputTokens: 6000,
  outputTokens: 256,
  limitApplied: false,
}

test("cache round preserves historical stops and admits exactly one request per case", () => {
  const f = fixture()
  const opened = f.open()
  try {
    expect(
      readFileSync(opened.ledger.file)
        .subarray(0, f.prior.length)
        .equals(f.prior),
    ).toBe(true)
    expect(opened.ledger.hasHistoricalStop("Historical stop")).toBe(true)
    opened.ledger.reserve(request)
    expect(() => opened.ledger.reserve(request)).toThrow(
      "Additional scenario attempt",
    )
    expect(() =>
      opened.ledger.reserve({ ...request, caseId: "claude-tool" }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({
        ...request,
        caseId: CACHE_CASE_IDS[1],
        model: "gpt-6-astra",
      }),
    ).toThrow("scope")
    for (const caseId of CACHE_CASE_IDS.slice(1))
      opened.ledger.reserve({ ...request, caseId })
    expect(opened.ledger.summary().attempts).toBe(6)
    expect(() => opened.ledger.reserve(request)).toThrow(
      "Additional reservation limit",
    )
    opened.ledger.halt("Cache done")
  } finally {
    opened.release()
  }
  expect(() => f.open()).toThrow("round has stopped")
})

test("cache authorization rejects changed ceilings, extra scenarios, caps and approvals", () => {
  const f = fixture()
  for (const update of [
    { approved: false },
    { model: "gpt-6-luna" },
    { additionalAttempts: 7 },
    { additionalCredits: 6 },
    { cumulative: { ...CACHE_CUMULATIVE, attempts: 130 } },
    {
      cumulative: {
        ...CACHE_CUMULATIVE,
        phases: {
          ...CACHE_CUMULATIVE.phases,
          clients: { credits: 850, attempts: 47 },
        },
      },
    },
    {
      cases: {
        ...f.authorization.cases,
        extra: f.authorization.cases[CACHE_CASE_IDS[0]],
      },
    },
    {
      cases: {
        ...f.authorization.cases,
        [CACHE_CASE_IDS[0]]: {
          ...f.authorization.cases[CACHE_CASE_IDS[0]],
          attempts: 2,
        },
      },
    },
  ])
    expect(() =>
      readCacheAuthorization({ ...f.authorization, ...update }),
    ).toThrow()
  f.authorization.priorLedgerSha256 = "0".repeat(64)
  f.save()
  expect(() => f.open()).toThrow("current ledger")
})

test("cache evidence keeps unknown counters unknown and rejects impossible cached totals", () => {
  expect(cacheEvidence({})).toMatchObject({
    input_tokens: null,
    cached_input_tokens: null,
    copilot_nano_aiu: null,
  })
  expect(
    cacheEvidence({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 101 },
      },
    }).cached_input_tokens,
  ).toBeNull()
  expect(
    cacheEvidence({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
      },
      copilot_usage: { total_nano_aiu: 25 },
    }),
  ).toMatchObject({
    cache_hit_ratio: 0.8,
    cache_write_tokens: 10,
    copilot_nano_aiu: 25,
  })
})

test("fixture repeats exactly and changes only the final suffix within an arm", () => {
  const prefix = cacheFixture("control", "fixed-marker")
  const initial = cacheBody(prefix, false)
  const repeat = cacheBody(prefix, false)
  const suffix = cacheBody(prefix, true)
  expect(initial).toEqual(repeat)
  expect(
    Array.isArray(initial.input)
      && Array.isArray(suffix.input)
      && initial.input[0],
  ).toEqual(Array.isArray(suffix.input) && suffix.input[0])
  const prepared = prepareGeneration(
    "/responses",
    initial as unknown as Record<string, unknown>,
  )
  expect(prepared.inputTokens).toBeLessThan(16384)
  expect(prepared.outputTokens).toBe(256)
})
