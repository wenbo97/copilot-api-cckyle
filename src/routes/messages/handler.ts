import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { modelSupportsEndpoint } from "~/lib/endpoint-router"
import { applyModelMapping, getModelMappings } from "~/lib/model-mapping"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { StreamTracer, traceRequest, traceResponse } from "~/lib/trace"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"

import type { ResponseStreamEvent } from "../responses/responses-types"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  createResponsesToAnthropicState,
  translateResponsesEventToAnthropicEvents,
} from "./responses-stream-translation"
import {
  translateAnthropicToResponses,
  translateResponsesToAnthropic,
} from "./responses-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Apply model mapping if configured
  const originalModel = anthropicPayload.model
  const mappings = getModelMappings()
  if (mappings.size > 0) {
    const { model, mapped } = applyModelMapping(
      anthropicPayload.model,
      mappings,
      state.verbose,
    )
    if (mapped) {
      consola.info(
        `[Anthropic] Model mapping: "${originalModel}" -> "${model}"`,
      )
      anthropicPayload = { ...anthropicPayload, model }
    }
  }

  // Endpoint routing: if the resolved model natively accepts /v1/messages (every
  // Claude model does), forward the Anthropic request straight through with NO
  // translation — lossless, preserving thinking blocks, cache_control, and native
  // usage details the Messages->ChatCompletions->Messages round-trip would drop.
  if (modelSupportsEndpoint(anthropicPayload.model, "/v1/messages")) {
    return handlePassthroughMessages(c, anthropicPayload)
  }

  // Else if the model is /responses-native (gpt-5.5, gpt-5.3-codex), bridge
  // Anthropic Messages <-> OpenAI Responses so Claude Code can reach it. This is
  // a documented-lossy cross-protocol path (reasoning original text is encrypted
  // by the backend; cache_control / strict tools / top_k do not map).
  if (modelSupportsEndpoint(anthropicPayload.model, "/responses")) {
    return handleCompletionViaResponses(c, anthropicPayload)
  }

  // Trace the original Anthropic request
  const traceTimestamp = await traceRequest({
    type: "anthropic",
    original: anthropicPayload,
  })

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.info(
    `[Anthropic] Using model: "${anthropicPayload.model}" -> translated to: "${openAIPayload.model}"`,
  )

  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
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

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    const streamTracer = new StreamTracer(traceTimestamp)

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        streamTracer.addChunk({ openai: chunk, anthropic: event })
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    await streamTracer.finish()
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

/**
 * Native /v1/messages passthrough for Claude models. No translation in either
 * direction — the Anthropic request body is forwarded as-is and the native
 * Anthropic response / SSE frames are returned unchanged (lossless). The exact
 * resolved catalog model id is preserved (translateModelName is NOT applied here,
 * since it would collapse claude-opus-4.8 -> claude-opus-4). Tracing still runs.
 */
async function handlePassthroughMessages(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  const traceTimestamp = await traceRequest({
    type: "anthropic-passthrough",
    original: payload,
  })

  if (state.manualApprove) await awaitApproval()

  const response = await createMessages(payload, {
    anthropicVersion: c.req.header("anthropic-version"),
    anthropicBeta: c.req.header("anthropic-beta"),
  })

  if (isMessagesNonStreaming(response)) {
    consola.debug(
      "Non-streaming passthrough response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    await traceResponse(
      { type: "anthropic-passthrough", native: response },
      traceTimestamp,
    )
    return c.json(response)
  }

  consola.debug("Streaming passthrough response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamTracer = new StreamTracer(traceTimestamp)

    for await (const rawEvent of response) {
      consola.debug("Copilot raw messages event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      streamTracer.addChunk(rawEvent)
      // Forward the native Anthropic SSE frame unchanged.
      await stream.writeSSE({
        event: rawEvent.event,
        data: rawEvent.data,
      })
    }

    await streamTracer.finish()
  })
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
) {
  const responsesPayload = translateAnthropicToResponses(payload)

  const traceTimestamp = await traceRequest({
    type: "anthropic-via-responses",
    original: payload,
    translated: responsesPayload,
  })

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(responsesPayload)

  if (isResponsesNonStreaming(response)) {
    const anthropicResponse = translateResponsesToAnthropic(
      response,
      payload.model,
    )
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
    const streamState = createResponsesToAnthropicState(payload.model)
    const streamTracer = new StreamTracer(traceTimestamp)

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const responsesEvent = JSON.parse(rawEvent.data) as ResponseStreamEvent
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
    }

    await streamTracer.finish()
  })
}

// The native /responses egress returns a ResponseObject (has an `output` array)
// when non-streaming, or an async SSE-event iterator when streaming.
const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is Extract<typeof response, { output: unknown }> =>
  Object.hasOwn(response, "output")
