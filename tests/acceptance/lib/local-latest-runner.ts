import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { E2eKind } from "./local-e2e-authorization"
import type { MatrixCase } from "./local-matrix-authorization"

import { cacheBody, cacheEvidence, cacheFixture } from "../cache"
import { record, type Json } from "./local-budget"
import { summarizeE2eCoverage } from "./local-e2e-coverage"
import { runKind } from "./local-e2e-scenarios"
import { executionManifest, identitySha256 } from "./local-identity"
import {
  buildLatestAuthorization,
  latestCases,
  LATEST_KINDS,
  readLatestAuthorization,
  type LatestAuthorization,
  type LatestKind,
} from "./local-latest-authorization"
import { validateLatestDiagnostics } from "./local-latest-diagnostics"
import { latestOptions } from "./local-latest-options"
import { offline, runCommand } from "./local-offline-gate"
import {
  AcceptanceRuntime,
  assert,
  ROOT,
  ACCEPTANCE_PORT,
  sourceManifest,
} from "./local-runtime"
import { responseText } from "./local-wire"

type Options = ReturnType<typeof latestOptions>
type Check = { name: string; pass: boolean; exitCode: number }
interface LatestCase extends MatrixCase {
  id: string
  kind: LatestKind
}

function cases(models: Array<string>): Array<LatestCase> {
  return Object.entries(latestCases(models)).map(([id, cap]) => {
    const kind = (Object.keys(LATEST_KINDS) as Array<LatestKind>).find(
      (key) => id === `latest-${cap.model}-${key}`,
    )
    assert(kind, "Unknown latest scenario")
    return { ...cap, id, kind }
  })
}

function authorization(
  directory: string,
  options: Options,
): LatestAuthorization {
  assert(options.approvalReference, "Live approval reference missing")
  const file = path.join(directory, "authorization.json")
  if (!existsSync(file)) {
    assert(
      !existsSync(path.join(directory, "ledger.jsonl")),
      "Existing latest ledger requires its original authorization",
    )
    writeFileSync(
      file,
      JSON.stringify(
        buildLatestAuthorization({
          roundId: `latest-${randomUUID()}`,
          budgetDirectory: directory,
          approvalReference: options.approvalReference,
          executionSha256: identitySha256(executionManifest()),
          fixtureSalt: randomUUID(),
          models: options.models,
          credits: options.credits,
          attempts: options.attempts,
          minutes: options.minutes,
          codexFixtureDirectory: options.codexFixtureDirectory,
        }),
        null,
        2,
      ),
      { encoding: "utf8", flag: "wx" },
    )
  }
  const saved = readLatestAuthorization(
    record(JSON.parse(readFileSync(file, "utf8"))),
  )
  assert(
    saved.executionSha256 === identitySha256(executionManifest()),
    "Latest source changed; continuation blocked",
  )
  assert(
    saved.budgetDirectory === directory
      && JSON.stringify(saved.models) === JSON.stringify(options.models)
      && saved.additionalCredits === options.credits
      && saved.additionalAttempts === options.attempts
      && saved.additionalMinutes === options.minutes,
    "Latest directory, model or limit binding changed",
  )
  assert(
    saved.approvalReference === options.approvalReference,
    "Latest approval reference changed",
  )
  assert(
    saved.codexFixtureDirectory === options.codexFixtureDirectory,
    "Latest Codex fixture binding changed",
  )
  return saved
}

async function cacheCase(
  runtime: AcceptanceRuntime,
  scenario: LatestCase,
  auth: LatestAuthorization,
) {
  const { id, kind } = scenario
  const group = kind.includes("control") ? "control" : "prefix"
  const suffix = kind.endsWith("suffix")
  const result = await runtime.responses(
    id,
    cacheBody(cacheFixture(group, auth.fixtureSalt), suffix) as unknown as Json,
    "comparison",
  )
  const counters = cacheEvidence(result)
  assert(
    responseText(result).trim() === (suffix ? "CACHE_OK_B" : "CACHE_OK_A"),
    "Cache lookup answer mismatch",
  )
  const file = path.join(runtime.directory, "cache-observations.json")
  const previous: Array<Json> =
    existsSync(file) ?
      (JSON.parse(readFileSync(file, "utf8")) as Array<Json>)
    : []
  previous.push({
    caseId: id,
    policy: group === "control" ? "off" : "prefix-v1",
    ...counters,
  })
  writeFileSync(file, JSON.stringify(previous, null, 2))
  return `Exact catalogue answer; cache read ${counters.cached_input_tokens ?? "unknown"}/${counters.input_tokens ?? "unknown"}`
}

function diagnostics(directory: string, auth: LatestAuthorization) {
  const file = path.join(directory, "diagnostic-cases.jsonl")
  assert(existsSync(file), "Correlated Responses diagnostic log missing")
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)))
  return validateLatestDiagnostics(rows, auth.models, auth.fixtureSalt)
}
interface ReportInput {
  directory: string
  options: Options
  checks: Array<Check>
  runtime?: AcceptanceRuntime
  fatal?: string
}
function buildSummary(input: ReportInput) {
  const { options, checks, runtime, fatal } = input
  const outcomes = cases(options.models).map(
    (scenario) =>
      runtime?.results.findLast((item) => item.id === scenario.id) ?? {
        id: scenario.id,
        phase: scenario.phase,
        status: "blocked",
        attempts: 0,
        durationMs: 0,
        detail: fatal ?? "Live requests not run",
      },
  )
  const auth = runtime?.e2e
  const coverage =
    runtime && auth ?
      summarizeE2eCoverage({
        grants: runtime.ledger.grants,
        observations: runtime.ledger.observations,
        models: options.models,
        cases: outcomes,
        roundId: auth.roundId,
        stage: "latest",
      })
    : []
  const sourceUnchanged =
    runtime ?
      JSON.stringify(runtime.manifest) === JSON.stringify(sourceManifest())
    : false
  const executionUnchanged =
    auth?.executionSha256 === identitySha256(executionManifest())
  const complete =
    sourceUnchanged
    && executionUnchanged
    && !fatal
    && checks.every((check) => check.pass)
    && outcomes.every((item) => item.status === "pass")
  return {
    schemaVersion: 1,
    profile: "latest",
    complete,
    fatal: fatal ?? null,
    sourceSha256: auth?.executionSha256 ?? identitySha256(executionManifest()),
    models: options.models,
    limits: {
      credits: options.credits,
      admissionCredits: options.credits * 0.9,
      attempts: options.attempts,
      minutes: options.minutes,
    },
    budget: runtime?.ledger.summary() ?? { attempts: 0, reservedCredits: 0 },
    elapsedMs: runtime ? runtime.clock.elapsedMs() : 0,
    checks,
    coverage,
    results: outcomes,
    productionSourceUnchanged: sourceUnchanged,
    executionUnchanged,
    interpretation:
      "Results list observed live coverage only. Fault/fallback/native-Messages contracts are offline-only. Advanced live scenarios are scoped to gpt-5.6-luna. Reservations are conservative bounds, not account debits; unknown usage remains unknown.",
  }
}
function renderReport(summary: ReturnType<typeof buildSummary>) {
  return [
    `# ${summary.models.length}-model latest-commit acceptance — ${summary.complete ? "PASS" : "INCOMPLETE"}`,
    "",
    `Source SHA-256: ${summary.sourceSha256}`,
    "",
    `Budget: ${summary.budget.attempts} upstream attempts; ${summary.budget.reservedCredits.toFixed(6)} conservative reserved credits.`,
    "Reservations are not actual account debits. Missing usage remains unknown.",
    `Live limit: ${summary.limits.minutes} minutes, ${summary.limits.attempts} attempts, ${summary.limits.credits} credits (${summary.limits.admissionCredits} admission limit).`,
    summary.fatal ? `\nStop: ${summary.fatal}\n` : "",
    "| Model | Passed | Attempts | Input/output usage | Cache usage |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...summary.coverage.map(
      (row) =>
        `| ${row.model} | ${row.casesPassed}/${row.casesTotal} | ${row.attempts} | ${row.usageCoverage} | ${row.cacheCoverage} |`,
    ),
    "",
    "| Scenario | Verdict | Attempts | Evidence |",
    "| --- | --- | ---: | --- |",
    ...summary.results.map(
      (item) =>
        `| ${item.id} | ${item.status.toUpperCase()} | ${item.attempts} | ${item.detail.replaceAll("|", "/").replaceAll(/\r?\n/gu, " ")} |`,
    ),
    "",
    "Offline checks: "
      + summary.checks
        .map((check) => `${check.name}=${check.pass ? "PASS" : "FAIL"}`)
        .join(", "),
    "",
    summary.interpretation,
    "Cache counters and policy acceptance do not establish incremental savings. Final-response and attempt usage are separate views and must not be added.",
    "Raw CLI logs and isolated client sessions are local diagnostics and must not be published wholesale. Historical reports remain separate.",
  ].join("\n")
}
function report(input: ReportInput) {
  const summary = buildSummary(input)
  writeFileSync(
    path.join(input.directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  )
  writeFileSync(path.join(input.directory, "REPORT.md"), renderReport(summary))
  console.log(`Report: ${path.join(input.directory, "REPORT.md")}`)
  if (input.options.live && !summary.complete) failRun()
}
function failRun() {
  process.exitCode = 1
}
function assertLiveAdmission(runtime: AcceptanceRuntime) {
  assert(!runtime.halted, "Latest persisted stop prevents admission")
  const cacheGrants = runtime.ledger.grants.filter((grant) =>
    grant.caseId.includes("-cache-"),
  )
  const cacheResults = runtime.results.filter((result) =>
    result.id.includes("-cache-"),
  )
  assert(
    cacheGrants.length === 0 || cacheResults.length === 6,
    "Interrupted cache experiment cannot continue across process-local fingerprints; no paid requests started",
  )
}
function assertCatalog(runtime: AcceptanceRuntime, models: Array<string>) {
  for (const id of models) {
    const model = runtime.catalog.find((entry) => entry.id === id)
    const supports = record(record(model?.capabilities).supports)
    assert(
      Array.isArray(model?.supported_endpoints)
        && model.supported_endpoints.includes("/responses")
        && Array.isArray(supports.reasoning_effort)
        && supports.reasoning_effort.includes("low"),
      "Authorized model capability missing",
    )
  }
}
async function runCases(runtime: AcceptanceRuntime, auth: LatestAuthorization) {
  assertCatalog(runtime, auth.models)
  for (const scenario of cases(auth.models)) {
    if (runtime.results.some((result) => result.id === scenario.id)) continue
    await runtime.management("configure", {
      caseId: scenario.id,
      phase: scenario.phase,
      cachePolicy:
        scenario.kind.startsWith("cache-prefix-") ? "prefix-v1" : "off",
    })
    await runtime.runCase(scenario.id, scenario.phase, () =>
      scenario.kind.startsWith("cache-") ?
        cacheCase(runtime, scenario, auth)
      : runKind(runtime, {
          id: scenario.id,
          model: scenario.model,
          kind: scenario.kind as E2eKind,
        }),
    )
    if (runtime.halted) break
  }
}

async function live(directory: string, options: Options, checks: Array<Check>) {
  const auth = authorization(directory, options)
  const runtime = new AcceptanceRuntime(directory, options.credits, {
    authorizationFile: path.join(directory, "authorization.json"),
  })
  let fatal: string | undefined
  try {
    assertLiveAdmission(runtime)
    await runtime.authenticate()
    await runtime.startProxy()
    await runCases(runtime, auth)
    assert(
      !runtime.halted,
      runtime.ledger.stopReason ?? "Live admission stopped",
    )
  } catch (error) {
    fatal = error instanceof Error ? error.message : "Latest live failure"
  } finally {
    try {
      await runtime.close()
    } catch (error) {
      fatal = [
        fatal,
        error instanceof Error ? error.message : "Latest cleanup failure",
      ]
        .filter(Boolean)
        .join("; cleanup: ")
    }
  }
  try {
    const observed = diagnostics(directory, auth)
    writeFileSync(
      path.join(directory, "diagnostic-coverage.json"),
      JSON.stringify(observed, null, 2),
    )
    const usage = await runCommand(directory, "usage-summary", [
      process.execPath,
      "run",
      "usage:summary",
      path.join(directory, "diagnostics.log"),
      "--json",
    ])
    checks.push(usage)
  } catch (error) {
    fatal ??=
      error instanceof Error ? error.message : "Diagnostic validation failed"
  }
  report({ directory, options, checks, runtime, fatal })
}

function printLatestPlan(options: Options, selected: Array<LatestCase>) {
  console.log(
    JSON.stringify(
      {
        profile: "latest",
        live: false,
        models: options.models,
        credits: options.credits,
        admissionCredits: options.credits * 0.9,
        attempts: options.attempts,
        minutes: options.minutes,
        proxyPort: ACCEPTANCE_PORT,
        codexFixtureDirectory: options.codexFixtureDirectory,
        nominalAttempts: selected.reduce(
          (sum, scenario) => sum + LATEST_KINDS[scenario.kind].nominal,
          0,
        ),
        cases: selected,
        pricingSource:
          "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
        pricesVerifiedAt: "2026-10-02",
      },
      null,
      2,
    ),
  )
}

export async function runLatest(args: Array<string>) {
  const options = latestOptions(args)
  if (options.verifyEvidence) {
    assert(
      options.directory,
      "Evidence verification requires an existing output directory",
    )
    const { verifyLatestEvidence } = await import(
      "./local-latest-evidence-verifier"
    )
    await verifyLatestEvidence(path.resolve(options.directory))
    return
  }
  const selected = cases(options.models)
  if (options.dryRun) {
    printLatestPlan(options, selected)
    return
  }
  const directory = path.resolve(
    options.directory
      ?? path.join(
        ROOT,
        "tests/_runlog",
        `latest-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
      ),
  )
  mkdirSync(directory, { recursive: true })
  console.log(`Latest evidence: ${directory}`)
  const checks = await offline(directory)
  if (checks.every((check) => check.pass)) {
    checks.push(
      await runCommand(directory, "lint", [
        process.execPath,
        "run",
        "lint",
        "tests/acceptance/lib/local-*.ts",
        "tests/acceptance/local.ts",
        "tests/acceptance/repros/*-tool-admission.ts",
      ]),
    )
    for (const client of ["codex", "claude"])
      checks.push(
        await runCommand(directory, `${client}-version`, [
          Bun.which(client) ?? client,
          "--version",
        ]),
      )
  }
  if (checks.every((check) => check.pass)) {
    for (const [name, script] of [
      ["codex-tool-preflight", "codex-tool-admission.ts"],
      ["claude-tool-preflight", "claude-tool-admission.ts"],
    ])
      checks.push(
        await runCommand(directory, name, [
          process.execPath,
          "--no-env-file",
          "--preload",
          path.join(import.meta.dir, "local-network-deny.ts"),
          path.join(ROOT, "tests/acceptance/repros", script),
          ...(name === "codex-tool-preflight" && options.codexFixtureDirectory ?
            ["--fixture-dir", options.codexFixtureDirectory]
          : []),
        ]),
      )
  }
  writeFileSync(
    path.join(directory, "preflight.json"),
    JSON.stringify(checks, null, 2),
  )
  if (checks.some((check) => !check.pass)) {
    report({
      directory,
      options,
      checks,
      fatal:
        "Offline or client admission gate failed; no paid requests started",
    })
    failRun()
  } else if (options.live) await live(directory, options, checks)
  else report({ directory, options, checks })
}
