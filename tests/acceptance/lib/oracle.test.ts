import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  assertTag,
  latestTrace,
  latestTraceTag,
  tracesSince,
} from "../lib/oracle"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oracle-test-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write a .req fixture with the given timestamp-style basename and JSON body. */
async function writeReq(basename: string, body: unknown): Promise<string> {
  const file = path.join(dir, `${basename}.req`)
  await writeFile(file, JSON.stringify(body, null, 2), "utf8")
  return file
}

describe("latestTraceTag", () => {
  test("reads top-level .type from a hand-written .req fixture", async () => {
    await writeReq("20260621_120000_000", { type: "anthropic-via-responses" })
    expect(await latestTraceTag(dir)).toBe("anthropic-via-responses")
  })

  test("returns the NEWEST .req by mtime when several exist", async () => {
    await writeReq("20260621_120000_000", { type: "anthropic-passthrough" })
    // Force a strictly newer mtime on the second file.
    await Bun.sleep(15)
    const newer = await writeReq("20260621_120001_000", {
      type: "responses-passthrough",
    })
    const trace = await latestTrace(dir)
    expect(trace?.file).toBe(newer)
    expect(trace?.tag).toBe("responses-passthrough")
  })

  test("undefined tag when .type is absent (raw chat passthrough)", async () => {
    await writeReq("20260621_120000_000", { model: "x", messages: [] })
    expect(await latestTraceTag(dir)).toBeUndefined()
  })

  test("empty / missing trace dir → undefined, no throw", async () => {
    expect(await latestTraceTag(dir)).toBeUndefined()
    expect(
      await latestTraceTag(path.join(dir, "does-not-exist")),
    ).toBeUndefined()
  })

  test("afterMtimeMs filters out traces from a prior run", async () => {
    await writeReq("old", { type: "anthropic" })
    const cutoff = Date.now()
    await Bun.sleep(15)
    await writeReq("new", { type: "responses-passthrough" })
    expect(await latestTraceTag(dir, cutoff)).toBe("responses-passthrough")
  })

  test("body is exposed for extra assertions (e.g. reasoning effort)", async () => {
    await writeReq("20260621_120000_000", {
      type: "anthropic-via-responses",
      translated: { reasoning: { effort: "xhigh" } },
    })
    const trace = await latestTrace(dir)
    const body = trace?.body as
      | { translated?: { reasoning?: { effort?: string } } }
      | undefined
    expect(body?.translated?.reasoning?.effort).toBe("xhigh")
  })
})

describe("tracesSince", () => {
  test("returns all fresh traces newest-first", async () => {
    await writeReq("a", { type: "anthropic-via-responses" })
    await Bun.sleep(15)
    const cutoff = Date.now()
    await Bun.sleep(15)
    await writeReq("b", { type: "anthropic-via-responses" })
    await Bun.sleep(15)
    await writeReq("c", { type: "responses-passthrough" })
    const traces = await tracesSince(dir, cutoff)
    expect(traces.length).toBe(2)
    expect(traces.map((t) => t.tag)).toEqual([
      "responses-passthrough",
      "anthropic-via-responses",
    ])
  })
})

describe("assertTag", () => {
  test("ok when tags match", () => {
    const v = assertTag("anthropic-passthrough", "anthropic-passthrough")
    expect(v.ok).toBe(true)
  })
  test("fails with a descriptive message on mismatch", () => {
    const v = assertTag("anthropic-passthrough", "responses-passthrough")
    expect(v.ok).toBe(false)
    expect(v.message).toContain("expected tag anthropic-passthrough")
    expect(v.message).toContain("responses-passthrough")
  })
  test("reports <none> when no tag was observed", () => {
    const v = assertTag("responses-passthrough", undefined)
    expect(v.ok).toBe(false)
    expect(v.message).toContain("<none>")
  })
})
