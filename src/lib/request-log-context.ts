import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import { cacheFingerprint } from "~/lib/cache-fingerprint"
import { cacheDiagnosticIdentity } from "~/lib/cache-history"
import { claudeCodeSessionId } from "~/routes/messages/bridge-cache-key"

export interface RequestLogContext {
  requestId: string
  session: string
  agent: "claude-code" | "codex" | "other" | "unknown"
  role: string
  agentType?: string
}

export const requestLogStorage = new AsyncLocalStorage<RequestLogContext>()

export function requestLogContext(): RequestLogContext | undefined {
  return requestLogStorage.getStore()
}

export function createRequestLogContext(headers: Headers): RequestLogContext {
  const session = headers.get("x-claude-code-session-id")
  const agent = headers.get("x-claude-code-agent-id")
  const requestClass = headers.get("x-claude-code-request-class")
  const codex = cacheDiagnosticIdentity(undefined, headers)
  const agentType = headers.get("x-claude-code-agent-type")
  return {
    requestId: randomUUID(),
    session: session ? logIdentifier(session) : codexSession(headers),
    agent: clientAgent(headers),
    role: declaredRole(agent, requestClass, codex.role),
    ...(agentType && /^[\w.-]{1,48}$/u.test(agentType) ? { agentType } : {}),
  }
}

function clientAgent(headers: Headers): RequestLogContext["agent"] {
  const userAgent = headers.get("user-agent")?.trim() ?? ""
  const claude =
    /^(?:claude-cli|claude-code)\//i.test(userAgent)
    || headers.has("x-claude-code-request-class")
    || headers.has("x-claude-code-session-id")
  const codex =
    /^(?:codex_cli_rs|codex-cli|codex)\//i.test(userAgent)
    || headers.has("x-codex-turn-metadata")
    || headers.has("x-codex-parent-thread-id")
  if (claude && codex) return "unknown"
  if (claude) return "claude-code"
  if (codex) return "codex"
  return userAgent ? "other" : "unknown"
}

function declaredRole(
  agent: string | null,
  requestClass: string | null,
  codexRole: string,
): string {
  if (agent) return `subagent:${shortIdentity("agent", agent)}`
  if (requestClass === "main" || requestClass === "compaction")
    return requestClass
  if (requestClass === "subagent" || codexRole === "subagent")
    return "subagent:?"
  return codexRole === "unknown" ? "?" : codexRole
}

/** Client declarations only; model, cache key and prompt content are not identity. */
export function observeRequestLogIdentity(
  payload: unknown,
  headers: Headers,
): void {
  const context = requestLogContext()
  if (!context) return
  if (typeof payload !== "object" || payload === null) return
  const codex = cacheDiagnosticIdentity(payload, headers)
  if (
    context.agent !== "claude-code"
    && (codex.conflict || codex.metadata_incomplete)
  ) {
    context.session = "?"
    context.role = "?"
    return
  }
  if (context.session === "?") context.session = legacyClaudeSession(payload)
  if (codex.thread && context.session === "?")
    context.session = codexSession(headers, payload)
  if (context.role === "?" && codex.role !== "unknown")
    context.role = codex.role === "subagent" ? "subagent:?" : codex.role
}

function legacyClaudeSession(payload: object): string {
  if (!("metadata" in payload)) return "?"
  const metadata = payload.metadata
  if (
    typeof metadata !== "object"
    || metadata === null
    || !("user_id" in metadata)
  )
    return "?"
  const userId = metadata.user_id
  return typeof userId === "string" && userId.length <= 32_768 ?
      logIdentifier(claudeCodeSessionId(userId))
    : "?"
}

function logIdentifier(value: unknown): string {
  return typeof value === "string" && /^[\w.-]{1,128}$/u.test(value) ?
      value
    : "?"
}

function codexSession(headers: Headers, payload?: unknown): string {
  const identity = cacheDiagnosticIdentity(payload, headers)
  if (!identity.thread) return "?"
  const direct = logIdentifier(headers.get("thread-id"))
  if (direct !== "?") return direct
  const values: Array<unknown> = [headers.get("x-codex-turn-metadata")]
  if (
    typeof payload === "object"
    && payload !== null
    && "client_metadata" in payload
  ) {
    const metadata = payload.client_metadata
    if (
      typeof metadata === "object"
      && metadata !== null
      && "x-codex-turn-metadata" in metadata
    )
      values.push(metadata["x-codex-turn-metadata"])
  }
  for (const value of values) {
    const thread = metadataThread(value)
    if (thread !== "?") return thread
  }
  return "?"
}

function metadataThread(value: unknown): string {
  if (typeof value !== "string" || value.length > 32_768) return "?"
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    if (error instanceof SyntaxError) return "?"
    throw error
  }
  return (
      typeof parsed === "object" && parsed !== null && "thread_id" in parsed
    ) ?
      logIdentifier(parsed.thread_id)
    : "?"
}

function shortIdentity(kind: string, value: string | null | undefined): string {
  if (
    !value
    || value.length > 256
    || Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 32 || code === 127
    })
  )
    return "?"
  return cacheFingerprint([kind, value])?.slice(0, 12) ?? "?"
}

export function requestLogLabel(context: RequestLogContext): string {
  return `[agent=${context.agent} session=${context.session} role=${context.role}${context.agentType ? `/${context.agentType}` : ""}]`
}
