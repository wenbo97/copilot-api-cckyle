import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Reservation } from "./local-budget"

import { openBudget } from "./local-continuation"
import {
  buildLatestAuthorization,
  LATEST_MODELS,
} from "./local-latest-authorization"

test("fresh latest round preserves reservations, caps, lock and stops across reload", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "latest-budget-"))
  const authorizationFile = path.join(directory, "authorization.json")
  writeFileSync(
    authorizationFile,
    JSON.stringify(
      buildLatestAuthorization({
        roundId: "latest-test",
        budgetDirectory: directory,
        approvalReference: "Synthetic test approval; no live account",
        executionSha256: "a".repeat(64),
        fixtureSalt: randomUUID(),
        models: [...LATEST_MODELS],
        credits: 500,
        attempts: 60,
        minutes: 45,
      }),
    ),
  )
  const input = {
    directory,
    maxCredits: 500,
    previous: [],
    options: { authorizationFile },
  }
  const request: Reservation = {
    caseId: "latest-gpt-6-astra-codex-tool",
    model: "gpt-6-astra",
    phase: "clients",
    endpoint: "/responses",
    inputTokens: 30000,
    outputTokens: 2048,
    effort: "low",
    limitApplied: true,
  }
  try {
    const first = openBudget(input)
    expect(() => openBudget(input)).toThrow("locked")
    first.ledger.reserve(request)
    first.clock.checkpoint()
    first.release()
    const resumed = openBudget(input)
    expect(resumed.ledger.grants).toHaveLength(1)
    expect(resumed.ledger.grants[0].reservedCredits).toBe(77.74)
    expect(() =>
      resumed.ledger.reserve({ ...request, model: "gpt-5.6-sol" }),
    ).toThrow()
    resumed.ledger.reserve(request)
    resumed.ledger.reserve(request)
    expect(() => resumed.ledger.reserve(request)).toThrow("scenario attempt")
    resumed.ledger.halt("Account stop")
    resumed.clock.checkpoint()
    resumed.release()
    expect(() => openBudget(input)).toThrow("stopped")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("latest global attempts and active deadline cannot reset on continuation", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "latest-global-"))
  const authorizationFile = path.join(directory, "authorization.json")
  const saved = buildLatestAuthorization({
    roundId: "latest-global",
    budgetDirectory: directory,
    approvalReference: "Synthetic test approval; no live account",
    executionSha256: "a".repeat(64),
    fixtureSalt: randomUUID(),
    models: [...LATEST_MODELS],
    credits: 500,
    attempts: 60,
    minutes: 45,
  })
  writeFileSync(authorizationFile, JSON.stringify(saved))
  const input = {
    directory,
    maxCredits: 500,
    previous: [],
    options: { authorizationFile },
  }
  try {
    const first = openBudget(input)
    for (const [caseId, cap] of Object.entries(saved.cases).slice(0, 24))
      for (let i = 0; i < cap.attempts; i++)
        first.ledger.reserve({
          ...cap,
          caseId,
          inputTokens: 1,
          outputTokens: 1,
          limitApplied: false,
        })
    expect(first.ledger.grants).toHaveLength(60)
    first.clock.checkpoint()
    first.release()
    const resumed = openBudget(input)
    const [caseId, cap] = Object.entries(saved.cases)[24]
    expect(() =>
      resumed.ledger.reserve({
        ...cap,
        caseId,
        inputTokens: 1,
        outputTokens: 1,
        limitApplied: false,
      }),
    ).toThrow("attempt limit")
    resumed.release()
    const clockDirectory = path.join(directory, "clock")
    mkdirSync(clockDirectory)
    const clockAuthorization = path.join(clockDirectory, "authorization.json")
    writeFileSync(
      clockAuthorization,
      JSON.stringify({
        ...saved,
        roundId: "latest-clock",
        budgetDirectory: clockDirectory,
      }),
    )
    const clockInput = {
      ...input,
      directory: clockDirectory,
      options: { authorizationFile: clockAuthorization },
    }
    const initialClock = openBudget(clockInput)
    initialClock.clock.checkpoint()
    initialClock.release()
    writeFileSync(
      path.join(clockDirectory, "live-time.json"),
      JSON.stringify({ elapsedMs: 2700000 }),
    )
    const expired = openBudget(clockInput)
    expect(expired.expired()).toBe(true)
    expect(() =>
      expired.ledger.reserve({
        ...cap,
        caseId,
        inputTokens: 1,
        outputTokens: 1,
        limitApplied: false,
      }),
    ).toThrow("deadline")
    expired.release()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
