import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record } from "./lib/local-budget"
import { CLIENTS } from "./lib/local-clients"
import { FOLLOWUPS } from "./lib/local-followups"
import { MATRIX, assertMatrixCatalog } from "./lib/local-matrix"
import { MATRIX_MODELS } from "./lib/local-matrix-authorization"
import {
  checkUsageReconciliation,
  OPERATIONS,
  soak,
} from "./lib/local-operations"
import { validateArguments } from "./lib/local-options"
import { AcceptanceRuntime, ROOT } from "./lib/local-runtime"
import { FUNCTIONAL } from "./lib/local-scenarios"

const args = process.argv.slice(2).filter((arg) => arg !== "--")
validateArguments(args)
function option(name: string, fallback: string) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const all = [...FUNCTIONAL, ...CLIENTS, ...OPERATIONS, ...FOLLOWUPS]
const selectedIds = option("--only", "").split(",").filter(Boolean)
if (
  selectedIds.includes("codex-fork-resume")
  && !selectedIds.includes("codex-seed")
)
  selectedIds.push("codex-seed")
for (const id of selectedIds)
  if (
    !["soak", "soak-recheck"].includes(id)
    && !all.some((scenario) => scenario.id === id)
  )
    throw new Error(`Unknown scenario: ${id}`)
const selected =
  args.includes("--matrix") ? MATRIX : (
    all.filter((scenario) =>
      selectedIds.length > 0 ?
        selectedIds.includes(scenario.id)
      : !scenario.optional,
    )
  )
if (args.includes("--budget-dir")) {
  const allowed = new Set([
    "claude-smoke",
    "claude-tool",
    "codex-tool",
    ...FOLLOWUPS.map((scenario) => scenario.id),
  ])
  if (selectedIds.some((id) => !allowed.has(id)))
    throw new Error(
      "Cross-version followup selected a scenario outside its approved plan",
    )
  selected.sort(
    (left, right) =>
      selectedIds.indexOf(left.id) - selectedIds.indexOf(right.id),
  )
}
const includeSoak =
  !args.includes("--matrix")
  && (selectedIds.length === 0
    || selectedIds.some((id) => ["soak", "soak-recheck"].includes(id)))

if (args.includes("--help")) {
  console.log(
    "bun run acceptance:local [--list|--dry-run|--live] [--only id,id] [--max-credits 1000] [--output-dir path]\nCross-version followup: --budget-dir historical-path --max-additional-credits 30 --max-additional-attempts 20 --max-additional-minutes 15\nNew approved round: add --authorization-file path (drafts are rejected; historical stops and cumulative limits remain).\nDefault: offline checks only. Live: wenbo97 bridge, Luna/low, OpenAI-only, 4143, 20-minute soak.\nReuse --output-dir to retain the budget ledger across targeted reruns. No automatic model upgrades or inference retries.",
  )
} else if (args.includes("--list") || args.includes("--dry-run")) {
  console.log(
    JSON.stringify(
      {
        live: false,
        model:
          args.includes("--matrix") ?
            "explicit per-case model; version 2 authorization required"
          : "gpt-5.6-luna",
        effort: "low",
        account: "wenbo97",
        maxCredits: Number(option("--max-credits", "1000")),
        budgetDirectory: option("--budget-dir", "") || undefined,
        authorizationFile: option("--authorization-file", "") || undefined,
        additionalCredits: Number(option("--max-additional-credits", "0")),
        additionalAttempts: Number(option("--max-additional-attempts", "0")),
        additionalMinutes: Number(option("--max-additional-minutes", "0")),
        admissionFraction: 0.9,
        maxUpstreamAttempts: args.includes("--matrix") ? 129 : 120,
        cases: [
          ...selected.map(({ id, phase }) => ({ id, phase })),
          ...(includeSoak ?
            [
              {
                id:
                  selectedIds.includes("soak-recheck") ? "soak-recheck" : (
                    "soak"
                  ),
                phase:
                  selectedIds.includes("soak-recheck") ? "recheck" : (
                    "operations"
                  ),
                requests: 20,
                minutes: 20,
              },
            ]
          : []),
        ],
        offline: [
          "full tests with external fetch denied",
          "typecheck",
          "build",
          "300 simulated route requests",
          "CLI help",
        ],
      },
      null,
      2,
    ),
  )
} else {
  await main()
}

async function runCommand(
  directory: string,
  name: string,
  command: Array<string>,
) {
  console.log(`OFFLINE ${name}`)
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => child.kill(), 180_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    writeFileSync(path.join(directory, `${name}.log`), stdout + stderr, "utf8")
    return { name, exitCode, pass: exitCode === 0 }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}

async function offline(directory: string) {
  const guard = path.join(import.meta.dir, "lib/local-network-deny.ts")
  const commands: Array<[string, Array<string>]> = [
    [
      "tests",
      [process.execPath, "test", "--timeout", "30000", "--preload", guard],
    ],
    ["typecheck", [process.execPath, "run", "typecheck"]],
    ["build", [process.execPath, "run", "build"]],
    [
      "offline-operations",
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "lib/local-offline.ts"),
        path.join(directory, "offline-operations.json"),
      ],
    ],
    [
      "start-help",
      [
        process.execPath,
        "--preload",
        guard,
        "./src/main.ts",
        "start",
        "--help",
      ],
    ],
    ["summary-help", [process.execPath, "run", "usage:summary", "--help"]],
  ]
  const outcomes = []
  for (const [name, command] of commands)
    outcomes.push(await runCommand(directory, name, command))
  writeFileSync(
    path.join(directory, "offline.json"),
    JSON.stringify(outcomes, null, 2),
    "utf8",
  )
  return outcomes
}

async function main() {
  const directory = path.resolve(
    option(
      "--output-dir",
      path.join(
        ROOT,
        "tests/_runlog",
        `local-acceptance-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
      ),
    ),
  )
  mkdirSync(directory, { recursive: true })
  console.log(`Evidence: ${directory}`)
  const checks = await offline(directory)
  if (checks.some((check) => !check.pass)) {
    console.error(
      "Offline gate failed; live requests were not started. Inspect the per-check logs.",
    )
    process.exitCode = 1
    return
  }
  if (!args.includes("--live")) {
    console.log(
      "Offline acceptance passed. Use --live for the printed OpenAI-only plan.",
    )
    return
  }
  // Exercise actual model-tool dispatch against loopback before spending quota.
  // CLI help and a direct sandbox command do not prove that this path is admitted.
  if (selected.some(({ id }) => id.endsWith("codex-tool"))) {
    const admission = await runCommand(directory, "codex-shell-preflight", [
      process.execPath,
      "--no-env-file",
      path.join(import.meta.dir, "repros/codex-tool-admission.ts"),
    ])
    if (!admission.pass) {
      throw new Error(
        "Local Codex shell preflight failed; no paid requests started. See codex-shell-preflight.log.",
      )
    }
  }
  const runtime = new AcceptanceRuntime(
    directory,
    Number(option("--max-credits", "1000")),
    args.includes("--budget-dir") ?
      {
        budgetDirectory: option("--budget-dir", ""),
        authorizationFile: option("--authorization-file", "") || undefined,
        additionalCredits: Number(option("--max-additional-credits", "30")),
        additionalAttempts: Number(option("--max-additional-attempts", "20")),
        additionalMinutes: Number(option("--max-additional-minutes", "15")),
      }
    : {},
  )
  let fatal: string | undefined
  try {
    if (runtime.halted)
      throw new Error(
        "Persisted account or budget stop prevents live continuation",
      )
    await runtime.authenticate()
    await runtime.startProxy()
    if (args.includes("--matrix")) assertMatrixCatalog(runtime)
    for (const scenario of selected)
      await runtime.runCase(scenario.id, scenario.phase, () =>
        scenario.run(runtime),
      )
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- awaited cases and controller callbacks can halt admission
    if (includeSoak && !runtime.halted)
      await soak(runtime, selectedIds.includes("soak-recheck"))
  } catch (error) {
    fatal = error instanceof Error ? error.message : "Fatal acceptance error"
    console.error(fatal)
  } finally {
    await runtime.close()
  }
  await writeReport({ runtime, directory, checks, fatal })
}

function escaped(value: string) {
  return value.replaceAll("|", String.raw`\|`).replaceAll(/\r?\n/gu, " ")
}

async function writeReport(options: {
  runtime: AcceptanceRuntime
  directory: string
  checks: Array<{ name: string; pass: boolean }>
  fatal?: string
}) {
  const { runtime, directory, checks, fatal } = options
  const usage = checkUsageReconciliation(runtime)
  writeFileSync(
    path.join(directory, "usage-observed.json"),
    JSON.stringify(usage, null, 2),
    "utf8",
  )
  const diagnosticPath = path.join(directory, "diagnostics.log")
  if (existsSync(diagnosticPath))
    await runCommand(directory, "usage-summary", [
      process.execPath,
      "run",
      "usage:summary",
      diagnosticPath,
      "--json",
    ])
  const lines = [
    "# Local Copilot API acceptance",
    "",
    `Date: ${new Date().toISOString()}`,
    "",
    "Account: wenbo97 (user-confirmed VS Code identity; Bridge does not expose a login).",
    args.includes("--matrix") ?
      `Selected models: ${MATRIX_MODELS.join(", ")}; reasoning: low. Preparation catalog did not list gpt-5.6-astra or gpt-6-terra; neither was substituted or tested.`
    : "Primary model: gpt-5.6-luna; reasoning: low. All real model calls are OpenAI-only.",
    "",
    `Offline gates: ${checks.map((check) => `${check.name}=${check.pass ? "PASS" : "FAIL"}`).join(", ")}.`,
    "",
    "| Case | Phase | Status | Attempts | Evidence |",
    "| --- | --- | --- | ---: | --- |",
    ...runtime.results.map(
      (result) =>
        `| ${result.id} | ${result.phase} | ${result.status.toUpperCase()} | ${result.attempts} | ${escaped(result.detail)} |`,
    ),
    "",
    "## Usage",
    "",
    `Conservative reservation: ${runtime.ledger.summary().reservedCredits.toFixed(6)} credits; ${runtime.ledger.summary().attempts} upstream attempts.`,
    `Observed input tokens: ${usage.observedInputTokens}; output tokens: ${usage.observedOutputTokens}; attempts missing usage: ${usage.unknownUsageAttempts}.`,
    "Missing usage is unknown, not zero. Reservations are not account deductions. Account dashboard/report deltas were not programmatically available through the bridge-only credential.",
    "",
    "## Interpretation",
    "",
    "- B7 and Messages effort forwarding have ordinary offline regressions. Real outcomes are listed individually above.",
    "- Native Anthropic egress and Chat fallback edge cases have offline coverage; this run does not certify all models or cross-account history recovery.",
    "- The 300-request offline exercise uses actual handlers with simulated non-streaming upstreams. The live observation window is not a statistical long-term reliability guarantee.",
    "- Source fingerprints identify the tested working tree. Production source remained fixed during this run. Normal services, global client settings, and original sessions were preserved.",
    ...(runtime.budgetSession.summary() ?
      [
        `- Followup accounting: ${JSON.stringify(runtime.budgetSession.summary())}`,
      ]
    : []),
    ...(fatal ? [`- Fatal stop: ${escaped(fatal)}`] : []),
    "",
    "Machine-readable evidence: result.json, ledger.jsonl, source-manifest.json, offline.json, offline-operations.json, usage-observed.json, diagnostics.log, and usage-summary.log.",
    "",
  ]
  writeFileSync(path.join(directory, "REPORT.md"), lines.join("\n"), "utf8")
  const effectiveResults = [
    ...new Map(runtime.results.map((result) => [result.id, result])).values(),
  ]
  const failures = effectiveResults.filter((result) => result.status !== "pass")
  console.log(
    `Report: ${path.join(directory, "REPORT.md")}\n${effectiveResults.length - failures.length}/${effectiveResults.length} latest live cases passed; ${runtime.ledger.summary().reservedCredits.toFixed(3)} reserved credits`,
  )
  // eslint-disable-next-line require-atomic-updates -- this CLI owns its exit status
  if (fatal || failures.length > 0) process.exitCode = 1
  // Keep this read explicit: evidence must remain parseable even after a failed run.
  record(JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")))
}
