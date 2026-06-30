# Universal CC + Codex ⇄ Copilot Proxy — Design & Ground Truth

> Branch: `feat/universal-cc-codex-copilot`
> Goal: **Claude Code CLI** and **Codex CLI** both reach **claude full series + gpt-5.3-codex + gpt-5.5**
> through the existing single-backend (GitHub Copilot) proxy, with **all reasoning/thinking levels** working.
> Backend stays Copilot-only. This is *client universality*, not multi-vendor routing.

Status: **All four client→model paths implemented & live-verified (2026-06-18).** The universal proxy goal is met.
- **P0**: `/responses`-only models (`gpt-5.3-codex`, `gpt-5.5`) reachable for the **Codex** `/v1/responses` client via native passthrough.
- **Phase A**: **Claude Code → Claude** uses native `/v1/messages` passthrough — **lossless** (thinking blocks, `signature_delta`, `cache_creation` survive), replacing the old lossy Messages→ChatCompletions→Messages round-trip.
- **Phase B**: **Claude Code → gpt-5.5 / gpt-5.3-codex** via a Messages⇄Responses bridge (lossy, cross-protocol; effort mapped + per-model clamped so codex never gets `max`).

Everything below is **captured from the live enterprise account via the VS Code token bridge
on 2026-06-18**, not guessed. Raw evidence: [`fixtures/raw-copilot-catalog.enterprise.json`](../../fixtures/raw-copilot-catalog.enterprise.json).

---

## Fidelity matrix (lossless vs lossy, per path)

"Lossless" is achievable only by **passthrough** (no translation), which requires **client protocol ==
model's native protocol**. Cross-protocol paths are structurally lossy — confirmed against LiteLLM's
passthrough-vs-unified split and Anthropic's own OpenAI-compat limitations table.

| Client → Model | Protocols | Fidelity | Mechanism | Known loss |
|---|---|---|---|---|
| **Codex → GPT** (5.5 / 5.3-codex / 5.4) | Responses→Responses | ✅ **lossless** | native `/responses` passthrough (P0) | none |
| **CC → Claude** (full series) | Messages→Messages | ✅ **lossless** | native `/v1/messages` passthrough (Phase A) | none¹ |
| **CC → GPT** (5.5 / 5.3-codex) | Messages→Responses | ⚠️ **lossy** | translate bridge (Phase B) | reasoning original text²; cache_control; `strict` tools; `top_k` |
| **Codex → Claude** | Responses→Messages | ⚠️ **lossy** | existing translate-down | reasoning original text²; cache_control |

¹ One request-side adaptation, **not** a loss: Copilot's native `/v1/messages` rejects Anthropic's standard
`thinking:{type:"enabled",budget_tokens}` and requires `{type:"adaptive"}` + `output_config.effort`. The
egress maps that one field (budget→clamped effort); the response is forwarded untouched.
² **Structural, not a proxy defect:** reasoning original text is **never** exposed by the backend — it returns
`{content:[], id:"<encrypted>"}` (verified in traces). OpenAI/Anthropic only round-trip it as opaque
`encrypted_content` **within the same protocol**, so any cross-protocol translation necessarily drops it.
Substantiated by two adversarially-verified research rounds (45 sources, zero counterexamples) + live
byte-level probes against the real backend — see [`cross-protocol-reasoning-research.md`](./cross-protocol-reasoning-research.md).

---

## 0. The decisive discovery: `supported_endpoints` per model

The **raw** Copilot `/models` catalog (what `getModels()` returns, *before* `routes/models/route.ts` reshapes it)
carries a `supported_endpoints` array per model. The current `/models` route **strips this away** — that is the
first thing to fix. Captured values for the target models:

| Model | `supported_endpoints` | `reasoning_effort` levels |
|---|---|---|
| `claude-opus-4.8` | `["/v1/messages", "/chat/completions"]` | low, medium, high, xhigh, **max** |
| `claude-opus-4.7` | `["/v1/messages", "/chat/completions"]` | low, medium, high, xhigh, max |
| `claude-opus-4.6` | `["/v1/messages", "/chat/completions"]` | low, medium, high, max |
| `claude-sonnet-4.6` | `["/chat/completions", "/v1/messages"]` | low, medium, high, max |
| `claude-sonnet-4.5`, `claude-opus-4.5`, `claude-haiku-4.5` | `["/chat/completions", "/v1/messages"]` | *(none — no reasoning)* |
| **`gpt-5.3-codex`** | **`["/responses", "ws:/responses"]`** | low, medium, high, **xhigh** *(NO max)* |
| **`gpt-5.5`** | **`["/responses", "ws:/responses"]`** | none, low, medium, high, xhigh |
| `gpt-5.4` | `["/responses", "/chat/completions", "ws:/responses"]` | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | `["/responses", "ws:/responses"]` | none, low, medium, high, xhigh |
| `gpt-5-mini` | `["/chat/completions", "/responses", "ws:/responses"]` | low, medium, high |
| `mai-code-1-flash-internal` | `["/responses"]` | low, medium, high |

### Consequences (all proven, none guessed)

1. **`gpt-5.3-codex` and `gpt-5.5` are `/responses`-ONLY.** They have **no** `/chat/completions` endpoint.
   The current proxy translates *every* surface down to `/chat/completions`, so today these two models are
   **completely unreachable** — they 400 with `unsupported_api_for_model`. This is THE core gap.
2. **`gpt-5.4` accepts BOTH** `/responses` and `/chat/completions` → it is the ideal **A/B canary** for tests.
3. **Every Claude model natively advertises `/v1/messages`.** Copilot has a *native Anthropic endpoint*.
   CC→Claude can become a near-lossless **passthrough** instead of the current lossy
   Anthropic→ChatCompletions→Anthropic round-trip. (Opportunity, not required for P0.)
4. **`reasoning_effort` sets are per-model and differ.** codex tops out at `xhigh` (no `max`); gpt-5.4/5.5 add
   `none`; opus-4.8 has full `max`. "All thinking levels" MUST be **clamped per-model from the catalog** —
   hardcoding `max` for everything would 400 on codex. There is also `adaptive_thinking` + `min/max_thinking_budget`
   (1024..32000) on Claude models for the budget→effort mapping.

---

## 1. Target capability matrix (the deliverable)

| Client → Model | claude full series | gpt-5.5 | gpt-5.3-codex |
|---|---|---|---|
| **Claude Code** (`/v1/messages` in) | ✅ exists (translate) / 🔭 passthrough opportunity | 🔧 Messages→Responses (NEW) | 🔧 Messages→Responses (NEW) |
| **Codex** (`/v1/responses` in) | ✅ exists (translate-down) | 🔧 native `/responses` passthrough (NEW) | 🔧 native `/responses` passthrough (NEW) |

User decision (2026-06-18): **CC + Codex full cross-product** — both clients must reach all three model groups.
gpt-5.5 + gpt-5.3-codex fully mapped for both clients.

Verification decision: **live smoke tests, small volume** via the VS Code bridge (premium quota aware).

---

## 2. Architecture: where the new seam goes

```
                          ┌────────────────────── copilot-api ──────────────────────┐
 Claude Code ──/v1/messages──▶ messages/handler ──┐                                  │
 Codex ────────/v1/responses──▶ responses/handler ─┤                                 │
 (others) ─────/v1/chat/comp──▶ chat/handler ──────┤                                 │
                                                    ▼                                 │
                                       ┌── endpoint router (NEW) ──┐                  │
                                       │ pick by model's           │                  │
                                       │ supported_endpoints       │                  │
                                       └─────┬───────────────┬─────┘                  │
                                  /chat/completions      /responses (NEW egress)      │
                                             │                  │                      │
                                   createChatCompletions   createResponses (NEW)       │
                                             └──────┬───────────┘                      │
                                              copilotFetch  (UNCHANGED chokepoint)     │
                                                    ▼                                  │
                              api.{tier}.githubcopilot.com  (single backend)           │
                          └──────────────────────────────────────────────────────────┘
```

**Key insight:** the egress chokepoint (`copilotFetch`) and auth/state stay untouched — we add a *second*
egress verb (`createResponses` → `copilotFetch("/responses")`) and a *router* that picks the verb by the
model's `supported_endpoints`. Everything else is inbound translation, the proven additive pattern.

---

## 3. Work breakdown (Phase 1+, NOT yet done)

### P0 — core gap: reach the `/responses`-only models  ✅ DONE (live-verified 2026-06-18)
- **P0.1 ✅** Expose `supported_endpoints` + `capabilities.supports.reasoning_effort` through `getModels()`
  typing (`services/copilot/get-models.ts`) and surface `supported_endpoints` in `routes/models/route.ts`.
- **P0.2 ✅** `services/copilot/create-responses.ts` — native `POST /responses` egress through the existing
  `copilotFetch` chokepoint (keeps 401-retry). Streaming + non-streaming.
- **P0.3 ✅** Endpoint router `lib/endpoint-router.ts` — `modelSupportsEndpoint(model, "/responses")` reads the
  catalog from `state.models`.
- **P0.4 ✅** Codex `/v1/responses` handler: passthrough (no translate) when the target model is
  `/responses`-native; else the existing translate-down path (unchanged). Unlocks **Codex → gpt-5.3-codex /
  gpt-5.5 / gpt-5.4**. Unit tests: `tests/endpoint-router.test.ts`, `tests/create-responses.test.ts`.

### P1 — Claude Code → codex/gpt-5.5 (the hard cross)
- **P1.1** `Anthropic Messages → Responses` request translator (+ Responses→Anthropic response/stream).
  This is the new lossy bridge (codex reasoning items ↔ Anthropic thinking). Unlocks **CC → gpt-5.3-codex / gpt-5.5**.
- **P1.2** Per-model `reasoning_effort` clamp from catalog (the budget/effort mapper must read the model's
  allowed set; never send `max` to codex).

### P2 — fidelity / cleanups (from prior audit, optional but verified-needed)
- Responses streaming: emit `response.output_item.done` (Codex reads tool calls from it); stop emitting empty
  `.done` text/args; map `reasoning.effort`→`reasoning_effort`; fix `isFunctionCallOutput` call_id misroute.
- Wire the existing mid-stream error helpers into the SSE loops.

### Verification (live, small volume, port 4142)
Run a *separate* instance on **:4142** (`:4141` powers the active CC session — read-only there).
Matrix to smoke-test end-to-end through the real backend:

| Client | Model | Assert |
|---|---|---|
| Codex | gpt-5.3-codex | native /responses, stream + tool call works, no `unsupported_api_for_model` |
| Codex | gpt-5.5 | native /responses |
| Codex | gpt-5.4 | **both** paths (canary) |
| Codex | claude-opus-4.8 | translate-down still works |
| CC | claude-opus-4.8 | unchanged, all effort levels |
| CC | gpt-5.5 | Messages→Responses bridge |
| CC | gpt-5.3-codex | Messages→Responses bridge, effort clamped to xhigh |

---

## 4. Open items needing capture before P0.2/P1.1 (no-guess rule)
- [x] **Raw Codex `/responses` request wire shape** — captured 2026-06-18 via the passthrough trace on :4142
      (`responses-passthrough` `.req`/`.resp` pairs, incl. a streaming tool-call response). Note: these were
      driven by `curl`, not the real Codex CLI — a genuine Codex-CLI capture is still ideal for P1.1 fidelity.
- [ ] **What `ws:/responses` implies** — websocket variant; plain `POST /responses` proven sufficient for
      non-streaming **and** SSE streaming this session. `ws:` not needed for current clients.

---

## 5. Evidence index
- `fixtures/raw-copilot-catalog.enterprise.json` — full raw 36-model catalog, enterprise tier, 2026-06-18.
- Live capture method: `tryVscodeProxyToken()` + `getModels()` with `http_proxy=localhost:10808`.
- `reasoning_effort` per-model sets, `supported_endpoints` per-model: see §0 table (all from the fixture).
