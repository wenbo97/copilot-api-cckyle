import type { Phase } from "./local-budget"
import type {
  MatrixAuthorization,
  MatrixCase,
} from "./local-matrix-authorization"

export const E2E_MODELS = [
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-5.6-terra",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6-astra",
] as const
export type E2eStage = "matrix" | "legacy"
export const E2E_LIMITS = {
  matrix: {
    additionalCredits: 1000,
    additionalAttempts: 176,
    additionalMinutes: 90,
  },
  legacy: {
    additionalCredits: 8000,
    additionalAttempts: 2,
    additionalMinutes: 10,
  },
} as const
export const E2E_KINDS = {
  "responses-json": { phase: "functional", attempts: 1, outputTokens: 512 },
  "responses-stream": { phase: "functional", attempts: 1, outputTokens: 512 },
  "messages-json": { phase: "functional", attempts: 1, outputTokens: 512 },
  "messages-stream": { phase: "functional", attempts: 1, outputTokens: 512 },
  "parallel-tools": { phase: "functional", attempts: 2, outputTokens: 512 },
  "claude-a": { phase: "clients", attempts: 3, outputTokens: 2048 },
  "claude-b": { phase: "clients", attempts: 3, outputTokens: 2048 },
  "codex-tool": { phase: "clients", attempts: 2, outputTokens: 2048 },
  history: { phase: "clients", attempts: 5, outputTokens: 512 },
  cancel: { phase: "operations", attempts: 2, outputTokens: 512 },
  refresh: { phase: "operations", attempts: 1, outputTokens: 512 },
} as const
export type E2eKind = keyof typeof E2E_KINDS
const phases: Array<Phase> = [
  "functional",
  "clients",
  "operations",
  "comparison",
  "recheck",
]

interface PriceTier {
  input: number
  cacheWrite: number
  output: number
}
export interface CopilotPrice {
  threshold: number
  default: PriceTier
  long: PriceTier
  source: string
  verifiedAt: string
}
const source =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing"
function price(
  threshold: number,
  standard: [number, number, number],
  extended: [number, number, number],
): CopilotPrice {
  return {
    threshold,
    default: {
      input: standard[0],
      cacheWrite: standard[1],
      output: standard[2],
    },
    long: { input: extended[0], cacheWrite: extended[1], output: extended[2] },
    source,
    verifiedAt: "2026-09-30",
  }
}
// Copilot prices fetched from the named official page on 2026-09-30.
// The fast catalog ID has no published row: it deliberately remains unpriced.
export const E2E_PRICES: Partial<Record<string, CopilotPrice>> = {
  "gpt-5.6-luna": price(200000, [0.2, 0.25, 1.2], [0.4, 0.5, 1.8]),
  "gpt-5.6-terra": price(272000, [2, 2.5, 12], [4, 5, 18]),
  "gpt-5.6-sol": price(272000, [4, 5, 20], [8, 10, 30]),
  "gpt-6-luna": price(272000, [0.1, 0.125, 0.5], [0.2, 0.25, 0.75]),
  "gpt-6-sol": price(272000, [2, 2.5, 10], [4, 5, 15]),
  "gpt-6-astra": price(272000, [10, 12.5, 50], [20, 25, 75]),
  "gpt-6.1-sol": price(272000, [2, 2.5, 10], [4, 5, 15]),
}
export interface E2eAuthorization extends MatrixAuthorization {
  stage: E2eStage
  roundId: string
  baseAttempts: number
  baseCredits: number
  baseElapsedMs: number
  executionSha256: string
  legacyManifestSha256?: string
  prices: Partial<Record<string, CopilotPrice>>
  phaseBaselines: Record<Phase, { attempts: number; credits: number }>
}
export interface E2eAuthorizationInput {
  stage: E2eStage
  roundId: string
  budgetDirectory: string
  approvalReference: string
  priorLedgerBytes: number
  priorLedgerSha256: string
  baseAttempts: number
  baseCredits: number
  baseElapsedMs: number
  executionSha256: string
  legacyManifestSha256?: string
  phaseBaselines: Record<Phase, { attempts: number; credits: number }>
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}
function nonnegative(value: unknown, integer = false): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || (integer && !Number.isSafeInteger(value))
  )
    throw new Error("Invalid E2E baseline")
  return value
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("Invalid E2E fingerprint")
  return value
}
export function e2eCases(stage: E2eStage): Record<string, MatrixCase> {
  if (stage === "legacy")
    return Object.fromEntries(
      ["fork", "resume"].map((kind) => [
        `e2e-legacy-astra-${kind}`,
        {
          model: "gpt-6-astra",
          phase: "recheck",
          endpoint: "/responses",
          effort: "low",
          attempts: 1,
          inputTokens: 1000000,
          outputTokens: 512,
        },
      ]),
    )
  return Object.fromEntries(
    E2E_MODELS.flatMap((model) =>
      Object.entries(E2E_KINDS).map(([kind, cap]) => [
        `e2e-${model}-${kind}`,
        {
          ...cap,
          model,
          endpoint: "/responses",
          effort: "low",
          inputTokens: 65536,
        },
      ]),
    ),
  )
}
export function buildE2eAuthorization(
  input: E2eAuthorizationInput,
): Record<string, unknown> {
  const limits = E2E_LIMITS[input.stage]
  const cases = e2eCases(input.stage)
  const phaseCaps = Object.fromEntries(
    phases.map((phase) => [
      phase,
      {
        credits: input.phaseBaselines[phase].credits + limits.additionalCredits,
        attempts:
          input.phaseBaselines[phase].attempts
          + Object.values(cases)
            .filter((cap) => cap.phase === phase)
            .reduce((sum, cap) => sum + cap.attempts, 0),
      },
    ]),
  )
  return {
    ...input,
    version: 4,
    approved: true,
    effort: "low",
    ...limits,
    prices: E2E_PRICES,
    cases,
    cumulative: {
      maxCredits: input.baseCredits + limits.additionalCredits,
      admissionCredits: input.baseCredits + limits.additionalCredits,
      attempts: input.baseAttempts + limits.additionalAttempts,
      activeMs: input.baseElapsedMs + limits.additionalMinutes * 60000,
      phases: phaseCaps,
    },
  }
}
function e2eStage(saved: Record<string, unknown>): E2eStage {
  if (
    saved.version !== 4
    || saved.approved !== true
    || saved.effort !== "low"
    || (saved.stage !== "matrix" && saved.stage !== "legacy")
    || typeof saved.approvalReference !== "string"
    || !saved.approvalReference.trim()
    || typeof saved.roundId !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(saved.roundId)
  )
    throw new Error("Explicit approved E2E authorization required")
  return saved.stage
}
export function readE2eAuthorization(
  saved: Record<string, unknown>,
): E2eAuthorization {
  const stage = e2eStage(saved)
  for (const [key, value] of Object.entries(E2E_LIMITS[stage]))
    if (saved[key] !== value) throw new Error("E2E stage limits cannot change")
  const baseline = {
    baseAttempts: nonnegative(saved.baseAttempts, true),
    baseCredits: nonnegative(saved.baseCredits),
    baseElapsedMs: nonnegative(saved.baseElapsedMs),
  }
  digest(saved.priorLedgerSha256)
  nonnegative(saved.priorLedgerBytes, true)
  const executionSha256 = digest(saved.executionSha256)
  const legacyManifestSha256 =
    stage === "legacy" ? digest(saved.legacyManifestSha256) : undefined
  const phaseBaselines = {} as E2eAuthorization["phaseBaselines"]
  for (const phase of phases) {
    const entry = object(object(saved.phaseBaselines)[phase])
    phaseBaselines[phase] = {
      attempts: nonnegative(entry.attempts, true),
      credits: nonnegative(entry.credits),
    }
  }
  if (
    phases.reduce((sum, phase) => sum + phaseBaselines[phase].attempts, 0)
      !== baseline.baseAttempts
    || Math.abs(
      phases.reduce((sum, phase) => sum + phaseBaselines[phase].credits, 0)
        - baseline.baseCredits,
    ) > 0.000001
  )
    throw new Error("E2E phase baselines do not reconcile")
  const expected = buildE2eAuthorization({
    stage,
    roundId: String(saved.roundId),
    budgetDirectory: String(saved.budgetDirectory),
    approvalReference: String(saved.approvalReference),
    priorLedgerBytes: Number(saved.priorLedgerBytes),
    priorLedgerSha256: String(saved.priorLedgerSha256),
    ...baseline,
    phaseBaselines,
    executionSha256,
    legacyManifestSha256,
  })
  for (const key of ["cases", "prices", "cumulative"])
    if (JSON.stringify(saved[key]) !== JSON.stringify(expected[key]))
      throw new Error(`E2E ${key} snapshot changed`)
  return {
    stage,
    roundId: String(saved.roundId),
    ...baseline,
    phaseBaselines,
    executionSha256,
    legacyManifestSha256,
    cases: e2eCases(stage),
    prices: E2E_PRICES,
    cumulative: expected.cumulative as E2eAuthorization["cumulative"],
  }
}
export function e2eRate(
  authorization: Pick<E2eAuthorization, "prices">,
  model: string,
  inputTokens: number,
) {
  const entry = authorization.prices[model]
  if (!entry) throw new Error("Copilot price unverified; paid request blocked")
  const tier: "long" | "default" =
    inputTokens > entry.threshold ? "long" : "default"
  const rates = entry[tier]
  return { tier, input: rates.input + rates.cacheWrite, output: rates.output }
}
