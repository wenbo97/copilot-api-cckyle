import type { Phase } from "./local-budget"
import type { E2eAuthorization } from "./local-e2e-authorization"
import type { MatrixCase } from "./local-matrix-authorization"

import { resolveCodexFixtureDirectory } from "./local-client-config"
import { E2E_PRICES, readE2eAuthorization } from "./local-e2e-authorization"

export const LATEST_MODELS = [
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
] as const
export const LATEST_LIMITS = { credits: 500, attempts: 60, minutes: 45 }
export const LATEST_KINDS = {
  "responses-json": { phase: "functional", nominal: 1, outputTokens: 512 },
  "messages-json": { phase: "functional", nominal: 1, outputTokens: 512 },
  "codex-tool": { phase: "clients", nominal: 2, outputTokens: 2048 },
  "claude-a": { phase: "clients", nominal: 2, outputTokens: 2048 },
  "parallel-tools": { phase: "functional", nominal: 2, outputTokens: 512 },
  "cache-control-initial": {
    phase: "comparison",
    nominal: 1,
    outputTokens: 256,
  },
  "cache-control-repeat": {
    phase: "comparison",
    nominal: 1,
    outputTokens: 256,
  },
  "cache-control-suffix": {
    phase: "comparison",
    nominal: 1,
    outputTokens: 256,
  },
  "cache-prefix-initial": {
    phase: "comparison",
    nominal: 1,
    outputTokens: 256,
  },
  "cache-prefix-repeat": { phase: "comparison", nominal: 1, outputTokens: 256 },
  "cache-prefix-suffix": { phase: "comparison", nominal: 1, outputTokens: 256 },
  cancel: { phase: "operations", nominal: 2, outputTokens: 512 },
  refresh: { phase: "operations", nominal: 1, outputTokens: 512 },
  history: { phase: "clients", nominal: 5, outputTokens: 2048 },
} as const
export type LatestKind = keyof typeof LATEST_KINDS
export interface LatestAuthorization extends Omit<E2eAuthorization, "stage"> {
  stage: "latest"
  models: Array<string>
  fixtureSalt: string
  budgetDirectory: string
  approvalReference: string
  codexFixtureDirectory?: string
  additionalCredits: number
  additionalAttempts: number
  additionalMinutes: number
}
export type ObservedAuthorization = E2eAuthorization | LatestAuthorization

const phases: Array<Phase> = [
  "functional",
  "clients",
  "operations",
  "comparison",
  "recheck",
]
const core: Array<LatestKind> = [
  "responses-json",
  "messages-json",
  "codex-tool",
  "claude-a",
]

export function latestCases(models: Array<string>): Record<string, MatrixCase> {
  const entries = models.flatMap((model) =>
    core.map((kind) => ({ model, kind })),
  )
  if (models.includes("gpt-5.6-luna"))
    entries.push(
      ...(Object.keys(LATEST_KINDS) as Array<LatestKind>)
        .filter((kind) => !core.includes(kind))
        .map((kind) => ({ model: "gpt-5.6-luna", kind })),
    )
  return Object.fromEntries(
    entries.map(({ model, kind }) => {
      const cap = LATEST_KINDS[kind]
      return [
        `latest-${model}-${kind}`,
        {
          model,
          phase: cap.phase,
          endpoint: "/responses",
          effort: "low",
          attempts: cap.nominal + (kind.startsWith("cache-") ? 0 : 1),
          inputTokens: 65536,
          outputTokens: cap.outputTokens,
        },
      ]
    }),
  )
}

export function validateLatestModels(models: Array<string>) {
  if (
    models.length === 0
    || new Set(models).size !== models.length
    || models.some(
      (model) => !(LATEST_MODELS as ReadonlyArray<string>).includes(model),
    )
  )
    throw new Error("Latest profile requires unique authorized model IDs")
}

export function buildLatestAuthorization(input: {
  roundId: string
  budgetDirectory: string
  approvalReference: string
  executionSha256: string
  fixtureSalt: string
  models: Array<string>
  credits: number
  attempts: number
  minutes: number
  codexFixtureDirectory?: string
}) {
  validateLatestModels(input.models)
  validateApprovalReference(input.approvalReference)
  const prices = Object.fromEntries(
    input.models.map((model) => [
      model,
      structuredClone({ ...E2E_PRICES[model], verifiedAt: "2026-10-02" }),
    ]),
  )
  return {
    ...input,
    version: 5,
    approved: true,
    stage: "latest",
    effort: "low",
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 0,
    priorLedgerBytes: 0,
    priorLedgerSha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    phaseBaselines: Object.fromEntries(
      phases.map((phase) => [phase, { attempts: 0, credits: 0 }]),
    ) as E2eAuthorization["phaseBaselines"],
    additionalCredits: input.credits,
    additionalAttempts: input.attempts,
    additionalMinutes: input.minutes,
    prices,
    cases: latestCases(input.models),
    cumulative: {
      maxCredits: input.credits,
      admissionCredits: input.credits * 0.9,
      attempts: input.attempts,
      activeMs: input.minutes * 60000,
      phases: Object.fromEntries(
        phases.map((phase) => [
          phase,
          { credits: input.credits * 0.9, attempts: input.attempts },
        ]),
      ) as E2eAuthorization["cumulative"]["phases"],
    },
  }
}

function validateApprovalReference(reference: unknown): string {
  if (typeof reference !== "string" || !reference.trim())
    throw new Error(
      "An explicit account, model and budget approval reference is required",
    )
  return reference
}

function latestBinding(saved: Record<string, unknown>) {
  if (
    saved.version !== 5
    || typeof saved.roundId !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(saved.roundId)
    || typeof saved.budgetDirectory !== "string"
    || !saved.budgetDirectory
    || typeof saved.executionSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(saved.executionSha256)
    || typeof saved.fixtureSalt !== "string"
    || !/^[a-f0-9-]{36}$/u.test(saved.fixtureSalt)
  )
    throw new Error("Invalid latest round binding")
  const fixture = saved.codexFixtureDirectory
  if (
    fixture !== undefined
    && (typeof fixture !== "string"
      || resolveCodexFixtureDirectory(fixture) !== fixture)
  )
    throw new Error("Invalid latest Codex fixture binding")
  return {
    roundId: saved.roundId,
    budgetDirectory: saved.budgetDirectory,
    executionSha256: saved.executionSha256,
    fixtureSalt: saved.fixtureSalt,
    ...(typeof fixture === "string" ? { codexFixtureDirectory: fixture } : {}),
  }
}
function latestLimits(saved: Record<string, unknown>) {
  for (const [key, max] of Object.entries(LATEST_LIMITS)) {
    const value = saved[key]
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || value <= 0
      || value > max
      || (key === "attempts" && !Number.isInteger(value))
    )
      throw new Error("Latest budget exceeds approved limits")
  }
  return {
    credits: Number(saved.credits),
    attempts: Number(saved.attempts),
    minutes: Number(saved.minutes),
  }
}
export function readLatestAuthorization(
  saved: Record<string, unknown>,
): LatestAuthorization {
  const models = saved.models
  if (
    !Array.isArray(models)
    || !models.every((model): model is string => typeof model === "string")
  )
    throw new Error("Latest models missing")
  validateLatestModels(models)
  const expected = buildLatestAuthorization({
    ...latestBinding(saved),
    ...latestLimits(saved),
    models,
    approvalReference: validateApprovalReference(saved.approvalReference),
  })
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error(`Latest ${key} snapshot changed`)
  return expected as LatestAuthorization
}

export function readObservedAuthorization(
  saved: Record<string, unknown>,
): ObservedAuthorization | undefined {
  if (saved.version === 5) return readLatestAuthorization(saved)
  if (saved.version === 4) return readE2eAuthorization(saved)
}
