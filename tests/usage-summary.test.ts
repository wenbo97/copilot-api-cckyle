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
      entry("a", { input_tokens: 999 })
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
      schema_version: 1,
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
