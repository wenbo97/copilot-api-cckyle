/**
 * High-volume SOAK verification (beyond the single-pass §7 matrix).
 *
 * For each (model × client) combo, run N≥50 LIVE iterations, cycling through the
 * client's features so the runs exercise different code paths (not the same call
 * 50×). Every run is judged by the trace-tag oracle + exit-0 + non-empty +
 * no-error-leak, and its .req/.resp evidence path is recorded. Writes
 * SOAK-RESULTS-<date>.md (per-combo pass rate + every failure's evidence).
 *
 * Models:  claude-opus-4.8, claude-sonnet-4.6, gpt-5.5, gpt-5.3-codex
 * Clients: claude -p (Messages handler) AND codex exec (Responses handler)
 *
 *   bun run tests/acceptance/soak.ts                 # all combos, 50 runs each
 *   bun run tests/acceptance/soak.ts --runs 10       # fewer runs (smoke)
 *   bun run tests/acceptance/soak.ts --only claude:gpt-5.5
 */
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runClaude } from "./lib/claude"
import { runCodex } from "./lib/codex"
import { latestTrace, type TraceTag } from "./lib/oracle"
import { startProxy } from "./lib/proxy"

// ── Combos: model × client, with the expected trace tag per Rule B ──────────────
interface Combo {
  key: string
  client: "claude" | "codex"
  model: string
  expectedTag: TraceTag
}

const MODELS = [
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "gpt-5.5",
  "gpt-5.3-codex",
] as const

// claude client: Claude models → passthrough, GPT models → bridge.
// codex client:  Claude models → translate-down ("responses"), GPT → passthrough.
function claudeTag(model: string): TraceTag {
  return model.startsWith("claude-") ?
      "anthropic-passthrough"
    : "anthropic-via-responses"
}
function codexTag(model: string): TraceTag {
  return model.startsWith("claude-") ? "responses" : "responses-passthrough"
}

const COMBOS: Array<Combo> = MODELS.flatMap((model) => [
  {
    key: `claude:${model}`,
    client: "claude",
    model,
    expectedTag: claudeTag(model),
  },
  {
    key: `codex:${model}`,
    client: "codex",
    model,
    expectedTag: codexTag(model),
  },
])

// ── Feature rotation: each iteration picks a variant so 50 runs differ ──────────
// Claude variants exercise: plain text, stream-json, varied content lengths,
// arithmetic (forces real generation), and a short tool-free reasoning prompt.
const CLAUDE_VARIANTS: Array<{
  label: string
  prompt: (i: number) => string
  outputFormat?: "text" | "stream-json"
}> = [
  { label: "text-ok", prompt: () => "Reply with the single word: OK" },
  {
    label: "arith",
    prompt: (i) =>
      `What is ${13 + i} times ${7 + (i % 5)}? Reply with only the number.`,
  },
  {
    label: "stream-json",
    prompt: () => "Reply with the single word: OK",
    outputFormat: "stream-json",
  },
  {
    label: "echo-token",
    prompt: (i) => `Repeat exactly this token and nothing else: TKN${i}`,
  },
  {
    label: "short-reason",
    prompt: (i) =>
      `Is ${100 + i} even or odd? Reply with only the word even or odd.`,
  },
]

// Codex variants exercise: plain reply, arithmetic, a file-write tool step, and
// an echo. (review mode is covered by the single-pass matrix; soak focuses on
// exec which is the high-frequency agent path.)
const CODEX_VARIANTS: Array<{ label: string; prompt: (i: number) => string }> =
  [
    { label: "text-ok", prompt: () => "Reply with the single word: OK" },
    {
      label: "arith",
      prompt: (i) =>
        `What is ${13 + i} times ${7 + (i % 5)}? Reply with only the number.`,
    },
    {
      label: "echo-token",
      prompt: (i) => `Repeat exactly this token and nothing else: TKN${i}`,
    },
  ]

// ── Per-run judging ─────────────────────────────────────────────────────────────
interface RunVerdict {
  combo: string
  i: number
  variant: string
  pass: boolean
  expectedTag: string
  actualTag: string | undefined
  exitCode: number | null
  reqFile: string | undefined
  reasons: Array<string>
}

const RAW_400 =
  /\b400\s+bad\s+request\b|\bhttp\/?[\d.]*\s+400\b|"(?:status|status_code|code)"\s*:\s*400\b/i
const UNSUPPORTED = /unsupported_api_for_model/i

interface JudgeInput {
  combo: Combo
  i: number
  variant: string
  exitCode: number | null
  timedOut: boolean
  finalText: string
  output: string
  tag: string | undefined
  reqFile: string | undefined
}

function judge(input: JudgeInput): RunVerdict {
  const { combo, tag } = input
  const reasons: Array<string> = []
  if (tag !== combo.expectedTag)
    reasons.push(`tag ${tag ?? "<none>"} != ${combo.expectedTag}`)
  if (input.timedOut) reasons.push("timed out")
  if (input.exitCode !== 0) reasons.push(`exit ${input.exitCode}`)
  if (input.finalText.trim() === "") reasons.push("empty final text")
  if (RAW_400.test(input.output)) reasons.push("raw 400")
  if (UNSUPPORTED.test(input.output)) reasons.push("unsupported_api_for_model")
  return {
    combo: combo.key,
    i: input.i,
    variant: input.variant,
    pass: reasons.length === 0,
    expectedTag: combo.expectedTag,
    actualTag: tag,
    exitCode: input.exitCode,
    reqFile: input.reqFile,
    reasons,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────
function parseArgs(argv: Array<string>) {
  let runs = 50
  let only: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i])
    else if (argv[i] === "--only") only = argv[++i]
  }
  return { runs, only }
}

// Execute ONE iteration: drive the client, read the trace, judge it.
async function executeRun(
  combo: Combo,
  i: number,
  ctx: { port: number; traceDir: string; workDir: string },
): Promise<RunVerdict> {
  const before = Date.now()
  const baseUrl = `http://localhost:${ctx.port}`

  if (combo.client === "claude") {
    const v = CLAUDE_VARIANTS[i % CLAUDE_VARIANTS.length]
    const res = await runClaude({
      prompt: v.prompt(i),
      model: combo.model,
      baseUrl,
      outputFormat: v.outputFormat ?? "text",
      timeoutMs: 90_000,
    })
    const trace = await latestTrace(ctx.traceDir, before)
    return judge({
      combo,
      i,
      variant: v.label,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      finalText: res.lastText,
      output: res.stdout + res.stderr,
      tag: trace?.tag,
      reqFile: trace?.file,
    })
  }

  const v = CODEX_VARIANTS[i % CODEX_VARIANTS.length]
  const res = await runCodex({
    prompt: v.prompt(i),
    model: combo.model,
    mode: "exec",
    baseUrl,
    cwd: ctx.workDir,
    timeoutMs: 90_000,
  })
  const trace = await latestTrace(ctx.traceDir, before)
  return judge({
    combo,
    i,
    variant: v.label,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    finalText: res.lastMessage,
    output: res.stdout + res.stderr,
    tag: trace?.tag,
    reqFile: trace?.file,
  })
}

async function main() {
  const { runs, only } = parseArgs(process.argv.slice(2))
  const combos = only ? COMBOS.filter((c) => c.key === only) : COMBOS
  if (combos.length === 0) {
    console.error(
      `No combo matches --only ${only}. Valid: ${COMBOS.map((c) => c.key).join(", ")}`,
    )
    process.exit(2)
  }

  // A throwaway working dir for codex file-write steps.
  const workDir = mkdtempSync(join(tmpdir(), "soak-work-"))

  console.log(
    `SOAK: ${combos.length} combo(s) × ${runs} runs = ${combos.length * runs} live runs`,
  )
  console.log("Starting proxy on :4143 …")
  const proxy = await startProxy({})
  console.log(`Proxy ready, traces → ${proxy.traceDir}`)

  const jsonlPath = join(import.meta.dir, `SOAK-RUNS.jsonl`)
  writeFileSync(jsonlPath, "")

  const summary: Array<{
    combo: string
    pass: number
    total: number
    failures: Array<RunVerdict>
  }> = []

  try {
    for (const combo of combos) {
      let pass = 0
      const failures: Array<RunVerdict> = []
      console.log(`\n▶ ${combo.key} (expect ${combo.expectedTag}) …`)

      for (let i = 0; i < runs; i++) {
        const verdict = await executeRun(combo, i, {
          port: proxy.port,
          traceDir: proxy.traceDir,
          workDir,
        })
        appendFileSync(jsonlPath, JSON.stringify(verdict) + "\n")
        if (verdict.pass) {
          pass++
          process.stdout.write(".")
        } else {
          failures.push(verdict)
          process.stdout.write("F")
        }
      }
      console.log(`\n  ${combo.key}: ${pass}/${runs} PASS`)
      summary.push({ combo: combo.key, pass, total: runs, failures })
    }
  } finally {
    await proxy.stop()
  }

  // ── Report ──
  const allPass = summary.every((s) => s.pass === s.total)
  const lines: Array<string> = []
  lines.push(
    `# SOAK Results`,
    "",
    `Runs per combo: ${runs} · Proxy: :4143 (fixed code) · Oracle: trace .type tag`,
    "",
    `| Combo | Pass | Total | Rate |`,
    `|---|---|---|---|`,
  )
  for (const s of summary) {
    lines.push(
      `| ${s.combo} | ${s.pass} | ${s.total} | ${((s.pass / s.total) * 100).toFixed(0)}% |`,
    )
  }
  lines.push("")
  const failed = summary.filter((s) => s.pass < s.total)
  if (failed.length === 0) {
    lines.push(
      `**ALL ${summary.reduce((a, s) => a + s.total, 0)} RUNS PASSED across ${summary.length} combos.**`,
    )
  } else {
    lines.push(
      `## Failures (${failed.reduce((a, s) => a + s.failures.length, 0)} runs)`,
    )
    for (const s of failed) {
      lines.push(`### ${s.combo} — ${s.failures.length} failed`)
      for (const f of s.failures.slice(0, 20)) {
        lines.push(
          `- run ${f.i} (${f.variant}): ${f.reasons.join("; ")} — req: \`${f.reqFile ?? "none"}\``,
        )
      }
    }
  }
  const outPath = join(import.meta.dir, "SOAK-RESULTS.md")
  writeFileSync(outPath, lines.join("\n"))
  console.log(
    `\n${allPass ? "ALL PASS" : "FAILURES PRESENT"} — report: ${outPath}`,
  )
  console.log(`per-run JSONL: ${jsonlPath}`)
  process.exit(allPass ? 0 : 1)
}

await main()
