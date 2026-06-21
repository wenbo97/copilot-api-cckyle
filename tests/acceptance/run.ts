/**
 * Headless acceptance runner (spec §7) — the ONLY thing that may declare "complete".
 *
 * For each matrix cell (§7.2–§7.5):
 *   1. ensure the :4143 worktree proxy is up (started once, reused across cells);
 *   2. run the real client (claude -p / codex exec) against it;
 *   3. read the trace-tag oracle and compare to the cell's expectedTag;
 *   4. also assert exit 0, non-empty final text, and NO `unsupported_api_for_model`
 *      / raw 400 in the client output, plus any cell-specific extra asserts.
 *
 * Writes `tests/acceptance/RESULTS-<date>.md` (one row per cell, expected vs actual
 * tag, exit code, PASS/FAIL, trace path) and exits non-zero if ANY cell FAILs.
 *
 * Usage:
 *   bun run tests/acceptance/run.ts                 # full matrix
 *   bun run tests/acceptance/run.ts --only 1a,1f    # subset by cell id
 *   bun run tests/acceptance/run.ts --mandate 1     # one mandate
 *   bun run tests/acceptance/run.ts --list          # print cells, don't run
 */
import consola from "consola"
import { writeFile } from "node:fs/promises"
import path from "node:path"

import { runClaude } from "./lib/claude"
import { runCodex } from "./lib/codex"
import { codexDoctor } from "./lib/codex"
import { tracesSince, type TraceInfo } from "./lib/oracle"
import { startProxy, type ProxyHandle } from "./lib/proxy"
import {
  MANDATE_TITLES,
  MATRICES,
  type ExtraAssertContext,
  type MatrixCell,
} from "./matrices"

const RESULTS_DIR = import.meta.dir
// Settle time for the trace `.req` to hit disk after the client returns.
const TRACE_SETTLE_MS = 1_500

interface CellResult {
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

interface CliOptions {
  only?: Set<string>
  mandate?: string
  list: boolean
}

function parseArgs(argv: Array<string>): CliOptions {
  const opts: CliOptions = { list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--only": {
        opts.only = new Set((argv[++i] ?? "").split(",").map((s) => s.trim()))

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

function selectCells(opts: CliOptions): Array<MatrixCell> {
  let cells = MATRICES
  if (opts.mandate) cells = cells.filter((c) => c.mandate === opts.mandate)
  if (opts.only) cells = cells.filter((c) => opts.only?.has(c.id))
  return cells
}

/** Drive one cell's client and return the captured outcome (no judging yet). */
async function driveCell(
  cell: MatrixCell,
  proxy: ProxyHandle,
): Promise<{
  exitCode: number | null
  timedOut: boolean
  finalText: string
  output: string
}> {
  if (cell.client === "claude") {
    const res = await runClaude({
      prompt: cell.prompt,
      model: cell.model,
      baseUrl: proxy.baseUrl,
      agentsJson: cell.agentsJson,
      mcpConfig: cell.mcpConfig,
      outputFormat: cell.claudeOutputFormat ?? "text",
    })
    return {
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      finalText: res.lastText,
      output: `${res.stdout}\n${res.stderr}`,
    }
  }
  const res = await runCodex({
    prompt: cell.prompt,
    model: cell.model,
    mode: cell.codexMode ?? "exec",
    baseUrl: proxy.baseUrl,
    cwd: proxy.traceDir, // a throwaway writable dir for exec tool steps
  })
  return {
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    finalText: res.lastMessage,
    output: `${res.stdout}\n${res.stderr}`,
  }
}

/** Judge a driven cell against tag + exit0 + non-empty + no-error + extras. */
function judgeCell(
  cell: MatrixCell,
  driven: {
    exitCode: number | null
    timedOut: boolean
    finalText: string
    output: string
  },
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
  if (/unsupported_api_for_model/i.test(driven.output)) {
    failures.push("output contains unsupported_api_for_model")
  }
  if (/\b(?:HTTP\s*)?400\b|"status"\s*:\s*400/i.test(driven.output)) {
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

async function runCell(
  cell: MatrixCell,
  proxy: ProxyHandle,
): Promise<CellResult> {
  const started = Date.now()
  // Cutoff marker so we attribute only THIS cell's traces.
  const cutoff = Date.now()
  let driven
  try {
    driven = await driveCell(cell, proxy)
  } catch (err) {
    return {
      cell,
      pass: false,
      expectedTag: cell.expectedTag,
      actualTag: undefined,
      exitCode: null,
      timedOut: false,
      finalTextLen: 0,
      failures: [
        `driver threw: ${err instanceof Error ? err.message : String(err)}`,
      ],
      tracePath: undefined,
      traceCount: 0,
      durationMs: Date.now() - started,
    }
  }

  await Bun.sleep(TRACE_SETTLE_MS)
  const traces = await tracesSince(proxy.traceDir, cutoff)
  const result = judgeCell(cell, driven, traces)
  result.durationMs = Date.now() - started
  return result
}

function renderResults(
  results: Array<CellResult>,
  meta: { proxyModels: number; traceDir: string; doctorOk: boolean },
): string {
  const date = new Date().toISOString()
  const passCount = results.filter((r) => r.pass).length
  const total = results.length
  const allGreen = passCount === total

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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const cells = selectCells(opts)

  if (opts.list) {
    for (const c of cells) {
      consola.log(
        `${c.id}\t${c.client}\t${c.model}\t→ ${c.expectedTag}\t${c.description}`,
      )
    }
    return
  }

  if (cells.length === 0) {
    consola.error("No cells selected.")
    process.exit(2)
  }

  consola.info(`Acceptance run: ${cells.length} cell(s)`)

  // codex doctor smoke precedes the matrix (spec §7.0 / §8).
  const doctor = await codexDoctor().catch(() => null)
  const doctorOk = doctor?.exitCode === 0
  if (!doctorOk) consola.warn("codex doctor returned non-zero (continuing)")

  consola.info("Starting proxy on :4143 …")
  let proxy: ProxyHandle
  try {
    proxy = await startProxy()
  } catch (err) {
    consola.error("Proxy failed to start; cannot run the live matrix.")
    consola.error(err instanceof Error ? err.message : err)
    process.exit(3)
  }
  consola.success(
    `Proxy ready: ${proxy.modelCount} models, traces → ${proxy.traceDir}`,
  )

  const results: Array<CellResult> = []
  try {
    for (const cell of cells) {
      consola.info(`▶ ${cell.id} (${cell.client}/${cell.model}) …`)
      const result = await runCell(cell, proxy)
      results.push(result)
      const badge = result.pass ? "PASS" : "FAIL"
      consola.log(
        `  ${badge} ${cell.id}: tag ${result.actualTag ?? "—"} (want ${result.expectedTag}), exit ${result.exitCode}, ${result.durationMs}ms`
          + (result.failures.length > 0 ?
            ` — ${result.failures.join("; ")}`
          : ""),
      )
    }
  } finally {
    await proxy.stop()
  }

  const report = renderResults(results, {
    proxyModels: proxy.modelCount,
    traceDir: proxy.traceDir,
    doctorOk,
  })
  const stamp = new Date().toISOString().slice(0, 10)
  const outPath = path.join(RESULTS_DIR, `RESULTS-${stamp}.md`)
  await writeFile(outPath, report, "utf8")

  const passCount = results.filter((r) => r.pass).length
  consola.box(`${passCount}/${results.length} PASS\nRESULTS: ${outPath}`)

  if (passCount !== results.length) process.exit(1)
}

await main()
