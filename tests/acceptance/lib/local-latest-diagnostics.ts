import { record, type Json } from "./local-budget"

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function validateCacheGroup(rows: Array<Json>, group: "control" | "prefix") {
  const summaries = ["initial", "repeat", "suffix"].map((kind) => {
    const selected = rows.filter(
      (row) => row.caseId === `latest-gpt-5.6-luna-cache-${group}-${kind}`,
    )
    requireCondition(
      selected.length === 1,
      "Cache scenario diagnostic correlation missing or duplicated",
    )
    const summary = record(selected[0].summary)
    const policy = record(summary.cache_policy)
    requireCondition(
      policy.status === (group === "control" ? "disabled" : "applied"),
      "Observed cache policy differs from experiment arm",
    )
    if (group === "prefix")
      requireCondition(
        policy.breakpoint_added === true && policy.key_source === "generated",
        "Prefix policy adaptation not observed",
      )
    return summary
  })
  const prefixes = summaries.map(
    (summary) => record(summary.egress_static_prefix).fingerprint,
  )
  const inputs = summaries.map(
    (summary) => record(summary.egress_fingerprints).input,
  )
  requireCondition(
    typeof prefixes[0] === "string"
      && prefixes.every((prefix) => prefix === prefixes[0]),
    "Cache static prefix changed",
  )
  requireCondition(
    typeof inputs[0] === "string"
      && inputs[0] === inputs[1]
      && inputs[0] !== inputs[2],
    "Cache repeat/suffix fingerprint mismatch",
  )
}

export function validateLatestDiagnostics(
  rows: Array<Json>,
  models: Array<string>,
  fixtureSalt: string,
) {
  const unique = new Map<string, Json>()
  for (const row of rows) {
    const summary = record(row.summary)
    requireCondition(
      typeof summary.request_id === "string",
      "Diagnostic request ID missing",
    )
    const previous = unique.get(summary.request_id)
    if (previous) {
      requireCondition(
        JSON.stringify(previous.summary) === JSON.stringify(summary),
        "Conflicting duplicate diagnostic summary",
      )
      continue
    }
    unique.set(summary.request_id, row)
  }
  const correlated = [...unique.values()]
  const summaries = correlated.map((row) => record(row.summary))
  requireCondition(
    summaries.length > 0
      && summaries.every(
        (entry) =>
          entry.schema_version === 2
          && Array.isArray(entry.attempt_details)
          && typeof entry.request_id === "string",
      ),
    "Invalid version-2 diagnostics",
  )
  requireCondition(
    !JSON.stringify(summaries).includes(fixtureSalt)
      && !JSON.stringify(summaries).includes("LATEST_TOOL_"),
    "Diagnostic prompt content leak",
  )
  const sources = models.map((model) => ({
    model,
    native: summaries.filter(
      (entry) => entry.model === model && entry.source === "native_responses",
    ).length,
    messages: summaries.filter(
      (entry) =>
        entry.model === model && entry.source === "messages_to_responses",
    ).length,
  }))
  requireCondition(
    sources.every((source) => source.native > 0 && source.messages > 0),
    "Per-model native/bridge diagnostics missing",
  )
  if (models.includes("gpt-5.6-luna")) {
    validateCacheGroup(correlated, "control")
    validateCacheGroup(correlated, "prefix")
  }
  return {
    count: summaries.length,
    identicalReplays: rows.length - summaries.length,
    sources,
    cachePoliciesVerified: models.includes("gpt-5.6-luna"),
  }
}
