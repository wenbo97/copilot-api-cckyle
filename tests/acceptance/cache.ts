import { encode } from "gpt-tokenizer/encoding/o200k_base"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import type { ResponsesPayload } from "~/routes/responses/responses-types"

import { applyResponsesCachePolicy } from "~/lib/responses-cache-policy"

import {
  BudgetLedger,
  prepareGeneration,
  record,
  type Json,
} from "./lib/local-budget"
import {
  CACHE_CASE_IDS,
  CACHE_CUMULATIVE,
  readCacheAuthorization,
} from "./lib/local-cache-authorization"
import { AcceptanceRuntime, assert, ROOT } from "./lib/local-runtime"
import { responseText } from "./lib/local-wire"

export function cacheFixture(group: "control" | "prefix", salt: string) {
  const rows = Array.from(
    { length: 50 },
    (_, index) =>
      `Record ${index + 1}: Module station_${index + 1} uses staging lane ${index % 7}; its retention period is ${14 + (index % 5)} days. Its approval marker is ${stationMarker(index)}. Owners validate the manifest before promoting a release.`,
  )
  return [
    `Synthetic reference group ${group}; fixed experiment marker ${salt}.`,
    "Find the approval marker of the station named in the final question in this catalogue. Return only that exact marker, with no explanation. Each record is independent; do not infer a marker from station numbers.",
    ...rows,
  ].join("\n")
}

function stationMarker(index: number) {
  if (index === 16) return "CACHE_OK_A"
  if (index === 43) return "CACHE_OK_B"
  return `STATION_APPROVED_${index + 1}`
}

export function cacheBody(prefix: string, suffix: boolean): ResponsesPayload {
  return {
    model: "gpt-5.6-luna",
    reasoning: { effort: "low" },
    max_output_tokens: 256,
    stream: false,
    input: [
      { role: "developer", content: prefix },
      {
        role: "user",
        content: `Return the approval marker for ${suffix ? "station_44" : "station_17"}.`,
      },
    ],
  }
}

function safeCount(value: unknown): number | null {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : null
}

export function cacheEvidence(response: Json) {
  const usage = record(response.usage)
  const details = record(usage.input_tokens_details)
  const input = safeCount(usage.input_tokens)
  const reportedCached = safeCount(details.cached_tokens)
  const cached =
    input !== null && reportedCached !== null && reportedCached > input ?
      null
    : reportedCached
  const written = safeCount(details.cache_write_tokens)
  const ordinary =
    (
      input !== null
      && cached !== null
      && written !== null
      && cached + written <= input
    ) ?
      input - cached - written
    : null
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_tokens: written,
    ordinary_input_tokens: ordinary,
    output_tokens: safeCount(usage.output_tokens),
    reasoning_tokens: safeCount(
      record(usage.output_tokens_details).reasoning_tokens,
    ),
    copilot_nano_aiu: safeCount(record(response.copilot_usage).total_nano_aiu),
    cache_hit_ratio:
      input !== null && input > 0 && cached !== null ? cached / input : null,
  }
}

function preflight(salt: string) {
  const previousPolicy = process.env.COPILOT_CACHE_POLICY
  const previousNamespace = process.env.COPILOT_CACHE_NAMESPACE
  try {
    process.env.COPILOT_CACHE_NAMESPACE = "local-acceptance"
    return CACHE_CASE_IDS.map((caseId) => {
      const group = caseId.includes("control") ? "control" : "prefix"
      process.env.COPILOT_CACHE_POLICY =
        group === "control" ? "off" : "prefix-v1"
      const prefix = cacheFixture(group, salt)
      assert(
        encode(prefix).length >= 1536 && encode(prefix).length <= 2500,
        "Cache fixture prefix outside target size",
      )
      const body = cacheBody(prefix, caseId.endsWith("suffix"))
      const result = applyResponsesCachePolicy(body, {
        endpoint: "/responses",
        accountType: "enterprise",
      })
      const prepared = prepareGeneration(
        "/responses",
        result.payload as unknown as Json,
      )
      assert(
        prepared.inputTokens <= 16384,
        "Cache fixture input reservation exceeds scope",
      )
      return {
        caseId,
        prefixTokens: encode(prefix).length,
        inputReservation: prepared.inputTokens,
        outputReservation: prepared.outputTokens,
        policy: result.summary,
      }
    })
  } finally {
    if (previousPolicy === undefined) delete process.env.COPILOT_CACHE_POLICY
    else process.env.COPILOT_CACHE_POLICY = previousPolicy
    if (previousNamespace === undefined)
      delete process.env.COPILOT_CACHE_NAMESPACE
    else process.env.COPILOT_CACHE_NAMESPACE = previousNamespace
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      prepare: { type: "boolean" },
      live: { type: "boolean" },
      directory: { type: "string" },
      "budget-dir": { type: "string" },
      authorization: { type: "string" },
      "start-signal": { type: "string" },
    },
    strict: true,
  })
  assert(
    Boolean(values.prepare) !== Boolean(values.live),
    "Select exactly --prepare or --live",
  )
  assert(values.directory, "Explicit evidence --directory required")
  const directory = path.resolve(values.directory)
  const budgetDirectory = path.resolve(
    values["budget-dir"]
      ?? path.join(ROOT, "tests/_runlog/local-acceptance-20260929"),
  )
  assert(
    directory !== budgetDirectory,
    "Cache evidence must be separate from historical budget",
  )
  mkdirSync(directory, { recursive: true })
  const authorizationFile = path.resolve(
    values.authorization ?? path.join(directory, "authorization.json"),
  )
  const locations = { directory, budgetDirectory, authorizationFile }
  if (values.prepare) prepareRound(locations)
  else await runRound(locations, values["start-signal"])
}

interface Locations {
  directory: string
  budgetDirectory: string
  authorizationFile: string
}

function prepareRound({
  directory,
  budgetDirectory,
  authorizationFile,
}: Locations) {
  assert(
    !existsSync(authorizationFile),
    "Refusing to replace prepared authorization",
  )
  const ledgerFile = path.join(budgetDirectory, "ledger.jsonl")
  const bytes = readFileSync(ledgerFile)
  const ledger = new BudgetLedger(ledgerFile)
  const summary = ledger.summary()
  assert(
    summary.attempts + 6 <= 129,
    "Insufficient cumulative cache attempt capacity",
  )
  assert(
    ledger.grants.filter((grant) => grant.phase === "clients").length + 6 <= 46,
    "Insufficient inherited phase capacity",
  )
  assert(
    summary.reservedCredits + 5 <= 900,
    "Insufficient cumulative credit capacity",
  )
  const elapsed = record(
    JSON.parse(
      readFileSync(path.join(budgetDirectory, "live-time.json"), "utf8"),
    ),
  ).elapsedMs
  assert(
    typeof elapsed === "number"
      && elapsed + 8 * 60000 <= CACHE_CUMULATIVE.activeMs,
    "Insufficient cumulative active time",
  )
  const saved = {
    version: 3,
    approved: true,
    approvalReference:
      "User instruction on 2026-09-30: research token cache, apply codes, and observe the current account in Chrome plus verbose/trace during local testing. Agent bounds: six Luna/low requests, five reserved credits, eight active minutes; account switch confirmed by user.",
    roundId: `cache-${new Date().toISOString().replaceAll(/\D/gu, "")}`,
    budgetDirectory,
    model: "gpt-5.6-luna",
    effort: "low",
    priorLedgerBytes: bytes.length,
    priorLedgerSha256: createHash("sha256").update(bytes).digest("hex"),
    baseAttempts: summary.attempts,
    baseCredits: summary.reservedCredits,
    baseElapsedMs: elapsed,
    additionalAttempts: 6,
    additionalCredits: 5,
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
    cumulative: CACHE_CUMULATIVE,
    fixtureSalt: randomUUID(),
  }
  readCacheAuthorization(saved)
  const checked = preflight(saved.fixtureSalt)
  writeFileSync(authorizationFile, JSON.stringify(saved, null, 2), {
    flag: "wx",
  })
  writeFileSync(
    path.join(directory, "preflight.json"),
    JSON.stringify(checked, null, 2),
  )
  console.log(
    "Prepared bounded cache round; no authentication or generation requests sent.",
  )
}

async function runRound(
  { directory, budgetDirectory, authorizationFile }: Locations,
  signal: string | undefined,
) {
  const authorization = record(
    JSON.parse(readFileSync(authorizationFile, "utf8")),
  )
  readCacheAuthorization(authorization)
  assert(
    typeof authorization.fixtureSalt === "string",
    "Prepared fixture marker missing",
  )
  preflight(authorization.fixtureSalt)
  // Parent captures the browser baseline before releasing this local signal.
  assert(
    signal && existsSync(path.resolve(signal)),
    "Browser baseline start signal required before live startup",
  )
  process.env.ACCEPTANCE_VERBOSE = "1"
  process.env.ACCEPTANCE_TRACE = "1"
  const runtime = new AcceptanceRuntime(directory, 1000, {
    budgetDirectory,
    authorizationFile,
    additionalAttempts: 6,
    additionalCredits: 5,
    additionalMinutes: 8,
  })
  const evidence: Array<Json> = []
  try {
    await runtime.authenticate()
    Object.assign(runtime.auth, {
      account: "current-enterprise-account",
      identityEvidence:
        "user-confirmed current Chrome and VS Code account; bridge endpoint does not independently identify login",
    })
    await runtime.startProxy()
    for (const caseId of CACHE_CASE_IDS) {
      const group = caseId.includes("control") ? "control" : "prefix"
      const policy = group === "control" ? "off" : "prefix-v1"
      await runtime.management("configure", {
        caseId,
        phase: "clients",
        cachePolicy: policy,
      })
      await runtime.runCase(caseId, "clients", async () => {
        const body = cacheBody(
          cacheFixture(group, String(authorization.fixtureSalt)),
          caseId.endsWith("suffix"),
        )
        const started = performance.now()
        const result = await runtime.responses(
          caseId,
          body as unknown as Json,
          "clients",
        )
        const expected = caseId.endsWith("suffix") ? "CACHE_OK_B" : "CACHE_OK_A"
        const counters = cacheEvidence(result)
        evidence.push({
          caseId,
          grantId: runtime.ledger.grants.at(-1)?.id ?? null,
          policy,
          observedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
          expected,
          exactAnswer: responseText(result).trim() === expected,
          status: result.status,
          ...counters,
        })
        writeFileSync(
          path.join(directory, "cache-observations.json"),
          JSON.stringify(evidence, null, 2),
        )
        assert(
          responseText(result).trim() === expected,
          "Cache factual answer mismatch",
        )
        assert(
          counters.input_tokens !== null
            && counters.output_tokens !== null
            && counters.cached_input_tokens !== null,
          "Required upstream cache usage missing",
        )
        assert(
          counters.input_tokens <= 16384 && counters.output_tokens <= 256,
          "Reported cache usage exceeds scope",
        )
        return `Exact ${expected}; cached ${counters.cached_input_tokens}/${counters.input_tokens} input tokens`
      })
      assert(
        runtime.results.at(-1)?.status === "pass" && !runtime.halted,
        "Cache experiment stopped after first failure",
      )
    }
    runtime.ledger.halt("Bounded cache round completed")
  } catch (error) {
    runtime.ledger.halt("Bounded cache round failed; no automatic continuation")
    throw error
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) await main()
