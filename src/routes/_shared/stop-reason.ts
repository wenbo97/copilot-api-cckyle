import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ResponseObject } from "~/routes/responses/responses-types"

import {
  ResponsesUpstreamError,
  responsesUpstreamError,
} from "~/services/copilot/responses-upstream-error"

/**
 * Anthropic `stop_reason` derived from (hasToolCall, status). Shared by the
 * non-stream and stream Responses->Anthropic bridges so the two can't drift.
 *
 * A terminal failure or truncation takes precedence over tool calls: partial
 * tool arguments must never be advertised as a completed tool invocation.
 */
export function deriveAnthropicStopReason(
  hasToolCall: boolean,
  response: ResponseObject,
): AnthropicResponse["stop_reason"] {
  if (response.status === "completed")
    return hasToolCall ? "tool_use" : "end_turn"
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens")
      return "max_tokens"
    if (response.incomplete_details?.reason === "content_filter")
      return "refusal"
    throw new ResponsesUpstreamError(
      502,
      "Upstream Responses returned an unknown incomplete reason.",
      "invalid_upstream_response",
    )
  }
  throw (
    responsesUpstreamError(response)
    ?? new ResponsesUpstreamError(
      502,
      `Upstream Responses returned status ${response.status}.`,
      "invalid_upstream_response",
    )
  )
}
