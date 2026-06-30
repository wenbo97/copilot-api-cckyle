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
import {
  judgeCell,
  parseArgs,
  renderResults,
  selectCells,
  type CellResult,
  type DrivenOutcome,
} from "./lib/judge"
import { tracesSince } from "./lib/oracle"
import { startProxy, type ProxyHandle } from "./lib/proxy"
import { MATRICES, type MatrixCell } from "./matrices"

const RESULTS_DIR = import.meta.dir
// Settle time for the trace `.req` to hit disk after the client returns.
const TRACE_SETTLE_MS = 1_500

/** Drive one cell's client and return the captured outcome (no judging yet). */
async function driveCell(
  cell: MatrixCell,
  proxy: ProxyHandle,
): Promise<DrivenOutcome> {
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const cells = selectCells(opts, MATRICES)

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
