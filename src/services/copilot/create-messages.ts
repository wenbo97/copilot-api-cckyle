import { events } from "fetch-event-stream"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { clampReasoningEffort } from "~/lib/endpoint-router"
import { mapThinkingToReasoningEffort } from "~/routes/messages/non-stream-translation"

import { copilotFetch } from "./copilot-fetch"

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"

export interface CreateMessagesHeaders {
  anthropicVersion?: string
  anthropicBeta?: string
}

/**
 * Native `POST /v1/messages` egress to the Copilot backend.
 *
 * Mirrors `createResponses` and routes through the shared `copilotFetch`
 * chokepoint so auth, tier selection, and 401-retry stay unchanged. Used by the
 * Claude Code `/v1/messages` handler to pass requests straight through for
 * Claude models (which natively advertise `/v1/messages`) with NO response-side
 * translation — a lossless path that preserves thinking blocks, cache_control,
 * and native usage details the Messages->ChatCompletions->Messages round-trip
 * would drop.
 *
 * The ONLY request-side adaptation is the thinking schema (see
 * `adaptThinkingForCopilot`): Copilot's native endpoint rejects Anthropic's
 * `{type:"enabled", budget_tokens}` and requires `{type:"adaptive"}` +
 * `output_config.effort`. The response is never touched.
 */
export const createMessages = async (
  payload: AnthropicMessagesPayload,
  headers: CreateMessagesHeaders = {},
) => {
  const enableVision = hasVisionContent(payload)
  const isAgentCall = hasAgentMessages(payload)
  const body = adaptThinkingForCopilot(payload)

  const extraHeaders: Record<string, string> = {
    "X-Initiator": isAgentCall ? "agent" : "user",
    "anthropic-version": headers.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
  }
  if (headers.anthropicBeta) {
    extraHeaders["anthropic-beta"] = headers.anthropicBeta
  }
  if (enableVision) extraHeaders["copilot-vision-request"] = "true"

  const response = await copilotFetch("/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    extraHeaders,
  })

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicResponse
}

/**
 * Copilot's native /v1/messages rejects Anthropic's standard thinking shape
 * (`{type:"enabled", budget_tokens}`) and requires `{type:"adaptive"}` plus
 * `output_config.effort`. Claude Code always sends the standard shape, so we
 * translate that ONE field, mapping the token budget to a per-model-clamped
 * effort level (reusing the same budget->effort logic as the translate path).
 * Returns the payload unchanged when no enabled-thinking is present.
 */
function adaptThinkingForCopilot(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const thinking = payload.thinking
  if (!thinking || (thinking.type as string) !== "enabled") {
    return { ...payload }
  }

  const effort = clampReasoningEffort(
    payload.model,
    mapThinkingToReasoningEffort(thinking, payload.max_tokens) ?? "high",
  )

  const { thinking: _omit, ...rest } = payload
  return {
    ...rest,
    thinking: { type: "adaptive" },
    output_config: { effort },
  }
}

// Vision: any user message carrying an Anthropic `image` content block.
function hasVisionContent(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "image"),
  )
}

// Agent turn: any assistant message, or a user message bearing tool_result
// blocks (i.e. this is a continuation of an agentic loop, not a first prompt).
function hasAgentMessages(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "assistant"
      || (Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result")),
  )
}
