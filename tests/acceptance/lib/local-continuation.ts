import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { BudgetLedger, record, type Reservation } from "./local-budget"
import { readCacheAuthorization } from "./local-cache-authorization"
import { readE2eAuthorization } from "./local-e2e-authorization"
import { LiveTime } from "./local-live-time"
import {
  assertMatrixScope,
  readMatrixAuthorization,
  type MatrixAuthorization,
} from "./local-matrix-authorization"

export interface ContinuationOptions {
  authorizationFile?: string
  budgetDirectory?: string
  additionalCredits?: number
  additionalAttempts?: number
  additionalMinutes?: number
}
interface Limits {
  additionalCredits: number
  additionalAttempts: number
  additionalMinutes: number
}
interface Contract extends Limits {
  matrix?: MatrixAuthorization
  baseAttempts: number
  baseCredits: number
  baseElapsedMs: number
  cases?: Partial<
    Record<
      string,
      { attempts: number; inputTokens: number; outputTokens: number }
    >
  >
}
interface BudgetContext {
  ledger: BudgetLedger
  clock: LiveTime
  contract?: Contract
}
const groups = [
  { prefix: "claude-", cap: 5 },
  { prefix: "rate-limit-followup", cap: 4 },
  { prefix: "context-followup-", cap: 4 },
  { prefix: "stability-followup-", cap: 5 },
  { prefix: "codex-tool", cap: 2 },
]
function acquireLock(directory: string, evidence: string) {
  const lock = path.join(directory, "runner.lock")
  let fd: number
  try {
    fd = openSync(lock, "wx")
  } catch {
    throw new Error(
      "Acceptance budget is locked; verify the owner before recovery",
    )
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    closeSync(fd)
    unlinkSync(lock)
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        evidence,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    )
  } catch (error) {
    release()
    throw error
  }
  return release
}
function historicalMaximum(directory: string, requested: number) {
  for (const file of [
    "ledger.jsonl",
    "live-time.json",
    "source-manifest.json",
    "result.json",
  ])
    if (!existsSync(path.join(directory, file)))
      throw new Error(`Missing historical budget evidence: ${file}`)
  const prior = record(
    JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")),
  )
  const maximum = record(prior.budget).maxCredits
  if (typeof maximum !== "number" || !Number.isFinite(maximum))
    throw new Error("Invalid historical budget")
  return Math.min(requested, maximum)
}
function readLimits(options: ContinuationOptions): Limits {
  const { additionalCredits, additionalAttempts, additionalMinutes } = options
  for (const [value, max] of [
    [additionalCredits, 30],
    [additionalAttempts, 20],
    [additionalMinutes, 15],
  ])
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || value <= 0
      || value > Number(max)
    )
      throw new Error("Explicit bounded additional limits are required")
  if (!Number.isInteger(additionalAttempts))
    throw new Error("Additional attempts must be an integer")
  return {
    additionalCredits: Number(additionalCredits),
    additionalAttempts: Number(additionalAttempts),
    additionalMinutes: Number(additionalMinutes),
  }
}
function restoreContract(
  saved: Record<string, unknown>,
  context: BudgetContext,
  limits: Limits,
): Contract {
  for (const [key, value] of Object.entries(limits))
    if (saved[key] !== value)
      throw new Error("Additional limits cannot change on continuation")
  const { baseAttempts, baseCredits, baseElapsedMs } = saved
  if (
    typeof baseAttempts !== "number"
    || !Number.isSafeInteger(baseAttempts)
    || baseAttempts < 0
    || baseAttempts > context.ledger.grants.length
    || typeof baseCredits !== "number"
    || !Number.isFinite(baseCredits)
    || typeof baseElapsedMs !== "number"
    || !Number.isFinite(baseElapsedMs)
    || baseElapsedMs < 0
    || baseElapsedMs > context.clock.elapsedMs()
  )
    throw new Error("Corrupt followup baseline")
  const prefixCredits = context.ledger.grants
    .slice(0, baseAttempts)
    .reduce((sum, grant) => sum + grant.reservedCredits, 0)
  if (Math.abs(prefixCredits - baseCredits) > 0.000001)
    throw new Error("Corrupt followup baseline credits")
  return { baseAttempts, baseCredits, baseElapsedMs, ...limits }
}
function openContract(
  locations: { directory: string; budgetDirectory: string },
  context: BudgetContext,
  limits: Limits,
) {
  const { directory, budgetDirectory } = locations
  const contractFile = path.join(budgetDirectory, "followup-budget.json")
  const originFile = path.join(budgetDirectory, "followup-origin.json")
  if (existsSync(contractFile) !== existsSync(originFile))
    throw new Error("Missing followup contract or origin checkpoint")
  const linkFile = path.join(directory, "budget-link.json")
  if (existsSync(linkFile)) {
    const link = record(JSON.parse(readFileSync(linkFile, "utf8")))
    if (link.budgetDirectory !== budgetDirectory || !existsSync(contractFile))
      throw new Error("Missing or changed followup budget binding")
  }
  let contract: Contract
  if (existsSync(contractFile)) {
    if (readFileSync(contractFile, "utf8") !== readFileSync(originFile, "utf8"))
      throw new Error("Corrupt followup contract checkpoint")
    contract = restoreContract(
      record(JSON.parse(readFileSync(contractFile, "utf8"))),
      context,
      limits,
    )
  } else {
    const summary = context.ledger.summary()
    contract = {
      baseAttempts: summary.attempts,
      baseCredits: summary.reservedCredits,
      baseElapsedMs: context.clock.elapsedMs(),
      ...limits,
    }
    writeFileSync(contractFile, JSON.stringify(contract, null, 2), {
      encoding: "utf8",
      flag: "wx",
    })
    writeFileSync(originFile, JSON.stringify(contract, null, 2), {
      encoding: "utf8",
      flag: "wx",
    })
  }
  writeFileSync(
    linkFile,
    JSON.stringify({ budgetDirectory, contractFile }),
    "utf8",
  )
  return contract
}

function validateAuthorization(
  saved: Record<string, unknown>,
  budgetDirectory: string,
) {
  if (
    saved.approved !== true
    || typeof saved.approvalReference !== "string"
    || !saved.approvalReference.trim()
    || typeof saved.roundId !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(saved.roundId)
    || saved.budgetDirectory !== budgetDirectory
    || (saved.version !== 2
      && saved.version !== 4
      && saved.model !== "gpt-5.6-luna")
    || saved.effort !== "low"
    || typeof saved.priorLedgerSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(saved.priorLedgerSha256)
    || !Number.isSafeInteger(saved.priorLedgerBytes)
    || Number(saved.priorLedgerBytes) < 0
  )
    throw new Error(
      "Explicit approved authorization and ledger binding required",
    )
}

function authorizationCaps(saved: Record<string, unknown>, attempts: number) {
  const cases = record(saved.cases)
  if (Object.keys(cases).length === 0)
    throw new Error("Authorization requires exact scenario caps")
  const caps: NonNullable<Contract["cases"]> = {}
  for (const [id, value] of Object.entries(cases)) {
    const cap = record(value)
    if (
      !["claude-tool", "codex-tool", "rate-limit-followup"].includes(id)
      || !Number.isSafeInteger(cap.attempts)
      || Number(cap.attempts) <= 0
      || Number(cap.attempts) > attempts
      || !Number.isSafeInteger(cap.inputTokens)
      || Number(cap.inputTokens) <= 0
      || Number(cap.inputTokens) > 65536
      || !Number.isSafeInteger(cap.outputTokens)
      || Number(cap.outputTokens) <= 0
      || Number(cap.outputTokens) > 4096
    )
      throw new Error("Invalid authorization scenario caps")
    caps[id] = {
      attempts: Number(cap.attempts),
      inputTokens: Number(cap.inputTokens),
      outputTokens: Number(cap.outputTokens),
    }
  }
  return caps
}

function validateHistoricalContract(
  budgetDirectory: string,
  context: BudgetContext,
) {
  const contractFile = path.join(budgetDirectory, "followup-budget.json")
  const originFile = path.join(budgetDirectory, "followup-origin.json")
  if (!existsSync(contractFile) || !existsSync(originFile))
    throw new Error("Missing historical followup contract or origin checkpoint")
  const serialized = readFileSync(contractFile, "utf8")
  if (serialized !== readFileSync(originFile, "utf8"))
    throw new Error("Corrupt historical followup contract checkpoint")
  const saved = record(JSON.parse(serialized))
  restoreContract(
    saved,
    context,
    readLimits({
      additionalCredits: Number(saved.additionalCredits),
      additionalAttempts: Number(saved.additionalAttempts),
      additionalMinutes: Number(saved.additionalMinutes),
    }),
  )
}

function openAuthorizedRound(
  locations: { directory: string; budgetDirectory: string },
  context: BudgetContext,
  options: ContinuationOptions,
): Contract {
  const { directory, budgetDirectory } = locations
  validateHistoricalContract(budgetDirectory, context)
  if (!options.authorizationFile) throw new Error("Authorization file required")
  const saved = record(
    JSON.parse(readFileSync(options.authorizationFile, "utf8")),
  )
  validateAuthorization(saved, budgetDirectory)
  const roundId = String(saved.roundId)
  let matrix: MatrixAuthorization | undefined
  switch (saved.version) {
    case 4: {
      matrix = readE2eAuthorization(saved)
      break
    }
    case 3: {
      matrix = readCacheAuthorization(saved)
      break
    }
    case 2: {
      matrix = readMatrixAuthorization(saved)
      break
    }
    default: {
      break
    }
  }
  const limits = matrix ? matrixLimits(options) : readLimits(options)
  const contract = restoreContract(saved, context, limits)
  const caps =
    matrix ? undefined : authorizationCaps(saved, contract.additionalAttempts)
  const serialized = JSON.stringify(saved)
  const origin = path.join(budgetDirectory, `authorization-${roundId}.json`)
  if (context.ledger.hasAuthorization(roundId) && !existsSync(origin))
    throw new Error("Missing authorization origin")
  if (existsSync(origin) && readFileSync(origin, "utf8") !== serialized)
    throw new Error("Authorization origin changed")
  const link = path.join(directory, "budget-link.json")
  if (existsSync(link)) {
    const previous = record(JSON.parse(readFileSync(link, "utf8")))
    if (
      previous.budgetDirectory !== budgetDirectory
      || previous.authorizationFile !== origin
    )
      throw new Error("Authorization evidence binding changed")
  }
  context.ledger.activateAuthorization(roundId, serialized)
  if (!existsSync(origin))
    writeFileSync(origin, serialized, { encoding: "utf8", flag: "wx" })
  writeFileSync(
    link,
    JSON.stringify({ budgetDirectory, authorizationFile: origin }),
    "utf8",
  )
  return { ...contract, cases: caps, matrix }
}
function matrixLimits(options: ContinuationOptions): Limits {
  const { additionalCredits, additionalAttempts, additionalMinutes } = options
  if (
    typeof additionalCredits !== "number"
    || typeof additionalAttempts !== "number"
    || typeof additionalMinutes !== "number"
  )
    throw new Error("Explicit matrix CLI limits required")
  return { additionalCredits, additionalAttempts, additionalMinutes }
}
function expired(context: BudgetContext) {
  const { clock, contract } = context
  return (
    clock.elapsedMs() >= (contract?.matrix?.cumulative.activeMs ?? 3600000)
    || (contract !== undefined
      && clock.elapsedMs() - contract.baseElapsedMs
        >= contract.additionalMinutes * 60000)
  )
}
function checkAdmission(
  context: BudgetContext,
  credits: number,
  request: Reservation,
) {
  if (expired(context))
    throw new Error("Additional or cumulative live deadline reached")
  const { contract, ledger } = context
  if (!contract) return
  const summary = ledger.summary()
  if (
    summary.attempts - contract.baseAttempts >= contract.additionalAttempts
    || summary.reservedCredits - contract.baseCredits + credits
      > contract.additionalCredits
  )
    throw new Error("Additional reservation limit reached")
  if (contract.matrix) {
    const cap = assertMatrixScope(contract.matrix, request)
    if (
      ledger.grants
        .slice(contract.baseAttempts)
        .filter((grant) => grant.caseId === request.caseId).length
      >= cap.attempts
    )
      throw new Error("Additional scenario attempt limit reached")
    return
  }
  checkLegacyAdmission(contract, ledger, request)
}
function checkLegacyAdmission(
  contract: Contract,
  ledger: BudgetLedger,
  request: Reservation,
) {
  if (request.model !== "gpt-5.6-luna")
    throw new Error("Followup permits Luna only")
  if (contract.cases) {
    const cap = contract.cases[request.caseId]
    const phase =
      request.caseId === "rate-limit-followup" ? "operations" : "clients"
    if (
      !cap
      || request.endpoint !== "/responses"
      || request.phase !== phase
      || request.inputTokens > cap.inputTokens
      || request.outputTokens > cap.outputTokens
    )
      throw new Error("Request exceeds authorized scenario scope")
    if (
      ledger.grants
        .slice(contract.baseAttempts)
        .filter((grant) => grant.caseId === request.caseId).length
      >= cap.attempts
    )
      throw new Error("Additional scenario attempt limit reached")
    return
  }
  const group = groups.find((item) => request.caseId.startsWith(item.prefix))
  if (!group) throw new Error("Scenario is not in the followup plan")
  const used = ledger.grants
    .slice(contract.baseAttempts)
    .filter((grant) => grant.caseId.startsWith(group.prefix)).length
  if (used >= group.cap)
    throw new Error("Additional scenario attempt limit reached")
}
/** Separate source evidence while retaining one locked, cumulative budget. */
export function openBudget(input: {
  directory: string
  maxCredits: number
  previous: Array<{ id: string; durationMs: number }>
  options: ContinuationOptions
}) {
  const { directory, maxCredits, previous, options } = input
  if (
    !options.budgetDirectory
    && existsSync(path.join(directory, "budget-link.json"))
  )
    throw new Error("Followup evidence requires its original --budget-dir")
  const budgetDirectory = path.resolve(options.budgetDirectory ?? directory)
  const shared = budgetDirectory !== path.resolve(directory)
  if (options.budgetDirectory && !shared)
    throw new Error("Followup evidence must use a separate directory")
  const maximum =
    shared ? historicalMaximum(budgetDirectory, maxCredits) : maxCredits
  const release = acquireLock(budgetDirectory, path.resolve(directory))
  try {
    const ledger = new BudgetLedger(
      path.join(budgetDirectory, "ledger.jsonl"),
      maximum,
    )
    reconcileHistorical(ledger, budgetDirectory)
    if (
      (existsSync(path.join(budgetDirectory, "followup-origin.json"))
        || ledger.hasAuthorizedRounds())
      && !existsSync(`${ledger.file}.checkpoint.json`)
    )
      throw new Error("Missing ledger checkpoint for followup")
    ledger.enableCheckpoint()
    const e2e =
      options.authorizationFile
      && record(JSON.parse(readFileSync(options.authorizationFile, "utf8")))
        .version === 4
    restoreSafetyStop(budgetDirectory, ledger, Boolean(e2e))
    restoreSafetyStop(directory, ledger, Boolean(e2e))
    const clock = new LiveTime(budgetDirectory, previous)
    const context: BudgetContext = { ledger, clock }
    if (options.authorizationFile && !shared)
      throw new Error("Authorization requires historical budget directory")
    if (options.authorizationFile)
      context.contract = openAuthorizedRound(
        { directory, budgetDirectory },
        context,
        options,
      )
    else if (shared)
      context.contract = openContract(
        { directory, budgetDirectory },
        context,
        readLimits(options),
      )
    ledger.beforeReserve = (credits, request) =>
      checkAdmission(context, credits, request)
    const summary = () =>
      context.contract ?
        {
          ...context.contract,
          budgetDirectory,
          attempts: ledger.grants.length - context.contract.baseAttempts,
          reservedCredits:
            ledger.summary().reservedCredits - context.contract.baseCredits,
          elapsedMs: clock.elapsedMs() - context.contract.baseElapsedMs,
        }
      : undefined
    return {
      ledger,
      clock,
      expired: () => expired(context),
      summary,
      release,
      shared,
    }
  } catch (error) {
    release()
    throw error
  }
}

function restoreSafetyStop(
  directory: string,
  ledger: BudgetLedger,
  e2e = false,
) {
  const filename = path.join(directory, "blocked.jsonl")
  if (!existsSync(filename)) return
  for (const line of readFileSync(filename, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)) {
    const reason = record(JSON.parse(line)).reason
    if (
      e2e
      && [
        "Additional scenario attempt limit reached",
        "Per-request token limit exceeded",
      ].includes(String(reason))
    )
      continue
    if (
      typeof reason === "string"
      && !ledger.hasHistoricalStop(reason)
      && /limit (?:exceeded|reached)|deadline|source changed|checkpoint/iu.test(
        reason,
      )
    )
      ledger.halt(reason)
  }
}

function reconcileHistorical(ledger: BudgetLedger, directory: string) {
  const filename = path.join(directory, "result.json")
  if (!existsSync(filename)) return
  const budget = record(
    record(JSON.parse(readFileSync(filename, "utf8"))).budget,
  )
  const attempts = budget.attempts
  if (
    typeof attempts !== "number"
    || !Number.isSafeInteger(attempts)
    || attempts < 0
    || ledger.grants.length < attempts
    || typeof budget.reservedCredits !== "number"
  )
    throw new Error("Historical ledger lost reservations")
  const prefix = ledger.grants.slice(0, attempts)
  const credits = prefix.reduce((sum, grant) => sum + grant.reservedCredits, 0)
  if (
    !Number.isFinite(budget.reservedCredits)
    || Math.abs(credits - budget.reservedCredits) > 0.000001
  )
    throw new Error("Historical ledger credits mismatch")
  const unknown = prefix.filter(
    (grant) => !ledger.observations.get(grant.id)?.usage,
  ).length
  if (
    typeof budget.unknownUsageAttempts !== "number"
    || unknown > budget.unknownUsageAttempts
  )
    throw new Error("Historical ledger lost usage observations")
}
