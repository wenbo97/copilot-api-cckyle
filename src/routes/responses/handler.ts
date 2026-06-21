import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { pickEgress } from "~/lib/endpoint-router"
import { resolveModelId } from "~/lib/model-identity"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { StreamTracer, traceRequest, traceResponse } from "~/lib/trace"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"

import type { ResponseObject } from "./responses-types"
import type {
  ResponsesPayload,
  ResponseStreamState,
  ResponseStreamEvent,
} from "./responses-types"

import { StreamItemIdNormalizer } from "../_shared/stream-item-id"
import {
  translateToOpenAI,
  translateToResponses,
} from "./non-stream-translation"
import { translateChunkToResponseEvents } from "./stream-translation"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses API request payload:",
    JSON.stringify(payload).slice(-400),
  )

  // Normalize the requested model id to a catalog id ONCE (exact id → alias →
  // strip [..] suffix), then forward under that id.
  const resolved = resolveModelId(payload.model)
  if (resolved !== payload.model) {
    consola.info(
      `[Responses] Model resolved: "${payload.model}" -> "${resolved}"`,
    )
    payload = { ...payload, model: resolved }
  }
  consola.info(`[Responses] Using model: "${payload.model}"`)

  // Pick the egress endpoint from the live catalog for the Codex (/responses)
  // inbound: prefer native /responses passthrough (lossless), else translate down
  // to /chat/completions. "unsupported" means the model advertises neither.
  const egress = pickEgress("responses", payload.model)
  if (egress === "/responses") {
    return handleResponsesPassthrough(c, payload)
  }
  if (egress === "unsupported") {
    return c.json(
      {
        error: {
          message: `Model "${payload.model}" is not reachable via /v1/responses or /chat/completions.`,
          type: "invalid_request_error",
          code: "unsupported_api_for_model",
        },
      },
      400,
    )
  }

  const traceTimestamp = await traceRequest({
    type: "responses",
    original: payload,
  })

  const openAIPayload = translateToOpenAI(payload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) await awaitApproval()

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const responsesResponse = translateToResponses(response)
    await traceResponse(
      { type: "responses", openai: response, translated: responsesResponse },
      traceTimestamp,
    )
    return c.json(responsesResponse)
  }

  // Streaming — Responses API uses plain SSE with `type` field in data, not `event:` field
  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: ResponseStreamState = {
      responseId: "",
      model: payload.model,
      outputItemIndex: 0,
      contentPartIndex: 0,
      messageStarted: false,
      toolCalls: {},
    }

    const streamTracer = new StreamTracer(traceTimestamp)

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToResponseEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Responses event:", JSON.stringify(event))
        streamTracer.addChunk({ openai: chunk, responses: event })
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
 * Native /responses passthrough for /responses-native models (gpt-5.3-codex,
 * gpt-5.5, gpt-5.4). No translation in either direction — the request body is
 * forwarded as-is and the native Responses object / SSE frames are returned
 * unchanged. Tracing still runs so the native wire shape can be captured.
 */
async function handleResponsesPassthrough(
  c: Context,
  payload: ResponsesPayload,
) {
  const traceTimestamp = await traceRequest({
    type: "responses-passthrough",
    original: payload,
  })

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(payload)

  if (isResponsesNonStreaming(response)) {
    consola.debug(
      "Non-streaming passthrough response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    await traceResponse(
      { type: "responses-passthrough", native: response },
      traceTimestamp,
    )
    return c.json(response)
  }

  consola.debug("Streaming passthrough response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamTracer = new StreamTracer(traceTimestamp)
    // Copilot tags each event of one output item with a different item id, which
    // crashes clients that key streaming state by item id (Vercel AI SDK "part
    // not found"). Stabilize to one anchor id per output_index before forwarding.
    const normalizer = new StreamItemIdNormalizer()

    for await (const rawEvent of response) {
      consola.debug("Copilot raw responses event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      streamTracer.addChunk(rawEvent)
      const fixed = normalizer.normalize(
        JSON.parse(rawEvent.data) as ResponseStreamEvent,
      )
      await stream.writeSSE({
        event: rawEvent.event,
        data: JSON.stringify(fixed),
      })
    }

    await streamTracer.finish()
  })
}

const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponseObject => Object.hasOwn(response, "output")
