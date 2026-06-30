import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ResponseObject } from "~/routes/responses/responses-types"

/**
 * Anthropic `stop_reason` derived from (hasToolCall, status). Shared by the
 * non-stream and stream Responses->Anthropic bridges so the two can't drift.
 *
 * Order matters: a tool call always wins (Anthropic clients branch on
 * `tool_use` before inspecting anything else), then an `incomplete` status maps
 * to `max_tokens`, otherwise `end_turn`.
 */
export function deriveAnthropicStopReason(
  hasToolCall: boolean,
  status: ResponseObject["status"] | undefined,
): AnthropicResponse["stop_reason"] {
  if (hasToolCall) return "tool_use"
  if (status === "incomplete") return "max_tokens"
  return "end_turn"
}
