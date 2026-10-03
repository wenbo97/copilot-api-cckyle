import { resolveCodexFixtureDirectory } from "./local-client-config"
import {
  LATEST_LIMITS,
  LATEST_MODELS,
  validateLatestModels,
} from "./local-latest-authorization"

function parseArguments(args: Array<string>) {
  const switches = new Set([
    "--live",
    "--dry-run",
    "--list",
    "--help",
    "--verify-evidence",
  ])
  const values = new Set([
    "--profile",
    "--models",
    "--max-credits",
    "--max-attempts",
    "--max-minutes",
    "--output-dir",
    "--codex-fixture-dir",
    "--approval-reference",
  ])
  const parsed = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (parsed.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    if (switches.has(flag)) parsed.set(flag, "true")
    else {
      if (!values.has(flag))
        throw new Error(`Unexpected latest argument: ${flag}`)
      const value = args[++i]
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${flag}`)
      parsed.set(flag, value)
    }
  }
  return parsed
}
function readLimits(parsed: Map<string, string>) {
  const limits = {
    credits: Number(parsed.get("--max-credits") ?? LATEST_LIMITS.credits),
    attempts: Number(parsed.get("--max-attempts") ?? LATEST_LIMITS.attempts),
    minutes: Number(parsed.get("--max-minutes") ?? LATEST_LIMITS.minutes),
  }
  for (const [key, value] of Object.entries(limits))
    if (
      !Number.isFinite(value)
      || value <= 0
      || value > LATEST_LIMITS[key as keyof typeof LATEST_LIMITS]
      || (key === "attempts" && !Number.isInteger(value))
    )
      throw new Error("Latest limits exceed approved scope")
  return limits
}
export function latestOptions(args: Array<string>) {
  const parsed = parseArguments(args)
  if (parsed.get("--profile") !== "latest")
    throw new Error("Unknown acceptance profile")
  if (
    ["--live", "--dry-run", "--list", "--verify-evidence"].filter((key) =>
      parsed.has(key),
    ).length > 1
  )
    throw new Error("Choose one acceptance mode")
  const requested = parsed.get("--models")
  const models =
    requested === undefined ? [...LATEST_MODELS] : requested.split(",")
  validateLatestModels(models)
  const fixture = parsed.get("--codex-fixture-dir")
  const approvalReference = parsed.get("--approval-reference")?.trim()
  if (parsed.has("--live") && !approvalReference)
    throw new Error(
      "Live acceptance requires --approval-reference for the current account, models and budget",
    )
  return {
    models,
    ...readLimits(parsed),
    live: parsed.has("--live"),
    verifyEvidence: parsed.has("--verify-evidence"),
    dryRun:
      parsed.has("--dry-run") || parsed.has("--list") || parsed.has("--help"),
    directory: parsed.get("--output-dir"),
    approvalReference,
    codexFixtureDirectory:
      fixture === undefined ? undefined : resolveCodexFixtureDirectory(fixture),
  }
}
