import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { BudgetLedger } from "./local-budget"
import { openBudget } from "./local-continuation"
import {
  MATRIX_MODELS,
  readMatrixAuthorization,
} from "./local-matrix-authorization"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), "authorization-test-"))
  directories.push(directory)
  return directory
}
const request = {
  caseId: "claude-tool",
  phase: "clients" as const,
  model: "gpt-5.6-luna",
  endpoint: "/responses",
  inputTokens: 1000,
  outputTokens: 100,
  effort: "low",
  limitApplied: false,
}
function fixture() {
  const budgetDirectory = temporary()
  const directory = temporary()
  const ledger = new BudgetLedger(path.join(budgetDirectory, "ledger.jsonl"))
  ledger.reserve(request)
  ledger.halt("Additional scenario attempt limit reached")
  ledger.enableCheckpoint()
  writeFileSync(
    path.join(budgetDirectory, "result.json"),
    JSON.stringify({ budget: ledger.summary() }),
  )
  writeFileSync(path.join(budgetDirectory, "source-manifest.json"), "{}")
  writeFileSync(
    path.join(budgetDirectory, "live-time.json"),
    JSON.stringify({ elapsedMs: 1000 }),
  )
  writeFileSync(
    path.join(budgetDirectory, "blocked.jsonl"),
    JSON.stringify({ reason: ledger.stopReason }) + "\n",
  )
  const legacy = JSON.stringify({
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 0,
    additionalCredits: 30,
    additionalAttempts: 20,
    additionalMinutes: 15,
  })
  for (const file of ["followup-budget.json", "followup-origin.json"])
    writeFileSync(path.join(budgetDirectory, file), legacy)
  const prior = readFileSync(ledger.file)
  const authorization = {
    approved: true,
    approvalReference: "Synthetic test approval",
    roundId: "test-round",
    budgetDirectory,
    model: "gpt-5.6-luna",
    effort: "low",
    priorLedgerBytes: prior.length,
    priorLedgerSha256: createHash("sha256").update(prior).digest("hex"),
    baseAttempts: 1,
    baseCredits: ledger.summary().reservedCredits,
    baseElapsedMs: 1000,
    additionalCredits: 2,
    additionalAttempts: 2,
    additionalMinutes: 1,
    cases: {
      "claude-tool": { attempts: 1, inputTokens: 1000, outputTokens: 100 },
    },
  }
  const authorizationFile = path.join(directory, "authorization.json")
  const save = () =>
    writeFileSync(authorizationFile, JSON.stringify(authorization))
  save()
  const options = {
    budgetDirectory,
    authorizationFile,
    additionalCredits: 2,
    additionalAttempts: 2,
    additionalMinutes: 1,
  }
  return {
    prior,
    ledger,
    directory,
    authorization,
    options,
    save,
    open: () =>
      openBudget({ directory, maxCredits: 1000, previous: [], options }),
  }
}

function matrixFixture() {
  const f = fixture()
  const cases = Object.fromEntries(
    MATRIX_MODELS.flatMap((model) =>
      ["basic-json", "basic-stream", "claude-tool", "codex-tool"].map(
        (kind) => {
          const basic = kind.startsWith("basic-")
          const clientAttempts = kind === "claude-tool" ? 3 : 2
          return [
            `matrix-${model}-${kind}`,
            {
              model,
              phase: basic ? "functional" : "clients",
              endpoint: "/responses",
              effort: "low",
              attempts: basic ? 1 : clientAttempts,
              inputTokens: basic ? 4096 : 32768,
              outputTokens: basic ? 512 : 2048,
            },
          ]
        },
      ),
    ),
  )
  const authorization = {
    ...f.authorization,
    version: 2,
    additionalCredits: 825,
    additionalAttempts: 42,
    additionalMinutes: 30,
    cases,
    cumulative: {
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
    },
  }
  const save = () =>
    writeFileSync(f.options.authorizationFile, JSON.stringify(authorization))
  save()
  const options = {
    ...f.options,
    additionalCredits: 825,
    additionalAttempts: 42,
    additionalMinutes: 30,
  }
  return {
    ...f,
    authorization,
    save,
    open: () =>
      openBudget({
        directory: f.directory,
        maxCredits: 1000,
        previous: [],
        options,
      }),
  }
}

test("matrix round permits exact six-model workflows with explicit cumulative phase extension", () => {
  const f = matrixFixture()
  const matrix = readMatrixAuthorization(f.authorization)
  const opened = f.open()
  try {
    for (const [caseId, cap] of Object.entries(matrix.cases)) {
      if (!cap) throw new Error("Missing fixture scope")
      for (let index = 0; index < cap.attempts; index++)
        opened.ledger.reserve({
          ...request,
          caseId,
          phase: cap.phase,
          model: cap.model,
        })
    }
    expect(opened.ledger.summary().attempts).toBe(43)
    expect(
      opened.ledger.grants.filter((grant) => grant.phase === "clients"),
    ).toHaveLength(31)
    expect(
      opened.ledger.grants.find((grant) => grant.model === "gpt-6-astra")
        ?.reservedCredits,
    ).toBe(2.75)
    expect(
      opened.ledger.grants.find((grant) => grant.model === "gpt-6-luna")
        ?.reservedCredits,
    ).toBe(0.0275)
    expect(() =>
      opened.ledger.reserve({
        ...request,
        caseId: "matrix-gpt-5.6-luna-claude-tool",
      }),
    ).toThrow("Additional reservation limit")
  } finally {
    opened.release()
  }
  const resumed = f.open()
  try {
    expect(resumed.ledger.summary().attempts).toBe(43)
  } finally {
    resumed.release()
  }
  expect(
    readFileSync(f.ledger.file).subarray(0, f.prior.length).equals(f.prior),
  ).toBe(true)
})

test("matrix admission rejects wrong models, phases, endpoint and absent cumulative amendments", () => {
  const f = matrixFixture()
  const opened = f.open()
  try {
    const matrixRequest = {
      ...request,
      caseId: "matrix-gpt-6-astra-claude-tool",
      model: "gpt-6-astra",
    }
    expect(() =>
      opened.ledger.reserve({ ...matrixRequest, model: "gpt-6-sol" }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({ ...matrixRequest, phase: "comparison" }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({
        ...matrixRequest,
        endpoint: "/chat/completions",
      }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({ ...matrixRequest, inputTokens: 32769 }),
    ).toThrow("scope")
  } finally {
    opened.release()
  }
  const missing = { ...f.authorization, cumulative: undefined }
  expect(() => readMatrixAuthorization(missing)).toThrow("credit ceilings")
  expect(() =>
    readMatrixAuthorization({ ...f.authorization, approved: false }),
  ).toThrow("approved")
  expect(() =>
    readMatrixAuthorization({
      ...f.authorization,
      cumulative: { ...f.authorization.cumulative, phases: {} },
    }),
  ).toThrow("limit")
})

test("newly priced models and legacy Terra cannot expand scope without matrix authorization", () => {
  const f = fixture()
  const opened = f.open()
  try {
    expect(() =>
      opened.ledger.reserve({ ...request, model: "gpt-6-astra" }),
    ).toThrow("matrix authorization")
    expect(() =>
      opened.ledger.reserve({ ...request, model: "gpt-5.6-terra" }),
    ).toThrow("comparison")
  } finally {
    opened.release()
  }
})

test("matrix time amendment is explicit and cumulative deadline still stops admission", () => {
  const f = matrixFixture()
  const clockFile = path.join(f.options.budgetDirectory, "live-time.json")
  f.authorization.baseElapsedMs = 3500000
  f.save()
  writeFileSync(clockFile, JSON.stringify({ elapsedMs: 3500000 }))
  const opened = f.open()
  opened.release()
  writeFileSync(clockFile, JSON.stringify({ elapsedMs: 3700000 }))
  const continued = f.open()
  expect(continued.expired()).toBe(false)
  continued.release()
  writeFileSync(clockFile, JSON.stringify({ elapsedMs: 4733445 }))
  const expired = f.open()
  try {
    expect(expired.expired()).toBe(true)
    expect(() =>
      expired.ledger.reserve({
        ...request,
        caseId: "matrix-gpt-5.6-luna-claude-tool",
      }),
    ).toThrow("deadline")
  } finally {
    expired.release()
  }
})

test("explicit round retains stop bytes and all accounting; reopened round ignores migrated old stop", () => {
  const f = fixture()
  const first = f.open()
  first.ledger.reserve(request)
  expect(first.ledger.summary().attempts).toBe(2)
  expect(
    readFileSync(f.ledger.file).subarray(0, f.prior.length).equals(f.prior),
  ).toBe(true)
  first.release()
  const resumed = f.open()
  try {
    expect(resumed.ledger.stopReason).toBeUndefined()
    expect(() => resumed.ledger.reserve(request)).toThrow("scenario attempt")
    resumed.ledger.halt("Additional scenario attempt limit reached")
  } finally {
    resumed.release()
  }
  expect(() => f.open()).toThrow("round has stopped")
})

test("missing authorization remains stopped, and draft or hash tampering cannot activate", () => {
  const f = fixture()
  expect(() => new BudgetLedger(f.ledger.file).reserve(request)).toThrow(
    "Persisted",
  )
  f.authorization.approved = false
  f.save()
  expect(() => f.open()).toThrow("approved authorization")
  f.authorization.approved = true
  f.authorization.priorLedgerSha256 = "0".repeat(64)
  f.save()
  expect(() => f.open()).toThrow("current ledger")
  expect(readFileSync(f.ledger.file).equals(f.prior)).toBe(true)
})

test("round scope and immutable origin fail closed; bare reload cannot reuse authorization", () => {
  const f = fixture()
  const opened = f.open()
  try {
    expect(() =>
      opened.ledger.reserve({ ...request, caseId: "codex-tool" }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({ ...request, outputTokens: 101 }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({ ...request, endpoint: "/chat/completions" }),
    ).toThrow("scope")
    expect(() =>
      opened.ledger.reserve({ ...request, phase: "recheck" }),
    ).toThrow("scope")
  } finally {
    opened.release()
  }
  expect(() => new BudgetLedger(f.ledger.file).reserve(request)).toThrow(
    "Persisted",
  )
  f.authorization.cases["claude-tool"].attempts = 2
  f.save()
  expect(() => f.open()).toThrow("origin changed")
})

test("an approved round cannot reset cumulative attempts", () => {
  const f = fixture()
  const opened = f.open()
  opened.release()
  const constrained = new BudgetLedger(f.ledger.file, 1000, 1)
  constrained.enableCheckpoint()
  constrained.activateAuthorization(
    f.authorization.roundId,
    JSON.stringify(f.authorization),
  )
  expect(() => constrained.reserve(request)).toThrow("attempt limit")
})

test("missing round origin or ledger checkpoint prevents reopening", () => {
  for (const missing of [
    "authorization-test-round.json",
    "ledger.jsonl.checkpoint.json",
  ]) {
    const f = fixture()
    const opened = f.open()
    opened.release()
    rmSync(path.join(f.options.budgetDirectory, missing))
    expect(() => f.open()).toThrow("Missing")
  }
})

test("new authorization requires intact historical contracts and valid baseline", () => {
  for (const corruption of [
    "missing-contract",
    "missing-origin",
    "missing-both",
    "mismatch",
    "baseline",
  ]) {
    const f = fixture()
    const contract = path.join(
      f.options.budgetDirectory,
      "followup-budget.json",
    )
    const origin = path.join(f.options.budgetDirectory, "followup-origin.json")
    if (["missing-both", "missing-contract"].includes(corruption))
      rmSync(contract)
    if (["missing-both", "missing-origin"].includes(corruption)) rmSync(origin)
    if (corruption === "mismatch") writeFileSync(contract, "{}")
    if (corruption === "baseline") {
      const invalid = JSON.stringify({
        baseAttempts: 1,
        baseCredits: 999,
        baseElapsedMs: 0,
        additionalCredits: 30,
        additionalAttempts: 20,
        additionalMinutes: 15,
      })
      writeFileSync(contract, invalid)
      writeFileSync(origin, invalid)
    }
    expect(() => f.open()).toThrow()
    expect(readFileSync(f.ledger.file).equals(f.prior)).toBe(true)
  }
})
