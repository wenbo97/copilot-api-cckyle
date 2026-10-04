import { open } from "node:fs/promises"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"

const metricNames = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "copilot_nano_aiu",
] as const
type MetricName = (typeof metricNames)[number]
type Count = number | null
interface Sample {
  model: string
  source: "native_responses" | "messages_to_responses" | "unknown_ingress"
  outcome: string
  attempts: Count
  metrics: Record<MetricName, Count>
  attemptDetailsAvailable: boolean
  attemptDetails: Array<Record<MetricName, Count>>
  role: string
  thread: string | null
  processScope: string | null
  correlationScope: string | null
  requestId: string | null
  history: Record<string, unknown>
  lifecycle: Record<string, unknown>
  ttft: Count
  duration: Count
}
interface Range {
  since?: number
  until?: number
}

const scope = "responses_egress"
const limitations = [
  "Only Responses egress diagnostic records in the selected range are included; coverage does not represent all service requests. Legacy ingress remains unknown.",
  "Final-response and attempt observations are separate views; never add their costs together. Missing retry usage remains unknown, not a verified account deduction.",
  "Reasoning and cached tokens are details; do not add them again to their output or input totals.",
]

function count(value: unknown): Count {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : null
}

function parseSample(text: string): { id: string; sample: Sample } | undefined {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const body = value as Record<string, unknown>
  if (
    body.route !== "/responses"
    || typeof body.request_id !== "string"
    || !body.request_id
    || typeof body.model !== "string"
    || !body.model
  )
    return
  const metrics = readMetrics(body)
  const attempts = count(body.upstream_attempts)
  const attemptDetailsAvailable =
    body.schema_version === 2 && Array.isArray(body.attempt_details)
  const source = body.schema_version === 2 ? body.source : undefined
  const outcomes = [
    "completed",
    "incomplete",
    "failed",
    "error",
    "cancelled",
    "stream_ended_without_terminal",
  ]
  return {
    id: body.request_id,
    sample: {
      model: body.model,
      source:
        source === "native_responses" || source === "messages_to_responses" ?
          source
        : "unknown_ingress",
      outcome:
        typeof body.outcome === "string" && outcomes.includes(body.outcome) ?
          body.outcome
        : "unknown",
      attempts,
      metrics,
      attemptDetailsAvailable,
      attemptDetails:
        attemptDetailsAvailable ?
          parseAttemptDetails(body.attempt_details, attempts)
        : [],
      role: requestRole(body.request_role),
      thread: digest(body.thread_fingerprint),
      processScope: uuid(body.process_scope),
      correlationScope: digest(body.correlation_scope),
      requestId: uuid(body.request_id),
      history: historyObservation(body.history_comparison),
      lifecycle: lifecycleObservation(body.identity),
      ttft: count(body.ttft_ms),
      duration: count(body.duration_ms),
    },
  }
}

function readMetrics(body: Record<string, unknown>): Record<MetricName, Count> {
  const metrics = Object.fromEntries(
    metricNames.map((name) => [name, count(body[name])]),
  ) as Record<MetricName, Count>
  if (
    metrics.input_tokens !== null
    && metrics.cached_input_tokens !== null
    && metrics.cached_input_tokens > metrics.input_tokens
  )
    metrics.cached_input_tokens = null
  return metrics
}

function parseAttemptDetails(
  value: unknown,
  attempts: Count,
): Array<Record<MetricName, Count>> {
  if (!Array.isArray(value)) return []
  const unique = new Map<number, Record<MetricName, Count>>()
  for (const candidate of value.slice(0, 16)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue
    const body = candidate as Record<string, unknown>
    const index = count(body.attempt_index)
    if (index === null || index === 0) continue
    if (attempts !== null && index > attempts) continue
    unique.set(index, readMetrics(body))
  }
  return [...unique.values()]
}

function measure(values: Array<Count>) {
  const known = values.filter((value): value is number => value !== null)
  const sum = known.reduce((total, value) => total + BigInt(value), 0n)
  const observedSum =
    sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : String(sum)
  return {
    // Very large nano-AIU totals retain precision as decimal strings in JSON.
    observed_sum: known.length === 0 ? null : observedSum,
    known_records: known.length,
    coverage: values.length > 0 ? known.length / values.length : null,
  }
}

function summarize(samples: Array<Sample>) {
  const cacheSamples = samples.filter(
    ({ metrics }) =>
      metrics.input_tokens !== null && metrics.cached_input_tokens !== null,
  )
  const input = cacheSamples.reduce(
    (sum, { metrics }) => sum + BigInt(metrics.input_tokens ?? 0),
    0n,
  )
  const cached = cacheSamples.reduce(
    (sum, { metrics }) => sum + BigInt(metrics.cached_input_tokens ?? 0),
    0n,
  )
  const outcomes = new Map<string, number>()
  for (const sample of samples)
    outcomes.set(sample.outcome, (outcomes.get(sample.outcome) ?? 0) + 1)
  return {
    records: samples.length,
    outcomes: Object.fromEntries(outcomes),
    upstream_attempts: measure(samples.map((sample) => sample.attempts)),
    retried_records: samples.filter(
      (sample) => sample.attempts !== null && sample.attempts > 1,
    ).length,
    metrics: Object.fromEntries(
      metricNames.map((name) => [
        name,
        measure(samples.map((sample) => sample.metrics[name])),
      ]),
    ),
    cache: {
      hit_ratio: input > 0n ? Number(cached) / Number(input) : null,
      known_records: cacheSamples.length,
      coverage:
        samples.length > 0 ? cacheSamples.length / samples.length : null,
    },
    attempt_usage: summarizeAttempts(samples),
  }
}

function summarizeAttempts(samples: Array<Sample>) {
  const totals = measure(samples.map((sample) => sample.attempts))
  const details = samples.flatMap((sample) => sample.attemptDetails)
  const denominator =
    totals.observed_sum === null ? null : Number(totals.observed_sum)
  const coverage = (known: number) =>
    (
      totals.known_records === samples.length
      && denominator !== null
      && denominator > 0
    ) ?
      known / denominator
    : null
  const cache = details.filter(
    (metrics) =>
      metrics.input_tokens !== null && metrics.cached_input_tokens !== null,
  )
  const input = cache.reduce(
    (sum, metrics) => sum + BigInt(metrics.input_tokens ?? 0),
    0n,
  )
  const cached = cache.reduce(
    (sum, metrics) => sum + BigInt(metrics.cached_input_tokens ?? 0),
    0n,
  )
  return {
    records_with_details: samples.filter(
      (sample) => sample.attemptDetailsAvailable,
    ).length,
    detailed_attempts: details.length,
    total_reported_attempts: totals.observed_sum,
    attempt_count_coverage: totals.coverage,
    metrics: Object.fromEntries(
      metricNames.map((name) => {
        const observed = measure(details.map((metrics) => metrics[name]))
        return [
          name,
          {
            observed_sum: observed.observed_sum,
            known_attempts: observed.known_records,
            coverage: coverage(observed.known_records),
          },
        ]
      }),
    ),
    cache: {
      hit_ratio: input > 0n ? Number(cached) / Number(input) : null,
      known_attempts: cache.length,
      coverage: coverage(cache.length),
    },
  }
}

async function readSamples(file: string, range: Range) {
  const samples = new Map<string, Sample>()
  const payloads = new Map<string, string>()
  const parsing = {
    malformed_records: 0,
    duplicate_records: 0,
    filtered_records: 0,
    missing_timestamp_records: 0,
  }
  const handle = await open(file, "r")
  try {
    const header = Buffer.alloc(2)
    await handle.read(header, 0, 2, 0)
    const utf16 = header[0] === 0xff && header[1] === 0xfe
    const stream = handle.createReadStream({
      encoding: utf16 ? "utf16le" : "utf8",
      start: utf16 ? 2 : 0,
      autoClose: false,
    })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, "")
        const match =
          /^(?:(\S+)\s+)?(?:\[info\]\s+)?\[cache-diagnostics\](.*)$/.exec(line)
        if (!match) continue
        let parsed: ReturnType<typeof parseSample>
        try {
          parsed = parseSample(match[2])
        } catch {
          /* Malformed records never echo raw log content. */
        }
        if (!parsed) {
          parsing.malformed_records++
          continue
        }
        const observed: unknown = JSON.parse(match[2])
        const observedAt = record(observed).observed_at
        const timestamp = observedTimestamp(match[1], observedAt)
        if (!Number.isFinite(timestamp)) parsing.missing_timestamp_records++
        if (isReplay(payloads, parsed.id, match[2].trim())) {
          parsing.duplicate_records++
          continue
        }
        payloads.set(parsed.id, match[2].trim())
        if (outsideRange(timestamp, range)) {
          parsing.filtered_records++
          continue
        }
        samples.set(parsed.id, parsed.sample)
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  } finally {
    await handle.close()
  }
  return { samples: [...samples.values()], parsing }
}

function requestRole(value: unknown): string {
  return (
      typeof value === "string"
        && ["compaction", "main", "memory", "prewarm", "subagent"].includes(
          value,
        )
    ) ?
      value
    : "unknown"
}

function observedTimestamp(reporter: string | undefined, embedded: unknown) {
  if (reporter) return Date.parse(reporter)
  return typeof embedded === "string" ? Date.parse(embedded) : Number.NaN
}

function isReplay(payloads: Map<string, string>, id: string, payload: string) {
  const previous = payloads.get(id)
  if (previous === undefined) return false
  if (previous !== payload)
    throw new Error(
      "Conflicting cache diagnostic records; original evidence was not overwritten",
    )
  return true
}

function outsideRange(timestamp: number, range: Range): boolean {
  if (range.since === undefined && range.until === undefined) return false
  return (
    !Number.isFinite(timestamp)
    || (range.since !== undefined && timestamp < range.since)
    || (range.until !== undefined && timestamp >= range.until)
  )
}

function timestampArgument(value: string | undefined): number | undefined {
  if (value === undefined) return
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
    || !Number.isFinite(Date.parse(value))
  )
    throw new Error(
      "Time arguments must be ISO8601 timestamps with a time zone",
    )
  const timestamp = Date.parse(value)
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value)
  const minutes =
    offset ?
      (Number(offset[2]) * 60 + Number(offset[3]))
      * (offset[1] === "+" ? 1 : -1)
    : 0
  if (
    new Date(timestamp + minutes * 60_000).toISOString().slice(0, 19)
    !== value.slice(0, 19)
  )
    throw new Error("The time argument contains an invalid date")
  return timestamp
}

function percent(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toFixed(2)}%`
}

function formatGroup(
  name: string,
  group: ReturnType<typeof summarize>,
): string {
  const lines = [
    `${name}: ${group.records} diagnostic records`,
    `Outcomes: ${JSON.stringify(group.outcomes)}`,
    `Upstream attempts: ${group.upstream_attempts.observed_sum ?? "unknown"}; coverage ${percent(group.upstream_attempts.coverage)}; records with retries: ${group.retried_records}`,
  ]
  for (const [metric, value] of Object.entries(group.metrics))
    lines.push(
      `${metric}: ${value.observed_sum ?? "unknown"}; known ${value.known_records}/${group.records}; coverage ${percent(value.coverage)}`,
    )
  lines.push(
    `Weighted cache hit rate: ${percent(group.cache.hit_ratio)}; cache usage coverage ${percent(group.cache.coverage)}`,
  )
  const attempts = group.attempt_usage
  lines.push(
    `Attempt observations: ${attempts.detailed_attempts}/${attempts.total_reported_attempts ?? "unknown"} details; attempt-count coverage ${percent(attempts.attempt_count_coverage)}`,
  )
  for (const [metric, value] of Object.entries(attempts.metrics))
    lines.push(
      `Attempt ${metric}: ${value.observed_sum ?? "unknown"}; known ${value.known_attempts}; coverage ${percent(value.coverage)}`,
    )
  return lines.join("\n")
}

function groupSamples(
  samples: Array<Sample>,
  key: "model" | "source" | "role",
) {
  const groups = new Map<string, Array<Sample>>()
  for (const sample of samples) {
    const group = groups.get(sample[key]) ?? []
    group.push(sample)
    groups.set(sample[key], group)
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => [name, summarize(group)]),
  )
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean" },
      history: { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log(
      "Usage: bun run usage:summary [logPath] [--since ISO8601] [--until ISO8601] [--json] [--history]\nDefault: tmps/cache-session.log; interval: [since, until)",
    )
    return
  }
  if (positionals.length > 1) throw new Error("Only one log path is accepted")
  const range = {
    since: timestampArgument(values.since),
    until: timestampArgument(values.until),
  }
  if (
    range.since !== undefined
    && range.until !== undefined
    && range.since >= range.until
  )
    throw new Error("--since must be earlier than --until")
  const { samples, parsing } = await readSamples(
    positionals[0] ?? "tmps/cache-session.log",
    range,
  )
  const overall = summarize(samples)
  const byModel = groupSamples(samples, "model")
  const bySource = groupSamples(samples, "source")
  const report = {
    schema_version: 2,
    scope,
    period: { since: values.since ?? null, until: values.until ?? null },
    overall,
    by_model: byModel,
    by_source: bySource,
    parsing,
    limitations,
    ...(values.history ? { history: historyReport(samples) } : {}),
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(
    [
      "Responses egress - Observed usage",
      ...limitations,
      `Time range: ${values.since ?? "unbounded"} to ${values.until ?? "unbounded"} (end exclusive)`,
      ...(samples.length > 0 ? [] : ["No data"]),
      formatGroup("Overall", overall),
      ...Object.entries(byModel).map(([name, group]) =>
        formatGroup(name, group),
      ),
      ...Object.entries(bySource).map(([name, group]) =>
        formatGroup(name, group),
      ),
      `Parsing statistics: ${JSON.stringify(parsing)}`,
      ...(values.history ?
        [
          "History analysis (structural evidence; unread input is not necessarily a preventable miss)",
          JSON.stringify(historyReport(samples), null, 2),
        ]
      : []),
    ].join("\n\n"),
  )
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ?
      value
    : null
}

function uuid(value: unknown): string | null {
  return (
      typeof value === "string"
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)
    ) ?
      value.toLowerCase()
    : null
}

function historyObservation(value: unknown) {
  const body = record(value)
  return {
    ingress: historyComparison(body.ingress),
    egress: historyComparison(body.egress),
    overlapping: body.overlapping === true,
    state_evicted: body.state_evicted === true,
  }
}

function lifecycleObservation(value: unknown) {
  const body = record(value)
  return {
    parent_thread: digest(body.parent_thread),
    forked_from_thread: digest(body.forked_from_thread),
    compaction: body.compaction === true,
    conflict: body.conflict === true,
    metadata_incomplete: body.metadata_incomplete === true,
  }
}

function historyComparison(value: unknown) {
  const body = record(value)
  const statuses = ["no_baseline", "compared", "truncated", "unavailable"]
  const relations = [
    "unchanged",
    "appended",
    "shortened",
    "modified",
    "representation_changed",
  ]
  const settings = [
    "model",
    "instructions",
    "tools",
    "reasoning",
    "text",
    "parallel_tool_calls",
    "tool_choice",
    "service_tier",
    "prompt_cache_options",
    "prompt_cache_retention",
    "prompt_cache_key",
  ]
  return {
    status:
      statuses.includes(String(body.status)) ? body.status : "unavailable",
    relation:
      relations.includes(String(body.relation)) ? body.relation : "unknown",
    matched_items: count(body.matched_items),
    first_changed_item: count(body.first_changed_item),
    first_changed_block: count(body.first_changed_block),
    changed_settings:
      Array.isArray(body.changed_settings) ?
        body.changed_settings
          .filter(
            (field): field is string =>
              typeof field === "string" && settings.includes(field),
          )
          .slice(0, settings.length)
      : [],
  }
}

function ordinaryInput(sample: Sample): Count {
  return ordinaryMetrics(sample.metrics)
}

function ordinaryMetrics(metrics: Record<MetricName, Count>): Count {
  const {
    input_tokens: input,
    cached_input_tokens: read,
    cache_write_tokens: write,
  } = metrics
  return (
      input !== null
        && read !== null
        && write !== null
        && read <= input
        && write <= input - read
    ) ?
      input - read - write
    : null
}

function unreadInput(sample: Sample): Count {
  const { input_tokens: input, cached_input_tokens: read } = sample.metrics
  return input !== null && read !== null ? input - read : null
}

function latency(values: Array<Count>) {
  const known = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  return {
    known_records: known.length,
    coverage: values.length > 0 ? known.length / values.length : null,
    median_ms:
      known.length > 0 ?
        (known[Math.floor((known.length - 1) / 2)]
          + known[Math.floor(known.length / 2)])
        / 2
      : null,
  }
}

function historyReport(samples: Array<Sample>) {
  const threads = new Map<string, Array<Sample>>()
  for (const sample of samples) {
    if (!sample.thread || !sample.processScope || !sample.correlationScope)
      continue
    const key = `${sample.processScope}:${sample.correlationScope}:${sample.thread}`
    const group = threads.get(key) ?? []
    group.push(sample)
    threads.set(key, group)
  }
  const ranked = samples
    .map((sample, index) => ({ sample, index, unread: unreadInput(sample) }))
    .filter(
      (entry): entry is typeof entry & { unread: number } =>
        entry.unread !== null,
    )
    .sort((a, b) => b.unread - a.unread || a.index - b.index)
    .slice(0, 20)
  return {
    by_model: groupHistory(samples, "model"),
    by_source: groupHistory(samples, "source"),
    by_role: groupHistory(samples, "role"),
    by_process_thread: Object.fromEntries(
      [...threads]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, group]) => [key, summarizeHistory(group)]),
    ),
    correlated_records: [...threads.values()].reduce(
      (total, group) => total + group.length,
      0,
    ),
    unread_input_tokens: measure(samples.map((sample) => unreadInput(sample))),
    ordinary_input_tokens: measure(
      samples.map((sample) => ordinaryInput(sample)),
    ),
    latency: {
      ttft: latency(samples.map((sample) => sample.ttft)),
      duration: latency(samples.map((sample) => sample.duration)),
    },
    largest_unread_inputs: ranked.map(({ sample, index, unread }) => ({
      request_id: sample.requestId ?? `record-${index + 1}`,
      model: sample.model,
      source: sample.source,
      role: sample.role,
      process_scope: sample.processScope,
      thread_fingerprint: sample.thread,
      input_tokens: sample.metrics.input_tokens,
      cached_input_tokens: sample.metrics.cached_input_tokens,
      cache_write_tokens: sample.metrics.cache_write_tokens,
      ordinary_input_tokens: ordinaryInput(sample),
      output_tokens: sample.metrics.output_tokens,
      unread_input_tokens: unread,
      history_comparison: sample.history,
      lifecycle: sample.lifecycle,
    })),
    limitations: [
      "Thread correlation requires explicit identity, correlation scope and process scope; keys and content similarity never supply identity.",
      "Unread input includes new context. Structural comparisons and provider cache reads are different observations.",
      "Legacy records cannot recover missing thread identities, task roles or earlier history.",
    ],
  }
}

function summarizeHistory(samples: Array<Sample>) {
  const attemptOrdinary = measure(
    samples
      .flatMap((sample) => sample.attemptDetails)
      .map((metrics) => ordinaryMetrics(metrics)),
  )
  const totalAttempts = measure(samples.map((sample) => sample.attempts))
  const denominator =
    totalAttempts.observed_sum === null ?
      null
    : Number(totalAttempts.observed_sum)
  return {
    ...summarize(samples),
    ordinary_input_tokens: measure(
      samples.map((sample) => ordinaryInput(sample)),
    ),
    unread_input_tokens: measure(samples.map((sample) => unreadInput(sample))),
    attempt_ordinary_input_tokens: {
      observed_sum: attemptOrdinary.observed_sum,
      known_attempts: attemptOrdinary.known_records,
      coverage:
        (
          totalAttempts.known_records === samples.length
          && denominator !== null
          && denominator > 0
        ) ?
          attemptOrdinary.known_records / denominator
        : null,
    },
    latency: {
      ttft: latency(samples.map((sample) => sample.ttft)),
      duration: latency(samples.map((sample) => sample.duration)),
    },
  }
}

function groupHistory(
  samples: Array<Sample>,
  key: "model" | "source" | "role",
) {
  const groups = new Map<string, Array<Sample>>()
  for (const sample of samples) {
    const group = groups.get(sample[key]) ?? []
    group.push(sample)
    groups.set(sample[key], group)
  }
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => [name, summarizeHistory(group)]),
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Log analysis failed",
    )
    process.exitCode = 1
  }
}
