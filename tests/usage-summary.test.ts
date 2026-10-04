import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directories: Array<string> = []
const script = resolve(import.meta.dir, "../scripts/usage-summary.ts")

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

test("time range is inclusive/exclusive and invalid metrics stay unknown", async () => {
  const file = await fixture(
    entry("before", { input_tokens: 999 }, "2026-09-29T09:59:59Z")
      + entry(
        "inside",
        {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: -1,
          usage_complete: true,
        },
        "2026-09-29T10:00:00Z",
      )
      + entry("until", { input_tokens: 888 }, "2026-09-29T11:00:00Z"),
  )
  const result = await run(
    file,
    "--since",
    "2026-09-29T18:00:00+08:00",
    "--until",
    "2026-09-29T19:00:00+08:00",
    "--json",
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    overall: {
      records: 1,
      metrics: {
        input_tokens: { observed_sum: 0 },
        output_tokens: { observed_sum: null },
      },
      cache: { hit_ratio: null, coverage: 1 },
    },
    parsing: { filtered_records: 2 },
  })
  const empty = await run(file, "--since", "2026-10-01T00:00:00Z")
  expect(empty.code).toBe(0)
  expect(empty.stdout).toContain("No data")
}, 30_000)

test("conflicting replay fails without echoing private contents, identical replay keeps first time association", async () => {
  const conflict = await fixture(
    entry("private-request", {
      input_tokens: 1,
      private_field: "private-secret",
    })
      + entry("private-request", {
        input_tokens: 2,
        private_field: "private-secret",
      }),
  )
  const failed = await run(conflict, "--history", "--json")
  expect(failed.code).toBe(1)
  expect(failed.stderr).toContain("Conflicting cache diagnostic records")
  expect(failed.stderr).not.toContain("private-")
  expect(failed.stdout).toBe("")
  const repeated = await fixture(
    entry("same", { input_tokens: 100 }, "2026-09-29T09:00:00Z")
      + entry("same", { input_tokens: 100 }, "2026-09-29T11:00:00Z"),
  )
  const result = await run(
    repeated,
    "--since",
    "2026-09-29T10:00:00Z",
    "--json",
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    overall: { records: 0 },
    parsing: { duplicate_records: 1, filtered_records: 1 },
  })
}, 30_000)

test("history reports pair counters, retain unknown legacy attribution, and scope thread groups by process", async () => {
  const identity = {
    schema_version: 2,
    source: "native_responses",
    thread_fingerprint: "a".repeat(64),
    correlation_scope: "b".repeat(64),
    process_scope: "00000000-0000-0000-0000-000000000001",
    request_role: "main",
  }
  const file = await fixture(
    entry("a", {
      ...identity,
      input_tokens: 100,
      cached_input_tokens: 80,
      cache_write_tokens: 10,
      output_tokens: 2,
      ttft_ms: 20,
      duration_ms: 50,
      history_comparison: {
        egress: {
          status: "compared",
          relation: "modified",
          first_changed_block: 1,
          changed_settings: ["tools", "private-setting"],
        },
      },
    })
      + entry("b", {
        ...identity,
        process_scope: "00000000-0000-0000-0000-000000000002",
        input_tokens: 300,
        cached_input_tokens: 0,
        cache_write_tokens: 400,
      })
      + entry("legacy", { input_tokens: 200, cached_input_tokens: null }),
  )
  const result = await run(file, "--history", "--json")
  expect(result.code).toBe(0)
  const report = JSON.parse(result.stdout) as {
    history: {
      by_process_thread: Record<string, unknown>
      largest_unread_inputs: Array<Record<string, unknown>>
    }
  }
  expect(report).toMatchObject({
    history: {
      correlated_records: 2,
      ordinary_input_tokens: { observed_sum: 10, known_records: 1 },
      unread_input_tokens: { observed_sum: 320, known_records: 2 },
      by_role: { main: { records: 2 }, unknown: { records: 1 } },
      latency: { ttft: { median_ms: 20 } },
    },
  })
  expect(Object.keys(report.history.by_process_thread)).toHaveLength(2)
  expect(report.history.largest_unread_inputs).toHaveLength(2)
  expect(report.history.largest_unread_inputs[0]).toMatchObject({
    unread_input_tokens: 300,
    ordinary_input_tokens: null,
  })
  expect(report.history.largest_unread_inputs[1]).toMatchObject({
    history_comparison: {
      egress: { first_changed_block: 1, changed_settings: ["tools"] },
    },
  })
  expect(result.stdout).not.toContain("private-setting")
}, 30_000)

test("rejects unreadable files and invalid time arguments", async () => {
  const file = await fixture("")
  for (const args of [
    [file + ".missing"],
    [file, "--since", "yesterday"],
    [file, "--since", "2026-02-30T00:00:00Z"],
    [
      file,
      "--since",
      "2026-10-01T00:00:00Z",
      "--until",
      "2026-09-01T00:00:00Z",
    ],
  ]) {
    const result = await run(...args)
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  }
}, 60_000)

async function fixture(text: string, encoding: "utf8" | "utf16le" = "utf8") {
  const directory = await mkdtemp(join(tmpdir(), "usage-summary-"))
  directories.push(directory)
  const file = join(directory, "session.log")
  await writeFile(
    file,
    Buffer.from((encoding === "utf16le" ? "\uFEFF" : "") + text, encoding),
  )
  return file
}

async function run(...args: Array<string>) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    clearTimeout(deadline)
  }
}

function entry(
  id: string,
  fields: Record<string, unknown>,
  date = "2026-09-29T10:00:00.000Z",
) {
  return `${date} [info] [cache-diagnostics] ${JSON.stringify({
    route: "/responses",
    request_id: id,
    model: "model-a",
    outcome: "completed",
    upstream_attempts: 1,
    ...fields,
  })}\n`
}

test.each(["utf8", "utf16le"] as const)(
  "summarizes observed usage and coverage from %s logs",
  async (encoding) => {
    const file = await fixture(
      entry("a", {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 10,
        usage_complete: true,
      })
        + entry("a", {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 10,
          usage_complete: true,
        })
        + entry("b", {
          input_tokens: 300,
          cached_input_tokens: 0,
          output_tokens: 0,
        })
        + entry("c", {
          model: "model-b",
          input_tokens: null,
          output_tokens: 5,
          upstream_attempts: 2,
          outcome: "error",
        })
        + "2026-09-29T10:00:00Z [info] [cache-diagnostics] {broken\n"
        + "2026-09-29T10:00:00Z [debug] private-prompt-must-not-appear\n",
      encoding,
    )
    const result = await run(file, "--json")
    expect(result.code).toBe(0)
    const report: unknown = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      schema_version: 2,
      parsing: { duplicate_records: 1, malformed_records: 1 },
      overall: {
        records: 3,
        retried_records: 1,
        outcomes: { completed: 2, error: 1 },
        upstream_attempts: { observed_sum: 4, known_records: 3 },
        metrics: {
          input_tokens: {
            observed_sum: 400,
            known_records: 2,
            coverage: 2 / 3,
          },
          output_tokens: { observed_sum: 15, known_records: 3, coverage: 1 },
          cached_input_tokens: { observed_sum: 80, known_records: 2 },
          copilot_nano_aiu: { observed_sum: null, known_records: 0 },
        },
        cache: { hit_ratio: 0.2, known_records: 2, coverage: 2 / 3 },
      },
      by_model: {
        "model-a": { records: 2 },
        "model-b": { records: 1 },
      },
    })
    expect(result.stdout).not.toContain("private-prompt")
    const text = await run(file)
    expect(text.code).toBe(0)
    expect(text.stdout).toContain("input_tokens: 400")
    expect(text.stdout).toContain("20.00%")
    expect(text.stdout).toContain("Observed usage")
    expect(text.stdout).toContain("retries")
    expect(text.stdout).not.toContain("private-prompt")
  },
  30_000,
)

test("separates actual attempts from final responses and keeps old ingress unknown", async () => {
  const file = await fixture(
    entry("legacy", {
      upstream_attempts: 2,
      input_tokens: 100,
      cached_input_tokens: 80,
      copilot_nano_aiu: 10,
    })
      + entry("bridge", {
        schema_version: 2,
        source: "messages_to_responses",
        upstream_attempts: 2,
        input_tokens: 100,
        cached_input_tokens: 70,
        copilot_nano_aiu: 20,
        attempt_details: [
          {
            attempt_index: 1,
            input_tokens: 100,
            cached_input_tokens: 80,
            copilot_nano_aiu: 10,
          },
          {
            attempt_index: 2,
            input_tokens: 100,
            cached_input_tokens: 70,
            copilot_nano_aiu: 20,
          },
        ],
      })
      + '2026-09-29T10:00:00Z [info] [messages-usage] {"request_id":"bridge","total_input_tokens":100}\n',
  )
  const result = await run(file, "--json")
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    schema_version: 2,
    scope: "responses_egress",
    overall: {
      records: 2,
      metrics: {
        input_tokens: { observed_sum: 200 },
        copilot_nano_aiu: { observed_sum: 30 },
      },
      attempt_usage: {
        records_with_details: 1,
        detailed_attempts: 2,
        total_reported_attempts: 4,
        attempt_count_coverage: 1,
        metrics: {
          input_tokens: { observed_sum: 200, known_attempts: 2, coverage: 0.5 },
          copilot_nano_aiu: {
            observed_sum: 30,
            known_attempts: 2,
            coverage: 0.5,
          },
        },
        cache: { hit_ratio: 0.75, known_attempts: 2, coverage: 0.5 },
      },
    },
    by_source: {
      unknown_ingress: { records: 1 },
      messages_to_responses: { records: 1 },
    },
  })
}, 30_000)

test("deduplicates attempt indices and preserves unknown attempt-count coverage", async () => {
  const file = await fixture(
    entry("known", {
      schema_version: 2,
      source: "native_responses",
      upstream_attempts: 2,
      attempt_details: [
        {
          attempt_index: 1,
          input_tokens: 999,
          cached_input_tokens: 999,
          copilot_nano_aiu: 999,
        },
        {
          attempt_index: 1,
          input_tokens: 100,
          cached_input_tokens: 0,
          copilot_nano_aiu: 0,
        },
        {
          attempt_index: 2,
          input_tokens: 10,
          cached_input_tokens: 11,
          copilot_nano_aiu: -1,
        },
        { attempt_index: 0, input_tokens: 999, copilot_nano_aiu: 999 },
        { attempt_index: 3, input_tokens: 999, copilot_nano_aiu: 999 },
      ],
    }) + entry("unknown", { upstream_attempts: null }),
  )
  const result = await run(file, "--json")
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    overall: {
      attempt_usage: {
        detailed_attempts: 2,
        attempt_count_coverage: 0.5,
        metrics: {
          input_tokens: {
            observed_sum: 110,
            known_attempts: 2,
            coverage: null,
          },
          cached_input_tokens: {
            observed_sum: 0,
            known_attempts: 1,
            coverage: null,
          },
          copilot_nano_aiu: {
            observed_sum: 0,
            known_attempts: 1,
            coverage: null,
          },
        },
        cache: { hit_ratio: 0, known_attempts: 1, coverage: null },
      },
    },
  })
}, 30_000)
