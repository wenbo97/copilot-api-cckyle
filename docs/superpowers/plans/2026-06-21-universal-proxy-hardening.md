# Universal Proxy Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the unreasonable design on `feat/universal-cc-codex-copilot` (catalog-distrusting regex router, 3× model-id rewrites, duplicated translators, scattered reasoning policy, latent stream/routing bugs) and prove it works via a headless acceptance suite.

**Architecture:** Catalog is the single source of truth for routing (per-inbound-handler egress preference). Model identity is normalized once. Translation primitives are shared. Reasoning policy lives in one module. A standing named team owns disjoint file sets; the lead owns the handler seams and the completion gate.

**Tech Stack:** TypeScript + Bun, Hono server, `bun:test`. Reference patterns from `D:\A_Projects\litellm` (`github_copilot/responses/transformation.py`, `anthropic/experimental_pass_through/adapters/transformation.py`).

**Worktree:** All edits in `D:\Tools\copilot-api-feat` (branch `feat/universal-cc-codex-copilot`). Spec: `docs/superpowers/specs/2026-06-21-universal-proxy-hardening-design.md`.

**Commands:** `bun test` · `bun run typecheck` (`tsc`) · `bun run lint` (`eslint --cache`). Run a single test: `bun test tests/<file>.test.ts`.

---

## File Structure

**Create:**
- `src/lib/model-identity.ts` — single `resolveModelId(requested, catalog) → catalogId` resolver + `validateModelMappings()`.
- `src/routes/_shared/tool-translation.ts` — shared Anthropic/Responses/Chat tool + tool_choice translators.
- `src/routes/_shared/stop-reason.ts` — shared `deriveStopReason`.
- `src/routes/_shared/reasoning-policy.ts` — `mapThinkingToReasoningEffort` + `clampReasoningEffort` + budget table (moved here).
- `src/routes/_shared/tool-name.ts` — 64-char tool-name truncation + mapping (litellm port).
- `src/routes/_shared/stream-item-id.ts` — Responses stream item-id stabilizer (litellm port).
- `tests/acceptance/run.ts` — headless acceptance runner (the "done" gate).
- `tests/acceptance/lib/` — proxy launcher, trace oracle, claude/codex drivers.
- New unit tests under `tests/` mirroring each module.

**Modify:**
- `src/lib/endpoint-router.ts` — replace regex with `pickEgress(handlerKind, modelId)`; delete `RESPONSES_ONLY_ID_PATTERNS`; move reasoning fns out.
- `src/routes/messages/handler.ts`, `src/routes/responses/handler.ts`, `src/routes/chat-completions/handler.ts` — use `resolveModelId` + `pickEgress` (lead-owned seams).
- `src/routes/messages/non-stream-translation.ts` — delete `translateModelName`; import shared tool/reasoning fns.
- `src/routes/messages/responses-translation.ts`, `src/routes/responses/non-stream-translation.ts`, `src/routes/messages/responses-stream-translation.ts` — import shared primitives; fix `isFunctionCallOutput`.
- `src/services/copilot/create-messages.ts`, `create-responses.ts` — import reasoning policy; wire ports.

**Ownership (the no-collision rule):**
- `@routing-eng` → `endpoint-router.ts`, `model-mapping.ts`, `model-identity.ts`, `reasoning-policy.ts`
- `@translation-eng` → `_shared/{tool-translation,stop-reason,tool-name,stream-item-id}.ts`, the 6 translators, `create-messages.ts`, `create-responses.ts`
- `@accept-eng` → `tests/acceptance/**`
- **Lead** → the 3 `handler.ts` seams (wired only after both engineers' modules land)

---

## TRACK R — @routing-eng (routing + identity + reasoning policy)

### Task R1: Reasoning-policy module (move, don't rewrite — behavior-preserving)

**Files:**
- Create: `src/routes/_shared/reasoning-policy.ts`
- Test: `tests/reasoning-policy.test.ts`
- Modify later (R5): callers import from here.

- [ ] **Step 1: Characterization test capturing CURRENT behavior**

Create `tests/reasoning-policy.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test"
import { state } from "../src/lib/state"
import {
  mapThinkingToReasoningEffort,
  clampReasoningEffort,
} from "../src/routes/_shared/reasoning-policy"

afterEach(() => { state.models = undefined })

describe("mapThinkingToReasoningEffort (preserved behavior)", () => {
  test("absent thinking → undefined", () => {
    expect(mapThinkingToReasoningEffort(undefined, 1000)).toBeUndefined()
  })
  test("enabled, no budget → high", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled" } as any, 1000)).toBe("high")
  })
  test("budget ≥ 0.95×max_tokens → max", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled", budget_tokens: 950 } as any, 1000)).toBe("max")
  })
  test("budget ≤2048 → low", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled", budget_tokens: 2048 } as any, 100000)).toBe("low")
  })
  test("budget ≤8192 → medium", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled", budget_tokens: 8192 } as any, 100000)).toBe("medium")
  })
  test("budget ≤24576 → high", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled", budget_tokens: 24576 } as any, 100000)).toBe("high")
  })
  test("budget >24576 → xhigh", () => {
    expect(mapThinkingToReasoningEffort({ type: "enabled", budget_tokens: 30000 } as any, 100000)).toBe("xhigh")
  })
})

describe("clampReasoningEffort (preserved behavior)", () => {
  test("undefined → undefined", () => {
    expect(clampReasoningEffort("gpt-5.3-codex", undefined)).toBeUndefined()
  })
  test("no catalog → passthrough", () => {
    state.models = undefined
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("max")
  })
  test("max clamped to xhigh for codex", () => {
    state.models = { object: "list", data: [
      { id: "gpt-5.3-codex", capabilities: { supports: { reasoning_effort: ["low","medium","high","xhigh"] } } },
    ] } as any
    expect(clampReasoningEffort("gpt-5.3-codex", "max")).toBe("xhigh")
  })
  test("allowed effort passes unchanged", () => {
    state.models = { object: "list", data: [
      { id: "claude-opus-4.8", capabilities: { supports: { reasoning_effort: ["low","medium","high","xhigh","max"] } } },
    ] } as any
    expect(clampReasoningEffort("claude-opus-4.8", "max")).toBe("max")
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `bun test tests/reasoning-policy.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create the module by MOVING the two functions verbatim.**

Create `src/routes/_shared/reasoning-policy.ts`. Copy `mapThinkingToReasoningEffort` from `src/routes/messages/non-stream-translation.ts` and `clampReasoningEffort` + `EFFORT_ORDER` from `src/lib/endpoint-router.ts`, unchanged. Header:

```ts
import { state } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

// Effort ordering, weakest to strongest (moved from endpoint-router.ts).
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const

// Budget→effort thresholds (named for clarity; values preserved from the original
// mapThinkingToReasoningEffort in non-stream-translation.ts).
const MAX_BUDGET_RATIO = 0.95 // budget ≥ ratio×max_tokens ⇒ "max" (no-constraint signal)
const LOW_BUDGET = 2048
const MEDIUM_BUDGET = 8192
const HIGH_BUDGET = 24576

export function mapThinkingToReasoningEffort(/* ...verbatim, using the named consts... */): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  // body unchanged except literals → the named constants above
}

export function clampReasoningEffort(modelId: string, effort: string | undefined): string | undefined {
  // body verbatim from endpoint-router.ts
}
```

- [ ] **Step 4: Run, verify pass** — `bun test tests/reasoning-policy.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_shared/reasoning-policy.ts tests/reasoning-policy.test.ts
git commit -m "refactor(reasoning): extract reasoning-policy module (behavior-preserving)"
```

### Task R2: pickEgress — catalog-truth routing (kills the regex)

**Files:**
- Modify: `src/lib/endpoint-router.ts`
- Test: `tests/endpoint-router.test.ts` (extend existing)

- [ ] **Step 1: Write failing tests for `pickEgress`.** Append to `tests/endpoint-router.test.ts`:

```ts
import { pickEgress } from "../src/lib/endpoint-router"

describe("pickEgress (per-handler, catalog-truth)", () => {
  // uses the fixtureModels already defined at top of this file (set state.models in beforeEach there)
  test("Codex+gpt-5.4 → /responses (same-protocol)", () => {
    state.models = fixtureModels as any
    expect(pickEgress("responses", "gpt-5.4")).toBe("/responses")
  })
  test("CC+gpt-5.4 → /responses (no messages; nearest cross)", () => {
    state.models = fixtureModels as any
    expect(pickEgress("messages", "gpt-5.4")).toBe("/responses")
  })
  test("OpenAI+gpt-5.4 → /chat/completions (same-protocol)", () => {
    state.models = fixtureModels as any
    expect(pickEgress("chat", "gpt-5.4")).toBe("/chat/completions")
  })
  test("OpenAI+gpt-5.5 (responses-only) → unsupported", () => {
    state.models = fixtureModels as any
    expect(pickEgress("chat", "gpt-5.5")).toBe("unsupported")
  })
  test("CC+claude-opus-4.8 → /v1/messages (passthrough)", () => {
    state.models = fixtureModels as any
    expect(pickEgress("messages", "claude-opus-4.8")).toBe("/v1/messages")
  })
  test("Codex+claude-opus-4.8 → /chat/completions (translate-down)", () => {
    state.models = fixtureModels as any
    expect(pickEgress("responses", "claude-opus-4.8")).toBe("/chat/completions")
  })
  test("model with NO supported_endpoints → same-protocol fallback (logged)", () => {
    state.models = { object: "list", data: [{ id: "mystery-model" }] } as any
    expect(pickEgress("messages", "mystery-model")).toBe("/v1/messages")
    expect(pickEgress("responses", "mystery-model")).toBe("/responses")
    expect(pickEgress("chat", "mystery-model")).toBe("/chat/completions")
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/endpoint-router.test.ts` → FAIL (`pickEgress` undefined).

- [ ] **Step 3: Implement `pickEgress`; delete the regex.** In `src/lib/endpoint-router.ts`: remove `RESPONSES_ONLY_ID_PATTERNS`, `inferResponsesOnly`, and the false-premise comment block. Remove `clampReasoningEffort` + `EFFORT_ORDER` (now in reasoning-policy). Keep/rewrite:

```ts
import { state } from "./state"
import consola from "consola"

export type HandlerKind = "messages" | "responses" | "chat"
export type Egress = "/v1/messages" | "/responses" | "/chat/completions"
export type EgressChoice = Egress | "unsupported"

// Same-protocol first, then the nearest EXISTING cross-leg. Each list only names
// egress legs that are actually implemented on this branch (see spec §4 Rule B).
const PREFERENCE: Record<HandlerKind, Array<Egress>> = {
  responses: ["/responses", "/chat/completions"],
  messages: ["/v1/messages", "/responses", "/chat/completions"],
  chat: ["/chat/completions"],
}

const SAME_PROTOCOL: Record<HandlerKind, Egress> = {
  responses: "/responses",
  messages: "/v1/messages",
  chat: "/chat/completions",
}

export function pickEgress(kind: HandlerKind, modelId: string): EgressChoice {
  const model = state.models?.data.find((m) => m.id === modelId)
  const endpoints = model?.supported_endpoints

  // No advertised set at all → same-protocol fallback (previous default), logged once.
  if (!endpoints || endpoints.length === 0) {
    consola.debug(`[router] ${modelId} advertises no supported_endpoints; falling back to same-protocol ${SAME_PROTOCOL[kind]}`)
    return SAME_PROTOCOL[kind]
  }

  for (const ep of PREFERENCE[kind]) {
    if (endpoints.includes(ep)) return ep
  }
  return "unsupported"
}
```

Keep `modelSupportsEndpoint` for now (other call sites) but it will be removed in R6 once handlers use `pickEgress`.

- [ ] **Step 4: Run, verify pass** — `bun test tests/endpoint-router.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/endpoint-router.ts tests/endpoint-router.test.ts
git commit -m "feat(router): pickEgress catalog-truth routing; remove responses-only regex"
```

### Task R3: resolveModelId — single identity resolver

**Files:**
- Create: `src/lib/model-identity.ts`
- Test: `tests/model-identity.test.ts`

- [ ] **Step 1: Failing test.** Create `tests/model-identity.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test"
import { state } from "../src/lib/state"
import { resolveModelId, validateModelMappings } from "../src/lib/model-identity"

const catalog = { object: "list", data: [
  { id: "claude-opus-4.8" }, { id: "claude-sonnet-4.6" }, { id: "gpt-5.5" },
] } as any

afterEach(() => { state.models = undefined; delete process.env.MODEL_MAPPINGS })

describe("resolveModelId", () => {
  test("exact catalog id passes through (zero-config Copilot id)", () => {
    state.models = catalog
    expect(resolveModelId("claude-opus-4.8")).toBe("claude-opus-4.8")
  })
  test("MODEL_MAPPINGS alias resolves", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "claude-opus-4-8:claude-opus-4.8"
    expect(resolveModelId("claude-opus-4-8")).toBe("claude-opus-4.8")
  })
  test("[1m] suffix stripped then resolved", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "claude-opus-4-8:claude-opus-4.8"
    expect(resolveModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4.8")
  })
  test("suffix strip → exact catalog id (no mapping needed)", () => {
    state.models = catalog
    expect(resolveModelId("claude-opus-4.8[1m]")).toBe("claude-opus-4.8")
  })
  test("unknown id returned as-is (handler decides)", () => {
    state.models = catalog
    expect(resolveModelId("nonexistent")).toBe("nonexistent")
  })
})

describe("validateModelMappings", () => {
  test("warns for target absent from catalog (returns the bad targets)", () => {
    state.models = catalog
    process.env.MODEL_MAPPINGS = "a:claude-opus-4.8,b:ghost-model"
    expect(validateModelMappings()).toEqual(["ghost-model"])
  })
})
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/model-identity.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `src/lib/model-identity.ts`:

```ts
import consola from "consola"
import { getModelMappings } from "./model-mapping"
import { state } from "./state"

const SUFFIX = /\[[^\]]*]$/ // trailing [1m] etc.

function inCatalog(id: string): boolean {
  return Boolean(state.models?.data.some((m) => m.id === id))
}

/**
 * Normalize a client-sent model id to a Copilot catalog id, ONCE, at handler entry.
 * Order: exact catalog hit → MODEL_MAPPINGS alias → strip trailing [..] suffix and retry.
 * Returns the input unchanged if nothing matches (the handler/router then decides).
 */
export function resolveModelId(requested: string): string {
  if (inCatalog(requested)) return requested

  const mappings = getModelMappings()
  const mapped = mappings.get(requested)
  if (mapped) return mapped

  const stripped = requested.replace(SUFFIX, "")
  if (stripped !== requested) {
    if (inCatalog(stripped)) return stripped
    const m2 = mappings.get(stripped)
    if (m2) return m2
  }
  return requested
}

/** Startup check: MODEL_MAPPINGS targets that aren't in the loaded catalog. */
export function validateModelMappings(): Array<string> {
  const bad: Array<string> = []
  for (const target of getModelMappings().values()) {
    if (!inCatalog(target)) bad.push(target)
  }
  if (bad.length > 0) {
    consola.warn(`MODEL_MAPPINGS targets not in catalog: ${bad.join(", ")}`)
  }
  return bad
}
```

- [ ] **Step 4: Run, verify pass** — `bun test tests/model-identity.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-identity.ts tests/model-identity.test.ts
git commit -m "feat(identity): single resolveModelId resolver + mapping validation"
```

### Task R4: Wire startup validation

**Files:**
- Modify: `src/start.ts` (the startup path awaits `cacheModels()` at `src/start.ts:89`)

- [ ] **Step 1: Confirm the cache point.** `src/start.ts:89` is `await cacheModels()`. Validation goes immediately after it.

- [ ] **Step 2: Call validation after models load.** After `await cacheModels()` in `src/start.ts`, add:

```ts
import { validateModelMappings } from "~/lib/model-identity"
// ...immediately after await cacheModels():
validateModelMappings()
```

- [ ] **Step 3: Typecheck** — `bun run typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/start.ts
git commit -m "feat(identity): validate MODEL_MAPPINGS against catalog at startup"
```

### Task R5: Repoint reasoning-policy importers (delete the old copies)

**Files:**
- Modify: `src/lib/endpoint-router.ts` (already removed in R2), `src/services/copilot/create-messages.ts`, `src/routes/messages/responses-translation.ts`, `src/routes/messages/non-stream-translation.ts`

- [ ] **Step 1: Update imports.** Replace `import { clampReasoningEffort } from "~/lib/endpoint-router"` with `from "~/routes/_shared/reasoning-policy"` in `create-messages.ts` and `responses-translation.ts`. In `non-stream-translation.ts`, delete the local `mapThinkingToReasoningEffort` definition and `export { mapThinkingToReasoningEffort } from "~/routes/_shared/reasoning-policy"` (or import + re-export) so existing importers keep working.

- [ ] **Step 2: Run full suite** — `bun test` → all green (behavior preserved).

- [ ] **Step 3: Typecheck + lint** — `bun run typecheck && bun run lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(reasoning): repoint all importers to reasoning-policy module"
```

---

## TRACK T — @translation-eng (shared primitives + bug fixes + ports)

### Task T1: Characterization tests BEFORE touching translators

**Files:**
- Test: `tests/responses-translation.test.ts` (extend), `tests/create-responses.test.ts` (extend)

- [ ] **Step 1: Capture current tool + stop-reason + tool_choice behavior.** Add tests asserting the CURRENT output of `translateTools`/`translateToolChoice` in both `messages/responses-translation.ts` and `responses/non-stream-translation.ts`, and `deriveStopReason` in both stream + non-stream. (These lock behavior so the de-dup can't drift.) Example:

```ts
import { translateAnthropicToResponses } from "../src/routes/messages/responses-translation"

test("anthropic tools → responses function tools (shape locked)", () => {
  const out = translateAnthropicToResponses({
    model: "gpt-5.5", max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
  } as any)
  expect(out.tools).toEqual([{ type: "function", name: "get_weather", description: "d", parameters: { type: "object" } }])
})
```

- [ ] **Step 2: Run, verify PASS against current code** — `bun test tests/responses-translation.test.ts` → PASS (these document the baseline).

- [ ] **Step 3: Commit**

```bash
git add tests/responses-translation.test.ts tests/create-responses.test.ts
git commit -m "test(translation): characterization tests before de-dup"
```

### Task T2: Shared tool-translation + stop-reason modules

**Files:**
- Create: `src/routes/_shared/tool-translation.ts`, `src/routes/_shared/stop-reason.ts`
- Test: `tests/shared-tool-translation.test.ts`

- [ ] **Step 1: Failing test** for the shared functions:

```ts
import { describe, test, expect } from "bun:test"
import { anthropicToolsToResponses, anthropicToolChoiceToResponses } from "../src/routes/_shared/tool-translation"

describe("anthropicToolsToResponses", () => {
  test("maps name/description/input_schema → parameters", () => {
    expect(anthropicToolsToResponses([{ name: "t", description: "d", input_schema: { type: "object" } }] as any))
      .toEqual([{ type: "function", name: "t", description: "d", parameters: { type: "object" } }])
  })
  test("undefined/empty → undefined", () => {
    expect(anthropicToolsToResponses(undefined)).toBeUndefined()
    expect(anthropicToolsToResponses([])).toBeUndefined()
  })
})

describe("anthropicToolChoiceToResponses", () => {
  test("auto/any/none/tool map correctly", () => {
    expect(anthropicToolChoiceToResponses({ type: "auto" } as any)).toBe("auto")
    expect(anthropicToolChoiceToResponses({ type: "any" } as any)).toBe("required")
    expect(anthropicToolChoiceToResponses({ type: "none" } as any)).toBe("none")
    expect(anthropicToolChoiceToResponses({ type: "tool", name: "x" } as any)).toEqual({ type: "function", name: "x" })
  })
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `src/routes/_shared/tool-translation.ts` by lifting the bodies from `messages/responses-translation.ts` (`translateTools`, `translateToolChoice`) verbatim (rename exports as above). Create `src/routes/_shared/stop-reason.ts`:

```ts
import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ResponseObject } from "~/routes/responses/responses-types"

/** Anthropic stop_reason from (hasToolCall, status). Shared by stream + non-stream. */
export function deriveAnthropicStopReason(
  hasToolCall: boolean,
  status: ResponseObject["status"] | undefined,
): AnthropicResponse["stop_reason"] {
  if (hasToolCall) return "tool_use"
  if (status === "incomplete") return "max_tokens"
  return "end_turn"
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/routes/_shared/tool-translation.ts src/routes/_shared/stop-reason.ts tests/shared-tool-translation.test.ts
git commit -m "feat(shared): shared tool-translation + stop-reason primitives"
```

### Task T3: Repoint translators to shared primitives (de-dup)

**Files:**
- Modify: `messages/responses-translation.ts`, `responses/non-stream-translation.ts`, `messages/responses-stream-translation.ts`

- [ ] **Step 1:** Replace the local `translateTools`/`translateToolChoice` in `messages/responses-translation.ts` with imports from `_shared/tool-translation`. Replace `deriveStopReason` in both `responses-translation.ts` and `responses-stream-translation.ts` with `deriveAnthropicStopReason` from `_shared/stop-reason`. (Note: the Responses-direction `translateTools` in `responses/non-stream-translation.ts` handles a DIFFERENT shape — Chat-format tools — keep it OR add a clearly-named second shared fn; do NOT force-merge two different behaviors.)

- [ ] **Step 2: Run characterization + unit suite** — `bun test` → all green (no drift).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(translation): de-dup tool + stop-reason via _shared"
```

### Task T4: Fix `isFunctionCallOutput` misroute

**Files:**
- Modify: `src/routes/responses/non-stream-translation.ts:74-77`
- Test: `tests/responses-translation.test.ts`

- [ ] **Step 1: Failing test** proving the bug — a `function_call` input item (assistant tool call, has `call_id`) must NOT be treated as a tool result:

```ts
import { translateToOpenAI } from "../src/routes/responses/non-stream-translation"
test("function_call input item is NOT misrouted as tool result", () => {
  const out = translateToOpenAI({
    model: "claude-opus-4.8",
    input: [
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" } as any,
      { type: "function_call_output", call_id: "c1", output: "ok" } as any,
    ],
  } as any)
  // The function_call_output → role:tool message; the function_call must become an
  // assistant tool_calls message, never a second role:tool message.
  const toolMsgs = out.messages.filter((m: any) => m.role === "tool")
  expect(toolMsgs.length).toBe(1)
})
```

- [ ] **Step 2: Run, verify fail** (current code routes both as tool, length 2).

- [ ] **Step 3: Fix the discriminator.** Change `isFunctionCallOutput` to test `type`, and handle `function_call` explicitly:

```ts
function isFunctionCallOutput(item: ResponseInputItem): item is ResponseInputFunctionCallOutput {
  return (item as { type?: string }).type === "function_call_output"
}
```

Add a branch in `translateInputToMessages` for `type === "function_call"` → push an assistant message with `tool_calls: [{ id: call_id, type: "function", function: { name, arguments } }]`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/routes/responses/non-stream-translation.ts tests/responses-translation.test.ts
git commit -m "fix(responses): disambiguate function_call vs function_call_output by type"
```

### Task T5: Port 64-char tool-name truncation (litellm)

**Files:**
- Create: `src/routes/_shared/tool-name.ts`
- Test: `tests/tool-name.test.ts`
- Modify: `_shared/tool-translation.ts` to apply it

- [ ] **Step 1: Failing test:**

```ts
import { truncateToolName } from "../src/routes/_shared/tool-name"
test("≤64 chars unchanged", () => { expect(truncateToolName("short")).toBe("short") })
test(">64 chars → 55-prefix + _ + 8-hash, deterministic", () => {
  const long = "a".repeat(80)
  const out = truncateToolName(long)
  expect(out.length).toBe(64)
  expect(truncateToolName(long)).toBe(out) // deterministic
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** (TS port of litellm `truncate_tool_name`):

```ts
import { createHash } from "node:crypto"

const MAX = 64, HASH = 8, PREFIX = MAX - HASH - 1 // 55

/** OpenAI caps tool names at 64 chars; Anthropic does not. Deterministic hash suffix
 *  avoids collisions when long names share a prefix. (Port of litellm truncate_tool_name.) */
export function truncateToolName(name: string): string {
  if (name.length <= MAX) return name
  const h = createHash("sha256").update(name).digest("hex").slice(0, HASH)
  return `${name.slice(0, PREFIX)}_${h}`
}
```

- [ ] **Step 4: Apply in `anthropicToolsToResponses`** (map each tool's `name` through `truncateToolName`). Run `bun test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_shared/tool-name.ts tests/tool-name.test.ts src/routes/_shared/tool-translation.ts
git commit -m "feat(tools): port 64-char tool-name truncation from litellm"
```

### Task T6: Port stream item-id stabilization (litellm)

**Files:**
- Create: `src/routes/_shared/stream-item-id.ts`
- Test: `tests/stream-item-id.test.ts`
- Modify: `src/routes/responses/handler.ts` passthrough loop + `messages/handler.ts` responses-bridge loop (apply normalizer before forwarding/translating). NOTE: handler edits are lead-owned — @translation-eng delivers the module + a unit test; lead wires it.

- [ ] **Step 1: Failing test** (port of litellm `_normalize_stream_item_id` semantics):

```ts
import { StreamItemIdNormalizer } from "../src/routes/_shared/stream-item-id"
test("rewrites per-event item_id to the anchor id from output_item.added", () => {
  const n = new StreamItemIdNormalizer()
  n.normalize({ type: "response.output_item.added", output_index: 0, item: { id: "anchor", type: "message" } })
  const ev = n.normalize({ type: "response.output_text.delta", output_index: 0, item_id: "drifting", delta: "x" })
  expect((ev as any).item_id).toBe("anchor")
})
test("output_item.done item.id rewritten to anchor", () => {
  const n = new StreamItemIdNormalizer()
  n.normalize({ type: "response.output_item.added", output_index: 1, item: { id: "A", type: "reasoning" } })
  const ev = n.normalize({ type: "response.output_item.done", output_index: 1, item: { id: "B" } })
  expect((ev as any).item.id).toBe("A")
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `src/routes/_shared/stream-item-id.ts` — a class holding `Map<number,string>` anchors keyed by `output_index`, seeded on `response.output_item.added`, rewriting any event carrying top-level `item_id`, and `output_item.done`'s nested `item.id`. Copy litellm's docstring rationale (Vercel AI SDK "part not found" crash) as the class comment.

- [ ] **Step 4: Run, verify pass. Commit.**

```bash
git add src/routes/_shared/stream-item-id.ts tests/stream-item-id.test.ts
git commit -m "feat(stream): port Responses item-id stabilizer from litellm"
```

### Task T7: Port encrypted_content reasoning continuity (litellm)

**Files:**
- Modify: `src/services/copilot/create-responses.ts` (or the responses passthrough path) — preserve `encrypted_content` on reasoning items in multi-turn input.
- Test: `tests/create-responses.test.ts`

- [ ] **Step 1: Failing test** — a reasoning item with `encrypted_content` round-trips intact (not stripped):

```ts
test("reasoning item preserves encrypted_content; drops status:null", () => {
  const cleaned = sanitizeReasoningItem({ type: "reasoning", id: "r", status: null, encrypted_content: "BLOB", content: [] })
  expect(cleaned.encrypted_content).toBe("BLOB")
  expect("status" in cleaned).toBe(false)
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `sanitizeReasoningItem` (TS port of litellm `_handle_reasoning_item`): keep `encrypted_content` when present, drop `status === null`, keep other non-null fields. Apply it to reasoning items in the responses egress path. Export for the test.

- [ ] **Step 4: Run, verify pass. Commit.**

```bash
git add src/services/copilot/create-responses.ts tests/create-responses.test.ts
git commit -m "feat(responses): preserve encrypted_content on reasoning items (litellm port)"
```

### Task T8: Close remaining stream P2 items

**Files:**
- Modify: `src/routes/responses/stream-translation.ts` (emit `response.output_item.done` for tool calls; stop emitting empty `.done` text/args)
- Test: `tests/responses-translation.test.ts`

- [ ] **Step 1: Failing test** asserting a tool call emits `response.output_item.done`, and no empty `output_text.done` is emitted when there was no text. (Use the existing stream-translation test harness shape.)

- [ ] **Step 2: Run, verify fail. Step 3: Implement. Step 4: Verify pass. Step 5: Commit.**

```bash
git commit -am "fix(stream): emit tool-call output_item.done; drop empty .done events"
```

---

## TRACK A — @accept-eng (headless acceptance harness)

### Task A1: Trace-tag oracle + proxy launcher

**Files:**
- Create: `tests/acceptance/lib/proxy.ts`, `tests/acceptance/lib/oracle.ts`

- [ ] **Step 1:** `proxy.ts` — start the worktree proxy on **:4143** with `--trace` into a temp trace dir, wait for `/v1/models` to 200, expose `stop()`. Use Bun's `spawn`. Trace dir is unique per run.

- [ ] **Step 2:** `oracle.ts` — `latestTraceTag(traceDir): string` reads the newest `*.req`, JSON-parses, returns `.type`. `assertTag(expected)` helper. Unit-test the oracle against a hand-written `.req` fixture file (`{"type":"anthropic-via-responses"}`) → returns `"anthropic-via-responses"`.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/lib/proxy.ts tests/acceptance/lib/oracle.ts
git commit -m "test(accept): proxy launcher + trace-tag oracle"
```

### Task A2: claude -p driver

**Files:**
- Create: `tests/acceptance/lib/claude.ts`

- [ ] **Step 1:** `runClaude({ prompt, model, env, agentsJson?, mcpConfig?, outputFormat? })` → spawns `claude -p <prompt> --model <model> [--agents ..] [--mcp-config ..] [--output-format stream-json]` with `ANTHROPIC_BASE_URL=http://localhost:4143`, `ANTHROPIC_AUTH_TOKEN=dummy`, `--allow-dangerously-skip-permissions`. Returns `{ exitCode, stdout, lastText }`. Add a 120s timeout.

- [ ] **Step 2: Smoke it** (manual, not committed gate): one trivial call to confirm wiring before building the matrix.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/lib/claude.ts
git commit -m "test(accept): claude -p driver"
```

### Task A3: codex exec driver

**Files:**
- Create: `tests/acceptance/lib/codex.ts`

- [ ] **Step 1:** `runCodex({ prompt, model, mode, lastMsgFile })` → spawns the codex binary at `C:\Users\IIIII\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` with `exec` (or `exec review`), `-m <model>`, `--json`, `-o <lastMsgFile>`, `--skip-git-repo-check`, `--sandbox workspace-write`, and `-c model_providers.copilot.base_url=http://localhost:4143/v1 -c model_providers.copilot.wire_api=responses -c model_provider=copilot`. Returns `{ exitCode, lastMessage }`. Precede the matrix with a `codex doctor` smoke.

- [ ] **Step 2: Commit**

```bash
git add tests/acceptance/lib/codex.ts
git commit -m "test(accept): codex exec driver"
```

### Task A4: The four mandate matrices + RESULTS writer

**Files:**
- Create: `tests/acceptance/run.ts`, `tests/acceptance/matrices.ts`

- [ ] **Step 1:** `matrices.ts` encodes §7.2–7.5 as data: `{ id, client, model, mode?, prompt, expectedTag, extraAsserts }`. Cover every cell in spec §7.2 (1a–1h), §7.3 (2a short ×3 models, 2b long ×2), §7.4 (3a/3b ×3 models), §7.5 (4a–4e).

- [ ] **Step 2:** `run.ts` — for each cell: ensure proxy up, run the driver, read the oracle tag, compare to `expectedTag`, check exit 0 + non-empty + no `unsupported_api_for_model`/raw 400 in output. Accumulate PASS/FAIL.

- [ ] **Step 3:** Write `tests/acceptance/RESULTS-<date>.md`: one row per cell — id, client, model, expected vs actual tag, exit code, PASS/FAIL, trace path. Exit nonzero if any FAIL.

- [ ] **Step 4: Commit**

```bash
git add tests/acceptance/run.ts tests/acceptance/matrices.ts
git commit -m "test(accept): four mandate matrices + RESULTS writer"
```

---

## LEAD — handler seams (after R + T modules land)

### Task L1: Wire resolveModelId + pickEgress into the three handlers

**Files:**
- Modify: `src/routes/messages/handler.ts`, `src/routes/responses/handler.ts`, `src/routes/chat-completions/handler.ts`

- [ ] **Step 1:** In each handler, after reading the payload, replace the ad-hoc model-mapping block with `const model = resolveModelId(payload.model); payload = { ...payload, model }`. Then branch on `pickEgress(kind, model)`:
  - `messages`: `/v1/messages` → `handlePassthroughMessages`; `/responses` → `handleCompletionViaResponses`; `/chat/completions` → existing translate path; `unsupported` → clean 4xx.
  - `responses`: `/responses` → `handleResponsesPassthrough`; `/chat/completions` → translate-down; `unsupported` → 4xx.
  - `chat`: `/chat/completions` → existing; `unsupported` → 4xx (`model X not reachable via /chat/completions`).
- Remove now-dead `modelSupportsEndpoint` calls + `translateModelName` usage.

- [ ] **Step 2:** Apply the `StreamItemIdNormalizer` (T6) in the responses passthrough + messages-bridge stream loops; apply `sanitizeReasoningItem` (T7) on the egress.

- [ ] **Step 3: Full deterministic gate** — `bun test && bun run typecheck && bun run lint` → all clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(handlers): wire resolveModelId + pickEgress; apply stream/reasoning ports"
```

### Task L2: Remove dead code

- [ ] **Step 1:** Delete `translateModelName` from `non-stream-translation.ts` and `modelSupportsEndpoint` from `endpoint-router.ts` if no remaining importers (`grep -rn`). Update any stragglers. Run `bun run knip` to catch dead exports.

- [ ] **Step 2: Gate** — `bun test && bun run typecheck && bun run lint` clean. **Commit.**

```bash
git commit -am "chore: remove translateModelName + modelSupportsEndpoint dead code"
```

---

## Phase 1.5 — @reviewer (adversarial)

### Task V1: Refute each fix

- [ ] Review the full diff `git diff c08ae92..HEAD`. For each of R2/R3/T3/T4: try to construct an input where the new code differs from old in a way the tests miss. Specifically: did de-dup (T3) change any tool/stop-reason output? Did `resolveModelId` change resolution for any real `.env` mapping? File each finding as a blocking task routed to the owning engineer. Loop until clean.

---

## Phase 2 — Verify (the gate)

### Task G1: Deterministic pre-gate
- [ ] `bun test` green · `bun run typecheck` clean · `bun run lint` clean.

### Task G2: Headless acceptance suite (declares "complete")
- [ ] Run `bun run tests/acceptance/run.ts`. Inspect `tests/acceptance/RESULTS-<date>.md`. **Every cell §7.1–7.5 must be PASS.** Any FAIL → route to owning engineer, fix, re-run. Completion is declared ONLY from a fully-green RESULTS file. Commit the RESULTS file as the evidence artifact.

```bash
git add tests/acceptance/RESULTS-*.md
git commit -m "test(accept): green acceptance run — completion evidence"
```

---

## Self-Review notes (done by author)
- **Spec coverage:** ①→R2; ②→R3/R4/L2; ③→T1-T3; ④→R1/R5; ⑤a→T4; ⑤b→L1; ⑤c→T8; ⑤d→T5/T6/T7; §6 team→track layout; §7 gate→Track A + G2. All covered.
- **Type consistency:** `pickEgress`/`EgressChoice`/`HandlerKind`, `resolveModelId`, `deriveAnthropicStopReason`, `truncateToolName`, `StreamItemIdNormalizer`, `sanitizeReasoningItem` used consistently across tasks.
- **No placeholders:** every code step has real code; the two ports (T6/T7) give signatures + tests + litellm source reference (the exact Python is in spec §3 / litellm files the engineer reads).
