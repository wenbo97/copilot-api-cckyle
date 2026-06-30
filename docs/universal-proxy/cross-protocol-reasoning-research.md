# Cross-Protocol Reasoning Continuity — Research & Live Evidence

> Companion to [`DESIGN.md`](./DESIGN.md). Captures **why the two cross-protocol paths in the fidelity
> matrix are structurally lossy** for reasoning/thinking, backed by two adversarially-verified deep-research
> rounds (45 sources) **and** live byte-level probes against the real enterprise Copilot backend (2026-06-18).
>
> **One-line verdict:** No LLM proxy or gateway preserves **encrypted/signed reasoning across a protocol
> boundary** — it is a structural physical limit, not a proxy defect. Continuity is achievable only via
> **same-protocol passthrough** or **provider server-side state**. The only reasoning that *can* cross
> protocols is **plaintext** reasoning, which by definition abandons the encrypted representation — and the
> Copilot backend never exposes plaintext (verified below), so even that downgrade does not apply here.

---

## 1. Question & scope

When a proxy translates between **Anthropic Messages** (CC, signature-signed `thinking` blocks) and
**OpenAI Chat Completions / Responses** (Codex, encrypted `reasoning` items / `encrypted_content`), is the
model's prior-turn reasoning **preserved or dropped** across multi-turn conversations? How do high-profile
gateways handle it, and is there any real solution — or is it a hard limit?

## 2. Methodology

| | Round 1 | Round 2 (gap-closing) | Live probes |
|---|---|---|---|
| Method | deep-research fan-out, adversarial 2/3-vote verify | targeted blind-spot closure (no re-confirmation) | direct curl against real backend on :4142 |
| Sources | 25 primary vendor docs | 20 (gateways, bridges, incident reports, repo code) | our own enterprise traces |
| Claims | 119 extracted → 25 verified → **24 confirmed, 1 killed** | 88 → 25 → **19 confirmed, 6 killed** | 4 probes |
| Agents / tokens | 108 / 5.5M | 102 / 4.3M | — |

The **1 killed (R1)** and **6 killed (R2)** claims are retained below under §8 (intellectual honesty — we do
not silently drop refuted material).

## 3. Verdict (fidelity conclusion)

**Holds, and strengthened across both rounds + live probes — zero counterexamples surfaced.**
Every gateway examined either (a) carries signed/encrypted reasoning **same-protocol only**, (b) **drops it
structurally**, or (c) **fabricates a fake/empty signature**. This independently validates the DESIGN.md
fidelity matrix: lossless only same-protocol.

## 4. Root cause — TWO causes, not one

1. **Cryptographic opacity.** OpenAI `encrypted_content` is decryptable only by the originating **key/org**
   (cross-org replay → `Encrypted content organization_id did not match`). Anthropic `thinking` is encrypted
   inside a tamper-evident `signature` decryptable only by Anthropic's server; if you **include** a thinking
   block you must pass it **unchanged** (modifying it → HTTP 400).
2. **Missing target field.** Even unencrypted, the OpenAI **Chat Completions** spec has **no field** to carry
   Anthropic `thinking_blocks`. LiteLLM names this as the root cause; OpenAI-compat downstreams silently
   discard them, and the next Anthropic turn 400s ("assistant message doesn't start with a thinking block").

A blob that cannot move between two deployments of the **same** protocol *a fortiori* cannot survive
**cross**-protocol translation.

## 5. How each gateway actually handles it

| Gateway / bridge | Cross-protocol reasoning behavior | Verdict | Source |
|---|---|---|---|
| **OpenAI Responses** | `previous_response_id`+`store=true` (server state) **or** `encrypted_content` replay — both same-protocol, same-key | continuity = same-protocol only | developers.openai.com/api/docs/guides/reasoning; cookbook reasoning_items |
| **Anthropic** | `signature` carries encrypted full thinking; include→pass unchanged, else 400; may **omit** prior blocks | drop-only legal; transform illegal | platform.claude.com/.../extended-thinking |
| **LiteLLM** | Anthropic→OpenAI flattens `thinking` → plaintext `output_text` — **filed as a BUG (#26916)**; affinity-routing pins encrypted items to origin deployment | structural loss; plaintext leak = defect | litellm #26916; encrypted-content-incident blog |
| **OpenRouter** | `reasoning_details[]` (format-tagged) — **"pass back UNMODIFIED to the same origin backend"** = replay, not transcoding | same-backend replay only | openrouter.ai/docs/use-cases/reasoning-tokens |
| **claude-code-router** | signature-aware, but cross-protocol leg **fabricates `signature = Date.now().toString()`** (a throwaway timestamp) | cannot mint valid signature | musistudio/llms: reasoning.transformer.ts L133 |
| **Portkey** | surfaces thinking **TEXT** only via non-standard `content_blocks`; no signature/encrypted handling | text only, no round-trip | portkey.ai/docs/integrations/llms/anthropic |
| **codex-responses-bridge** | `preserve_thinking` round-trips **plaintext** `reasoning_content`; **intentionally drops `encrypted_content`** | works *because* plaintext | aidenlabsdotdev/codex-responses-bridge |
| Cloudflare AI GW / Helicone / Vercel AI GW | **no evidence found either round** | UNVERIFIED | — |

**Key takeaway:** even the closest thing to a "universal reasoning format" (OpenRouter `reasoning_details`) is
**replay to the same backend**, not cross-protocol transcoding. The one project that moves reasoning across
protocols (codex-responses-bridge) does so **only because the reasoning is plaintext** and explicitly throws
the encrypted blob away.

## 6. Live empirical probes — our real Copilot backend (2026-06-18, :4142)

These answer questions **no vendor doc covers** — only observable by capturing the live wire shape.

| Probe | Question | Result |
|---|---|---|
| **A** | Shape of Copilot's `/responses` reasoning item? | `id` = **~408-char base64 encrypted blob** (NOT `rs_…`); `content:[]` **and** `summary:[]` **both empty**; no top-level `encrypted_content` field — the encrypted reasoning is **baked into the `id`** |
| **B** | Does Copilot support server-side reasoning state? | `store:true` → **HTTP 400 `"store is not supported"` (`unsupported_value`)** → `previous_response_id` continuation is **NOT available** on Copilot |
| **C** | Does replaying Copilot's own encrypted `id` work? | **Accepted (HTTP 200)**; model continued correctly (13×17=221, ×2=**442**) → continuity works **same-protocol, same-backend only** |
| **D** | Is the CC→Claude `thinking` signature native or re-issued? | **288 base64 chars = 214 bytes binary** (header `12d1010a…`), consistent with a **native Anthropic** opaque signature passed through — not a short Copilot-minted token |

**Consequence for the "plaintext-summary downgrade" idea:** it does **NOT** apply to Copilot. OpenAI's
*direct* API exposes a plaintext reasoning summary you could forward as assistant text; **Copilot's `summary`
is empty `[]`** (Probe A). There is no summary to forward — the downgrade path is unavailable on this backend.

## 7. Double-verification: live probes ⇄ public research agree

The strongest validation — two **independent** evidence chains converging:

| Fact | Live probe | Public research (independent) |
|---|---|---|
| `store:true` rejected | Probe B: `400 store is not supported` | openclaw#71333 curl: `rejects store:true (unsupported_value)` |
| encrypted reasoning id-bound, same-proto replay | Probe C: replay accepted → 442 | oh-my-pi#290: id-bound; truncated id → 400; verbatim id round-trips |
| no server-side `previous_response_id` path | Probe B (inferred) | research: "client-side encrypted replay is the only path" |
| plaintext/summary never exposed | Probe A: `content:[]`, `summary:[]` | DESIGN.md L34-36 (live traces): `{content:[], id:"<encrypted>"}` |

## 8. Refuted claims (retained for honesty)

Six claims were **killed** by adversarial verification. We record them so the conclusion is not overstated:

- **(R1, 0-3)** "LiteLLM `encrypted_content_affinity` solves continuity *without* server state" — false; it is a
  same-backend routing trick, still needs same protocol+backend.
- **(R2, 0-3)** "y-router architecturally cannot carry encrypted reasoning" — unverifiable; y-router's actual
  behavior is **unconfirmed in either direction**.
- **(R2, 1-2)** "claude-code-router does bidirectional cross-protocol *thinking* translation" — refuted; it
  carries text and fakes the signature.
- **(R2, 1-2)** **"Anthropic officially sanctions omitting prior-turn thinking"** — **contested, NOT proven.**
  We **retract** any earlier framing that called omission explicitly "legal/sanctioned." What survives 3-0 is
  only: *if included*, thinking blocks must be passed **unchanged**.
- **(R2, 0-3)** "During tool use the block MUST be echoed back" — too strong; you may omit, you just may not
  modify when including.
- **(R2, 1-2)** "LiteLLM doc flags cross-provider round-trip as unresolved + drop→no-thinking" — partial
  evidence only.

## 9. Remaining blind spots / open questions

- **Cloudflare AI Gateway, Helicone, Vercel AI Gateway** — no evidence found in either round. Largest
  uncovered part of the gateway survey. (Not disproven — *查无实据*.)
- **Copilot Claude-path signature passthrough vs re-sign** — Probe D + local DESIGN.md strongly indicate
  passthrough, but there is **no third-party packet capture** confirming it.
- **Cross-protocol quality cost** — no benchmark exists. The only public number (~3% SWE-bench from including
  reasoning items, OpenAI self-reported) is **same-protocol** and informal (no baseline/CI/split).

## 10. Implications for this proxy

1. **Our design is correct and industry-standard.** Same-protocol passthrough = lossless; cross-protocol =
   honest drop. This matches LiteLLM/OpenRouter, and is **cleaner than claude-code-router** (which fabricates
   a fake `Date.now()` signature — we drop honestly).
2. **The two lossy paths cannot be fixed by translation** — the loss is backend-encrypted reasoning, a
   physical limit. Do not spend effort trying to "translate" reasoning across protocols.
3. **No plaintext-downgrade fallback is available** on Copilot (empty `summary`), so that avenue is closed —
   no need to build it.
4. **Functional fidelity is intact** on all 6 corners (answers, tool calls, effort) — verified live. Only the
   *visibility* and *cross-turn replay* of reasoning is lost, and only on the cross-protocol paths.

## 11. Source index (primary)

- developers.openai.com/api/docs/guides/reasoning · cookbook reasoning_items (~3% SWE-bench)
- platform.claude.com/docs/en/build-with-claude/extended-thinking (signature = encrypted full thinking)
- docs.litellm.ai/docs/reasoning_content · /docs/response_api · **issue #26916** (flatten-to-text bug) ·
  blog: responses-api-encrypted-content-incident (org-bound; affinity routing)
- openrouter.ai/docs/use-cases/reasoning-tokens (`reasoning_details`, pass-back-unmodified)
- github.com/can1357/oh-my-pi#290 (Copilot encrypted replay, id-bound) · openclaw#71333 (`store` rejected)
- musistudio/llms (claude-code-router): reasoning.transformer.ts L133 (`Date.now()` signature)
- portkey.ai/docs/integrations/llms/anthropic (`content_blocks` text only)
- aidenlabsdotdev/codex-responses-bridge (`preserve_thinking`, plaintext only)
- Live enterprise traces, this repo, 2026-06-18 (Probes A-D, port :4142)
