import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BudgetLedger, record } from "./local-budget"
import { summarizeE2eCoverage } from "./local-e2e-coverage"
import { executionManifest, identitySha256 } from "./local-identity"
import { readLatestAuthorization } from "./local-latest-authorization"
import { validateLatestDiagnostics } from "./local-latest-diagnostics"
import { runCommand } from "./local-offline-gate"
import { assert, sourceManifest, type CaseResult } from "./local-runtime"

function readObject(directory: string, name: string) {
  return record(JSON.parse(readFileSync(path.join(directory, name), "utf8")))
}

export const LATEST_PREFLIGHT_NAMES = [
  "tests",
  "typecheck",
  "build",
  "offline-operations",
  "start-help",
  "summary-help",
  "lint",
  "codex-version",
  "claude-version",
  "codex-tool-preflight",
  "claude-tool-preflight",
]
export function verifyLatestPreflight(checks: Array<unknown>): boolean {
  return (
    checks.every(
      (check) => record(check).pass === true && record(check).exitCode === 0,
    )
    && LATEST_PREFLIGHT_NAMES.every((name) =>
      checks.some((check) => record(check).name === name),
    )
  )
}

/** Binding an existing authorization rejects persisted stops without writing a new entry. */
export function bindLatestEvidenceLedger(
  ledger: BudgetLedger,
  saved: Record<string, unknown>,
) {
  const auth = readLatestAuthorization(saved)
  assert(
    ledger.hasAuthorization(auth.roundId),
    "Recorded round authorization missing",
  )
  ledger.activateAuthorization(auth.roundId, JSON.stringify(saved))
}
function caseResult(raw: unknown): CaseResult {
  const value = record(raw)
  assert(
    typeof value.id === "string"
      && typeof value.phase === "string"
      && typeof value.detail === "string"
      && typeof value.status === "string"
      && ["blocked", "fail", "pass", "skipped"].includes(value.status)
      && typeof value.attempts === "number"
      && Number.isSafeInteger(value.attempts)
      && value.attempts >= 0
      && typeof value.durationMs === "number"
      && Number.isFinite(value.durationMs)
      && value.durationMs >= 0,
    "Invalid saved case result",
  )
  return value as unknown as CaseResult
}
function loadEvidence(directory: string) {
  assert(
    !existsSync(path.join(directory, "runner.lock")),
    "Cannot verify an active round",
  )
  const saved = readObject(directory, "authorization.json")
  const auth = readLatestAuthorization(saved)
  assert(
    auth.budgetDirectory === directory,
    "Evidence directory binding changed",
  )
  assert(
    readFileSync(path.join(directory, "authorization-origin.json"), "utf8")
      === JSON.stringify(saved),
    "Authorization origin changed",
  )
  const manifest = readObject(directory, "execution-manifest.json")
  assert(
    Object.values(manifest).every((value) => typeof value === "string"),
    "Invalid execution manifest",
  )
  assert(
    identitySha256(manifest as Record<string, string>) === auth.executionSha256,
    "Original execution manifest does not match authorization",
  )
  assert(
    readObject(directory, "loaded-identity.json").executionSha256
      === auth.executionSha256,
    "Loaded proxy identity changed",
  )
  assert(
    JSON.stringify(readObject(directory, "source-manifest.json"))
      === JSON.stringify(sourceManifest()),
    "Production source differs from live snapshot",
  )
  const ledgerFile = path.join(directory, "ledger.jsonl")
  assert(
    existsSync(`${ledgerFile}.checkpoint.json`),
    "Ledger checkpoint missing",
  )
  const ledger = new BudgetLedger(
    ledgerFile,
    auth.additionalCredits,
    auth.additionalAttempts,
  )
  ledger.enableCheckpoint()
  bindLatestEvidenceLedger(ledger, saved)
  const result = readObject(directory, "result.json")
  assert(
    result.sourceUnchanged === true && Array.isArray(result.results),
    "Original run source or results invalid",
  )
  const budget = record(result.budget)
  assert(
    budget.attempts === ledger.grants.length
      && Math.abs(
        Number(budget.reservedCredits) - ledger.summary().reservedCredits,
      ) < 0.000001,
    "Result and ledger disagree",
  )
  const elapsedMs = readObject(directory, "live-time.json").elapsedMs
  assert(
    typeof elapsedMs === "number"
      && Number.isSafeInteger(elapsedMs)
      && elapsedMs >= 0
      && elapsedMs <= auth.cumulative.activeMs,
    "Live time exceeded authorized limit",
  )
  const results = result.results.map((value) => caseResult(value))
  return { auth, ledger, elapsedMs, results }
}

/** Verifies saved evidence only: no authentication, proxy, clients or generation calls. */
export async function verifyLatestEvidence(directory: string) {
  const { auth, ledger, elapsedMs, results } = loadEvidence(directory)
  const rows = readFileSync(
    path.join(directory, "diagnostic-cases.jsonl"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)))
  const diagnostics = validateLatestDiagnostics(
    rows,
    auth.models,
    auth.fixtureSalt,
  )
  writeFileSync(
    path.join(directory, "diagnostic-coverage-verified.json"),
    JSON.stringify(diagnostics, null, 2),
  )
  const usage = await runCommand(directory, "usage-summary-verified", [
    process.execPath,
    "run",
    "usage:summary",
    path.join(directory, "diagnostics.log"),
    "--json",
  ])
  const checks: Array<unknown> = JSON.parse(
    readFileSync(path.join(directory, "preflight.json"), "utf8"),
  ) as Array<unknown>
  const required = Object.keys(auth.cases)
  const complete =
    usage.pass
    && verifyLatestPreflight(checks)
    && required.every(
      (id) => results.findLast((result) => result.id === id)?.status === "pass",
    )
    && ledger.grants.length <= auth.cumulative.attempts
    && ledger.summary().reservedCredits <= auth.cumulative.admissionCredits
  const coverage = summarizeE2eCoverage({
    grants: ledger.grants,
    observations: ledger.observations,
    models: auth.models,
    cases: results,
    roundId: auth.roundId,
    stage: "latest",
  })
  const summary = {
    profile: "latest",
    complete,
    sourceSha256: auth.executionSha256,
    verifierSourceSha256: identitySha256(executionManifest()),
    verificationMode: "saved-evidence-only",
    budget: ledger.summary(),
    elapsedMs,
    results,
    coverage,
    diagnostics,
    productionSourceUnchanged: true,
    originalExecutionIdentityVerified: true,
    interpretation:
      "One logical request is counted once. Identical logger replays retain their first correlation; conflicting summaries fail. Reservations are not account debits; unknown usage remains unknown. Original reports and raw evidence are preserved.",
  }
  writeFileSync(
    path.join(directory, "summary-verified.json"),
    JSON.stringify(summary, null, 2),
  )
  writeFileSync(
    path.join(directory, "REPORT-verified.md"),
    [
      `# ${auth.models.length}-model latest-commit acceptance — ${complete ? "PASS" : "INCOMPLETE"}`,
      "",
      `Live source SHA-256: ${auth.executionSha256}`,
      `Verifier source SHA-256: ${summary.verifierSourceSha256}`,
      "",
      `Cases: ${coverage.reduce((sum, row) => sum + row.casesPassed, 0)}/${required.length}. Attempts: ${ledger.grants.length}/${auth.cumulative.attempts}. Active live time: ${(elapsedMs / 60000).toFixed(2)}/${auth.additionalMinutes} minutes.`,
      `Conservative reservations: ${ledger.summary().reservedCredits.toFixed(6)} credits; admission limit ${auth.cumulative.admissionCredits}, authorized ceiling ${auth.cumulative.maxCredits}. Unknown-usage attempts: ${ledger.summary().unknownUsageAttempts}.`,
      "",
      "| Model | Passed | Attempts | Input/output usage | Cache usage |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...coverage.map(
        (row) =>
          `| ${row.model} | ${row.casesPassed}/${row.casesTotal} | ${row.attempts} | ${row.usageCoverage} | ${row.cacheCoverage} |`,
      ),
      "",
      `Diagnostic records: ${diagnostics.count} unique requests; ${diagnostics.identicalReplays} identical logger replay(s) deduplicated. Both ingress sources verified; cache-policy/prefix observations ${diagnostics.cachePoliciesVerified ? "verified" : "outside selected scope"}.`,
      "",
      summary.interpretation,
      `Requested models: ${auth.models.join(", ")}. Actual per-model verdicts are listed above. Shared advanced scenarios are scoped to gpt-5.6-luna when selected. Fault, fallback and native Messages contracts were offline-only.`,
      "Missing usage is not counted as zero. Cache policy acceptance or cache hits do not establish incremental prefix-v1 savings.",
      `Client configuration: owned synthetic ${auth.codexFixtureDirectory ? "reused" : "fresh"} Codex home, read-only/elevated Windows sandbox and approval never; separate Claude configuration homes. Original reports remain available.`,
      "This report revalidates existing records without replaying paid requests. The original live-source and current verifier identities are recorded separately; the live ledger/checkpoint and authorization remain unchanged.",
    ].join("\n"),
  )
  console.log(`Verified report: ${path.join(directory, "REPORT-verified.md")}`)
  if (!complete) failVerification()
}

function failVerification() {
  process.exitCode = 1
}
