import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record, type Json } from "./local-budget"
import {
  claudeCases,
  type ClaudeProxyAuthorization,
} from "./local-claude-authorization"
import { AcceptanceRuntime, assert } from "./local-runtime"

export function uniqueDiagnostics(rows: Array<Json>) {
  const unique = new Map<string, Json>()
  for (const row of rows) {
    const summary = record(row.summary)
    assert(
      typeof summary.request_id === "string",
      "Diagnostic identity missing",
    )
    const previous = unique.get(summary.request_id)
    if (previous)
      assert(
        JSON.stringify(previous.summary) === JSON.stringify(summary),
        "Conflicting diagnostic replay",
      )
    else unique.set(summary.request_id, row)
  }
  return [...unique.values()]
}

export function cacheMetrics(summaries: Array<Json>) {
  const paired = summaries.filter(
    (row) =>
      Number.isSafeInteger(row.input_tokens)
      && Number(row.input_tokens) >= 0
      && Number.isSafeInteger(row.cached_input_tokens)
      && Number(row.cached_input_tokens) >= 0
      && Number(row.cached_input_tokens) <= Number(row.input_tokens),
  )
  const input = paired.reduce((sum, row) => sum + Number(row.input_tokens), 0)
  const read = paired.reduce(
    (sum, row) => sum + Number(row.cached_input_tokens),
    0,
  )
  return {
    records: summaries.length,
    pairedRecords: paired.length,
    coverage: summaries.length > 0 ? paired.length / summaries.length : null,
    inputTokens: paired.length > 0 ? input : null,
    cachedTokens: paired.length > 0 ? read : null,
    tokenHitRatio: input ? read / input : null,
    requestHitRatio:
      paired.length > 0 ?
        paired.filter((row) => Number(row.cached_input_tokens) > 0).length
        / paired.length
      : null,
  }
}

function latency(values: Array<unknown>) {
  const known = values
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
    .sort((a, b) => a - b)
  return {
    samples: known.length,
    p50: known.length > 0 ? known[Math.ceil(known.length * 0.5) - 1] : null,
    p95: known.length > 0 ? known[Math.ceil(known.length * 0.95) - 1] : null,
  }
}

export function diagnosticRows(directory: string) {
  const file = path.join(directory, "diagnostic-cases.jsonl")
  return existsSync(file) ?
      uniqueDiagnostics(
        readFileSync(file, "utf8")
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => record(JSON.parse(line))),
      )
    : []
}

export function validateMessagesTerminal(events: Array<Json>) {
  assert(
    events.filter((event) => event.type === "message_stop").length === 1,
    "Missing or duplicate message_stop",
  )
  assert(
    !events.some((event) => event.type === "error"),
    "Downstream error event observed",
  )
  const terminalDeltas = events.filter(
    (event) =>
      event.type === "message_delta"
      && typeof (event.stopReason ?? record(event.delta).stop_reason)
        === "string",
  )
  const terminal = terminalDeltas[0]
  assert(
    terminalDeltas.length === 1
      && ["end_turn", "tool_use"].includes(
        String(terminal.stopReason ?? record(terminal.delta).stop_reason),
      )
      && events.indexOf(terminal)
        < events.findIndex((event) => event.type === "message_stop")
      && events.at(-1)?.type === "message_stop",
    "Downstream completion was truncated or invalid",
  )
}

export async function verifyCaseWire(runtime: AcceptanceRuntime, id: string) {
  const grants = runtime.ledger.grants.filter((grant) => grant.caseId === id)
  assert(grants.length > 0, "No matching upstream attempts")
  // Final diagnostics are emitted as the response iterator unwinds.
  const deadline = Date.now() + 5000
  let rows: Array<Json> = []
  const files = readdirSync(runtime.directory).filter(
    (file) => file.startsWith(`${id}-`) && file.endsWith("-ingress.json"),
  )
  while (Date.now() < deadline) {
    rows = diagnosticRows(runtime.directory).filter((row) => row.caseId === id)
    if (
      rows.length === files.length
      && grants.every((grant) => runtime.ledger.observations.has(grant.id))
    )
      break
    await Bun.sleep(50)
  }
  const summaries = rows.map((row) => record(row.summary))
  assert(
    grants.every((grant) => runtime.ledger.observations.has(grant.id)),
    "Missing attempt observations",
  )
  if (
    summaries.some(
      (row) => row.upstream_http_status === 401 && row.outcome !== "completed",
    )
  ) {
    runtime.halted = true
    runtime.ledger.halt("Authentication failed after refresh")
  }
  assert(
    files.length > 0 && summaries.length === files.length,
    "Missing request diagnostics",
  )
  assert(
    summaries.every(
      (row) =>
        row.outcome === "completed" && row.source === "messages_to_responses",
    ),
    "A logical request failed or was truncated",
  )
  for (const file of files) {
    const requestId = file.slice(id.length + 1, -"-ingress.json".length)
    const evidence = record(
      JSON.parse(
        readFileSync(
          path.join(runtime.directory, `${requestId}-messages.json`),
          "utf8",
        ),
      ),
    )
    assert(Array.isArray(evidence.events), "Downstream evidence missing")
    validateMessagesTerminal(evidence.events.map((item) => record(item)))
  }
}

function tokenTotals(rows: Array<Json>) {
  return Object.fromEntries(
    [
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cached_input_tokens",
      "cache_write_tokens",
      "copilot_nano_aiu",
    ].map((key) => {
      const counts = rows
        .map((row) => row[key])
        .filter(
          (value): value is number =>
            typeof value === "number"
            && Number.isSafeInteger(value)
            && value >= 0,
        )
      return [
        key,
        {
          known: counts.length,
          total: counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null,
        },
      ]
    }),
  )
}

function summarizeModel(
  runtime: AcceptanceRuntime,
  model: string,
  rows: Array<Json>,
) {
  const selected = rows.filter((row) => record(row.summary).model === model)
  const summaries = selected.map((row) => record(row.summary))
  const cacheRows = selected
    .filter((row) => row.caseId === `claude-proxy-${model}-cache`)
    .map((row) => record(row.summary))
  const prefix = cacheRows.map(
    (row) => record(row.egress_static_prefix).fingerprint,
  )
  const input = cacheRows.map((row) => record(row.egress_fingerprints).input)
  const repeatValidated =
    cacheRows.length === 4
    && typeof input[0] === "string"
    && input[0] === input[1]
    && input[1] === input[2]
    && input[2] !== input[3]
    && typeof prefix[0] === "string"
    && prefix.every((value) => value === prefix[0])
  const grants = runtime.ledger.grants.filter((grant) => grant.model === model)
  const observations = grants.map((grant) =>
    runtime.ledger.observations.get(grant.id),
  )
  return {
    model,
    requests: selected.length,
    attempts: grants.length,
    actualEfforts: [...new Set(grants.map((grant) => grant.effort))],
    cache: cacheMetrics(summaries),
    finalUsage: tokenTotals(summaries),
    attemptUsage: tokenTotals(
      summaries.flatMap((row) =>
        Array.isArray(row.attempt_details) ?
          row.attempt_details.map((item) => record(item))
        : [],
      ),
    ),
    byCase: Object.fromEntries(
      [...new Set(selected.map((row) => String(row.caseId)))].map((id) => [
        id,
        cacheMetrics(
          selected
            .filter((row) => row.caseId === id)
            .map((row) => record(row.summary)),
        ),
      ]),
    ),
    cliCache: cacheMetrics(
      selected
        .filter((row) => row.caseId !== `claude-proxy-${model}-cache`)
        .map((row) => record(row.summary)),
    ),
    controlledCache: {
      prefixAndSuffixVerified: repeatValidated,
      calls: cacheRows.map((row, index) => ({
        kind: [
          "cli-seed",
          "exact-repeat-1",
          "exact-repeat-2",
          "changed-suffix",
        ][index],
        ...cacheMetrics([row]),
        durationMs: row.duration_ms,
      })),
      reuseObserved:
        cacheMetrics(cacheRows.slice(1, 3)).pairedRecords === 0 ?
          null
        : repeatValidated
          && cacheRows
            .slice(1, 3)
            .some(
              (row) =>
                typeof row.cached_input_tokens === "number"
                && row.cached_input_tokens > 0,
            ),
    },
    latencyMs: {
      firstEvent: latency(observations.map((row) => row?.firstEventMs)),
      firstText: latency(observations.map((row) => row?.firstTextMs)),
      total: latency(summaries.map((row) => row.duration_ms)),
    },
    outcomes: Object.fromEntries(
      [...new Set(summaries.map((row) => String(row.outcome)))].map(
        (outcome) => [
          outcome,
          summaries.filter((row) => row.outcome === outcome).length,
        ],
      ),
    ),
  }
}

export function writeClaudeReport(
  runtime: AcceptanceRuntime,
  auth: ClaudeProxyAuthorization,
  fatal?: string,
) {
  const rows = diagnosticRows(runtime.directory)
  const byModel = auth.models.map((model) =>
    summarizeModel(runtime, model, rows),
  )
  const cases = Object.entries(claudeCases(auth.models)).map(
    ([id]) =>
      runtime.results.find((result) => result.id === id) ?? {
        id,
        status: "blocked",
        detail: fatal ?? "Not executed",
      },
  )
  const summary = {
    profile: "claude-proxy",
    executionSha256: auth.executionSha256,
    complete:
      !fatal
      && cases.every((result) => result.status === "pass")
      && rows
        .filter((row) => !String(row.caseId).endsWith("-cancel"))
        .every((row) => record(row.summary).outcome === "completed")
      && byModel.every((row) => row.controlledCache.prefixAndSuffixVerified),
    fatal: fatal ?? null,
    cases,
    byModel,
    budget: runtime.ledger.summary(),
    elapsedMs: runtime.clock.elapsedMs(),
    limitations: [
      "Bounded acceptance, not a production availability estimate.",
      "Paired cache counters only; unknown is not zero. Cache reads do not establish incremental policy savings.",
      "CLI cases and captured Messages replays are separate observations. Native thread attribution may be unavailable.",
      "Reserved credits are conservative bounds, not verified account debits.",
    ],
  }
  writeFileSync(
    path.join(runtime.directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  )
  writeFileSync(
    path.join(runtime.directory, "REPORT.md"),
    [
      `# Claude proxy acceptance — ${summary.complete ? "PASS" : "INCOMPLETE"}`,
      "",
      `Models: ${auth.models.join(", ")}; effort: high; source: ${auth.executionSha256}.`,
      `Budget: ${summary.budget.attempts} attempts; ${summary.budget.reservedCredits.toFixed(3)} reserved credits; ${(summary.elapsedMs / 60000).toFixed(2)} active minutes.`,
      "",
      "| Model | CLI cache ratio | Paired coverage | Controlled repeat reads |",
      "| --- | ---: | ---: | --- |",
      ...byModel.map(
        (row) =>
          `| ${row.model} | ${row.cliCache.tokenHitRatio === null ? "unknown" : (row.cliCache.tokenHitRatio * 100).toFixed(2) + "%"} | ${row.cliCache.pairedRecords}/${row.cliCache.records} | ${row.controlledCache.reuseObserved} |`,
      ),
      "",
      "| Case | Status | Evidence |",
      "| --- | --- | --- |",
      ...cases.map(
        (result) =>
          `| ${result.id} | ${result.status} | ${result.detail.replaceAll("|", "/").replaceAll(/\r?\n/gu, " ")} |`,
      ),
      "",
      ...summary.limitations,
      fatal ? `\nStop: ${fatal}` : "",
    ].join("\n"),
  )
  return summary
}
