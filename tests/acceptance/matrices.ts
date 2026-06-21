/**
 * The four mandate matrices (spec §7.2–§7.5), encoded as data.
 *
 * Each cell names: which real client to drive, the model id sent, the prompt, and
 * the trace tag the proxy MUST emit for routing to be correct. The runner
 * (`run.ts`) executes each cell against the :4143 worktree proxy, reads the oracle
 * tag, and compares.
 *
 * Expected tags follow Rule A (identity) + Rule B (catalog-truth routing):
 *   claude-opus-4.8 / claude-sonnet-4.6  →  /v1/messages present
 *       claude client → anthropic-passthrough ;  codex client → responses (translate-down)
 *   gpt-5.5 / gpt-5.3-codex               →  /responses only
 *       claude client → anthropic-via-responses ; codex client → responses-passthrough
 *   gpt-5.4 (dual /responses + /chat)     →  codex → responses-passthrough (same-protocol)
 *
 * NOTE (live status): some of these tags are only correct AFTER @routing-eng's
 * pickEgress fix lands. Until then, cells may legitimately FAIL against current code
 * — the matrix asserts the TARGET behavior. The runner documents this in the
 * RESULTS preamble.
 */
import type { TraceTag } from "./lib/oracle"
import type { TraceInfo } from "./lib/oracle"

export type Client = "claude" | "codex"

export interface ExtraAssertContext {
  /** Exit code of the client process (null if it timed out). */
  exitCode: number | null
  /** The final assistant text / last message. */
  finalText: string
  /** Combined stdout+stderr of the client. */
  output: string
  /** The newest parsed trace for this cell. */
  trace: TraceInfo | null
  /** All traces produced during this cell, newest-first. */
  traces: Array<TraceInfo>
}

export interface ExtraAssert {
  label: string
  check: (ctx: ExtraAssertContext) => boolean
}

export interface MatrixCell {
  /** Stable cell id from the spec (e.g. "1a", "2b-opus", "4d"). */
  id: string
  /** Spec section this cell belongs to. */
  mandate: "1" | "2" | "3" | "4"
  client: Client
  /** Model id sent to the proxy (may carry a [1m]-style suffix for 1b). */
  model: string
  /** Codex mode, when client==="codex". */
  codexMode?: "exec" | "review"
  /** Claude agents JSON (§7.4 3a) — passed to --agents. */
  agentsJson?: string
  /** Claude MCP config (§7.4 3b). */
  mcpConfig?: string | Array<string>
  /** Claude output format override (subagent rows use stream-json). */
  claudeOutputFormat?: "text" | "json" | "stream-json"
  /** The prompt / task. */
  prompt: string
  /** The trace tag the proxy MUST emit. */
  expectedTag: TraceTag
  /** Human description for the RESULTS table. */
  description: string
  /** Optional extra assertions beyond tag + exit0 + non-empty. */
  extraAsserts?: Array<ExtraAssert>
}

// A trivial agents JSON defining two custom subagents for the §7.4 3a fan-out rows.
const TWO_AGENTS_JSON = JSON.stringify({
  alpha: {
    description: "Returns the word ALPHA",
    prompt: "You are Alpha. Reply with exactly: ALPHA",
  },
  beta: {
    description: "Returns the word BETA",
    prompt: "You are Beta. Reply with exactly: BETA",
  },
})

/** ≥2 distinct trace clusters appeared (parent + at least one subagent call). */
const multiTrace: ExtraAssert = {
  label: "≥2 model-call traces (subagent activity)",
  check: (ctx) => ctx.traces.length >= 2,
}

/** A codex tool/command step occurred (an item event beyond the final message). */
const codexToolStep: ExtraAssert = {
  label: "a tool/command step occurred",
  check: (ctx) =>
    /"type"\s*:\s*"(?:item\.(?:started|updated)|command|exec|patch)/.test(
      ctx.output,
    ),
}

// ───────────────────────────── Mandate 1 (§7.2) ─────────────────────────────
const mandate1: Array<MatrixCell> = [
  {
    id: "1a",
    mandate: "1",
    client: "claude",
    model: "claude-opus-4.8",
    prompt: "Reply with the single word: OK",
    expectedTag: "anthropic-passthrough",
    description: "CC + claude-opus-4.8 → native passthrough",
  },
  {
    id: "1b",
    mandate: "1",
    client: "claude",
    model: "claude-opus-4-8[1m]",
    prompt: "Reply with the single word: OK",
    expectedTag: "anthropic-passthrough",
    description:
      "CC + claude-opus-4-8[1m] (suffix) → resolves to claude-opus-4.8, passthrough",
  },
  {
    id: "1c",
    mandate: "1",
    client: "claude",
    model: "claude-sonnet-4.6",
    prompt: "Reply with the single word: OK",
    expectedTag: "anthropic-passthrough",
    description: "CC + claude-sonnet-4.6 → native passthrough",
  },
  {
    id: "1d",
    mandate: "1",
    client: "claude",
    model: "gpt-5.5",
    prompt: "Reply with the single word: OK",
    expectedTag: "anthropic-via-responses",
    description: "CC + gpt-5.5 → Messages→Responses bridge",
  },
  {
    id: "1e",
    mandate: "1",
    client: "claude",
    model: "gpt-5.3-codex",
    prompt: "Reply with the single word: OK",
    expectedTag: "anthropic-via-responses",
    description: "CC + gpt-5.3-codex → bridge; effort clamped ≤xhigh",
    extraAsserts: [
      {
        label: "reasoning effort (if present) clamped to ≤ xhigh (no 'max')",
        check: (ctx) => {
          const body = ctx.trace?.body as
            | { translated?: { reasoning?: { effort?: string } } }
            | undefined
          const effort = body?.translated?.reasoning?.effort
          return effort === undefined || effort !== "max"
        },
      },
    ],
  },
  {
    id: "1f",
    mandate: "1",
    client: "codex",
    model: "gpt-5.5",
    codexMode: "exec",
    prompt: "Reply with the single word: OK",
    expectedTag: "responses-passthrough",
    description: "Codex + gpt-5.5 → native responses passthrough",
  },
  {
    id: "1g",
    mandate: "1",
    client: "codex",
    model: "gpt-5.3-codex",
    codexMode: "exec",
    prompt: "Reply with the single word: OK",
    expectedTag: "responses-passthrough",
    description: "Codex + gpt-5.3-codex → native responses passthrough",
  },
  {
    id: "1h",
    mandate: "1",
    client: "codex",
    model: "claude-opus-4.8",
    codexMode: "exec",
    prompt: "Reply with the single word: OK",
    expectedTag: "responses",
    description:
      "Codex + claude-opus-4.8 → translate-down to chat (tag 'responses')",
  },
]

// ───────────────────────────── Mandate 2 (§7.3) ─────────────────────────────
// Subagents effective on every target model (short single-shot + long multi-turn).
const SUBAGENT_PROMPT =
  "Use the Explore subagent to find how many TypeScript files exist under the "
  + "tests/ directory, then report just the number. Keep it brief."

const mandate2: Array<MatrixCell> = [
  {
    id: "2a-opus",
    mandate: "2",
    client: "claude",
    model: "claude-opus-4.8",
    claudeOutputFormat: "stream-json",
    prompt: SUBAGENT_PROMPT,
    expectedTag: "anthropic-passthrough",
    description: "Subagent (short) on claude-opus-4.8 (passthrough)",
    extraAsserts: [multiTrace],
  },
  {
    id: "2a-gpt55",
    mandate: "2",
    client: "claude",
    model: "gpt-5.5",
    claudeOutputFormat: "stream-json",
    prompt: SUBAGENT_PROMPT,
    expectedTag: "anthropic-via-responses",
    description: "Subagent (short) on gpt-5.5 (bridge)",
    extraAsserts: [multiTrace],
  },
  {
    id: "2a-codex",
    mandate: "2",
    client: "claude",
    model: "gpt-5.3-codex",
    claudeOutputFormat: "stream-json",
    prompt: SUBAGENT_PROMPT,
    expectedTag: "anthropic-via-responses",
    description: "Subagent (short) on gpt-5.3-codex (bridge)",
    extraAsserts: [multiTrace],
  },
  {
    id: "2b-opus",
    mandate: "2",
    client: "claude",
    model: "claude-opus-4.8",
    claudeOutputFormat: "stream-json",
    prompt:
      "First, use the Explore subagent to count TypeScript files under tests/. "
      + "Then, based on that subagent's finding, tell me whether the count is even "
      + "or odd. Reference the number the subagent reported.",
    expectedTag: "anthropic-passthrough",
    description: "Subagent (long/multi-turn) on claude-opus-4.8 (passthrough)",
    extraAsserts: [multiTrace],
  },
  {
    id: "2b-gpt55",
    mandate: "2",
    client: "claude",
    model: "gpt-5.5",
    claudeOutputFormat: "stream-json",
    prompt:
      "First, use the Explore subagent to count TypeScript files under tests/. "
      + "Then, based on that subagent's finding, tell me whether the count is even "
      + "or odd. Reference the number the subagent reported.",
    expectedTag: "anthropic-via-responses",
    description:
      "Subagent (long/multi-turn) on gpt-5.5 (bridge — item-id/encrypted_content path)",
    extraAsserts: [multiTrace],
  },
]

// ───────────────────────────── Mandate 3 (§7.4) ─────────────────────────────
// CC Agent Team (--agents) + workflow/MCP (--mcp-config), on Claude AND GPT.
const AGENT_TEAM_PROMPT =
  "Ask the alpha agent and the beta agent each for their word, then reply with "
  + "both words separated by a space."

const MCP_PROMPT = "List the available MCP tools you can see, then reply DONE."

const AGENT_TEAM_MODELS: Array<{ model: string; tag: TraceTag; note: string }> =
  [
    {
      model: "claude-opus-4.8",
      tag: "anthropic-passthrough",
      note: "passthrough",
    },
    { model: "gpt-5.5", tag: "anthropic-via-responses", note: "bridge" },
    {
      model: "gpt-5.3-codex",
      tag: "anthropic-via-responses",
      note: "bridge",
    },
  ]

const mandate3: Array<MatrixCell> = [
  ...AGENT_TEAM_MODELS.map<MatrixCell>(({ model, tag, note }) => ({
    id: `3a-${model}`,
    mandate: "3",
    client: "claude",
    model,
    agentsJson: TWO_AGENTS_JSON,
    claudeOutputFormat: "stream-json",
    prompt: AGENT_TEAM_PROMPT,
    expectedTag: tag,
    description: `--agents multi-agent fan-out on ${model} (${note})`,
    extraAsserts: [multiTrace],
  })),
  ...AGENT_TEAM_MODELS.map<MatrixCell>(({ model, tag, note }) => ({
    id: `3b-${model}`,
    mandate: "3",
    client: "claude",
    model,
    mcpConfig: JSON.stringify({
      mcpServers: {
        codegraph: {
          type: "stdio",
          command: "codegraph",
          args: ["serve", "--mcp"],
        },
      },
    }),
    claudeOutputFormat: "stream-json",
    prompt: MCP_PROMPT,
    expectedTag: tag,
    description: `--mcp-config tool round-trip on ${model} (${note})`,
  })),
]

// ───────────────────────────── Mandate 4 (§7.5) ─────────────────────────────
const CODEX_TASK = "Reply with the single word: OK"

const mandate4: Array<MatrixCell> = [
  {
    id: "4a",
    mandate: "4",
    client: "codex",
    model: "gpt-5.3-codex",
    codexMode: "exec",
    prompt:
      "Create a file named ok.txt containing the text OK, then reply DONE.",
    expectedTag: "responses-passthrough",
    description: "codex exec (tool step) on gpt-5.3-codex",
    extraAsserts: [codexToolStep],
  },
  {
    id: "4b",
    mandate: "4",
    client: "codex",
    model: "gpt-5.5",
    codexMode: "exec",
    prompt: CODEX_TASK,
    expectedTag: "responses-passthrough",
    description: "codex exec on gpt-5.5",
  },
  {
    id: "4c",
    mandate: "4",
    client: "codex",
    model: "gpt-5.4",
    codexMode: "exec",
    prompt: CODEX_TASK,
    expectedTag: "responses-passthrough",
    description:
      "codex exec on gpt-5.4 (dual-endpoint canary → same-protocol /responses)",
  },
  {
    id: "4d",
    mandate: "4",
    client: "codex",
    model: "gpt-5.3-codex",
    codexMode: "review",
    prompt: "",
    expectedTag: "responses-passthrough",
    description: "codex exec review (headless) on gpt-5.3-codex",
  },
  {
    id: "4e",
    mandate: "4",
    client: "codex",
    model: "claude-opus-4.8",
    codexMode: "exec",
    prompt: CODEX_TASK,
    expectedTag: "responses",
    description: "codex exec on claude-opus-4.8 → translate-down path",
  },
]

export const MATRICES: Array<MatrixCell> = [
  ...mandate1,
  ...mandate2,
  ...mandate3,
  ...mandate4,
]

export const MANDATE_TITLES: Record<MatrixCell["mandate"], string> = {
  "1": "Mandate 1 — single-shot model mapping (§7.2)",
  "2": "Mandate 2 — subagents fully effective (§7.3)",
  "3": "Mandate 3 — CC Agent Team + workflow modes (§7.4)",
  "4": "Mandate 4 — Codex task/agent modes (§7.5)",
}
