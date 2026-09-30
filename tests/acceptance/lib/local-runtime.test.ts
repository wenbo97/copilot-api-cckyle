import { afterEach, expect, spyOn, test } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { checkUsageReconciliation } from "./local-operations"
import {
  AcceptanceBlockedError,
  AcceptanceRuntime,
  AcceptanceTimeoutError,
} from "./local-runtime"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function createRuntime() {
  const directory = mkdtempSync(path.join(tmpdir(), "copilot-accept-runtime-"))
  directories.push(directory)
  return new AcceptanceRuntime(directory, 1000)
}

const request = {
  caseId: "fixture",
  phase: "functional" as const,
  model: "gpt-5.6-luna",
  endpoint: "/responses",
  inputTokens: 1000,
  outputTokens: 100,
  effort: "low",
  limitApplied: false,
}

test("quota/permission/rate-limit responses stop subsequent live admission", async () => {
  for (const status of [402, 403, 429]) {
    const runtime = createRuntime()
    try {
      const grant = runtime.ledger.reserve(request)
      runtime.recordObservation(grant.id, {
        status,
        outcome: "http_error",
        usage: null,
      })
      expect(runtime.halted).toBe(true)
      expect(runtime.ledger.summary().reservedCredits).toBeGreaterThan(0)
    } finally {
      await runtime.close()
    }
  }
})

test("per-field usage coverage keeps missing output unknown and observed zero", async () => {
  const runtime = createRuntime()
  try {
    const grant = runtime.ledger.reserve(request)
    runtime.recordObservation(grant.id, {
      outcome: "completed",
      usage: { input_tokens: 0 },
    })
    const summary = checkUsageReconciliation(runtime)
    expect(summary.observedInputTokens).toBe(0)
    expect(summary.inputTokensCoverage).toBe(1)
    expect(summary.observedOutputTokens).toBeNull()
    expect(summary.outputTokensCoverage).toBe(0)
  } finally {
    await runtime.close()
  }
})

test("a targeted continuation retains both results and reserved attempts", async () => {
  const runtime = createRuntime()
  runtime.ledger.reserve(request)
  runtime.results.push({
    id: "previous",
    phase: "functional",
    status: "pass",
    detail: "fixture",
    durationMs: 1,
    attempts: 1,
  })
  await runtime.close()
  const continued = new AcceptanceRuntime(runtime.directory, 1000)
  try {
    expect(continued.ledger.summary().attempts).toBe(1)
    expect(continued.results[0].id).toBe("previous")
  } finally {
    await continued.close()
  }
})

test("account stops and observed reservation overruns survive continuation", async () => {
  for (const observation of [
    { status: 402, outcome: "http_error", usage: null },
    { status: 429, outcome: "http_error", usage: null },
    { status: 200, outcome: "completed", usage: { input_tokens: 1001 } },
  ]) {
    const runtime = createRuntime()
    const grant = runtime.ledger.reserve(request)
    runtime.recordObservation(grant.id, observation)
    await runtime.close()
    const continued = new AcceptanceRuntime(runtime.directory, 1000)
    try {
      expect(continued.halted).toBe(true)
      expect(continued.ledger.summary().attempts).toBe(1)
    } finally {
      await continued.close()
    }
  }
})

test("cross-version followups inherit the ledger and cannot reset additional limits", async () => {
  const previous = createRuntime()
  previous.ledger.reserve(request)
  await previous.close()
  const evidence = mkdtempSync(path.join(tmpdir(), "copilot-followup-"))
  directories.push(evidence)
  const historical = readFileSync(
    path.join(previous.directory, "result.json"),
    "utf8",
  )
  const options = {
    budgetDirectory: previous.directory,
    additionalCredits: 30,
    additionalAttempts: 1,
    additionalMinutes: 15,
  }
  const current = new AcceptanceRuntime(evidence, 1000, options)
  try {
    expect(current.ledger.summary().attempts).toBe(1)
    current.ledger.reserve({ ...request, caseId: "claude-smoke" })
    expect(() =>
      current.ledger.reserve({ ...request, caseId: "claude-smoke" }),
    ).toThrow("Additional")
    expect(() => new AcceptanceRuntime(evidence, 1000, options)).toThrow(
      "locked",
    )
  } finally {
    await current.close()
  }
  const continued = new AcceptanceRuntime(evidence, 1000, options)
  try {
    expect(continued.ledger.summary().attempts).toBe(2)
    expect(() => continued.ledger.reserve(request)).toThrow("Additional")
    expect(
      readFileSync(path.join(previous.directory, "result.json"), "utf8"),
    ).toBe(historical)
  } finally {
    await continued.close()
  }
  expect(() => new AcceptanceRuntime(evidence, 1000)).toThrow("budget-dir")
  const contractFile = path.join(previous.directory, "followup-budget.json")
  renameSync(contractFile, `${contractFile}.preserved`)
  expect(() => new AcceptanceRuntime(evidence, 1000, options)).toThrow(
    "Missing",
  )
  const freshEvidence = mkdtempSync(
    path.join(tmpdir(), "copilot-followup-fresh-"),
  )
  directories.push(freshEvidence)
  expect(() => new AcceptanceRuntime(freshEvidence, 1000, options)).toThrow(
    "Missing",
  )
})

test("empty and valid-tail-truncated historical ledgers fail closed", async () => {
  for (const empty of [true, false]) {
    const previous = createRuntime()
    previous.ledger.reserve(request)
    const last = previous.ledger.reserve(request)
    previous.recordObservation(last.id, {
      outcome: "http_error",
      status: 429,
      usage: null,
    })
    await previous.close()
    const ledger = path.join(previous.directory, "ledger.jsonl")
    const rows = readFileSync(ledger, "utf8").trim().split("\n")
    writeFileSync(
      ledger,
      empty ? "" : `${rows.slice(0, -1).join("\n")}\n`,
      "utf8",
    )
    const evidence = mkdtempSync(
      path.join(tmpdir(), "copilot-followup-truncated-"),
    )
    directories.push(evidence)
    expect(
      () =>
        new AcceptanceRuntime(evidence, 1000, {
          budgetDirectory: previous.directory,
          additionalCredits: 30,
          additionalAttempts: 20,
          additionalMinutes: 15,
        }),
    ).toThrow()
  }
})

test("cleanup persistence failure stops the controller and retains accounting ownership", async () => {
  const runtime = createRuntime()
  const checkpoint = spyOn(runtime.clock, "checkpoint").mockImplementation(
    () => {
      throw new Error("Synthetic persistence failure")
    },
  )
  expect(await runtime.close().catch((error: unknown) => error)).toBeInstanceOf(
    Error,
  )
  expect(() => new AcceptanceRuntime(runtime.directory, 1000)).toThrow("locked")
  checkpoint.mockRestore()
  await runtime.close()
})

test("cross-version source changes preserve historical stops, credits, and active time", async () => {
  const previous = createRuntime()
  const grant = previous.ledger.reserve(request)
  previous.recordObservation(grant.id, {
    status: 429,
    outcome: "http_error",
    usage: null,
  })
  await previous.close()
  writeFileSync(
    path.join(previous.directory, "source-manifest.json"),
    JSON.stringify({ historical: "old-revision" }),
    "utf8",
  )
  const evidence = mkdtempSync(path.join(tmpdir(), "copilot-followup-"))
  directories.push(evidence)
  const options = {
    budgetDirectory: previous.directory,
    additionalCredits: 0.001,
    additionalAttempts: 20,
    additionalMinutes: 15,
  }
  const current = new AcceptanceRuntime(evidence, 1000, options)
  expect(current.halted).toBe(true)
  expect(() =>
    current.ledger.reserve({ ...request, caseId: "claude-smoke" }),
  ).toThrow("Additional")
  const base = current.budgetSession.summary()?.baseElapsedMs ?? 0
  await current.close()
  writeFileSync(
    path.join(previous.directory, "live-time.json"),
    JSON.stringify({ elapsedMs: Math.ceil(base + 900001) }),
    "utf8",
  )
  const continued = new AcceptanceRuntime(evidence, 1000, options)
  try {
    expect(continued.halted).toBe(true)
    expect(() =>
      continued.ledger.reserve({ ...request, caseId: "claude-smoke" }),
    ).toThrow("deadline")
    expect(
      readFileSync(
        path.join(previous.directory, "source-manifest.json"),
        "utf8",
      ),
    ).toContain("old-revision")
  } finally {
    await continued.close()
  }
})

test("guard stops survive a new source evidence directory", async () => {
  const previous = createRuntime()
  await previous.close()
  writeFileSync(
    path.join(previous.directory, "blocked.jsonl"),
    `${JSON.stringify({ reason: "Additional scenario attempt limit reached" })}\n`,
    "utf8",
  )
  const evidence = mkdtempSync(path.join(tmpdir(), "copilot-followup-stopped-"))
  directories.push(evidence)
  const current = new AcceptanceRuntime(evidence, 1000, {
    budgetDirectory: previous.directory,
    additionalCredits: 30,
    additionalAttempts: 20,
    additionalMinutes: 15,
  })
  try {
    expect(current.halted).toBe(true)
    expect(() =>
      current.ledger.reserve({ ...request, caseId: "claude-smoke" }),
    ).toThrow("Persisted acceptance stop")
  } finally {
    await current.close()
  }
})

test("the active deadline shuts down owned proxy work without another request", async () => {
  const runtime = createRuntime()
  const stopped = spyOn(runtime, "stopProxy").mockResolvedValue()
  const expired = spyOn(runtime.budgetSession, "expired").mockReturnValue(true)
  try {
    await Bun.sleep(1200)
    expect(runtime.halted).toBe(true)
    expect(stopped).toHaveBeenCalledTimes(1)
  } finally {
    expired.mockRestore()
    stopped.mockRestore()
    await runtime.close()
  }
})

const stoppingCases: Array<[Error, "blocked" | "fail"]> = [
  [
    new AcceptanceBlockedError("Synthetic model-tool policy rejection"),
    "blocked",
  ],
  [new AcceptanceTimeoutError("Synthetic client timeout"), "fail"],
  [new DOMException("Synthetic basic request timeout", "TimeoutError"), "fail"],
]
test.each(stoppingCases)(
  "client stopping errors retain classification and stop later cases: %s",
  async (error, status) => {
    const runtime = createRuntime()
    runtime.child = Bun.spawn(
      [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      await runtime.runCase("codex-tool", "clients", () =>
        Promise.reject(error),
      )
      expect(runtime.results.at(-1)?.status).toBe(status)
      expect(runtime.halted).toBe(true)
      expect(runtime.ledger.grants).toHaveLength(0)
      expect(runtime.ledger.stopReason).toBeDefined()
      let executed = false
      await runtime.runCase("later-case", "clients", () => {
        executed = true
        return Promise.resolve("must not execute")
      })
      expect(executed).toBe(false)
      expect(runtime.results.at(-1)?.status).toBe("blocked")
    } finally {
      await runtime.close()
    }
  },
)
