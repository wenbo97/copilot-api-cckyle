import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record } from "./local-budget"
import {
  buildClaudeAuthorization,
  claudeOptions,
  claudeCases,
  CLAUDE_KINDS,
  type ClaudeKind,
} from "./local-claude-authorization"
import { writeClaudeReport, verifyCaseWire } from "./local-claude-report"
import { ClaudeScenarios } from "./local-claude-scenarios"
import { executionManifest, identitySha256 } from "./local-identity"
import { offline, runCommand } from "./local-offline-gate"
import {
  AcceptanceRuntime,
  assert,
  ROOT,
  ACCEPTANCE_PORT,
} from "./local-runtime"

export async function runClaudeProxy(args: Array<string>) {
  const options = claudeOptions(args)
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          profile: "claude-proxy",
          ...options,
          proxyPort: ACCEPTANCE_PORT,
          cases: claudeCases(options.models),
          pricesVerifiedAt: "2026-10-22",
        },
        null,
        2,
      ),
    )
    return
  }
  const directory = path.resolve(
    options.directory
      ?? path.join(
        ROOT,
        "tests/_runlog",
        `claude-proxy-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
      ),
  )
  assert(
    !existsSync(path.join(directory, "authorization.json")),
    "Completed/interrupted rounds are immutable; inspect their evidence before any new run",
  )
  mkdirSync(directory, { recursive: true })
  console.log(`Claude proxy evidence: ${directory}`)
  const checks = await offline(directory)
  if (checks.every((check) => check.pass)) {
    checks.push(
      await runCommand(directory, "lint", [
        process.execPath,
        "run",
        "lint",
        "tests/acceptance/lib/local-claude*.ts",
        "tests/acceptance/lib/local-budget.ts",
        "tests/acceptance/lib/local-continuation.ts",
        "tests/acceptance/lib/local-latest-authorization.ts",
        "tests/acceptance/lib/local-matrix-authorization.ts",
        "tests/acceptance/lib/local-options.ts",
        "tests/acceptance/lib/local-proxy.ts",
        "tests/acceptance/lib/local-runtime.ts",
        "tests/acceptance/local.ts",
        "tests/acceptance/repros/claude-proxy-preflight.ts",
      ]),
      await runCommand(directory, "claude-version", [
        Bun.which("claude") ?? "claude",
        "--version",
      ]),
      await runCommand(directory, "claude-proxy-preflight", [
        process.execPath,
        "--no-env-file",
        "--preload",
        path.join(import.meta.dir, "local-network-deny.ts"),
        path.join(ROOT, "tests/acceptance/repros/claude-proxy-preflight.ts"),
      ]),
    )
  }
  writeFileSync(
    path.join(directory, "preflight.json"),
    JSON.stringify(checks, null, 2),
  )
  if (checks.some((check) => !check.pass)) {
    console.error("Offline gate failed; no paid requests started")
    failRun()
    return
  }
  if (!options.live) return
  await liveClaude(directory, options)
}

async function liveClaude(
  directory: string,
  options: ReturnType<typeof claudeOptions>,
) {
  assert(options.approvalReference, "Approval reference missing")
  const auth = buildClaudeAuthorization({
    roundId: `claude-${randomUUID()}`,
    budgetDirectory: directory,
    approvalReference: options.approvalReference,
    executionSha256: identitySha256(executionManifest()),
    fixtureSalt: randomUUID(),
    models: options.models,
    credits: options.credits,
    attempts: options.attempts,
    minutes: options.minutes,
  })
  const authorizationFile = path.join(directory, "authorization.json")
  writeFileSync(authorizationFile, JSON.stringify(auth, null, 2), {
    flag: "wx",
  })
  const runtime = new AcceptanceRuntime(directory, options.credits, {
    authorizationFile,
  })
  let fatal: string | undefined
  try {
    await runtime.authenticate()
    await runtime.startProxy()
    verifyCapabilities(runtime.catalog, options.models)
    const scenarios = new ClaudeScenarios(runtime, auth)
    for (const kind of Object.keys(CLAUDE_KINDS) as Array<ClaudeKind>) {
      for (const model of options.models) {
        if (runtime.halted) break
        const id = `claude-proxy-${model}-${kind}`
        const cap = CLAUDE_KINDS[kind]
        await runtime.management("configure", {
          caseId: id,
          phase: cap.phase,
          cachePolicy: "off",
        })
        await runtime.runCase(id, cap.phase, async () => {
          try {
            const detail = await scenarios.run(id, model, kind)
            if (kind !== "cancel") await verifyCaseWire(runtime, id)
            return detail
          } catch (error) {
            // Also inspect terminal authentication failures when the CLI exits first.
            if (kind !== "cancel")
              await verifyCaseWire(runtime, id).catch(() => undefined)
            throw error
          }
        })
      }
    }
    assert(
      !runtime.halted,
      runtime.ledger.stopReason ?? "Live admission stopped",
    )
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      await runtime.close()
    } catch (error) {
      fatal = `${fatal ?? ""}; cleanup: ${String(error)}`
    }
  }
  const summary = writeClaudeReport(runtime, auth, fatal)
  console.log(`Report: ${path.join(directory, "REPORT.md")}`)
  if (!summary.complete) failRun()
}

function failRun() {
  process.exitCode = 1
}

function verifyCapabilities(
  catalog: Array<Record<string, unknown>>,
  models: Array<string>,
) {
  for (const id of models) {
    const model = record(catalog.find((item) => item.id === id))
    const capabilities = record(model.capabilities)
    const supports = record(capabilities.supports)
    assert(
      Array.isArray(model.supported_endpoints)
        && model.supported_endpoints.includes("/responses")
        && Array.isArray(supports.reasoning_effort)
        && supports.reasoning_effort.includes("high")
        && supports.tool_calls === true
        && supports.streaming === true
        && supports.vision === true
        && Number(record(capabilities.limits).max_output_tokens) >= 16384,
      `Model capability missing: ${id}`,
    )
  }
}
