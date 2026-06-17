# Universal CC + Codex ⇄ Copilot Proxy — Design & Ground Truth

> Branch: `feat/universal-cc-codex-copilot`
> Goal: **Claude Code CLI** and **Codex CLI** both reach **claude full series + gpt-5.3-codex + gpt-5.5**
> through the existing single-backend (GitHub Copilot) proxy, with **all reasoning/thinking levels** working.
> Backend stays Copilot-only. This is *client universality*, not multi-vendor routing.

Status: **Phase 0 (ground truth) complete.** No code changes yet. Implementation pending (Phase 1+).
Everything below is **captured from the live enterprise account via the VS Code token bridge on 2026-06-18**,
not guessed. Raw evidence: [`fixtures/raw-copilot-catalog.enterprise.json`](../../fixtures/raw-copilot-catalog.enterprise.json).

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

### P0 — core gap: reach the `/responses`-only models
- **P0.1** Expose `supported_endpoints` + `capabilities` through `getModels()` typing and stop stripping it in
  `routes/models/route.ts`. (Foundation for routing.)
- **P0.2** `services/copilot/create-responses.ts` — native `POST /responses` egress via `copilotFetch`
  (streaming + non-streaming). Body forwarded in Responses shape. Ref pattern: ericc-ch/copilot-api PR #219
  (needs re-capture — `gh`/web blocked this session).
- **P0.3** Endpoint router: given a (model) decide `/responses` vs `/chat/completions` from the catalog.
- **P0.4** Codex `/v1/responses` handler: when target model is `/responses`-native → **passthrough** (no
  translate-down); else keep the existing translate-to-chat path. Unlocks **Codex → gpt-5.3-codex / gpt-5.5**.

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
- [ ] **Raw Codex `/responses` request wire shape** — local traces are 100% `anthropic` (Claude Code); zero
      Codex captures exist. Capture by pointing Codex CLI at `:4142` with `--trace`, OR re-fetch PR #219.
- [ ] **PR #219 exact native-forward code** — `gh` unauthenticated + WebFetch blocked this session; retry with
      `gh auth login` or `GH_TOKEN`.
- [ ] **What `ws:/responses` implies** — websocket variant; confirm the plain `POST /responses` is sufficient.

---

## 5. Evidence index
- `fixtures/raw-copilot-catalog.enterprise.json` — full raw 36-model catalog, enterprise tier, 2026-06-18.
- Live capture method: `tryVscodeProxyToken()` + `getModels()` with `http_proxy=localhost:10808`.
- `reasoning_effort` per-model sets, `supported_endpoints` per-model: see §0 table (all from the fixture).
