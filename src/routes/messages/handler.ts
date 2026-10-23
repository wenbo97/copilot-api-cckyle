import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { inspectCacheIntent } from "~/lib/cache-intent"
import { debugJson } from "~/lib/debug-log"
import { pickEgress } from "~/lib/endpoint-router"
import { resolveModelId } from "~/lib/model-identity"
import { checkRateLimit } from "~/lib/rate-limit"
import { RequestSummary } from "~/lib/request-summary"
import { responsesDiagnosticOrigin } from "~/lib/responses-diagnostics"
import { state } from "~/lib/state"
import { StreamTracer, traceRequest, traceResponse } from "~/lib/trace"
import { preserveStreamingRequest } from "~/routes/_shared/streaming-request"
import { createToolNameMap } from "~/routes/_shared/tool-name"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"
import { copilotRequestOptions } from "~/services/copilot/request-options"
import {
  describeHistoryRecovery,
  ResponsesUpstreamError,
} from "~/services/copilot/responses-upstream-error"

import type { ResponseStreamEvent } from "../responses/responses-types"

import { parseNativeResponsesSseData } from "../responses/stream-protocol"
import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
} from "./anthropic-types"
import { withBridgeCacheKey } from "./bridge-cache-key"
import { stripBridgeReasoning } from "./bridge-reasoning"
import { stabilizeBridgeTools } from "./bridge-stability"
import { streamMessagesFromChat } from "./chat-stream"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
  translateResponsesFailureToAnthropicEvents,
} from "./responses-stream-translation"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "./responses-translation"
import {
  withMessagesUsage,
  type MessagesUsageDiagnostics,
} from "./usage-diagnostics"
import { readMessagesUsage, type MessagesUsage } from "./usage-translation"

export async function handleCompletion(c: Context) {
  let anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  preserveStreamingRequest(c.req.raw, anthropicPayload)
  await checkRateLimit(state, c.req.raw.signal)
  debugJson("Anthropic request payload:", () => anthropicPayload)

  // Normalize the requested model id to a catalog id ONCE (exact id → alias →
  // strip [..] suffix), then route under that id.
  const resolved = resolveModelId(anthropicPayload.model)
  if (resolved !== anthropicPayload.model) {
    consola.info(
      `[Anthropic] Model resolved: "${anthropicPayload.model}" -> "${resolved}"`,
    )
    anthropicPayload = { ...anthropicPayload, model: resolved }
  }

  // Pick the egress endpoint from the live catalog for the Claude Code
  // (/v1/messages) inbound:
  //   /v1/messages      → native passthrough (lossless: thinking, cache_control,
  //                       native usage survive). Every Claude model advertises it.
  //   /responses        → Messages⇄Responses bridge so CC can reach /responses-only
  //                       models (gpt-5.5, gpt-5.3-codex). Documented-lossy cross.
  //   /chat/completions → legacy translate-down path.
  //   unsupported       → clean 4xx (no implemented leg for this model).
  const egress = pickEgress("messages", anthropicPayload.model)
  if (egress !== "/responses")
    anthropicPayload = stripBridgeReasoning(anthropicPayload)
  if (egress === "/v1/messages") {
    return withMessagesUsage("messages", (diagnostics) =>
      handlePassthroughMessages(c, anthropicPayload, diagnostics),
    )
  }
  if (egress === "/responses") {
    return withMessagesUsage("responses", (diagnostics) =>
      handleCompletionViaResponses(c, anthropicPayload, diagnostics),
    )
  }
  if (egress === "unsupported") {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model "${anthropicPayload.model}" is not reachable via /v1/messages, /responses, or /chat/completions.`,
        },
      },
      400,
    )
  }

  return withMessagesUsage("chat", (diagnostics) =>
    handleCompletionViaChat(c, anthropicPayload, diagnostics),
  )
}

async function handleCompletionViaChat(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  diagnostics: MessagesUsageDiagnostics,
) {
  // Trace the original Anthropic request
  const traceTimestamp = await traceRequest({
    type: "anthropic",
    original: anthropicPayload,
  })

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.info(
    `[Anthropic] Using model: "${anthropicPayload.model}" -> translated to: "${openAIPayload.model}"`,
  )

  debugJson("Translated OpenAI request payload:", () => openAIPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const requestOptions = copilotRequestOptions(
    c.req.raw.signal,
    new RequestSummary("messages", anthropicPayload.model),
  )
  const trailerController = new AbortController()
  const response = await createChatCompletions(openAIPayload, {
    ...requestOptions,
    signal: AbortSignal.any([requestOptions.signal, trailerController.signal]),
  })

  if (isNonStreaming(response)) {
    debugJson("Non-streaming response from Copilot:", () => response, 400)
    const anthropicResponse = translateToAnthropic(response)
    diagnostics.finish(readMessagesUsage(response.usage, "chat"))
    debugJson("Translated Anthropic response:", () => anthropicResponse)
    // Trace the response (both OpenAI and translated Anthropic)
    await traceResponse(
      {
        type: "anthropic",
        openai: response,
        translated: anthropicResponse,
      },
      traceTimestamp,
    )
    return c.json(anthropicResponse)
  }

  return streamMessagesFromChat(c, {
    response,
    requestOptions,
    trailerController,
    traceTimestamp,
    diagnostics,
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Native /v1/messages passthrough for Claude models. No translation in either
 * direction — the Anthropic request body is forwarded as-is and the native
 * Anthropic response / SSE frames are returned unchanged (lossless). The exact
 * resolved catalog model id (from resolveModelId at handler entry) is preserved.
 * Tracing still runs.
 */
async function handlePassthroughMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
  diagnostics: MessagesUsageDiagnostics,
) {
  consola.info(`[Anthropic] Using model: "${payload.model}" (passthrough)`)

  const traceTimestamp = await traceRequest({
    type: "anthropic-passthrough",
    original: payload,
  })

  if (state.manualApprove) await awaitApproval()

  const summary = new RequestSummary("messages", payload.model)
  diagnostics.setRequestId(summary.id)
  const finishDiagnostics = () =>
    diagnostics.finish(passthroughUsage(summary), () =>
      passthroughDiagnostics(payload, summary),
    )
  const requestOptions = copilotRequestOptions(c.req.raw.signal, summary)
  const response = await createMessages(
    payload,
    {
      anthropicVersion: c.req.header("anthropic-version"),
      anthropicBeta: c.req.header("anthropic-beta"),
    },
    requestOptions,
  )

  if (isMessagesNonStreaming(response)) {
    finishDiagnostics()
    debugJson(
      "Non-streaming passthrough response from Copilot:",
      () => response,
      400,
    )
    await traceResponse(
      { type: "anthropic-passthrough", native: response },
      traceTimestamp,
    )
    return c.json(response)
  }

  consola.debug("Streaming passthrough response from Copilot")
  return streamSSE(c, async (stream) => {
    stream.onAbort(requestOptions.abort)
    const streamTracer = new StreamTracer(traceTimestamp)

    try {
      for await (const rawEvent of response) {
        debugJson("Copilot raw messages event:", () => rawEvent)
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue

        streamTracer.addChunk(rawEvent)
        // Forward the native Anthropic SSE frame unchanged.
        await stream.writeSSE({
          event: rawEvent.event,
          data: rawEvent.data,
        })
      }
    } finally {
      finishDiagnostics()
      await streamTracer.finish()
    }
  })
}

function passthroughUsage(summary: RequestSummary): MessagesUsage {
  return {
    totalInput: summary.usage.totalInput,
    cachedInput: summary.usage.cachedInput,
    output: summary.usage.output,
    // Native Anthropic reports cache creation as its own verified counter.
    unverifiedWrite: false,
  }
}

function passthroughDiagnostics(
  payload: AnthropicMessagesPayload,
  summary: RequestSummary,
): Record<string, unknown> {
  const intent = inspectCacheIntent(payload, "messages")
  return {
    cache_write_tokens: summary.usage.cacheWrite ?? null,
    // cache_control is forwarded unchanged on the native path.
    cache_intent: {
      ...intent,
      status: intent.present ? "observed" : "absent",
    },
  }
}

// Non-streaming native responses are a plain Anthropic Message object (has a
// `type` field); the streaming branch returns an async event iterator.
const isMessagesNonStreaming = (
  response: Awaited<ReturnType<typeof createMessages>>,
): response is AnthropicResponse => Object.hasOwn(response, "type")

/**
 * Bridge Claude Code (/v1/messages) to a /responses-native model (gpt-5.5,
 * gpt-5.3-codex). Translates the Anthropic request into a Responses request,
 * calls the native /responses egress, then translates the Responses result
 * back into Anthropic shape. Documented-lossy: reasoning original text is
 * dropped (backend-encrypted), as are cache_control / strict tools / top_k.
 */
async function handleCompletionViaResponses(
  c: Context,
  payload: AnthropicMessagesPayload,
  diagnostics: MessagesUsageDiagnostics,
) {
  consola.info("[Anthropic→Responses] Using model:", payload.model)

  const origin = responsesDiagnosticOrigin(
    "messages",
    payload,
    c.req.raw.headers,
  )
  diagnostics.setRequestId(origin?.requestId)
  const bridged = stabilizeBridgeTools(payload)
  const toolNames = createToolNameMap(bridged)
  const responsesPayload = withBridgeCacheKey(
    translateAnthropicToResponses(bridged, toolNames),
    payload,
  )

  const traceTimestamp = await traceRequest({
    type: "anthropic-via-responses",
    original: payload,
    translated: responsesPayload,
  })

  if (state.manualApprove) await awaitApproval()

  const requestOptions = copilotRequestOptions(
    c.req.raw.signal,
    new RequestSummary("messages", payload.model),
  )
  const response = await createResponses(responsesPayload, {
    ...requestOptions,
    responsesDiagnostics: origin,
  })

  if (isResponsesNonStreaming(response)) {
    const anthropicResponse = translateResponsesToAnthropic(
      response,
      payload.model,
      toolNames,
    )
    diagnostics.finish(readMessagesUsage(response.usage, "responses"))
    await traceResponse(
      {
        type: "anthropic-via-responses",
        responses: response,
        translated: anthropicResponse,
      },
      traceTimestamp,
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response via Responses bridge")
  return streamSSE(c, async (stream) => {
    stream.onAbort(requestOptions.abort)
    const streamState = createResponsesToAnthropicState(
      payload.model,
      toolNames,
    )
    const streamTracer = new StreamTracer(traceTimestamp)
    const fail = async (message: string) => {
      for (const event of translateResponsesFailureToAnthropicEvents(
        message,
        streamState,
      )) {
        streamTracer.addChunk({ anthropic: event })
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    try {
      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue

        const responsesEvent = parseNativeResponsesSseData(
          rawEvent.data,
        ) as unknown as ResponseStreamEvent
        const events = translateResponsesEventToAnthropicEvents(
          responsesEvent,
          streamState,
        )

        for (const event of events) {
          streamTracer.addChunk({ responses: responsesEvent, anthropic: event })
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
        if (streamState.terminalSeen) break
      }
      if (!requestOptions.signal.aborted && !streamState.terminalSeen)
        await fail("Upstream Responses stream ended before a terminal event.")
    } catch (error) {
      if (!requestOptions.signal.aborted) await fail(bridgeFailureText(error))
    } finally {
      diagnostics.finish(streamState.usage)
      await streamTracer.finish()
    }
  })
}

function bridgeFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof ResponsesUpstreamError)) return message
  return message + describeHistoryRecovery(error.recovery)
}

// The native /responses egress returns a ResponseObject (has an `output` array)
// when non-streaming, or an async SSE-event iterator when streaming.
const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is Extract<typeof response, { output: unknown }> =>
  Object.hasOwn(response, "output")
