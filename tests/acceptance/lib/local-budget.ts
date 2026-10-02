import { encode } from "gpt-tokenizer/encoding/o200k_base"
import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs"

import { readCacheAuthorization } from "./local-cache-authorization"
import {
  e2eRate,
  readE2eAuthorization,
  type E2eAuthorization,
} from "./local-e2e-authorization"
import {
  assertMatrixScope,
  MATRIX_RATES,
  readMatrixAuthorization,
  type MatrixAuthorization,
} from "./local-matrix-authorization"

export type Phase =
  | "functional"
  | "clients"
  | "operations"
  | "comparison"
  | "recheck"
export type Json = Record<string, unknown>

export const PHASE_LIMITS: Record<
  Phase,
  { credits: number; attempts: number }
> = {
  functional: { credits: 200, attempts: 24 },
  clients: { credits: 250, attempts: 24 },
  operations: { credits: 150, attempts: 32 },
  comparison: { credits: 100, attempts: 16 },
  recheck: { credits: 200, attempts: 24 },
}

// GitHub Copilot published USD / million tokens, checked 2026-09-29.
// Reserve input + cache-write at full price; never assume a cache discount.
const RATES: Partial<Record<string, { input: number; output: number }>> = {
  ...MATRIX_RATES,
  // Pin legacy ledger rates: restore validates old reservations against these
  // amounts. A future pricing change needs a versioned accounting migration.
  "gpt-5.6-luna": { input: 0.45, output: 1.2 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5.6-terra": { input: 4.5, output: 12 },
}

export function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Json)
    : {}
}

export interface Reservation {
  caseId: string
  phase: Phase
  model: string
  endpoint: string
  inputTokens: number
  outputTokens: number
  effort: string
  limitApplied: boolean
}

export interface Grant extends Reservation {
  kind: "reserve"
  id: string
  at: string
  reservedCredits: number
  roundId?: string
  pricingTier?: "default" | "long"
}

export interface Observation {
  outcome: string
  status?: number
  durationMs?: number
  upstreamSignalAborted?: boolean
  usage: Json | null
  protocolOutcome?: string
  transportOutcome?: string
}

interface Observed extends Observation {
  kind: "observe"
  id: string
  at: string
}

export class BudgetLedger {
  private matrix?: MatrixAuthorization
  private e2e?: E2eAuthorization
  stopReason?: string
  private readonly stops: Array<string> = []
  private readonly authorizations = new Map<
    string,
    { serialized: string; stops: number }
  >()
  private checkpointFile?: string
  private checkpointFailed = false
  beforeReserve?: (credits: number, request: Reservation) => void
  readonly file: string
  readonly maxCredits: number
  readonly maxAttempts: number
  readonly grants: Array<Grant> = []
  readonly observations = new Map<string, Observed>()

  constructor(file: string, maxCredits = 1000, maxAttempts = 120) {
    if (!Number.isFinite(maxCredits) || maxCredits <= 0 || maxCredits > 1000)
      throw new Error("Credits must be in (0, 1000]")
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 120)
      throw new Error("Attempts must be in [1, 120]")
    this.file = file
    this.maxCredits = maxCredits
    this.maxAttempts = maxAttempts
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)) {
        const row = record(JSON.parse(line))
        this.restore(row)
      }
    }
  }

  enableCheckpoint() {
    this.checkpointFile = `${this.file}.checkpoint.json`
    if (existsSync(this.checkpointFile)) {
      const saved = record(
        JSON.parse(readFileSync(this.checkpointFile, "utf8")),
      )
      const current = this.fingerprint()
      if (saved.bytes !== current.bytes || saved.sha256 !== current.sha256)
        throw new Error("Corrupt or truncated ledger checkpoint")
    } else {
      if (!existsSync(this.file))
        writeFileSync(this.file, "", { encoding: "utf8", flag: "wx" })
      this.writeCheckpoint()
    }
  }

  private fingerprint() {
    const bytes = readFileSync(this.file)
    return {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }

  private writeCheckpoint() {
    if (!this.checkpointFile) return
    try {
      const temporary = `${this.checkpointFile}.tmp`
      writeFileSync(temporary, JSON.stringify(this.fingerprint()), "utf8")
      renameSync(temporary, this.checkpointFile)
    } catch (error) {
      this.checkpointFailed = true
      throw new Error("Ledger checkpoint failed; further admission blocked", {
        cause: error,
      })
    }
  }

  private restoreAuthorization(row: Json) {
    const serialized = row.serialized
    if (typeof serialized !== "string") throw new Error("Corrupt authorization")
    const authorization = record(JSON.parse(serialized))
    const bytes = readFileSync(this.file)
    const offset = authorization.priorLedgerBytes
    if (
      !Number.isSafeInteger(offset)
      || Number(offset) < 0
      || Number(offset) > bytes.length
      || createHash("sha256")
        .update(bytes.subarray(0, Number(offset)))
        .digest("hex") !== authorization.priorLedgerSha256
      || typeof authorization.roundId !== "string"
      || this.authorizations.has(authorization.roundId)
    )
      throw new Error("Corrupt authorization ledger binding")
    this.authorizations.set(authorization.roundId, {
      serialized,
      stops: this.stops.length,
    })
    this.e2e =
      authorization.version === 4 ?
        readE2eAuthorization(authorization)
      : undefined
    if (this.e2e) this.assertE2eBaseline(this.e2e)
    this.stopReason ??=
      "Explicit authorization file required for round continuation"
  }

  private restore(row: Json) {
    if (row.kind === "authorization") {
      this.restoreAuthorization(row)
      return
    }
    if (row.kind === "stop") {
      this.restoreStop(row)
      return
    }
    if (row.kind === "observe") {
      if (
        typeof row.id !== "string"
        || !this.grants.some((grant) => grant.id === row.id)
      )
        throw new Error("Corrupt observation ledger")
      this.observations.set(row.id, row as unknown as Observed)
      return
    }
    if (row.kind !== "reserve")
      throw new Error("Unrecognized ledger entry; refusing to reset budget")
    this.restoreGrant(row as unknown as Grant)
  }

  private ratesFor(
    request: Pick<Reservation, "model" | "inputTokens">,
  ): { input: number; output: number; tier?: "default" | "long" } | undefined {
    if (this.e2e) return e2eRate(this.e2e, request.model, request.inputTokens)
    return Object.hasOwn(RATES, request.model) ?
        RATES[request.model]
      : undefined
  }

  private restoreGrant(grant: Grant) {
    this.validateRequest(grant)
    const rates = this.ratesFor(grant)
    if (this.e2e) {
      assertMatrixScope(this.e2e, grant)
      if (
        grant.roundId !== this.e2e.roundId
        || grant.pricingTier !== rates?.tier
      )
        throw new Error("Corrupt E2E reservation binding")
    } else if (grant.roundId !== undefined)
      throw new Error("Unexpected E2E reservation")
    if (
      !rates
      || typeof grant.id !== "string"
      || typeof grant.at !== "string"
      || this.grants.some((prior) => prior.id === grant.id)
    )
      throw new Error("Corrupt reservation identity")
    const minimum =
      (grant.inputTokens * rates.input + grant.outputTokens * rates.output)
      / 10000
    if (
      !Number.isFinite(grant.reservedCredits)
      || grant.reservedCredits + 0.000001 < minimum
    )
      throw new Error("Corrupt reservation cost")
    this.grants.push(grant)
  }

  private validateRequest(request: Reservation) {
    if (request.effort !== "low")
      throw new Error("Expected low reasoning effort")
    if (!["/chat/completions", "/responses"].includes(request.endpoint))
      throw new Error("Generation endpoint is not allowed")
    const phase = Object.entries(PHASE_LIMITS).find(
      ([name]) => name === request.phase,
    )?.[1]
    if (!phase || !request.caseId) throw new Error("Missing case or phase")
    for (const count of [request.inputTokens, request.outputTokens])
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new Error("Invalid token count")
    const cap = this.e2e?.cases[request.caseId]
    if (
      request.inputTokens > (cap?.inputTokens ?? 65536)
      || request.outputTokens > (cap?.outputTokens ?? 4096)
    )
      throw new Error("Per-request token limit exceeded")
    return phase
  }

  private restoreStop(row: Json) {
    if (
      typeof row.reason !== "string"
      || !row.reason
      || typeof row.at !== "string"
    )
      throw new Error("Corrupt safety stop")
    this.stopReason ??= row.reason
    this.stops.push(row.reason)
  }

  hasHistoricalStop(reason: string) {
    return this.stops.includes(reason)
  }

  hasAuthorization(roundId: string) {
    return this.authorizations.has(roundId)
  }

  hasAuthorizedRounds() {
    return this.authorizations.size > 0
  }

  activateAuthorization(roundId: string, serialized: string) {
    const saved = record(JSON.parse(serialized))
    let matrix: MatrixAuthorization | undefined
    const e2e = saved.version === 4 ? readE2eAuthorization(saved) : undefined
    if (e2e) matrix = e2e
    else if (saved.version === 3) matrix = readCacheAuthorization(saved)
    else if (saved.version === 2) matrix = readMatrixAuthorization(saved)
    if (this.checkpointFailed) throw new Error("Ledger checkpoint failed")
    const existing = this.authorizations.get(roundId)
    if (existing) {
      if (
        existing.serialized !== serialized
        || existing.stops !== this.stops.length
        || Array.from(this.authorizations.keys()).at(-1) !== roundId
      )
        throw new Error("Authorization changed or its round has stopped")
    } else {
      const authorization = record(JSON.parse(serialized))
      const current = this.fingerprint()
      if (
        authorization.priorLedgerBytes !== current.bytes
        || authorization.priorLedgerSha256 !== current.sha256
      )
        throw new Error("Authorization does not match current ledger")
      if (
        authorization.baseAttempts !== this.grants.length
        || Math.abs(
          Number(authorization.baseCredits) - this.summary().reservedCredits,
        ) > 0.000001
      )
        throw new Error("Authorization baseline must match current ledger")
      if (e2e) this.assertE2eBaseline(e2e)
      appendFileSync(
        this.file,
        `${JSON.stringify({ kind: "authorization", serialized })}\n`,
        "utf8",
      )
      this.authorizations.set(roundId, { serialized, stops: this.stops.length })
      this.writeCheckpoint()
    }
    this.stopReason = undefined
    this.matrix = matrix
    this.e2e = e2e
  }

  private assertE2eBaseline(authorization: E2eAuthorization) {
    if (
      authorization.baseAttempts !== this.grants.length
      || Math.abs(authorization.baseCredits - this.summary().reservedCredits)
        > 0.000001
    )
      throw new Error("E2E authorization baseline mismatch")
    for (const [phase, baseline] of Object.entries(
      authorization.phaseBaselines,
    )) {
      const grants = this.grants.filter((grant) => grant.phase === phase)
      if (
        grants.length !== baseline.attempts
        || Math.abs(
          grants.reduce((sum, grant) => sum + grant.reservedCredits, 0)
            - baseline.credits,
        ) > 0.000001
      )
        throw new Error("E2E phase baseline mismatch")
    }
  }

  private admissionPhase(request: Reservation) {
    const defaultPhase = this.validateRequest(request)
    const phase = this.matrix?.cumulative.phases[request.phase] ?? defaultPhase
    if (this.matrix) assertMatrixScope(this.matrix, request)
    else if (
      !["gpt-5-mini", "gpt-5.6-luna", "gpt-5.6-terra"].includes(request.model)
    )
      throw new Error("Model requires explicit matrix authorization")
    if (request.model === "gpt-5.6-terra" && !this.matrix) {
      if (request.phase !== "comparison")
        throw new Error("Terra requires comparison phase")
      if (
        this.grants.filter((grant) => grant.model === request.model).length >= 4
      )
        throw new Error("Terra four-attempt limit exceeded")
    }
    return phase
  }

  private assertE2eCaseCap(request: Reservation) {
    if (!this.e2e) return
    const cap = assertMatrixScope(this.e2e, request)
    const attempts = this.grants
      .slice(this.e2e.baseAttempts)
      .filter((grant) => grant.caseId === request.caseId).length
    if (attempts >= cap.attempts)
      throw new Error("Additional scenario attempt limit reached")
  }

  private assertReservationPrice(credits: number) {
    if (!Number.isFinite(credits) || credits <= 0)
      throw new Error("Invalid credit reservation")
  }

  reserve(request: Reservation): Grant {
    if (this.stopReason)
      throw new Error(`Persisted acceptance stop: ${this.stopReason}`)
    if (this.checkpointFailed) throw new Error("Ledger checkpoint failed")
    if (typeof request.model !== "string")
      throw new Error("Model must be an allowlisted string")
    const rates = this.ratesFor(request)
    if (!rates) throw new Error("Model is not in the priced OpenAI allowlist")
    const phase = this.admissionPhase(request)
    this.assertE2eCaseCap(request)
    const credits =
      Math.ceil(
        ((request.inputTokens * rates.input
          + request.outputTokens * rates.output)
          / 10000)
          * 1e6,
      ) / 1e6
    this.assertReservationPrice(credits)
    const phaseGrants = this.grants.filter(
      (grant) => grant.phase === request.phase,
    )
    if (
      this.grants.length
        >= (this.matrix?.cumulative.attempts ?? this.maxAttempts)
      || phaseGrants.length >= phase.attempts
    )
      throw new Error("Upstream attempt limit exceeded")
    const sum = (rows: Array<Grant>) =>
      rows.reduce((total, grant) => total + grant.reservedCredits, 0)
    if (
      sum(this.grants) + credits
        > (this.e2e?.cumulative.admissionCredits ?? this.maxCredits * 0.9)
      || sum(phaseGrants) + credits > phase.credits
    )
      throw new Error("Credit reservation limit exceeded")
    this.beforeReserve?.(credits, request)
    const grant: Grant = {
      ...request,
      kind: "reserve",
      id: randomUUID(),
      at: new Date().toISOString(),
      reservedCredits: credits,
      ...(this.e2e ?
        {
          roundId: this.e2e.roundId,
          pricingTier: rates.tier,
        }
      : {}),
    }
    // Synchronous append and accounting keep concurrent reservations atomic.
    appendFileSync(this.file, `${JSON.stringify(grant)}\n`, "utf8")
    this.grants.push(grant)
    this.writeCheckpoint()
    return grant
  }

  observe(id: string, observation: Observation): void {
    if (!this.grants.some((grant) => grant.id === id))
      throw new Error("Unknown reservation")
    const event: Observed = {
      ...observation,
      kind: "observe",
      id,
      at: new Date().toISOString(),
    }
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8")
    this.observations.set(id, event)
    this.writeCheckpoint()
  }

  summary() {
    return {
      maxCredits: this.e2e?.cumulative.maxCredits ?? this.maxCredits,
      admissionLimitCredits:
        this.e2e?.cumulative.admissionCredits ?? this.maxCredits * 0.9,
      reservedCredits: this.grants.reduce(
        (total, grant) => total + grant.reservedCredits,
        0,
      ),
      attempts: this.grants.length,
      unknownUsageAttempts: this.grants.filter(
        (grant) => !this.observations.get(grant.id)?.usage,
      ).length,
      estimatedInputTokens: this.grants.reduce(
        (total, grant) => total + grant.inputTokens,
        0,
      ),
      reservedOutputTokens: this.grants.reduce(
        (total, grant) => total + grant.outputTokens,
        0,
      ),
    }
  }

  halt(reason: string) {
    if (this.stopReason) return
    this.stopReason = reason
    this.stops.push(reason)
    appendFileSync(
      this.file,
      `${JSON.stringify({ kind: "stop", reason, at: new Date().toISOString() })}\n`,
      "utf8",
    )
    this.writeCheckpoint()
  }
}

function outputLimitKey(endpoint: string, body: Json): string {
  if (endpoint === "/responses") return "max_output_tokens"
  if (body.max_tokens !== undefined) {
    if (body.max_completion_tokens !== undefined)
      throw new Error("Ambiguous Chat output limits")
    return "max_tokens"
  }
  return "max_completion_tokens"
}

export function prepareGeneration(
  endpoint: string,
  source: Json,
  limits = { inputTokens: 65536, outputTokens: 4096 },
) {
  if (!["/chat/completions", "/responses"].includes(endpoint))
    throw new Error("Unexpected generation endpoint")
  const body = { ...source }
  if (body.n !== undefined && body.n !== 1)
    throw new Error("Acceptance permits one completion per request")
  const effort =
    endpoint === "/responses" ?
      record(body.reasoning).effort
    : body.reasoning_effort
  if (effort !== "low")
    throw new Error("Egress reasoning effort must be explicitly low")
  const key = outputLimitKey(endpoint, body)
  const requested = body[key] ?? undefined
  if (
    requested !== undefined
    && (!Number.isSafeInteger(requested) || Number(requested) <= 0)
  )
    throw new Error("Invalid output token limit")
  validateGenerationLimits(limits)
  const outputTokens = Math.min(Number(requested ?? 2048), limits.outputTokens)
  const limitApplied =
    requested === undefined || Number(requested) > outputTokens
  body[key] = outputTokens
  const serialized = JSON.stringify(body)
  const media = /"type":"input_(?:image|file)"|"image_url"/u.test(serialized)
  const inputTokens = media ? 65536 : encode(serialized).length * 2 + 1024
  if (inputTokens > limits.inputTokens)
    throw new Error(
      limits.inputTokens === 65536 ?
        "Estimated input exceeds 64K acceptance limit"
      : "Estimated input exceeds authorized history limit",
    )
  return { body, serialized, inputTokens, outputTokens, effort, limitApplied }
}

function validateGenerationLimits(limits: {
  inputTokens: number
  outputTokens: number
}) {
  if (
    !Number.isSafeInteger(limits.inputTokens)
    || limits.inputTokens <= 0
    || limits.inputTokens > 1000000
    || !Number.isSafeInteger(limits.outputTokens)
    || limits.outputTokens <= 0
    || limits.outputTokens > 4096
  )
    throw new Error("Invalid explicit request token caps")
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function list(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}
