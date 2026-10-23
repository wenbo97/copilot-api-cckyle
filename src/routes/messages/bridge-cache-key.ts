import { createHash } from "node:crypto"

import type { ResponsesPayload } from "~/routes/responses/responses-types"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { bridgeFlagEnabled } from "./bridge-reasoning"

const SESSION_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const LEGACY_SESSION = /_session_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i

/**
 * Default-on (`COPILOT_BRIDGE_CACHE_KEY=0` disables) `prompt_cache_key` for the
 * Messages→Responses bridge, scoped to one Claude Code session and model so
 * that a session's turns share upstream cache routing. Only a digest is sent.
 */
export function withBridgeCacheKey(
  responses: ResponsesPayload,
  anthropic: AnthropicMessagesPayload,
): ResponsesPayload {
  if (!bridgeFlagEnabled("COPILOT_BRIDGE_CACHE_KEY")) return responses
  if (typeof responses.prompt_cache_key === "string") return responses
  const session = claudeCodeSessionId(anthropic.metadata?.user_id)
  if (!session) return responses
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: "cc-v1",
        namespace: process.env.COPILOT_CACHE_NAMESPACE?.trim() ?? "",
        model: responses.model,
        session,
      }),
    )
    .digest("hex")
  return { ...responses, prompt_cache_key: `cc-v1:${digest.slice(0, 48)}` }
}

/** Claude Code sends either a JSON string with `session_id` or `..._session_<uuid>`. */
export function claudeCodeSessionId(
  userId: string | undefined,
): string | undefined {
  if (!userId) return
  if (userId.startsWith("{")) {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown }
      const session = parsed.session_id
      return typeof session === "string" && SESSION_ID.test(session) ?
          session.toLowerCase()
        : undefined
    } catch {
      return
    }
  }
  return LEGACY_SESSION.exec(userId)?.[1]?.toLowerCase()
}
