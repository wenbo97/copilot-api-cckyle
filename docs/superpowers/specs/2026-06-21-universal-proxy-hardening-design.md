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
  array at all, fall back to that handler's same-protocol endpoint (the previous default behavior), logged
  once. No id-pattern guessing.
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

### P2 — Refactor to hub-IR (opt-in, gated on all P1 green)

Introduce a minimal internal representation + a `transformRequest/transformResponse/transformStream` shape per
(protocol) inspired by litellm's `BaseResponsesAPIConfig`, collapsing the 6 ad-hoc translators into
hub-and-spoke. **Only attempted if P1 lands clean and review approves.** Documented as a follow-up otherwise.

## 6. Agent Team topology

Phased pipeline: **fan out on reads, serialize on shared-file writes.** The hard constraint: P1-A & P1-D both
touch `endpoint-router.ts`; P1-C & P1-E both touch the translation files. Naive "one agent per fix in
parallel" collides.

- **Phase 0 — Recon (parallel, read-only subagents).**
  - *litellm pattern-extractor*: extract exact litellm logic for the three ⑤ ports (item-id, encrypted_content,
    tool-name) as TS-ready pseudocode.
  - *catalog ground-truth diagnostician*: already largely done in this session (field present, regex dead) —
    formalize as a one-page evidence note the implementers consume.
  - Independent inputs → genuine parallel.
- **Phase 1 — Implement (two serial tracks, parallel to each other).**
  - *Track Routing+Identity* (owns `endpoint-router.ts`, `model-mapping.ts`): P1-A → P1-B → P1-D, serial.
  - *Track Translation* (owns translators + `_shared/`): P1-C (characterization tests first) → P1-E, serial.
  - Independent new modules (tool-name truncation util) fan out freely.
  - **Shared-file edits executed in the main thread** (most reliable for overlapping seams) rather than
    worktree-merge reconciliation; subagents draft, main thread integrates.
- **Phase 1.5 — Adversarial review.** A reviewer subagent refutes each fix: correctness, and specifically "did
  any P1-C/P1-D de-dup change observable behavior?" Findings block acceptance until resolved.
- **Phase 2 — Verify (gate).** Unit + `tsc` + lint first; then the live smoke matrix (§7).

## 7. Verification

### Deterministic (fast loop, must pass before live)
- `bun test` (existing suite + new tests from P1-A…E green).
- `bunx tsc --noEmit` clean.
- `bun run lint` clean.

### Live smoke matrix (final gate, user-chosen) — separate instance on **:4142**, small volume
`:4141` powers the active CC session (read-only there). Run a second instance on `:4142` via the VS Code
bridge, premium-quota-aware.

| Client | Model | Assert |
|---|---|---|
| Codex | `gpt-5.3-codex` | native `/responses`, stream + tool call, no `unsupported_api_for_model` |
| Codex | `gpt-5.5` | native `/responses` |
| Codex | `gpt-5.4` | resolves to `/responses` (canary: dual-endpoint, same-protocol) |
| Codex | `claude-opus-4.8` | translate-down still works |
| CC | `claude-opus-4.8` | unchanged, all effort levels, thinking lossless |
| CC | `gpt-5.5` | Messages→Responses bridge |
| CC | `gpt-5.3-codex` | Messages→Responses bridge, effort clamped to `xhigh` (never `max`) |
| CC | `gpt-5.4` | resolves to `/responses` (CC canary) |
| OpenAI client | `gpt-5.4` | resolves to `/chat/completions` (same-protocol) |
| OpenAI client | `gpt-5.5` | `/responses`-only → **clean 4xx** (out of scope to bridge), **not** raw backend 400 |

## 8. Risks & mitigations

- **De-dup changes behavior (③/④).** → Characterization tests captured before refactor; Phase 1.5 explicitly
  hunts behavior drift.
- **`encrypted_content`/item-id ports are subtle.** → Port with litellm's docstring rationale verbatim as
  comments; cover with the live multi-turn `/responses` smoke (Codex gpt-5.3-codex tool-call turn).
- **Live quota burn.** → Small volume, one assertion per cell, `:4142` only.
- **Shared-file collisions in the team.** → Main-thread integration of overlapping seams; tracks own disjoint
  files.

## 9. Definition of done

All P1 items implemented; deterministic gate green; live smoke matrix green (or any red cell explained and
accepted by the user). P2 either landed-green or documented as a follow-up. Branch ready for the user's chosen
integration (merge/PR — decided separately).
