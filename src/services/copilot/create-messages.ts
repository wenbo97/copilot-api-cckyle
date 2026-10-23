import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import {
  summarizeFailure,
  summarizeJson,
  summarizeStream,
} from "~/lib/request-summary"
import {
  clampReasoningEffort,
  resolveMessagesReasoningEffort,
} from "~/routes/_shared/reasoning-policy"

import type { CopilotRequestOptions } from "./request-options"

import { copilotFetch } from "./copilot-fetch"
import { CopilotStreamLifecycle } from "./stream-lifecycle"

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
  options: CopilotRequestOptions = {},
) => {
  const body = adaptThinkingForCopilot(payload)
  const extraHeaders = buildMessagesHeaders(payload, headers)

  const lifecycle =
    payload.stream ?
      new CopilotStreamLifecycle(options.signal, options.streamTimeouts)
    : undefined
  const summary = options.summary
  try {
    const serializedBody = JSON.stringify(body)
    summary?.attempt("messages", serializedBody, payload.messages.length)
    const response = await copilotFetch("/v1/messages", {
      method: "POST",
      body: serializedBody,
      extraHeaders,
      signal: lifecycle?.signal ?? options.signal,
      headerTimeoutMs: options.headerTimeoutMs,
      disableNativeTimeout: payload.stream === true,
    })

    if (lifecycle) return summarizeStream(summary, lifecycle.iterate(response))

    return summarizeJson(summary, (await response.json()) as AnthropicResponse)
  } catch (error) {
    lifecycle?.dispose(error)
    summarizeFailure(summary, error)
    throw error
  }
}

function buildMessagesHeaders(
  payload: AnthropicMessagesPayload,
  headers: CreateMessagesHeaders,
): Record<string, string> {
  const extraHeaders: Record<string, string> = {
    "X-Initiator": hasAgentMessages(payload) ? "agent" : "user",
    "anthropic-version": headers.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
  }
  if (headers.anthropicBeta) {
    extraHeaders["anthropic-beta"] = headers.anthropicBeta
  }
  if (hasVisionContent(payload)) extraHeaders["copilot-vision-request"] = "true"
  return extraHeaders
}

/**
 * Copilot's native /v1/messages rejects Anthropic's standard thinking shape
 * (`{type:"enabled", budget_tokens}`) and requires `{type:"adaptive"}` plus
 * `output_config.effort`. Legacy clients send the enabled shape, so we
 * translate that field, mapping the token budget to a per-model-clamped
 * effort level (reusing the same budget->effort logic as the translate path).
 * Returns the payload unchanged when no enabled-thinking is present.
 */
function adaptThinkingForCopilot(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const thinking = payload.thinking
  const effort = clampReasoningEffort(
    payload.model,
    resolveMessagesReasoningEffort(payload),
  )
  if (!thinking || thinking.type !== "enabled") {
    return effort === undefined ?
        { ...payload }
      : {
          ...payload,
          output_config: { ...payload.output_config, effort },
        }
  }
  return {
    ...payload,
    thinking: { type: "adaptive" },
    output_config: { ...payload.output_config, effort },
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
