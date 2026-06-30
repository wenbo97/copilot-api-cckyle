/**
 * Pure verdict + reporting logic for the acceptance runner (spec §7).
 *
 * Extracted from run.ts so the gate's DECISION engine is unit-testable without
 * spawning a proxy or a CLI. `run.ts` owns orchestration (spawn, settle, write);
 * everything here is a pure function of its inputs.
 *
 * A cell PASSES iff, for the request just made:
 *   - the newest trace tag === the cell's expectedTag, AND
 *   - the client exited 0 (not timed out), AND
 *   - the final text is non-empty, AND
 *   - the output carries no `unsupported_api_for_model` and no raw HTTP 400, AND
 *   - every cell-specific extra assertion holds.
 */
import type { TraceInfo } from "./oracle"

import {
  MANDATE_TITLES,
  type ExtraAssertContext,
  type MatrixCell,
} from "./../matrices"

export interface DrivenOutcome {
  exitCode: number | null
  timedOut: boolean
  finalText: string
  output: string
}

export interface CellResult {
  cell: MatrixCell
  pass: boolean
  expectedTag: string
  actualTag: string | undefined
  exitCode: number | null
  timedOut: boolean
  finalTextLen: number
  failures: Array<string>
  tracePath: string | undefined
  traceCount: number
  durationMs: number
}

export interface CliOptions {
  only?: Set<string>
  mandate?: string
  list: boolean
}

/** True when the output reports the proxy's `unsupported_api_for_model` error. */
export function hasUnsupportedApi(output: string): boolean {
  return /unsupported_api_for_model/i.test(output)
}

/**
 * True when the output carries a *real* HTTP 400 error — NOT merely the digits
 * "400" appearing in a token count or a model's reply. We only trip on shapes that
 * unambiguously denote an HTTP 400: the "Bad Request" reason phrase, an HTTP status
 * line, or an error-object status/code field set to 400.
 */
export function hasRawHttp400(output: string): boolean {
  return (
    /\b400\s+bad\s+request\b/i.test(output)
    || /\bhttp\/?[\d.]*\s+400\b/i.test(output)
    || /\bstatus(?:\s+code)?\s+400\b/i.test(output)
    || /"(?:status|status_code|statuscode|code)"\s*:\s*400\b/i.test(output)
  )
}

/** Judge a driven cell against tag + exit0 + non-empty + no-error + extras. */
export function judgeCell(
  cell: MatrixCell,
  driven: DrivenOutcome,
  traces: Array<TraceInfo>,
): CellResult {
  const newest = traces.length > 0 ? traces[0] : null
  const actualTag = newest?.tag
  const failures: Array<string> = []

  if (actualTag !== cell.expectedTag) {
    failures.push(
      `tag: expected ${cell.expectedTag}, got ${actualTag ?? "<none>"}`,
    )
  }
  if (driven.timedOut) failures.push("client timed out")
  if (driven.exitCode !== 0) failures.push(`exit code ${driven.exitCode}`)
  if (driven.finalText.trim().length === 0) failures.push("empty final text")
  if (hasUnsupportedApi(driven.output)) {
    failures.push("output contains unsupported_api_for_model")
  }
  if (hasRawHttp400(driven.output)) {
    failures.push("output contains a raw 400")
  }

  const ctx: ExtraAssertContext = {
    exitCode: driven.exitCode,
    finalText: driven.finalText,
    output: driven.output,
    trace: newest,
    traces,
  }
  for (const extra of cell.extraAsserts ?? []) {
    if (!extra.check(ctx)) failures.push(`extra: ${extra.label}`)
  }

  return {
    cell,
    pass: failures.length === 0,
    expectedTag: cell.expectedTag,
    actualTag,
    exitCode: driven.exitCode,
    timedOut: driven.timedOut,
    finalTextLen: driven.finalText.trim().length,
    failures,
    tracePath: newest?.file,
    traceCount: traces.length,
    durationMs: 0,
  }
}

/** Parse runner CLI flags (`--only a,b`, `--mandate N`, `--list`). */
export function parseArgs(argv: Array<string>): CliOptions {
  const opts: CliOptions = { list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--only": {
        opts.only = new Set(
          (argv[++i] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        )
        break
      }
      case "--mandate": {
        opts.mandate = argv[++i]
        break
      }
      case "--list": {
        opts.list = true
        break
      }
      // No default
    }
  }
  return opts
}

/** Filter the matrix by `--mandate` and `--only` selectors. */
export function selectCells(
  opts: CliOptions,
  matrices: Array<MatrixCell>,
): Array<MatrixCell> {
  let cells = matrices
  if (opts.mandate) cells = cells.filter((c) => c.mandate === opts.mandate)
  if (opts.only) cells = cells.filter((c) => opts.only?.has(c.id))
  return cells
}

/** Render the RESULTS-<date>.md report from judged cells (pure). */
export function renderResults(
  results: Array<CellResult>,
  meta: {
    proxyModels: number
    traceDir: string
    doctorOk: boolean
    date?: string
  },
): string {
  const date = meta.date ?? new Date().toISOString()
  const passCount = results.filter((r) => r.pass).length
  const total = results.length
  const allGreen = total > 0 && passCount === total

  const preamble = [
    `# Acceptance RESULTS — ${date}`,
    "",
    `**${passCount}/${total} PASS** · proxy :4143 served ${meta.proxyModels} models · codex doctor: ${meta.doctorOk ? "ok" : "WARN"}`,
    "",
    "> **Preamble.** Judged by the trace-tag oracle (the `.type` of each",
    "> `<traceDir>/<ts>.req`), not by eyeballing replies. A cell passes only",
    "> when the egress tag matches, the client exits 0 with non-empty output,",
    "> and no `unsupported_api_for_model` / raw 400 appears. Some target tags",
    "> only become correct AFTER the routing fix (pickEgress) lands — cells may",
    "> legitimately FAIL against pre-fix code; the harness asserts the TARGET.",
    "",
    `Trace dir: \`${meta.traceDir}\``,
    "",
  ]

  const byMandate = new Map<string, Array<CellResult>>()
  for (const r of results) {
    const k = r.cell.mandate
    if (!byMandate.has(k)) byMandate.set(k, [])
    byMandate.get(k)?.push(r)
  }

  const tableRow = (r: CellResult): string => {
    const result = r.pass ? "PASS" : "FAIL"
    const notes =
      r.failures.length > 0 ? r.failures.join("; ") : `${r.traceCount} trace(s)`
    return `| ${r.cell.id} | ${r.cell.client} | ${r.cell.model} | ${r.expectedTag} | ${r.actualTag ?? "—"} | ${r.exitCode ?? "—"} | ${result} | ${notes} |`
  }

  const sections = [...byMandate.entries()]
    .sort()
    .flatMap(([mandate, rows]) => [
      `## ${MANDATE_TITLES[mandate as MatrixCell["mandate"]]}`,
      "",
      "| Cell | Client | Model | Expected tag | Actual tag | Exit | Result | Notes |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => tableRow(r)),
      "",
    ])

  const evidence = [
    "## Evidence (trace files)",
    "",
    ...results.map(
      (r) =>
        `- **${r.cell.id}** (${r.pass ? "PASS" : "FAIL"}): \`${r.tracePath ?? "no trace"}\``,
    ),
    "",
    allGreen ?
      "**ALL CELLS PASS — completion criteria met.**"
    : `**${total - passCount} cell(s) FAILED — not complete.**`,
    "",
  ]

  return [...preamble, ...sections, ...evidence].join("\n")
}
