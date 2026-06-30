# Universal CC + Codex ⇄ Copilot Proxy — Hardening Design

> Branch: `feat/universal-cc-codex-copilot` · Repo: `D:\Tools\copilot-api`
> Reference implementation studied: `D:\A_Projects\litellm` (`litellm/llms/github_copilot/*`,
> `litellm/llms/anthropic/experimental_pass_through/*`, `litellm/llms/base_llm/responses/transformation.py`)
> Date: 2026-06-21
> Status: **Design — awaiting approval.** Supersedes nothing; complements
> [`docs/universal-proxy/DESIGN.md`](../../universal-proxy/DESIGN.md) (the original ground-truth doc).

## 1. Goal & non-goals

**Goal.** The universal-proxy feature on `feat/universal-cc-codex-copilot` is *functionally* live-verified
(all four client→model paths work), but its **design is unreasonable** in specific, enumerated ways. Fix and
strengthen it without regressing the working paths. Backend stays Copilot-only — this is *client
universality*, not multi-vendor routing.

**Non-goals.**
- No new client or model families beyond what the branch already targets (Claude full series, `gpt-5.5`,
  `gpt-5.3-codex`, `gpt-5.4`).
- No attempt to "fix" cross-protocol reasoning loss — that is a proven structural limit (see
  `cross-protocol-reasoning-research.md`), not a defect.
- The deep hub-IR refactor (P2) is **opt-in** and gated on P1 landing green; it is not required to call this
  work done.

## 2. What is "unreasonable" today (diagnosis — all verified against code + fixture)

| # | Problem | Evidence | Severity |
|---|---|---|---|
| **①** | **Router distrusts its own catalog.** `endpoint-router.ts` carries `RESPONSES_ONLY_ID_PATTERNS = [/^gpt-5/i, /codex/i]` and a comment asserting "the enterprise backend currently returns no such array on any model." That premise is **false**: `cacheModels()` does `state.models = models` with no reshaping, and the live fixture carries `supported_endpoints` for **16/36** models — including every target. The regex is **dead code on a wrong premise**, and it **misroutes `gpt-5.4`** (a dual-endpoint model `["/responses","/chat/completions","ws:/responses"]`) by forcing `/responses` via `/^gpt-5/`. | `src/lib/endpoint-router.ts:18-26`; `src/lib/utils.ts cacheModels`; `fixtures/raw-copilot-catalog.enterprise.json` (16 models w/ `supported_endpoints`) | **High** — core correctness |
| **②** | **Model identity is rewritten in 3 uncoordinated places.** `.env MODEL_MAPPINGS` (`claude-opus-4-6→claude-opus-4.6`), then `translateModelName()` (`claude-opus-4-*→claude-opus-4`, a pre-dotted-id leftover now shadowed by ①), then the routing regex (③ overlaps ①). One model id, three rewrites. | `src/lib/model-mapping.ts`; `non-stream-translation.ts translateModelName`; `.env` | **High** — root of the "unreasonable" feel |
| **③** | **N×M translator mesh, no shared primitives.** `translateTools` reimplemented in 3 files, `deriveStopReason` in 2, tool_choice / content-part / stop-reason logic copy-pasted per direction across 6 modules. | `messages/responses-translation.ts`, `responses/non-stream-translation.ts`, `messages/non-stream-translation.ts`, stream variants | **Medium** |
| **④** | **Reasoning policy scattered + fragile.** `mapThinkingToReasoningEffort` (hardcoded budget thresholds), `clampReasoningEffort`, `adaptThinkingForCopilot` live in 3 files; the "max-by-ratio ≥0.95×max_tokens" heuristic is brittle. | `non-stream-translation.ts`, `endpoint-router.ts`, `create-messages.ts` | **Medium** |
| **⑤** | **Latent bugs + missing hardening litellm already has.** (a) `isFunctionCallOutput` tests `"call_id" in item` but `function_call` items also carry `call_id` → assistant tool-call misrouted as tool-result. (b) `chat-completions/handler.ts` never calls `modelSupportsEndpoint` → an OpenAI client asking a `/responses`-only model 400s. (c) DESIGN.md §P2 open items: empty `.done` events, missing tool-call `output_item.done`. (d) Not ported from litellm: stream **item-id stabilization** (Vercel-AI-SDK "part not found" crash), **`encrypted_content` reasoning continuity**, **64-char tool-name truncation**. | `responses/non-stream-translation.ts:74-77`; `chat-completions/handler.ts`; litellm `github_copilot/responses/transformation.py _normalize_stream_item_id`, `_handle_reasoning_item`; litellm `adapters/transformation.py truncate_tool_name` | **Medium-High** |

## 3. Architectural lessons borrowed from litellm

LiteLLM solves the same Anthropic ⇄ Chat ⇄ Responses problem against the same Copilot backend. Three
patterns we adopt (adapted to this smaller TS codebase — not a wholesale port):

1. **Catalog is the single source of truth for capability.** litellm gates `/responses` dispatch on
   `supported_endpoints` from model info (`github_copilot_supports_responses_api`), with mode overrides — never
   on a model-id regex. → **Directly fixes ①.**
2. **Identity normalization happens once, at the provider boundary.** `github_copilot/<catalog-id>` is the
   canonical key; friendly aliases resolve to it via the model registry. → **Directly fixes ②.**
3. **Per-endpoint hardening lives in one named method, documented with the failure it prevents.**
   `_normalize_stream_item_id`, `_handle_reasoning_item`, `truncate_tool_name` — each a single function with a
   docstring naming the exact client crash it avoids. → **The model for ⑤'s ports.**

The heavier litellm `BaseConfig.transform_request/response/streaming` abstraction (one config class per
provider/endpoint) is the inspiration for the **optional P2** hub-IR, not P1.

## 4. The two decided design rules

### Rule A — Model identity: normalize once, catalog is truth (fixes ②)

Collapse the three rewrites into **one resolver**, `resolveModelId(requested) → catalogId`, applied at each
handler entry immediately after reading the payload:

1. If `requested` exactly matches a `state.models[].id` → use as-is. *(So a client may also just send the
   real Copilot id, e.g. `claude-opus-4.8`, and it works with zero config — `.env` mapping becomes optional
   sugar, not a requirement.)*
2. Else if `MODEL_MAPPINGS` has it → map.
3. Else strip a trailing `[…]` suffix (e.g. `claude-opus-4-6[1m]`) and retry steps 1–2.
4. The result must be a catalog id; routing (Rule B) only ever reads `supported_endpoints` of a catalog id.

- **Delete** `translateModelName()` (dead, shadowed by `MODEL_MAPPINGS`, and produced non-catalog ids).
- **Startup validation:** warn for any `MODEL_MAPPINGS` target absent from the loaded catalog.

### Rule B — Endpoint routing: same-protocol first, catalog fallback (fixes ①, ⑤b, the `gpt-5.4` question)

The endpoint preference is **not** a global constant — it is a function of *which inbound handler* (= client
protocol) is calling, intersected with the model's catalog `supported_endpoints`. Each handler picks the
first egress in its ordered preference list that the model actually supports:

| Inbound handler (client) | Preference order (first supported wins) | Rationale |
|---|---|---|
| `/v1/responses` (**Codex**) | `/responses` → `/chat/completions` | same-protocol passthrough = lossless; else translate-down (the only cross-leg that already exists) |
| `/v1/messages` (**Claude Code**) | `/v1/messages` → `/responses` → `/chat/completions` | native messages lossless; else nearest existing cross-leg |
| `/v1/chat/completions` (**OpenAI**) | `/chat/completions` only, else clean 4xx | same-protocol lossless; reaching responses-only models from generic OpenAI clients is a non-goal (no ChatComp→Responses bridge in P1) |

Applied to `gpt-5.4` (`["/responses","/chat/completions","ws:/responses"]`): Codex→`/responses`,
CC→`/responses`, OpenAI→`/chat/completions`. Three clients, three fact-derived answers.

**No unbuilt translators implied.** Each preference list only names egress legs that already exist on the
branch (Responses-passthrough, Responses→Chat translate-down, Messages-passthrough, Messages→Responses
bridge). No catalog model is `/v1/messages`-only (every Claude model also advertises `/chat/completions`), so
the Codex list never needs a Responses→Messages leg, and none is built. The Chat handler deliberately stops at
same-protocol — a ChatCompletions→Responses bridge is out of scope (see non-goals) and is left as a possible
P2 follow-up.

- **Replace** `RESPONSES_ONLY_ID_PATTERNS` + `modelSupportsEndpoint`'s regex branch with a pure catalog read:
  `pickEgress(handlerKind, modelId)` returning the chosen endpoint (or a typed "unsupported" the handler maps
  to a clean 4xx, not a backend 400).
- **Narrowed safety fallback (kept, not regex):** only if a catalog entry has **no** `supported_endpoints`
  array at all (20/36 enterprise models — gpt-4o, gpt-4.1, gemini-2.5-pro, …), fall back to the
  `/chat/completions` translate-down path for **all** handlers, logged once. This is the true pre-branch
  default (both the messages and responses handlers fell through to translate-down when a model matched no
  native endpoint; the chat handler always used it). It is **not** same-protocol — routing gpt-4o to
  `/v1/messages` or `/responses` passthrough would 400. No id-pattern guessing.
- **Wire the Chat handler in** (⑤b): `chat-completions/handler.ts` joins the same `pickEgress` rule so a
  `/responses`-only model requested by an OpenAI client returns a **clean 4xx** (model not reachable via this
  protocol), not a raw backend 400.

## 5. Work breakdown

### P1 — Harden (the committed scope)

- **P1-A Catalog-truth routing (Rule B).** New `pickEgress(handlerKind, modelId)` in `endpoint-router.ts`;
  delete regex + false-premise comment. (`clampReasoningEffort` relocates to P1-D's reasoning module; the
  router keeps only endpoint selection.) Wire all three handlers. Unit tests:
  every target model × every handler asserts the chosen egress; `gpt-5.4` asserts per-handler divergence;
  no-`supported_endpoints` model asserts same-protocol fallback.
- **P1-B Single identity resolver (Rule A).** New `resolveModelId` (likely in `model-mapping.ts` or a small
  `lib/model-identity.ts`); delete `translateModelName`; add startup validation. Tests: exact-id passthrough,
  alias, `[1m]` suffix strip, unknown id.
- **P1-C Shared translation primitives (③).** New `src/routes/_shared/` (e.g. `tool-translation.ts`,
  `stop-reason.ts`, `content-parts.ts`). De-dupe the 3 `translateTools` / 2 `deriveStopReason` / tool_choice
  into shared, well-tested functions. **Behavior-preserving** — characterization tests captured *before*
  refactor (TDD).
- **P1-D Reasoning policy module (④).** Consolidate the 3 reasoning functions into
  `src/routes/_shared/reasoning-policy.ts` with one documented budget→effort table; `create-messages.ts` and
  both translators import from it. Behavior preserved; the ratio heuristic gets a named constant + test.
- **P1-E Bug fixes + litellm hardening ports (⑤).**
  - Fix `isFunctionCallOutput` to disambiguate `function_call` (assistant tool call) vs `function_call_output`
    (tool result) by `type`, not `"call_id" in item`.
  - Port **stream item-id stabilization** (litellm `_normalize_stream_item_id`) into the Responses stream
    paths.
  - Port **`encrypted_content` reasoning continuity** (litellm `_handle_reasoning_item`) so multi-turn
    `/responses` replay doesn't drop the encrypted blob.
  - Port **64-char tool-name truncation** (litellm `truncate_tool_name`) on the Messages→Responses and
    Messages→Chat tool paths.
  - Close DESIGN.md §P2 stream items (empty `.done`, missing tool-call `output_item.done`) — each with a
    regression test.
- **P1-F Headless acceptance harness (the "done" gate — see §7).** Build `tests/acceptance/` — a runner that
  drives real `claude -p` and `codex exec` against a worktree-code proxy instance and asserts on trace-path
  oracles + exit codes. This harness *is* the definition of done; no one declares "complete" by inspection.

### P2 — Refactor to hub-IR (opt-in, gated on all P1 green)

Introduce a minimal internal representation + a `transformRequest/transformResponse/transformStream` shape per
(protocol) inspired by litellm's `BaseResponsesAPIConfig`, collapsing the 6 ad-hoc translators into
hub-and-spoke. **Only attempted if P1 lands clean and review approves.** Documented as a follow-up otherwise.

## 6. Agent Team (named, persistent — not fire-and-forget subagents)

This runs as a **standing team of named teammates**, not one-shot parallel subagents. Each teammate is spawned
once, addressed by name via SendMessage, kept alive across the phase, and coordinated through the shared
TaskList. **I am the lead/integrator:** I own the shared-file seams, assign and unblock tasks, run the
adversarial review, and am the only one permitted to mark a task complete (gated on §7 evidence). The team is
sized so each member owns a **disjoint file set** — the org chart enforces the no-collision rule instead of
hoping parallel writers don't clash.

### Roster

| Teammate | Owns (writable) | Responsible for |
|---|---|---|
| **@recon** | nothing (read-only) | Phase 0: extract exact litellm logic for the three ⑤ ports as TS-ready notes; formalize the catalog ground-truth evidence note. Disbands after handing notes to the leads. |
| **@routing-eng** | `src/lib/endpoint-router.ts`, `src/lib/model-mapping.ts`, `src/lib/model-identity.ts` (new) | P1-A routing + P1-B identity + P1-D reasoning-policy module. Serial within this member. |
| **@translation-eng** | `src/routes/_shared/**` (new), the 6 translator modules, `create-messages.ts`/`create-responses.ts` | P1-C shared primitives (characterization tests FIRST) + P1-E bug fixes & litellm ports. Serial within this member. |
| **@accept-eng** | `tests/acceptance/**` (new) | P1-F: build the headless runner (trace-tag oracle, `claude -p` + `codex exec` drivers, RESULTS writer). Can build against the spec while engineers code — depends only on trace tags + CLI flags, both already pinned. |
| **@reviewer** | nothing (read-only) | Phase 1.5: adversarially refute each landed fix; specifically hunt behavior drift from P1-C/P1-D de-dup. Findings file as tasks that block completion. |

Disjoint ownership means **@routing-eng and @translation-eng run truly in parallel** (no shared file), and
**@accept-eng runs alongside them** (new dir). The only cross-member seam is each handler file
(`messages/handler.ts`, `responses/handler.ts`, `chat-completions/handler.ts`) — those call *both* the routing
and translation modules, so **I (lead) make the handler wiring edits** once both engineers' modules land, not
either engineer unilaterally.

### Phase flow (coordination, not just parallelism)

- **Phase 0 — Recon.** `@recon` produces the litellm-port notes + evidence note. Gates Phase 1 (engineers
  consume the notes). `@accept-eng` may start the runner skeleton now (CLI/oracle are known).
- **Phase 1 — Implement.** `@routing-eng` ∥ `@translation-eng` ∥ `@accept-eng`, each on its own files, each
  doing TDD (tests before/with code). Progress + blockers flow through TaskList; I unblock and answer design
  questions via SendMessage. As each module stabilizes, **I wire the handlers** to it.
- **Phase 1.5 — Adversarial review.** `@reviewer` refutes; drift/bugs become blocking tasks routed back to the
  owning engineer. Loop until clean.
- **Phase 2 — Verify (gate).** Deterministic pre-gate (unit/tsc/lint), then `@accept-eng` runs the **headless
  acceptance suite (§7)** on `:4143`. I declare completion ONLY from a green `RESULTS-<date>.md`.
- **Phase 2 — Verify (gate).** Unit + `tsc` + lint first; then the **headless acceptance suite (§7)** — the
  only thing permitted to declare "complete." Driven by real `claude -p` / `codex exec`, judged by trace-tag
  oracles.

## 7. Verification — headless acceptance suite (the ONLY thing that may declare "complete")

> **Hard rule (user-mandated).** "Complete" may NEVER be asserted by inspection, reasoning, or "it should
> work." It is earned ONLY by the acceptance suite below passing end-to-end. Each row runs a **real client in
> headless mode** (`claude -p` / `codex exec`) against a proxy serving **worktree (fixed) code**, and is judged
> by a **machine oracle**, not by eyeballing the answer. Any red cell ⇒ not complete.

### 7.0 Test rig

- **Proxy under test:** a fresh instance on **:4143** started from the worktree (`D:\Tools\copilot-api-feat`),
  so it serves the *fixed* code — `:4141` (live CC session) and `:4142` (existing test instance, *old* code)
  are left untouched. Started with `--trace` so every request writes a trace file.
- **The oracle = trace path tag.** The proxy tags each trace with the egress it took
  (`anthropic-passthrough`, `anthropic-via-responses`, `responses-passthrough`, `responses` [=translate-down],
  `chat`). The runner asserts the **tag**, not just that text returned — this is what proves *routing*
  correctness rather than merely "a reply arrived." Plus: process **exit code 0**, non-empty final message, and
  **no** `unsupported_api_for_model` / raw 400 in output.
- **Clients & how they're pointed at the proxy:**
  - **Claude Code:** `ANTHROPIC_BASE_URL=http://localhost:4143 ANTHROPIC_AUTH_TOKEN=dummy claude -p "<prompt>"
    --model <id> --output-format stream-json` (+ `--agents` / `--mcp-config` for the agent-team rows).
  - **Codex:** `codex exec -m <id> -c model_providers.copilot.base_url=http://localhost:4143/v1
    -c model_providers.copilot.wire_api=responses -c model_provider=copilot --json --skip-git-repo-check
    -o <lastmsg-file> "<prompt>"` (a throwaway `--profile`/config for the proxy provider; auth token dummy).
- **Quota:** small volume, one assertion per cell, premium-aware. Prompts are trivial ("reply OK", "what is
  13×17") to minimize tokens; tool-call rows use a single cheap tool.

### 7.1 Deterministic pre-gate (must pass before any live row)
- `bun test` (unit suite + new P1-A…E tests) green · `bunx tsc --noEmit` clean · `bun run lint` clean.

### 7.2 Mandate 1 — single-shot model mapping (Claude series + GPT-5.5 + GPT-5.3-codex)
One headless sentence per model; assert it resolves + routes correctly. Covers the identity resolver (Rule A)
and per-handler routing (Rule B) on the simplest path.

| # | Client | Model id sent | Expected trace tag | Also assert |
|---|---|---|---|---|
| 1a | `claude -p` | `claude-opus-4.8` | `anthropic-passthrough` | exit 0, non-empty |
| 1b | `claude -p` | `claude-opus-4-8[1m]` (suffix) | `anthropic-passthrough`, resolved→`claude-opus-4.8` | suffix-strip works |
| 1c | `claude -p` | `claude-sonnet-4.6` | `anthropic-passthrough` | |
| 1d | `claude -p` | `gpt-5.5` | `anthropic-via-responses` | Messages→Responses bridge |
| 1e | `claude -p` | `gpt-5.3-codex` | `anthropic-via-responses` | effort clamped ≤`xhigh` in trace |
| 1f | `codex exec` | `gpt-5.5` | `responses-passthrough` | native, no `unsupported_api_for_model` |
| 1g | `codex exec` | `gpt-5.3-codex` | `responses-passthrough` | |
| 1h | `codex exec` | `claude-opus-4.8` | `responses`→translate-down to chat | translate path intact |

### 7.3 Mandate 2 — subagents fully effective (short + long session)
Claude Code subagents must work on **every** target model.
- **2a Short:** `claude -p "Use the Explore subagent to find <X>; report back" --model gpt-5.5` (and a repeat
  with `claude-opus-4.8`, `gpt-5.3-codex`). Oracle: a subagent trace appears (a distinct
  `X-Initiator: agent`-tagged request in traces) **and** parent exit 0 with a synthesized answer.
- **2b Long/multi-turn:** a scripted `--output-format stream-json` session that spawns a subagent, then asks a
  follow-up that depends on the subagent's result (≥3 turns). Oracle: multiple agent-tagged traces across
  turns, final answer references the subagent finding, no mid-stream error frame. Run on `claude-opus-4.8`
  (passthrough) **and** `gpt-5.5` (bridge) — the bridge path is the risky one (item-id/encrypted_content ports).

### 7.4 Mandate 3 — CC Agent Team + workflow modes, full series
The orchestration features must work however invoked, on Claude **and** GPT models.
- **3a `--agents` multi-agent:** define 2 custom agents via `--agents '{...}'`, prompt a task that fans out to
  both. Run with `--model claude-opus-4.8`, `--model gpt-5.5`, `--model gpt-5.3-codex`. Oracle: ≥2 distinct
  agent-tagged trace clusters, exit 0, combined answer.
- **3b Workflow / tool-heavy:** a `--mcp-config` run exercising MCP tool calls through the proxy (tool_use ⇄
  tool_result round-trip), on the same three models. Oracle: trace shows tool_use blocks *and* matching
  tool_result continuation (this is exactly what the `isFunctionCallOutput` fix + tool-name truncation guard);
  exit 0.
- Each model × {3a, 3b} is a cell; all must be green.

### 7.5 Mandate 4 — Codex task/agent modes (exec + review)
Codex's non-interactive surfaces, which we enumerated from `codex --help`: **`exec`** (agent) and
**`exec review` / `review`** (review). Both must work through the proxy on the GPT models (and Claude via
translate-down).

| # | Codex mode | Model | Oracle |
|---|---|---|---|
| 4a | `codex exec "<task>"` | `gpt-5.3-codex` | `responses-passthrough`, exit 0, `-o` last-message non-empty, a tool/command step occurred |
| 4b | `codex exec "<task>"` | `gpt-5.5` | `responses-passthrough`, exit 0 |
| 4c | `codex exec "<task>"` | `gpt-5.4` | `responses-passthrough` (dual-endpoint canary → same-protocol) |
| 4d | `codex exec review` (or `codex review`) | `gpt-5.3-codex` | review runs headless, `responses-passthrough`, exit 0, non-empty review |
| 4e | `codex exec "<task>"` | `claude-opus-4.8` | translate-down path, exit 0 (Codex→Claude still works) |

> Codex modes beyond exec/review (e.g. `cloud`, `mcp-server`) are out of scope — they don't exercise the
> proxy's chat/responses egress. If a `codex exec` row needs a tool step to be meaningful, a trivial repo task
> ("create a file `ok.txt` containing OK") is used under `--sandbox workspace-write`.

### 7.6 Result recording
The runner writes `tests/acceptance/RESULTS-<date>.md`: one row per cell with PASS/FAIL, the asserted vs actual
trace tag, exit code, and the trace file path as evidence. **Completion is declared only when every cell in
7.1–7.5 is PASS in that file** — the report is the artifact, not a verbal claim.

## 8. Risks & mitigations

- **De-dup changes behavior (③/④).** → Characterization tests captured before refactor; Phase 1.5 explicitly
  hunts behavior drift; §7.2–7.5 re-prove behavior end-to-end through the real clients.
- **`encrypted_content`/item-id ports are subtle.** → Port with litellm's docstring rationale verbatim as
  comments; cover with the multi-turn rows (§7.3 long session on `gpt-5.5`, §7.5 Codex tool-call turns).
- **Trace-tag oracle depends on `--trace` being on and tags being stable.** → P1 must keep the existing trace
  `type` tags (they're load-bearing for acceptance); a tag rename requires updating the runner in lockstep.
- **Codex→proxy provider wiring is non-trivial** (`model_providers.*` + `wire_api=responses` + auth). → The
  harness pins an explicit throwaway config via `-c` overrides (§7.0) so it's reproducible and doesn't mutate
  `~/.codex/config.toml`; a `codex doctor` smoke precedes the matrix.
- **Live quota burn.** → Trivial prompts, one assertion per cell, dedicated `:4143` instance only.
- **Port contention.** → Acceptance uses **:4143** (fixed-code), distinct from `:4141` (live session) and
  `:4142` (old-code test instance), so nothing collides and the live session is never touched.
- **Shared-file collisions in the team.** → Main-thread integration of overlapping seams; tracks own disjoint
  files.

## 9. Definition of done

**Binding definition (user-mandated):** the work is "complete" if and only if
`tests/acceptance/RESULTS-<date>.md` shows **PASS for every cell in §7.1–§7.5** — produced by real headless
`claude -p` / `codex exec` runs against the `:4143` fixed-code proxy, judged by trace-tag oracles. No verbal,
inspected, or inferred completion claim is permitted. A red or skipped cell ⇒ not done; either fix it or get
explicit user sign-off to accept it. P2 (hub-IR) is separately either landed-green under the same suite or
documented as a follow-up. Branch integration (merge/PR) is decided separately after the suite is green.
