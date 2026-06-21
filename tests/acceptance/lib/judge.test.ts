import { describe, test, expect } from "bun:test"

import type { DrivenOutcome } from "../lib/judge"
import type { TraceInfo } from "../lib/oracle"
import type { MatrixCell } from "../matrices"

import {
  hasRawHttp400,
  hasUnsupportedApi,
  judgeCell,
  parseArgs,
  renderResults,
  selectCells,
  type CellResult,
} from "../lib/judge"

// ── helpers ────────────────────────────────────────────────────────────────
function cell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    id: "1a",
    mandate: "1",
    client: "claude",
    model: "claude-opus-4.8",
    prompt: "Reply OK",
    expectedTag: "anthropic-passthrough",
    description: "test cell",
    ...overrides,
  }
}

function driven(overrides: Partial<DrivenOutcome> = {}): DrivenOutcome {
  return {
    exitCode: 0,
    timedOut: false,
    finalText: "OK",
    output: "OK\n",
    ...overrides,
  }
}

function trace(tag: string | undefined, file = "/t/x.req"): TraceInfo {
  return { file, tag, body: { type: tag }, mtimeMs: 1 }
}

// ── hasRawHttp400 (the false-FAIL bug fix) ──────────────────────────────────
describe("hasRawHttp400", () => {
  test("does NOT trip on a bare 400 in a token count (the bug)", () => {
    expect(hasRawHttp400('{"output_tokens": 400}')).toBe(false)
    expect(hasRawHttp400('{"input_tokens":1400,"output_tokens":400}')).toBe(
      false,
    )
  })

  test("does NOT trip on 400 appearing in a model's reply", () => {
    expect(hasRawHttp400("The answer is 400 dollars.")).toBe(false)
    expect(hasRawHttp400("400")).toBe(false)
  })

  test("trips on the HTTP 400 Bad Request reason phrase", () => {
    expect(hasRawHttp400("Error: 400 Bad Request")).toBe(true)
    expect(hasRawHttp400("400 bad request")).toBe(true)
  })

  test("trips on an HTTP status line", () => {
    expect(hasRawHttp400("HTTP/1.1 400")).toBe(true)
    expect(hasRawHttp400("HTTP 400")).toBe(true)
  })

  test("trips on an error-object status/code field == 400", () => {
    expect(hasRawHttp400('{"status":400}')).toBe(true)
    expect(hasRawHttp400('{"status_code": 400}')).toBe(true)
    expect(hasRawHttp400('{"code":400,"message":"bad"}')).toBe(true)
  })

  test("trips on 'status 400' / 'status code 400' phrasing", () => {
    expect(hasRawHttp400("request failed with status 400")).toBe(true)
    expect(hasRawHttp400("status code 400")).toBe(true)
  })

  test("does NOT trip on a non-400 status (e.g. 4000 tokens, 200)", () => {
    expect(hasRawHttp400('{"status":200}')).toBe(false)
    expect(hasRawHttp400('{"output_tokens":4000}')).toBe(false)
    expect(hasRawHttp400('{"status":40000}')).toBe(false)
  })
})

describe("hasUnsupportedApi", () => {
  test("detects unsupported_api_for_model (case-insensitive)", () => {
    expect(hasUnsupportedApi('{"error":"unsupported_api_for_model"}')).toBe(
      true,
    )
    expect(hasUnsupportedApi("UNSUPPORTED_API_FOR_MODEL")).toBe(true)
  })
  test("clean output is fine", () => {
    expect(hasUnsupportedApi("OK")).toBe(false)
  })
})

// ── judgeCell ───────────────────────────────────────────────────────────────
describe("judgeCell", () => {
  test("PASS when tag matches, exit 0, non-empty, clean output", () => {
    const r = judgeCell(cell(), driven(), [trace("anthropic-passthrough")])
    expect(r.pass).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.actualTag).toBe("anthropic-passthrough")
    expect(r.traceCount).toBe(1)
  })

  test("FAIL on tag mismatch (judges routing, not just a reply)", () => {
    const r = judgeCell(cell(), driven(), [trace("responses-passthrough")])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("expected anthropic-passthrough")
    expect(r.failures.join(",")).toContain("responses-passthrough")
  })

  test("FAIL with <none> when no trace was produced", () => {
    const r = judgeCell(cell(), driven(), [])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("<none>")
    expect(r.actualTag).toBeUndefined()
    expect(r.tracePath).toBeUndefined()
  })

  test("FAIL on non-zero exit code", () => {
    const r = judgeCell(cell(), driven({ exitCode: 1 }), [
      trace("anthropic-passthrough"),
    ])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("exit code 1")
  })

  test("FAIL on timeout (exitCode null)", () => {
    const r = judgeCell(cell(), driven({ exitCode: null, timedOut: true }), [
      trace("anthropic-passthrough"),
    ])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("timed out")
  })

  test("FAIL on empty final text", () => {
    const r = judgeCell(cell(), driven({ finalText: "   " }), [
      trace("anthropic-passthrough"),
    ])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("empty final text")
  })

  test("FAIL when output carries unsupported_api_for_model", () => {
    const r = judgeCell(
      cell(),
      driven({ output: "OK but unsupported_api_for_model leaked" }),
      [trace("anthropic-passthrough")],
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("unsupported_api_for_model")
  })

  test("FAIL on a real raw 400 in output", () => {
    const r = judgeCell(cell(), driven({ output: "400 Bad Request" }), [
      trace("anthropic-passthrough"),
    ])
    expect(r.pass).toBe(false)
    expect(r.failures.join(",")).toContain("raw 400")
  })

  test("does NOT FAIL when 400 is just a token count", () => {
    const r = judgeCell(
      cell(),
      driven({ output: 'OK {"output_tokens":400}' }),
      [trace("anthropic-passthrough")],
    )
    expect(r.pass).toBe(true)
  })

  test("runs cell-specific extra asserts", () => {
    const failing = judgeCell(
      cell({
        extraAsserts: [
          { label: "needs 2 traces", check: (ctx) => ctx.traces.length >= 2 },
        ],
      }),
      driven(),
      [trace("anthropic-passthrough")],
    )
    expect(failing.pass).toBe(false)
    expect(failing.failures.join(",")).toContain("extra: needs 2 traces")

    const passing = judgeCell(
      cell({
        extraAsserts: [
          { label: "needs 2 traces", check: (ctx) => ctx.traces.length >= 2 },
        ],
      }),
      driven(),
      [
        trace("anthropic-passthrough"),
        trace("anthropic-passthrough", "/t/y.req"),
      ],
    )
    expect(passing.pass).toBe(true)
  })

  test("accumulates multiple failures at once", () => {
    const r = judgeCell(cell(), driven({ exitCode: 2, finalText: "" }), [
      trace("responses"),
    ])
    expect(r.failures.length).toBeGreaterThanOrEqual(3)
  })
})

// ── parseArgs ────────────────────────────────────────────────────────────────
describe("parseArgs", () => {
  test("--list", () => {
    expect(parseArgs(["--list"]).list).toBe(true)
  })
  test("--only splits, trims, drops empties", () => {
    const o = parseArgs(["--only", "1a, 1f ,"])
    expect([...(o.only ?? [])]).toEqual(["1a", "1f"])
  })
  test("--mandate captures the next arg", () => {
    expect(parseArgs(["--mandate", "3"]).mandate).toBe("3")
  })
  test("defaults: no flags", () => {
    const o = parseArgs([])
    expect(o.list).toBe(false)
    expect(o.only).toBeUndefined()
    expect(o.mandate).toBeUndefined()
  })
})

// ── selectCells ──────────────────────────────────────────────────────────────
describe("selectCells", () => {
  const cells: Array<MatrixCell> = [
    cell({ id: "1a", mandate: "1" }),
    cell({ id: "1f", mandate: "1", client: "codex" }),
    cell({ id: "3a", mandate: "3" }),
  ]
  test("no selector returns all", () => {
    expect(selectCells({ list: false }, cells).length).toBe(3)
  })
  test("--mandate filters by mandate", () => {
    const got = selectCells({ list: false, mandate: "1" }, cells)
    expect(got.map((c) => c.id)).toEqual(["1a", "1f"])
  })
  test("--only filters by id", () => {
    const got = selectCells({ list: false, only: new Set(["3a"]) }, cells)
    expect(got.map((c) => c.id)).toEqual(["3a"])
  })
})

// ── renderResults ────────────────────────────────────────────────────────────
describe("renderResults", () => {
  const meta = {
    proxyModels: 36,
    traceDir: "/tmp/traces",
    doctorOk: true,
    date: "2026-06-21T00:00:00.000Z",
  }
  const passing: CellResult = {
    cell: cell(),
    pass: true,
    expectedTag: "anthropic-passthrough",
    actualTag: "anthropic-passthrough",
    exitCode: 0,
    timedOut: false,
    finalTextLen: 2,
    failures: [],
    tracePath: "/t/x.req",
    traceCount: 1,
    durationMs: 10,
  }

  test("all-green report announces completion criteria met", () => {
    const md = renderResults([passing], meta)
    expect(md).toContain("1/1 PASS")
    expect(md).toContain("ALL CELLS PASS — completion criteria met.")
    expect(md).toContain("| 1a | claude | claude-opus-4.8 |")
    expect(md).toContain("/t/x.req")
  })

  test("any failure announces NOT complete with a count", () => {
    const failing: CellResult = {
      ...passing,
      pass: false,
      actualTag: "responses",
      failures: ["tag: expected anthropic-passthrough, got responses"],
    }
    const md = renderResults([passing, failing], meta)
    expect(md).toContain("1/2 PASS")
    expect(md).toContain("1 cell(s) FAILED — not complete.")
  })

  test("empty results are not declared all-green", () => {
    const md = renderResults([], meta)
    expect(md).not.toContain("ALL CELLS PASS")
  })

  test("uses the provided date deterministically", () => {
    expect(renderResults([passing], meta)).toContain("2026-06-21T00:00:00.000Z")
  })
})
