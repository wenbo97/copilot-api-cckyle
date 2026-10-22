import type { LatestAuthorization } from "./local-latest-authorization"
import type { MatrixCase } from "./local-matrix-authorization"

import { E2E_PRICES } from "./local-e2e-authorization"

export const CLAUDE_MODELS = ["gpt-6.1-sol", "gpt-6-luna"]
export const CLAUDE_LIMITS = { credits: 500, attempts: 60, minutes: 45 }
export const CLAUDE_KINDS = {
  smoke: { phase: "clients", attempts: 2 },
  coding: { phase: "clients", attempts: 10 },
  resume: { phase: "clients", attempts: 5 },
  mcp: { phase: "clients", attempts: 4 },
  cancel: { phase: "operations", attempts: 2 },
  recovery: { phase: "clients", attempts: 2 },
  cache: { phase: "comparison", attempts: 6 },
} as const
export type ClaudeKind = keyof typeof CLAUDE_KINDS
export interface ClaudeProxyAuthorization
  extends Omit<LatestAuthorization, "stage"> {
  stage: "claude-proxy"
}

function parseClaudeArguments(args: Array<string>) {
  const switches = new Set(["--live", "--dry-run", "--list", "--help"])
  const names = new Set([
    "--profile",
    "--models",
    "--effort",
    "--max-credits",
    "--max-attempts",
    "--max-minutes",
    "--output-dir",
    "--approval-reference",
  ])
  const parsed = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (parsed.has(key)) throw new Error(`Duplicate option: ${key}`)
    if (switches.has(key)) parsed.set(key, "true")
    else {
      if (!names.has(key))
        throw new Error(`Unexpected claude-proxy option: ${key}`)
      const value = args.at(++i)
      if (!value?.trim() || value.startsWith("--"))
        throw new Error(`Missing value: ${key}`)
      parsed.set(key, value)
    }
  }
  return parsed
}

export function claudeOptions(args: Array<string>) {
  const parsed = parseClaudeArguments(args)
  if (parsed.get("--profile") !== "claude-proxy")
    throw new Error("Invalid Claude profile")
  if (
    parsed.has("--live")
    && ["--dry-run", "--list", "--help"].some((key) => parsed.has(key))
  )
    throw new Error("Choose one acceptance mode")
  const models = (parsed.get("--models") ?? CLAUDE_MODELS.join(",")).split(",")
  if (
    models.length === 0
    || new Set(models).size !== models.length
    || models.some((model) => !CLAUDE_MODELS.includes(model))
  )
    throw new Error("Invalid Claude models")
  const effort = parsed.get("--effort") ?? "high"
  if (effort !== "high") throw new Error("Claude profile requires high effort")
  const limits = claudeLimits(parsed)
  const approvalReference = parsed.get("--approval-reference")?.trim()
  if (parsed.has("--live") && !approvalReference)
    throw new Error("Live Claude acceptance requires approval reference")
  return {
    ...limits,
    models,
    effort,
    approvalReference,
    live: parsed.has("--live"),
    dryRun: ["--dry-run", "--list", "--help"].some((key) => parsed.has(key)),
    directory: parsed.get("--output-dir"),
  }
}

function claudeLimits(parsed: Map<string, string>) {
  const limits = {
    credits: Number(parsed.get("--max-credits") ?? CLAUDE_LIMITS.credits),
    attempts: Number(parsed.get("--max-attempts") ?? CLAUDE_LIMITS.attempts),
    minutes: Number(parsed.get("--max-minutes") ?? CLAUDE_LIMITS.minutes),
  }
  for (const [name, value] of Object.entries(limits))
    if (
      !Number.isFinite(value)
      || value <= 0
      || value > CLAUDE_LIMITS[name as keyof typeof CLAUDE_LIMITS]
      || (name === "attempts" && !Number.isInteger(value))
    )
      throw new Error("Claude budget exceeds scope")
  return limits
}

export function claudeCases(models: Array<string>): Record<string, MatrixCase> {
  return Object.fromEntries(
    Object.entries(CLAUDE_KINDS).flatMap(([kind, cap]) =>
      models.map((model) => [
        `claude-proxy-${model}-${kind}`,
        {
          ...cap,
          model,
          endpoint: "/responses",
          effort: "high",
          inputTokens: 65536,
          outputTokens: 16384,
        },
      ]),
    ),
  )
}

export function buildClaudeAuthorization(input: {
  roundId: string
  budgetDirectory: string
  approvalReference: string
  executionSha256: string
  fixtureSalt: string
  models: Array<string>
  credits: number
  attempts: number
  minutes: number
}): ClaudeProxyAuthorization {
  claudeOptions([
    "--profile",
    "claude-proxy",
    "--models",
    input.models.join(","),
    "--max-credits",
    String(input.credits),
    "--max-attempts",
    String(input.attempts),
    "--max-minutes",
    String(input.minutes),
    "--live",
    "--approval-reference",
    input.approvalReference,
  ])
  if (
    !/^[a-z0-9-]{1,80}$/u.test(input.roundId)
    || !/^[a-f0-9]{64}$/u.test(input.executionSha256)
    || !/^[a-f0-9-]{36}$/u.test(input.fixtureSalt)
    || !input.budgetDirectory
  )
    throw new Error("Invalid Claude execution binding")
  const phases = [
    "functional",
    "clients",
    "operations",
    "comparison",
    "recheck",
  ]
  return {
    ...input,
    version: 6,
    approved: true,
    stage: "claude-proxy",
    effort: "high",
    baseAttempts: 0,
    baseCredits: 0,
    baseElapsedMs: 0,
    priorLedgerBytes: 0,
    priorLedgerSha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    phaseBaselines: Object.fromEntries(
      phases.map((phase) => [phase, { attempts: 0, credits: 0 }]),
    ) as ClaudeProxyAuthorization["phaseBaselines"],
    additionalCredits: input.credits,
    additionalAttempts: input.attempts,
    additionalMinutes: input.minutes,
    prices: Object.fromEntries(
      input.models.map((model) => [
        model,
        { ...structuredClone(E2E_PRICES[model]), verifiedAt: "2026-10-22" },
      ]),
    ),
    cases: claudeCases(input.models),
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
      ) as ClaudeProxyAuthorization["cumulative"]["phases"],
    },
  } as ClaudeProxyAuthorization
}

export function readClaudeAuthorization(
  saved: Record<string, unknown>,
): ClaudeProxyAuthorization {
  const expected = buildClaudeAuthorization({
    roundId: String(saved.roundId),
    budgetDirectory: String(saved.budgetDirectory),
    approvalReference:
      typeof saved.approvalReference === "string" ?
        saved.approvalReference
      : "",
    executionSha256: String(saved.executionSha256),
    fixtureSalt: String(saved.fixtureSalt),
    models: Array.isArray(saved.models) ? saved.models.map(String) : [],
    credits: Number(saved.credits),
    attempts: Number(saved.attempts),
    minutes: Number(saved.minutes),
  })
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error(`Claude ${key} snapshot changed`)
  return expected
}
