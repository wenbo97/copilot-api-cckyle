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
        const timestamp = match[1] ? Date.parse(match[1]) : Number.NaN
        if (!Number.isFinite(timestamp)) parsing.missing_timestamp_records++
        if (outsideRange(timestamp, range)) {
          parsing.filtered_records++
          continue
        }
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
        if (samples.has(parsed.id)) parsing.duplicate_records++
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

function groupSamples(samples: Array<Sample>, key: "model" | "source") {
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
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log(
      "Usage: bun run usage:summary [logPath] [--since ISO8601] [--until ISO8601] [--json]\nDefault: tmps/cache-session.log; interval: [since, until)",
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
    ].join("\n\n"),
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
