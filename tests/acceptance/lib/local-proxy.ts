import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { ensureCopilotToken } from "~/lib/token"
import { server } from "~/server"

import { stringValue } from "./local-budget"
import {
  prepareGeneration,
  record,
  type Phase,
  type Json,
} from "./local-budget"
import { projectWireEvent } from "./local-client-evidence"
import { readE2eAuthorization } from "./local-e2e-authorization"
import { executionManifest, identitySha256 } from "./local-identity"
import { observeBody } from "./local-wire"

const loadedIdentitySha256 = identitySha256(executionManifest())
const e2eAuthorizationFile = process.env.ACCEPTANCE_E2E_AUTHORIZATION
const e2eAuthorization =
  e2eAuthorizationFile ?
    readE2eAuthorization(
      record(JSON.parse(readFileSync(e2eAuthorizationFile, "utf8"))),
    )
  : undefined

const controlUrl = process.env.ACCEPTANCE_CONTROL_URL
const secret = process.env.ACCEPTANCE_SECRET
const directory = process.env.ACCEPTANCE_DIRECTORY
if (!controlUrl || !secret || !directory)
  throw new Error("Use the local acceptance runner")
const controllerUrl = controlUrl
const evidenceDirectory = directory
const controllerSecret = secret
const originalFetch = globalThis.fetch
const context = new AsyncLocalStorage<{
  caseId: string
  phase: Phase
  ingress?: Json
  requestId?: string
}>()
let defaultContext: { caseId: string; phase: Phase; requestId?: string } = {
  caseId: "unassigned",
  phase: "functional",
}
let active = 0
let blocked = 0
// Observe the public admission timestamp in the test child, before translation
// and tokenization. Final network reservations can be closer together than slots.
const rateAdmissions: Array<number> = []
let admissionTimestamp = state.lastRequestTimestamp
Object.defineProperty(state, "lastRequestTimestamp", {
  configurable: true,
  enumerable: true,
  get: () => admissionTimestamp,
  set: (value: number | undefined) => {
    admissionTimestamp = value
    if (value !== undefined) rateAdmissions.push(value)
  },
})

PATHS.APP_DIR = path.join(directory, "app-state")
PATHS.GITHUB_TOKEN_PATH = path.join(PATHS.APP_DIR, "github_token")
state.responsesHistoryDirectory = path.join(directory, "history")

async function control(route: string, body: unknown) {
  const result = await originalFetch(`${controllerUrl}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acceptance-secret": controllerSecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const json = record(await result.json())
  if (!result.ok)
    throw new Error(
      stringValue(json.error) || "Budget controller rejected request",
    )
  return json
}

function isMetadataRequest(url: URL, method: string): boolean {
  if (method !== "GET") return false
  if (
    url.hostname === "127.0.0.1"
    && url.port === (process.env.VSCODE_PROXY_PORT ?? "18774")
    && url.pathname === "/token"
  )
    return true
  if (url.hostname === "aur.archlinux.org") return true
  return isUpstream(url) && url.pathname === "/models"
}
function isUpstream(url: URL): boolean {
  return (
    url.protocol === "https:"
    && /^api(?:\.(?:individual|business|enterprise))?\.githubcopilot\.com$/u.test(
      url.hostname,
    )
  )
}

function egressSummary(payload: Json): Json {
  return {
    model: payload.model,
    ...inputSummary(payload.input),
    reasoningEffort:
      record(payload.reasoning).effort ?? payload.reasoning_effort ?? null,
  }
}

function inputSummary(input: unknown): Json {
  if (input === undefined) return {}
  let text: unknown = input
  if (Array.isArray(input) && input.length === 1)
    text = record(input[0]).content
  return {
    inputShape: Array.isArray(input) ? "array" : typeof input,
    ...(typeof text === "string" ?
      {
        inputCharacters: text.length,
        inputTextSha256: createHash("sha256").update(text).digest("hex"),
      }
    : {}),
  }
}

function requestTarget(input: string | URL | Request, init?: RequestInit) {
  return {
    url: new URL(input instanceof Request ? input.url : String(input)),
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
  }
}

function prepareObservedRequest(
  pathname: string,
  payload: Json,
  caseId: string,
) {
  const cap = e2eAuthorization?.cases[caseId]
  if (e2eAuthorization && !cap)
    throw new Error("Unassigned E2E request blocked")
  return prepareGeneration(pathname, payload, cap)
}

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const { url, method } = requestTarget(input, init)
    if (isMetadataRequest(url, method))
      return originalFetch(input, { ...init, redirect: "error" })
    if (!isUpstream(url) || method !== "POST")
      throw new Error("Acceptance network allowlist rejected request")
    let grantId = ""
    let egress: Json = {}
    try {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON generation body")
      const payload = record(JSON.parse(init.body))
      egress = egressSummary(payload)
      const owner = context.getStore() ?? defaultContext
      const prepared = prepareObservedRequest(
        url.pathname,
        payload,
        owner.caseId,
      )
      const grant = await control("reserve", {
        ...owner,
        egress,
        model: prepared.body.model,
        endpoint: url.pathname,
        inputTokens: prepared.inputTokens,
        outputTokens: prepared.outputTokens,
        effort: prepared.effort,
        limitApplied: prepared.limitApplied,
      })
      grantId = String(grant.id)
      active++
      const started = performance.now()
      let headerDurationMs: number | undefined
      let completed = false
      const finish = async (observation: unknown) => {
        if (completed) return
        completed = true
        active--
        await control("observe", {
          id: grantId,
          observation: {
            ...record(observation),
            upstreamSignalAborted: init.signal?.aborted ?? false,
            headerDurationMs,
            totalDurationMs: performance.now() - started,
          },
        })
      }
      try {
        const response = await originalFetch(input, {
          ...init,
          body: prepared.serialized,
          redirect: "error",
        })
        headerDurationMs = performance.now() - started
        return await observeUpstream(response, finish, {
          owner,
          grantId,
          tools: prepared.body.tools,
        })
      } catch (error) {
        await finish({ outcome: "fetch_error", usage: null })
        throw error
      }
    } catch (error) {
      if (!grantId) {
        blocked++
        await control("blocked", {
          ...(context.getStore() ?? defaultContext),
          egress,
          reason:
            error instanceof Error ? error.message : "Unknown guard error",
        })
      }
      throw error
    }
  },
  { preconnect: originalFetch.preconnect },
)

const originalHandler = server.fetch.bind(server)
server.fetch = async (request, env, executionCtx) => {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/__acceptance/")) {
    return (async () => {
      if (request.headers.get("x-acceptance-secret") !== controllerSecret)
        return new Response("Forbidden", { status: 403 })
      if (url.pathname.endsWith("/health"))
        return Response.json({
          pid: process.pid,
          active,
          blocked,
          rss: process.memoryUsage().rss,
          accountType: state.accountType,
          bridgeOnly: !state.githubToken,
          uptime: process.uptime(),
          rateAdmissions,
          loadedIdentitySha256,
        })
      if (url.pathname.endsWith("/configure") && request.method === "POST") {
        const body = record(await request.json())
        defaultContext = {
          caseId: String(body.caseId),
          phase: String(body.phase) as Phase,
        }
        if (body.cachePolicy === "off" || body.cachePolicy === "prefix-v1")
          process.env.COPILOT_CACHE_POLICY = body.cachePolicy
        if (body.refresh === true) await ensureCopilotToken(true)
        if (
          typeof body.rateLimitSeconds === "number"
          && Number.isFinite(body.rateLimitSeconds)
          && body.rateLimitSeconds >= 0
        ) {
          state.rateLimitSeconds = body.rateLimitSeconds || undefined
          state.rateLimitWait = body.rateLimitSeconds > 0
          if (body.resetRateLimit === true) {
            state.lastRequestTimestamp = Date.now()
            rateAdmissions.length = 0
          }
        }
        return Response.json({ ok: true })
      }
      return new Response("Not found", { status: 404 })
    })()
  }
  const owner = request.headers.get("x-acceptance-case")
  let ingress: Json | undefined
  let tools: unknown
  if (request.method === "POST") {
    const body = record(await request.clone().json())
    tools = body.tools
    ingress = {
      model: body.model,
      ...inputSummary(body.input),
      thinking: {
        type: record(body.thinking).type ?? null,
        budget_tokens: record(body.thinking).budget_tokens ?? null,
      },
      outputConfigEffort: record(body.output_config).effort ?? null,
      reasoningEffort:
        record(body.reasoning).effort ?? body.reasoning_effort ?? null,
    }
  }
  const selected =
    owner ?
      {
        caseId: owner,
        phase: (request.headers.get("x-acceptance-phase")
          ?? "functional") as Phase,
      }
    : defaultContext
  const requestId = randomUUID()
  return context.run({ ...selected, ingress, requestId }, async () => {
    const response = await originalHandler(request, env, executionCtx)
    if (!isClaudeToolCase(selected.caseId)) return response
    return observeMessages(response, { requestId, tools })
  })
}

function observeMessages(
  response: Response,
  capture: { requestId: string; tools: unknown },
) {
  const { requestId, tools } = capture
  const events: Array<Json> = []
  return observeBody(
    response,
    () => {
      writeFileSync(
        path.join(evidenceDirectory, `${requestId}-messages.json`),
        JSON.stringify(
          { requestId, tools: readSchema(tools), events },
          null,
          2,
        ),
      )
      return Promise.resolve()
    },
    (event) => {
      if (
        events.length < 100
        && (event.usage
          || record(event.message).usage
          || event.type === "message_stop")
      )
        events.push({
          type: event.type,
          usage: event.usage ?? record(event.message).usage,
          stopReason: record(event.delta).stop_reason,
        })
    },
  )
}

function observeUpstream(
  response: Response,
  finish: Parameters<typeof observeBody>[1],
  capture: {
    owner: { caseId: string; requestId?: string }
    grantId: string
    tools: unknown
  },
) {
  const { owner, grantId, tools } = capture
  const events: Array<Json> = []
  return observeBody(
    response,
    async (observation) => {
      if (isClaudeToolCase(owner.caseId))
        writeFileSync(
          path.join(
            evidenceDirectory,
            `${owner.requestId}-${grantId}-upstream.json`,
          ),
          JSON.stringify(
            {
              requestId: owner.requestId,
              grantId,
              tools: readSchema(tools),
              events,
            },
            null,
            2,
          ),
        )
      await finish(observation)
    },
    (event) => {
      if (isClaudeToolCase(owner.caseId) && events.length < 100) {
        const projected = projectWireEvent(event)
        if (projected.usage || projected.status || projected.readCall)
          events.push(projected)
      }
    },
  )
}

function isClaudeToolCase(id: string): boolean {
  return (
    id === "claude-tool"
    || /^e2e-gpt-[\d.]+-(?:luna|terra|sol|astra)(?:-fast)?-claude-[ab]$/u.test(
      id,
    )
    || /^matrix-gpt-[\d.]+-(?:luna|terra|sol|astra)-claude-tool$/u.test(id)
  )
}

function readSchema(tools: unknown): unknown {
  if (!Array.isArray(tools)) return null
  const tool = tools
    .map((item) => record(item))
    .find((item) => item.name === "Read")
  if (!tool) return null
  const schema = tool.input_schema ?? tool.parameters
  const serialized = JSON.stringify(schema)
  return serialized && serialized.length <= 32000 ?
      schema
    : { omitted: "schema exceeded bound" }
}

// Import after installing the guard; even startup cannot fall back to old OAuth.
const { runServer } = await import("~/start")
await runServer({
  port: Number(process.env.ACCEPTANCE_PORT ?? "4143"),
  accountType: process.env.ACCEPTANCE_ACCOUNT_TYPE ?? "individual",
  verbose: process.env.ACCEPTANCE_VERBOSE === "1",
  manual: false,
  rateLimitWait: false,
  showToken: false,
  githubToken: "acceptance-bridge-only",
  claudeCode: false,
  proxyEnv: false,
  trace: process.env.ACCEPTANCE_TRACE === "1",
  traceFolder: path.join(evidenceDirectory, "traces"),
})

// A lost parent must not leave a credential-refreshing child behind.
let missedHeartbeats = 0
const parentWatchdog = setInterval(() => {
  void control("heartbeat", {})
    .then(() => {
      missedHeartbeats = 0
    })
    .catch(() => {
      missedHeartbeats++
      if (missedHeartbeats >= 6) process.exit(3)
    })
}, 10000)
parentWatchdog.unref()
