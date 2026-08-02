/**
 * Direct-connect probe — answers ONE question: can Claude Code point
 * ANTHROPIC_BASE_URL straight at the Copilot backend and drop this proxy?
 *
 * It puts Claude Code's OWN wire format on the wire — its minimal headers, its
 * `thinking` schema, its model ids, a raw GitHub token as the bearer — i.e.
 * exactly what a settings.json of
 *
 *   { "apiKeyHelper": "gh auth token",
 *     "env": { "ANTHROPIC_BASE_URL": "https://api.enterprise.githubcopilot.com" } }
 *
 * would send, and reports which parts the backend accepts. It deliberately does
 * NOT use `copilotHeaders` (no vscode-chat integration id, no editor-version):
 * spoofing those is a thing the proxy does, and the point here is to measure the
 * unassisted path.
 *
 * Every gating check that FAILs is a job the proxy is currently doing for you.
 * When they all PASS, the proxy is optional for Claude Code + Claude models
 * (it remains required for Codex, GPT/Gemini routing, and tracing).
 *
 * Verified 2026-07-31 (enterprise): `thinking-standard` FAILs — the backend
 * rejects Anthropic's `{type:"enabled",budget_tokens}` and demands
 * `{type:"adaptive"}` + `output_config.effort`. That single incompatibility is
 * why `adaptThinkingForCopilot` (src/services/copilot/create-messages.ts) exists
 * and why direct connect is not viable today.
 *
 * Costs a handful of tiny live completions (max_tokens 64/2048, one short
 * prompt); `--catalog-only` runs the GET checks alone and spends nothing.
 *
 * Usage:
 *   bun run tests/direct-probe.ts
 *   bun run tests/direct-probe.ts --models claude-opus-5,claude-haiku-4.5
 *   bun run tests/direct-probe.ts --account-type individual
 *   bun run tests/direct-probe.ts --catalog-only
 *   bun run tests/direct-probe.ts --json
 *
 * Exit: 0 = direct connect viable · 1 = proxy still required · 2 = probe error
 */
import consola from "consola"
import fs from "node:fs/promises"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { clampReasoningEffort } from "~/routes/_shared/reasoning-policy"

const PROMPT = "Reply with the single word: ok"
const ANTHROPIC_VERSION = "2023-06-01"
const REQUEST_TIMEOUT_MS = 60_000
const DETAIL_MAX = 150

// The model ids a direct-connect settings.json would put in
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL.
const DEFAULT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4.5"]

// Claude Code's observed thinking payload (traces: budget 1024..31999, always
// `type:"enabled"`, never an `output_config`). 1024 is the catalog minimum.
const CC_THINKING_BUDGET = 1024
const THINKING_MAX_TOKENS = 2048

type Status = "PASS" | "FAIL" | "SKIP"

interface Check {
  scope: string
  name: string
  status: Status
  /** Counts toward the direct-viable verdict. Informational checks do not. */
  gating: boolean
  detail: string
  /** What this proxy does about it, shown when the check FAILs. */
  remedy?: string
}

interface Options {
  models: Array<string>
  accountType: string
  catalogOnly: boolean
  json: boolean
  token?: string
}

function parseArgs(argv: Array<string>): Options {
  const opts: Options = {
    models: DEFAULT_MODELS,
    accountType: "enterprise",
    catalogOnly: false,
    json: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--models": {
        i += 1
        opts.models = (argv[i] ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
        break
      }
      case "--account-type": {
        i += 1
        opts.accountType = argv[i] ?? "enterprise"
        break
      }
      case "--token": {
        i += 1
        opts.token = argv[i]
        break
      }
      case "--catalog-only": {
        opts.catalogOnly = true
        break
      }
      case "--json": {
        opts.json = true
        break
      }
      default: {
        consola.warn(`Unknown argument: ${arg}`)
      }
    }
  }

  return opts
}

/**
 * Mirrors `copilotBaseUrl` in src/lib/api-config.ts. Duplicated rather than
 * imported so the probe measures a literal URL a user would paste into
 * settings.json, independent of proxy state.
 */
function baseUrl(accountType: string): string {
  return accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`
}

/** Exactly the headers Claude Code sends — nothing Copilot-specific. */
function directHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  }
}

async function ghAuthToken(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = (await new Response(proc.stdout).text()).trim()
    const code = await proc.exited
    return code === 0 && out ? out : undefined
  } catch {
    return undefined
  }
}

/** Same order a direct-connect setup would resolve credentials in. */
async function resolveToken(
  explicit?: string,
): Promise<{ token: string; source: string }> {
  if (explicit) return { token: explicit, source: "--token" }

  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (env) return { token: env, source: "$GH_TOKEN" }

  const gh = await ghAuthToken()
  if (gh) return { token: gh, source: "gh auth token" }

  try {
    const stored = (await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")).trim()
    if (stored) return { token: stored, source: PATHS.GITHUB_TOKEN_PATH }
  } catch {
    // No stored token file — fall through to the error below.
  }

  throw new Error(
    "No GitHub token found. Pass --token, set $GH_TOKEN, or run `gh auth login`.",
  )
}

function truncate(text: string): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat
}

/** Both backend error shapes seen in the wild nest the text under `error`. */
function describeError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string }
      message?: string
    }
    const message = parsed.error?.message ?? parsed.message
    if (message) return truncate(message)
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return truncate(raw)
}

/** First text block of an Anthropic response, for a human-readable PASS detail. */
function describeReply(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = parsed.content?.find((block) => block.type === "text")?.text
    if (text) return `200, reply "${truncate(text)}"`
  } catch {
    // Not JSON — report the status alone.
  }
  return "200"
}

interface Outcome {
  ok: boolean
  detail: string
}

async function postMessages(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: directHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const raw = await response.text()
    return response.ok ?
        { ok: true, detail: describeReply(raw) }
      : { ok: false, detail: `${response.status} ${describeError(raw)}` }
  } catch (error) {
    return {
      ok: false,
      detail: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function userMessage(model: string, maxTokens: number) {
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: PROMPT }],
  }
}

/** GET /models with Claude Code's headers — also the auth check. */
async function fetchCatalog(
  url: string,
  token: string,
): Promise<ModelsResponse> {
  const response = await fetch(`${url}/models`, {
    headers: directHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status} ${describeError(raw)}`)
  }
  return JSON.parse(raw) as ModelsResponse
}

interface ProbeContext {
  url: string
  token: string
  catalog: ModelsResponse
  catalogOnly: boolean
}

/** Static checks read straight off /models — spends nothing. */
function catalogChecks(
  modelId: string,
  model: Model | undefined,
): Array<Check> {
  const checks: Array<Check> = []

  checks.push({
    scope: modelId,
    name: "catalog",
    status: model ? "PASS" : "FAIL",
    gating: true,
    detail:
      model ?
        `present, ctx=${model.capabilities.limits.max_context_window_tokens ?? "?"}, endpoints=[${(model.supported_endpoints ?? []).join(",")}]`
      : "id absent from /models — a direct request would 400 model_not_supported",
    remedy:
      "resolveModelId (src/lib/model-identity.ts) maps aliases via MODEL_MAPPINGS",
  })

  if (!model) return checks

  const nativeMessages = model.supported_endpoints?.includes("/v1/messages")
  checks.push({
    scope: modelId,
    name: "native-messages",
    status: nativeMessages ? "PASS" : "FAIL",
    gating: true,
    detail:
      nativeMessages ?
        "advertises /v1/messages"
      : `only [${(model.supported_endpoints ?? []).join(",")}] — unreachable over the Anthropic protocol`,
    remedy:
      "pickEgress (src/lib/endpoint-router.ts) bridges to /responses or /chat/completions",
  })

  return checks
}

/**
 * The gate: Claude Code's verbatim thinking schema, plus the adaptive shape the
 * proxy rewrites to as a control. standard FAIL + adaptive PASS means the
 * rewrite is still load-bearing; both FAIL means the backend moved again.
 */
async function thinkingChecks(
  ctx: ProbeContext,
  model: Model,
): Promise<Array<Check>> {
  if (!model.capabilities.supports.adaptive_thinking) {
    return [
      {
        scope: model.id,
        name: "thinking-standard",
        status: "SKIP",
        gating: false,
        detail: "model does not advertise adaptive_thinking",
      },
    ]
  }

  const standard = await postMessages(ctx.url, ctx.token, {
    ...userMessage(model.id, THINKING_MAX_TOKENS),
    thinking: { type: "enabled", budget_tokens: CC_THINKING_BUDGET },
  })

  const effort = clampReasoningEffort(model.id, "low") ?? "low"
  const adaptive = await postMessages(ctx.url, ctx.token, {
    ...userMessage(model.id, THINKING_MAX_TOKENS),
    thinking: { type: "adaptive" },
    output_config: { effort },
  })

  return [
    {
      scope: model.id,
      name: "thinking-standard",
      status: standard.ok ? "PASS" : "FAIL",
      gating: true,
      detail: standard.detail,
      remedy:
        "adaptThinkingForCopilot (src/services/copilot/create-messages.ts) rewrites it to the adaptive shape",
    },
    {
      scope: model.id,
      name: "thinking-adaptive",
      status: adaptive.ok ? "PASS" : "FAIL",
      gating: false,
      detail: `effort=${effort} · ${adaptive.detail}`,
    },
  ]
}

/** Informational: Claude Code sends the `[1m]` suffix verbatim when configured. */
async function suffixCheck(ctx: ProbeContext, model: Model): Promise<Check> {
  const suffixed = await postMessages(
    ctx.url,
    ctx.token,
    userMessage(`${model.id}[1m]`, 64),
  )

  return {
    scope: model.id,
    name: "model-suffix-1m",
    status: suffixed.ok ? "PASS" : "FAIL",
    gating: false,
    detail:
      suffixed.ok ?
        suffixed.detail
      : `${suffixed.detail} — keep ANTHROPIC_DEFAULT_*_MODEL suffix-free (native ctx is already ${model.capabilities.limits.max_context_window_tokens ?? "?"})`,
  }
}

async function probeModel(
  ctx: ProbeContext,
  modelId: string,
): Promise<Array<Check>> {
  const model = ctx.catalog.data.find((m) => m.id === modelId)
  const checks = catalogChecks(modelId, model)
  if (!model || ctx.catalogOnly) return checks

  // Baseline: no thinking. Isolates auth/model problems from schema problems.
  const plain = await postMessages(ctx.url, ctx.token, userMessage(modelId, 64))

  checks.push(
    {
      scope: modelId,
      name: "plain-completion",
      status: plain.ok ? "PASS" : "FAIL",
      gating: true,
      detail: plain.detail,
      remedy: "none — a failure here is upstream, not a translation gap",
    },
    ...(await thinkingChecks(ctx, model)),
    await suffixCheck(ctx, model),
  )

  return checks
}

function renderTable(checks: Array<Check>): void {
  const scopeWidth = Math.max(...checks.map((c) => c.scope.length))
  const nameWidth = Math.max(...checks.map((c) => c.name.length))

  for (const check of checks) {
    consola.log(
      `  ${check.status.padEnd(4)}  ${check.scope.padEnd(scopeWidth)}  ${check.name.padEnd(nameWidth)}  ${check.detail}`,
    )
  }
}

function renderVerdict(checks: Array<Check>, catalogOnly: boolean): boolean {
  const blockers = checks.filter((c) => c.gating && c.status === "FAIL")

  consola.log("")
  if (blockers.length > 0) {
    consola.error(
      `PROXY STILL REQUIRED — ${blockers.length} gating check(s) fail on the direct path:`,
    )
    for (const blocker of blockers) {
      consola.log(`  ✗ ${blocker.scope} · ${blocker.name}: ${blocker.detail}`)
      if (blocker.remedy)
        consola.log(`      proxy covers it: ${blocker.remedy}`)
    }
    return false
  }

  // --catalog-only never sends the thinking payload, so it cannot clear the one
  // gate that actually blocks direct connect. Say so instead of claiming a pass.
  if (catalogOnly) {
    consola.warn(
      "INCONCLUSIVE — catalog checks pass, but --catalog-only skipped the live"
        + " thinking gate. Re-run without it before switching to direct connect.",
    )
    return true
  }

  consola.success(
    "DIRECT CONNECT VIABLE — the proxy is optional for Claude Code.",
  )
  consola.log(
    "  Still proxy-only: Codex (/v1/responses), GPT/Gemini routing, tracing, rate limiting.",
  )
  return true
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.models.length === 0) {
    consola.error("No models selected.")
    process.exit(2)
  }

  let token: string
  let source: string
  try {
    ;({ token, source } = await resolveToken(opts.token))
  } catch (error) {
    consola.error(error instanceof Error ? error.message : error)
    process.exit(2)
  }

  const url = baseUrl(opts.accountType)
  consola.info(`Probing ${url} with a raw GitHub token from ${source}`)
  if (opts.catalogOnly)
    consola.info("--catalog-only: skipping live completions")

  let catalog: ModelsResponse
  try {
    catalog = await fetchCatalog(url, token)
  } catch (error) {
    consola.error(
      `GET /models failed — the backend does not accept this token directly: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(2)
  }

  // Seed proxy state so clampReasoningEffort resolves against the live catalog.
  state.models = catalog
  state.accountType = opts.accountType

  const checks: Array<Check> = [
    {
      scope: "-",
      name: "auth",
      status: "PASS",
      gating: true,
      detail: `GET /models 200, ${catalog.data.length} models (token from ${source})`,
    },
  ]

  const ctx: ProbeContext = {
    url,
    token,
    catalog,
    catalogOnly: opts.catalogOnly,
  }

  for (const modelId of opts.models) {
    checks.push(...(await probeModel(ctx, modelId)))
  }

  const viable = checks.every((c) => !c.gating || c.status !== "FAIL")

  if (opts.json) {
    consola.log(
      JSON.stringify(
        { baseUrl: url, catalogOnly: opts.catalogOnly, viable, checks },
        null,
        2,
      ),
    )
    process.exit(viable ? 0 : 1)
  }

  consola.log("")
  renderTable(checks)
  const ok = renderVerdict(checks, opts.catalogOnly)
  process.exit(ok ? 0 : 1)
}

await main()
