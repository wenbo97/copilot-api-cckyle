/** Reject ambiguous invocations before any offline work or live authentication. */
export function validateArguments(args: Array<string>): void {
  const switches = new Set([
    "--list",
    "--dry-run",
    "--live",
    "--help",
    "--matrix",
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
    validateLimit(flag, value, args.includes("--matrix"))
  }
  validateBudgetOptions(seen)
}

function validateBudgetOptions(seen: Set<string>) {
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
      || (!seen.has("--only") && !seen.has("--matrix"))
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

function validateLimit(flag: string, value: string, matrix: boolean) {
  const maximum = {
    "--max-additional-credits": matrix ? 825 : 30,
    "--max-additional-attempts": matrix ? 42 : 20,
    "--max-additional-minutes": matrix ? 30 : 15,
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
