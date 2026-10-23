import type { ResponseInputReasoning } from "../responses/responses-types"
import type { AnthropicMessagesPayload } from "./anthropic-types"

// Carries Copilot's encrypted reasoning through Claude Code as an opaque
// `redacted_thinking` block, so the next bridged request can replay it and the
// model keeps its chain of thought across tool steps instead of re-deriving it.
const PREFIX = "copilot-reasoning:v1:"

/** Bridge features are on by default; `0`, `false` or `off` disables them. */
export function bridgeFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return !value || !["0", "false", "off"].includes(value)
}

export function bridgeReasoningEnabled(): boolean {
  return bridgeFlagEnabled("COPILOT_BRIDGE_REASONING")
}

export function encodeBridgeReasoning(item: {
  id?: string
  encrypted_content?: string | null
}): string | undefined {
  if (!bridgeReasoningEnabled()) return undefined
  if (typeof item.encrypted_content !== "string" || !item.encrypted_content)
    return undefined
  return (
    PREFIX
    + JSON.stringify({ id: item.id, encrypted_content: item.encrypted_content })
  )
}

const isBridgeBlock = (block: { type: string; data?: unknown }) =>
  block.type === "redacted_thinking"
  && typeof block.data === "string"
  && block.data.startsWith(PREFIX)

// Other egresses (Claude passthrough, chat) cannot verify Copilot Responses
// ciphertext, so drop our blocks when a session switches model family.
export function stripBridgeReasoning(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  const hasBlocks = payload.messages.some(
    (message) =>
      message.role === "assistant"
      && Array.isArray(message.content)
      && message.content.some((block) => isBridgeBlock(block)),
  )
  if (!hasBlocks) return payload
  return {
    ...payload,
    messages: payload.messages.map((message) =>
      message.role === "assistant" && Array.isArray(message.content) ?
        {
          ...message,
          content: message.content.filter((block) => !isBridgeBlock(block)),
        }
      : message,
    ),
  }
}

export function decodeBridgeReasoning(
  data: string,
): ResponseInputReasoning | undefined {
  if (!data.startsWith(PREFIX)) return undefined
  try {
    const value = JSON.parse(data.slice(PREFIX.length)) as {
      id?: unknown
      encrypted_content?: unknown
    }
    if (typeof value.encrypted_content !== "string" || !value.encrypted_content)
      return undefined
    return {
      type: "reasoning",
      ...(typeof value.id === "string" && { id: value.id }),
      summary: [],
      encrypted_content: value.encrypted_content,
    }
  } catch {
    return undefined
  }
}
