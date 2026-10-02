import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BudgetLedger, PHASE_LIMITS, record, type Phase } from "./local-budget"
import {
  E2E_MODELS,
  E2E_LIMITS,
  E2E_PRICES,
  e2eCases,
  readE2eAuthorization,
  buildE2eAuthorization,
  type E2eStage,
} from "./local-e2e-authorization"
import { summarizeE2eCoverage } from "./local-e2e-coverage"
import {
  legacyManifest,
  prepareLegacyHistory,
  runLegacyHistory,
} from "./local-e2e-legacy"
import { E2E_MATRIX } from "./local-e2e-scenarios"
import { identitySha256, executionManifest } from "./local-identity"
import { offline, runCommand } from "./local-offline-gate"
import { AcceptanceRuntime, ROOT } from "./local-runtime"

const historicalBudget = path.join(
  ROOT,
  "tests/_runlog/local-acceptance-20260929",
)
const e2ePriceSource =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing"
function option(args: Array<string>, name: string, fallback = ""): string {
  const index = args.indexOf(name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}
function readHistorical() {
  const ledgerPath = path.join(historicalBudget, "ledger.jsonl")
  const ledgerBytes = readFileSync(ledgerPath)
  const checkpoint = record(
    JSON.parse(readFileSync(`${ledgerPath}.checkpoint.json`, "utf8")),
  )
  if (
    checkpoint.bytes !== ledgerBytes.length
    || checkpoint.sha256 !== sha256(ledgerBytes)
  )
    throw new Error("Historical ledger checkpoint mismatch")
  const ledger = new BudgetLedger(ledgerPath)
  const old = record(
    record(
      JSON.parse(
        readFileSync(path.join(historicalBudget, "result.json"), "utf8"),
      ),
    ).budget,
  )
  const count = Number(old.attempts)
  const credits = ledger.grants
    .slice(0, count)
    .reduce((sum, grant) => sum + grant.reservedCredits, 0)
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || ledger.grants.length < count
    || Math.abs(credits - Number(old.reservedCredits)) > 0.000001
  )
    throw new Error("Historical attempts or reservations changed")
  const clock = record(
    JSON.parse(
      readFileSync(path.join(historicalBudget, "live-time.json"), "utf8"),
    ),
  )
  const elapsedMs = Number(clock.elapsedMs)
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
    throw new Error("Historical active clock is invalid")
  const phaseBaselines = Object.fromEntries(
    Object.keys(PHASE_LIMITS).map((phase) => {
      const grants = ledger.grants.filter((grant) => grant.phase === phase)
      return [
        phase,
        {
          attempts: grants.length,
          credits: grants.reduce(
            (sum, grant) => sum + grant.reservedCredits,
            0,
          ),
        },
      ]
    }),
  ) as Record<Phase, { attempts: number; credits: number }>
  return { ledger, ledgerBytes, elapsedMs, phaseBaselines }
}
function authorization(
  stage: E2eStage,
  directory: string,
  provided: string,
): string {
  const filename =
    provided ?
      path.resolve(provided)
    : path.join(directory, "authorization.json")
  if (existsSync(filename)) {
    const saved = record(JSON.parse(readFileSync(filename, "utf8")))
    const contract = readE2eAuthorization(saved)
    if (
      contract.stage !== stage
      || path.resolve(String(saved.budgetDirectory)) !== historicalBudget
    )
      throw new Error("Authorization targets another E2E stage or ledger")
    return filename
  }
  if (provided) throw new Error("Explicit authorization file does not exist")
  const { ledger, ledgerBytes, elapsedMs, phaseBaselines } = readHistorical()
  const roundId = `e2e-${stage}-20260930`
  if (ledger.hasAuthorization(roundId))
    throw new Error(
      "Existing E2E round requires its original output directory and authorization",
    )
  const manifest =
    stage === "legacy" ?
      readFileSync(
        path.join(
          ROOT,
          "tests/_runlog/resume-400-20260930/foreign-reasoning.json",
        ),
      )
    : undefined
  const saved = buildE2eAuthorization({
    stage,
    roundId,
    budgetDirectory: historicalBudget,
    approvalReference:
      "User selected stage limits and requested implementation of the eight-model live acceptance plan on 2026-09-30",
    priorLedgerBytes: ledgerBytes.length,
    priorLedgerSha256: sha256(ledgerBytes),
    baseAttempts: ledger.grants.length,
    baseCredits: ledger.summary().reservedCredits,
    baseElapsedMs: elapsedMs,
    phaseBaselines,
    executionSha256: identitySha256(executionManifest()),
    legacyManifestSha256: manifest ? sha256(manifest) : undefined,
  })
  writeFileSync(filename, JSON.stringify(saved, null, 2), {
    encoding: "utf8",
    flag: "wx",
  })
  return filename
}

function report(input: {
  directory: string
  stage: E2eStage
  runtime: AcceptanceRuntime
  fatal?: string
}) {
  const { directory, stage, runtime, fatal } = input
  const expected = Object.keys(e2eCases(stage))
  const latest = new Map(runtime.results.map((result) => [result.id, result]))
  const cases = expected.map((id) => {
    const result = latest.get(id)
    return {
      id,
      status: result?.status ?? "skipped",
      attempts: result?.attempts ?? 0,
      detail: result?.detail ?? "Run stopped before scenario",
    }
  })
  const passed = cases.every((result) => result.status === "pass") && !fatal
  const models = summarizeE2eCoverage({
    grants: runtime.ledger.grants,
    observations: runtime.ledger.observations,
    models: stage === "matrix" ? [...E2E_MODELS] : ["gpt-6-astra"],
    cases,
    roundId: runtime.e2e?.roundId ?? "",
    stage,
  })
  const summary = {
    stage,
    passed,
    fatal,
    sourceSha256: identitySha256(runtime.execution),
    priceSource: e2ePriceSource,
    priceSnapshotDate: "2026-09-30",
    attempts: runtime.ledger.grants.length,
    reservedCredits: runtime.ledger.summary().reservedCredits,
    newAttempts: runtime.budgetSession.summary()?.attempts,
    newReservedCredits: runtime.budgetSession.summary()?.reservedCredits,
    unknownUsageAttempts: runtime.ledger.summary().unknownUsageAttempts,
    knownDefects: [],
    models,
    cases,
  }
  writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  )
  const rows = cases.map(
    (result) =>
      `| ${result.id} | ${result.status.toUpperCase()} | ${result.attempts} | ${result.detail.replaceAll("|", String.raw`\|`).replaceAll(/\r?\n/gu, " ")} |`,
  )
  writeFileSync(
    path.join(directory, "REPORT.md"),
    [
      `# Real Copilot E2E ${stage} — ${passed ? "PASS" : "NOT COMPLETE"}`,
      "",
      `Source SHA-256: ${summary.sourceSha256}`,
      `Historical plus new attempts: ${summary.attempts}; conservative reserved credits: ${summary.reservedCredits}.`,
      `This stage: ${summary.newAttempts} attempts; ${summary.newReservedCredits} reserved credits.`,
      `Unknown usage attempts: ${summary.unknownUsageAttempts}. Reservations are not actual account debits.`,
      `Price source: ${e2ePriceSource}; verified 2026-09-30.`,
      "",
      "| Model | Passed | Attempts | Input/output usage | Cache usage |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...models.map(
        (result) =>
          `| ${result.model} | ${result.casesPassed}/${result.casesTotal} | ${result.attempts} | ${result.usageCoverage} | ${result.cacheCoverage} |`,
      ),
      ...(fatal ? [`Fatal stop: ${fatal}`] : []),
      "",
      "| Scenario | Verdict | Attempts | Evidence |",
      "| --- | --- | ---: | --- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  )
  console.log(
    `E2E ${stage}: ${cases.filter((value) => value.status === "pass").length}/${cases.length} passed; report ${path.join(directory, "REPORT.md")}`,
  )
  if (!passed) process.exitCode = 1
}

function mark(input: {
  runtime: AcceptanceRuntime
  id: string
  phase: Phase
  status: "blocked" | "skipped"
  detail: string
}) {
  const { runtime, id, phase, status, detail } = input
  runtime.results.push({
    id,
    phase,
    status,
    detail,
    durationMs: 0,
    attempts: 0,
  })
  runtime.save()
  console.log(`${status.toUpperCase()} ${id}: ${detail}`)
}

function modelReady(runtime: AcceptanceRuntime, model: string): boolean {
  const item = runtime.catalog.find((entry) => entry.id === model)
  const supports = record(record(item?.capabilities).supports)
  return (
    Array.isArray(item?.supported_endpoints)
    && item.supported_endpoints.includes("/responses")
    && supports.tool_calls === true
    && supports.streaming === true
    && Array.isArray(supports.reasoning_effort)
    && supports.reasoning_effort.includes("low")
  )
}

function legacyPrerequisite(args: Array<string>): void {
  const directory = path.resolve(
    option(
      args,
      "--matrix-output-dir",
      path.join(ROOT, "tests/_runlog/e2e-matrix-20260930"),
    ),
  )
  const summary = record(
    JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8")),
  )
  if (
    summary.stage !== "matrix"
    || summary.sourceSha256 !== identitySha256(executionManifest())
  )
    throw new Error(
      "Astra matrix evidence is missing or belongs to another source",
    )
  const results =
    Array.isArray(summary.cases) ?
      summary.cases.map((caseResult) => record(caseResult))
    : []
  for (const kind of ["responses-json", "responses-stream", "history"])
    if (
      !results.some(
        (result) =>
          result.id === `e2e-gpt-6-astra-${kind}` && result.status === "pass",
      )
    )
      throw new Error(`Astra ${kind} did not pass its matrix prerequisite`)
}

function preflightBlocked(
  directory: string,
  stage: E2eStage,
  error: unknown,
): void {
  const message =
    error instanceof Error ? error.message : "Offline preflight failed"
  const cases = Object.keys(e2eCases(stage)).map((id, index) => ({
    id,
    status: index === 0 ? "blocked" : "skipped",
    attempts: 0,
    detail: message,
  }))
  writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify({ stage, passed: false, fatal: message, cases }, null, 2),
    "utf8",
  )
  writeFileSync(
    path.join(directory, "REPORT.md"),
    `# Real Copilot E2E ${stage} — BLOCKED\n\nPreflight: ${message}\nNo model generation was started.\n`,
    "utf8",
  )
  console.error(message)
  process.exitCode = 1
}

function printPlan(stage: E2eStage) {
  const cases = e2eCases(stage)
  console.log(
    JSON.stringify(
      {
        stage,
        live: false,
        models: E2E_MODELS,
        pricesVerified: Object.keys(E2E_PRICES),
        pricesUnavailable: E2E_MODELS.filter((id) => !E2E_PRICES[id]),
        limits: E2E_LIMITS[stage],
        caseCount: Object.keys(cases).length,
        cases: Object.entries(cases).map(([id, cap]) => ({
          id,
          model: cap.model,
          attempts: cap.attempts,
          inputTokens: cap.inputTokens,
          outputTokens: cap.outputTokens,
        })),
        budgetDirectory: historicalBudget,
        proxyPort: 4142,
      },
      null,
      2,
    ),
  )
}

function liveDirectory(args: Array<string>, stage: E2eStage) {
  if (path.resolve(option(args, "--budget-dir")) !== historicalBudget)
    throw new Error("E2E must use the historical cumulative budget")
  for (const [key, value] of Object.entries({
    "--max-additional-credits": E2E_LIMITS[stage].additionalCredits,
    "--max-additional-attempts": E2E_LIMITS[stage].additionalAttempts,
    "--max-additional-minutes": E2E_LIMITS[stage].additionalMinutes,
  })) {
    const flag = key
    if (Number(option(args, flag)) !== value)
      throw new Error(`E2E requires exact ${flag} ${value}`)
  }
  const directory = path.resolve(option(args, "--output-dir"))
  if (directory === historicalBudget)
    throw new Error("E2E output must be separate from the ledger")
  return directory
}

interface LivePreparation {
  authorizationFile: string
  shellReady: boolean
  legacyPreparation?: Awaited<ReturnType<typeof prepareLegacyHistory>>
}
async function prepareLive(
  stage: E2eStage,
  args: Array<string>,
  directory: string,
): Promise<LivePreparation | undefined> {
  mkdirSync(directory, { recursive: true })
  const checks = await offline(directory)
  if (checks.some((check) => !check.pass)) {
    preflightBlocked(
      directory,
      stage,
      new Error("Offline acceptance gate failed"),
    )
    return
  }
  let legacyPreparation:
    | Awaited<ReturnType<typeof prepareLegacyHistory>>
    | undefined
  if (stage === "legacy") {
    try {
      legacyPrerequisite(args)
      legacyPreparation = await prepareLegacyHistory(directory)
    } catch (error) {
      preflightBlocked(directory, stage, error)
      return
    }
  }
  const authorizationFile = authorization(
    stage,
    directory,
    option(args, "--authorization-file"),
  )
  let shellReady = true
  if (stage === "matrix") {
    const shell = await runCommand(directory, "codex-shell-preflight", [
      process.execPath,
      "--no-env-file",
      path.join(ROOT, "tests/acceptance/repros/codex-tool-admission.ts"),
    ])
    shellReady = shell.pass
  }
  return { authorizationFile, shellReady, legacyPreparation }
}

async function runMatrix(runtime: AcceptanceRuntime, shellReady: boolean) {
  const previous = new Set(runtime.results.map((result) => result.id))
  for (const scenario of E2E_MATRIX) {
    if (previous.has(scenario.id)) continue
    if (!E2E_PRICES[scenario.model])
      mark({
        runtime,
        id: scenario.id,
        phase: scenario.phase,
        status: "blocked",
        detail: "Copilot price not verified",
      })
    else if (!modelReady(runtime, scenario.model))
      mark({
        runtime,
        id: scenario.id,
        phase: scenario.phase,
        status: "blocked",
        detail: "Model endpoint or capability absent from current catalog",
      })
    else if (!shellReady && scenario.kind === "codex-tool")
      mark({
        runtime,
        id: scenario.id,
        phase: scenario.phase,
        status: "blocked",
        detail: "Offline Codex shell admission failed",
      })
    else
      await runtime.runCase(scenario.id, scenario.phase, () =>
        scenario.run(runtime),
      )
  }
}

async function executeLive(input: {
  stage: E2eStage
  directory: string
  preparation: LivePreparation
}) {
  const { stage, directory, preparation } = input
  const limits = E2E_LIMITS[stage]
  const runtime = new AcceptanceRuntime(directory, 1000, {
    budgetDirectory: historicalBudget,
    authorizationFile: preparation.authorizationFile,
    additionalCredits: limits.additionalCredits,
    additionalAttempts: limits.additionalAttempts,
    additionalMinutes: limits.additionalMinutes,
  })
  const legacyPreparation = preparation.legacyPreparation
  if (legacyPreparation)
    runtime.proxyEnvironment.COPILOT_FOREIGN_REASONING_MANIFEST = legacyManifest
  let fatal: string | undefined
  try {
    if (runtime.halted)
      throw new Error("Persisted budget or account stop prevents continuation")
    await runtime.authenticate()
    await runtime.startProxy()
    if (stage === "matrix") await runMatrix(runtime, preparation.shellReady)
    else {
      if (!legacyPreparation)
        throw new Error("Historical preflight was not prepared")
      await runLegacyHistory(runtime, legacyPreparation)
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : "Fatal E2E error"
    console.error(fatal)
  } finally {
    try {
      await runtime.close()
    } catch (error) {
      fatal = error instanceof Error ? error.message : "E2E cleanup failed"
      console.error(fatal)
    }
  }
  report({ directory, stage, runtime, fatal })
}

export async function runE2e(args: Array<string>) {
  const stage = option(args, "--stage")
  if (stage !== "matrix" && stage !== "legacy")
    throw new Error("Unknown E2E stage")
  if (args.includes("--list") || args.includes("--dry-run")) {
    printPlan(stage)
    return
  }
  if (!args.includes("--live"))
    throw new Error("Choose --list, --dry-run, or --live for E2E")
  const directory = liveDirectory(args, stage)
  const preparation = await prepareLive(stage, args, directory)
  if (preparation) await executeLive({ stage, directory, preparation })
}
