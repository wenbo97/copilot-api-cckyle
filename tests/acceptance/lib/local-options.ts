import { E2E_LIMITS } from "./local-e2e-authorization"

/** Reject ambiguous invocations before any offline work or live authentication. */
export function validateArguments(args: Array<string>): void {
  const switches = new Set([
    "--list",
    "--dry-run",
    "--live",
    "--help",
    "--matrix",
    "--e2e",
  ])
  const values = new Set([
    "--only",
    "--max-credits",
    "--output-dir",
    "--budget-dir",
    "--authorization-file",
    "--max-additional-credits",
    "--max-additional-attempts",
    "--max-additional-minutes",
    "--stage",
    "--matrix-output-dir",
  ])
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    seen.add(flag)
    if (switches.has(flag)) continue
    if (!values.has(flag)) throw new Error(`Unexpected argument: ${flag}`)
    const value = args.at(++index)
    if (!value?.trim() || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`)
    if (flag === "--only") validateSelection(value)
    validateLimit(flag, value, {
      matrix: args.includes("--matrix"),
      e2e: args.includes("--e2e"),
      stage: args[args.indexOf("--stage") + 1],
    })
  }
  validateBudgetOptions(seen, args)
}

function validateE2eOptions(seen: Set<string>, args: Array<string>) {
  if (
    seen.has("--e2e")
    && (!seen.has("--stage") || seen.has("--matrix") || seen.has("--only"))
  )
    throw new Error("E2E requires --stage without --matrix or --only")
  if (seen.has("--stage") && !seen.has("--e2e"))
    throw new Error("--stage requires --e2e")
  if (
    seen.has("--matrix-output-dir")
    && (!seen.has("--e2e") || args[args.indexOf("--stage") + 1] !== "legacy")
  )
    throw new Error("--matrix-output-dir requires a legacy E2E stage")
  if (
    seen.has("--e2e")
    && seen.has("--live")
    && (!seen.has("--budget-dir") || !seen.has("--output-dir"))
  )
    throw new Error(
      "Live E2E requires its historical budget and one output directory",
    )
}
function validateBudgetOptions(seen: Set<string>, args: Array<string>) {
  validateE2eOptions(seen, args)
  if (
    seen.has("--matrix")
    && (!seen.has("--budget-dir")
      || !seen.has("--authorization-file")
      || seen.has("--only"))
  )
    throw new Error(
      "--matrix requires --budget-dir and --authorization-file, without --only",
    )
  const additional = [
    "--max-additional-credits",
    "--max-additional-attempts",
    "--max-additional-minutes",
  ]
  if (seen.has("--authorization-file") && !seen.has("--budget-dir"))
    throw new Error("Authorization requires --budget-dir")
  if (
    seen.has("--budget-dir")
    && (!seen.has("--output-dir")
      || (!seen.has("--only") && !seen.has("--matrix") && !seen.has("--e2e"))
      || additional.some((flag) => !seen.has(flag)))
  )
    throw new Error(
      "--budget-dir requires --output-dir, --only, and all additional limits",
    )
  if (!seen.has("--budget-dir") && additional.some((flag) => seen.has(flag)))
    throw new Error("Additional limits require --budget-dir")
  if (
    ["--list", "--dry-run", "--live"].filter((flag) => seen.has(flag)).length
    > 1
  )
    throw new Error("Select exactly one of --list, --dry-run, or --live")
}

function validateSelection(value: string) {
  const ids = value.split(",").map((id) => id.trim())
  if (ids.some((id) => id.length === 0))
    throw new Error("--only requires nonempty scenario IDs")
  if (ids.includes("soak") && ids.includes("soak-recheck"))
    throw new Error("Select one observation window")
}

function validateLimit(
  flag: string,
  value: string,
  options: { matrix: boolean; e2e: boolean; stage?: string },
) {
  if (flag === "--stage" && !["legacy", "matrix"].includes(value))
    throw new Error("E2E stage must be matrix or legacy")
  let limits = {
    additionalCredits: 30,
    additionalAttempts: 20,
    additionalMinutes: 15,
  }
  if (options.matrix)
    limits = {
      additionalCredits: 825,
      additionalAttempts: 42,
      additionalMinutes: 30,
    }
  if (options.e2e)
    limits = E2E_LIMITS[options.stage === "legacy" ? "legacy" : "matrix"]
  const maximum = {
    "--max-additional-credits": limits.additionalCredits,
    "--max-additional-attempts": limits.additionalAttempts,
    "--max-additional-minutes": limits.additionalMinutes,
  }[flag]
  if (
    maximum !== undefined
    && (!Number.isFinite(Number(value))
      || Number(value) <= 0
      || Number(value) > maximum
      || (flag === "--max-additional-attempts"
        && !Number.isInteger(Number(value))))
  )
    throw new Error(`Invalid additional limit for ${flag}`)
  if (
    flag === "--max-credits"
    && (!Number.isFinite(Number(value))
      || Number(value) <= 0
      || Number(value) > 1000)
  )
    throw new Error("Credits must be in (0, 1000]")
}
