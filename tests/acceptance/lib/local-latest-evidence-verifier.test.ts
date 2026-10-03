import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { BudgetLedger } from "./local-budget"
import {
  buildLatestAuthorization,
  LATEST_MODELS,
} from "./local-latest-authorization"
import {
  LATEST_PREFLIGHT_NAMES,
  bindLatestEvidenceLedger,
  verifyLatestPreflight,
} from "./local-latest-evidence-verifier"

test("evidence verification requires every successful named gate, never an empty or partial list", () => {
  const checks = LATEST_PREFLIGHT_NAMES.map((name) => ({
    name,
    pass: true,
    exitCode: 0,
  }))
  expect(verifyLatestPreflight(checks)).toBe(true)
  expect(verifyLatestPreflight([])).toBe(false)
  expect(verifyLatestPreflight(checks.slice(0, -1))).toBe(false)
  expect(
    verifyLatestPreflight(
      checks.map((check) =>
        check.name === "codex-tool-preflight" ?
          { ...check, exitCode: 1 }
        : check,
      ),
    ),
  ).toBe(false)
  expect(
    verifyLatestPreflight([
      ...checks,
      { name: "failed-extra", pass: false, exitCode: 1 },
    ]),
  ).toBe(false)
})

test("evidence ledger binding preserves bytes and cannot clear a recorded safety stop", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "latest-evidence-stop-"))
  const file = path.join(directory, "ledger.jsonl")
  const saved = buildLatestAuthorization({
    roundId: "latest-evidence-test",
    budgetDirectory: directory,
    approvalReference: "Synthetic test approval; no live account",
    executionSha256: "a".repeat(64),
    fixtureSalt: randomUUID(),
    models: [...LATEST_MODELS],
    credits: 500,
    attempts: 60,
    minutes: 45,
  })
  try {
    const initial = new BudgetLedger(file, 500, 60)
    initial.enableCheckpoint()
    initial.activateAuthorization(saved.roundId, JSON.stringify(saved))
    const before = readFileSync(file, "utf8")
    const loaded = new BudgetLedger(file, 500, 60)
    loaded.enableCheckpoint()
    bindLatestEvidenceLedger(loaded, saved)
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(() =>
      bindLatestEvidenceLedger(loaded, {
        ...saved,
        approvalReference: "Changed approval",
      }),
    ).toThrow()
    loaded.halt("Observed usage exceeded reservation")
    const stopped = new BudgetLedger(file, 500, 60)
    stopped.enableCheckpoint()
    expect(() => bindLatestEvidenceLedger(stopped, saved)).toThrow("stopped")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
