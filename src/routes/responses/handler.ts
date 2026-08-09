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
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"
import {
  readCopilotHeaderTimeoutMs,
  readCopilotStreamTimeouts,
} from "~/services/copilot/stream-lifecycle"

import type { ResponseObject } from "./responses-types"
import type { ResponsesPayload, ResponseStreamState } from "./responses-types"

import { isKnownReasoningEffort } from "../_shared/reasoning-policy"
import { StreamItemIdNormalizer } from "../_shared/stream-item-id"
import { validateResponsesFallback } from "./fallback-capabilities"
import {
  translateToOpenAI,
  translateToResponses,
} from "./non-stream-translation"
import {
  NativeResponsesStreamTracker,
  parseChatCompletionSseData,
  parseNativeResponsesSseData,
} from "./stream-protocol"
import {
  translateChunkToResponseEvents,
  translateStreamFailureToResponseEvents,
} from "./stream-translation"

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

  const effortError = rejectUnknownReasoningEffort(c, payload)
  if (effortError) return effortError

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

  return handleResponsesFallback(c, payload)
}

async function handleResponsesFallback(c: Context, payload: ResponsesPayload) {
  const fallbackError = validateResponsesFallback(payload)
  if (fallbackError) return c.json({ error: fallbackError }, 400)

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

  const response = await createChatCompletions(openAIPayload, {
    signal: c.req.raw.signal,
    headerTimeoutMs: readCopilotHeaderTimeoutMs(),
    streamTimeouts: readCopilotStreamTimeouts(),
  })

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const responsesResponse = translateToResponses(response, payload.metadata)
    await traceResponse(
      { type: "responses", openai: response, translated: responsesResponse },
      traceTimestamp,
    )
    return c.json(responsesResponse)
  }

  // Streaming — Responses API uses plain SSE with `type` field in data, not `event:` field
  consola.debug("Streaming response from Copilot")
  return streamChatFallback(c, { payload, response, traceTimestamp })
}

interface ChatFallbackStreamContext {
  payload: ResponsesPayload
  response: Exclude<
    Awaited<ReturnType<typeof createChatCompletions>>,
    ChatCompletionResponse
  >
  traceTimestamp: string | null
}

function streamChatFallback(c: Context, context: ChatFallbackStreamContext) {
  const { payload, response, traceTimestamp } = context
  return streamSSE(c, async (stream) => {
    const streamState: ResponseStreamState = {
      responseId: "",
      model: payload.model,
      outputItemIndex: 0,
      contentPartIndex: 0,
      messageStarted: false,
      metadata: payload.metadata,
      toolCalls: {},
    }

    const streamTracer = new StreamTracer(traceTimestamp)
    let endedWithDone = false

    try {
      for await (const rawEvent of response) {
        if (c.req.raw.signal.aborted) break
        consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          endedWithDone = true
          break
        }
        if (!rawEvent.data) continue

        const chunk = parseChatCompletionSseData(rawEvent.data)
        const translatedEvents = translateChunkToResponseEvents(
          chunk,
          streamState,
        )

        for (const event of translatedEvents) {
          consola.debug("Translated Responses event:", JSON.stringify(event))
          streamTracer.addChunk({ openai: chunk, responses: event })
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }

        if (streamState.terminalEmitted) break
      }

      if (!c.req.raw.signal.aborted && !streamState.terminalEmitted) {
        const message =
          endedWithDone ?
            "Upstream Chat Completions sent [DONE] before a finish_reason."
          : "Upstream Chat Completions stream ended before a finish_reason."
        await writeSyntheticFailure(
          { state: streamState, stream, tracer: streamTracer },
          message,
        )
      }
    } catch (error) {
      if (!c.req.raw.signal.aborted && !streamState.terminalEmitted) {
        await writeSyntheticFailure(
          { state: streamState, stream, tracer: streamTracer },
          describeStreamError("Upstream Chat Completions stream failed", error),
        ).catch(() => undefined)
      }
    } finally {
      await streamTracer.finish()
    }
  })
}

function rejectUnknownReasoningEffort(
  c: Context,
  payload: ResponsesPayload,
): Response | undefined {
  const requested = (payload.reasoning as { effort?: unknown } | undefined)
    ?.effort
  if (requested === undefined || isKnownReasoningEffort(requested)) return

  const label =
    typeof requested === "string" ? `"${requested}"` : JSON.stringify(requested)
  return c.json(
    {
      error: {
        message: `Unknown reasoning effort ${label}.`,
        type: "invalid_request_error",
        code: "invalid_reasoning_effort",
      },
    },
    400,
  )
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

  const response = await createResponses(payload, {
    signal: c.req.raw.signal,
    headerTimeoutMs: readCopilotHeaderTimeoutMs(),
    streamTimeouts: readCopilotStreamTimeouts(),
  })

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
    const tracker = new NativeResponsesStreamTracker()
    let endedWithDone = false

    try {
      for await (const rawEvent of response) {
        if (c.req.raw.signal.aborted) break
        consola.debug("Copilot raw responses event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          endedWithDone = true
          break
        }
        if (!rawEvent.data) continue

        const fixed = normalizer.normalize(
          parseNativeResponsesSseData(rawEvent.data),
        )
        tracker.observe(fixed)
        streamTracer.addChunk(fixed)
        await stream.writeSSE({
          event: fixed.type,
          data: JSON.stringify(fixed),
        })

        if (tracker.terminalSeen) break
      }

      if (!c.req.raw.signal.aborted && !tracker.terminalSeen) {
        const message =
          endedWithDone ?
            "Upstream Responses stream sent [DONE] before a terminal event."
          : "Upstream Responses stream ended before a terminal event."
        await writeNativeFailure(
          { stream, tracer: streamTracer, tracker },
          message,
        )
      }
    } catch (error) {
      if (!c.req.raw.signal.aborted && !tracker.terminalSeen) {
        await writeNativeFailure(
          { stream, tracer: streamTracer, tracker },
          describeStreamError("Upstream Responses stream failed", error),
        ).catch(() => undefined)
      }
    } finally {
      await streamTracer.finish()
    }
  })
}

const isResponsesNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponseObject => Object.hasOwn(response, "output")

type SseWriter = {
  writeSSE(input: { event?: string; data: string }): Promise<unknown>
}

interface SyntheticFailureContext {
  state: ResponseStreamState
  stream: SseWriter
  tracer: StreamTracer
}

async function writeSyntheticFailure(
  context: SyntheticFailureContext,
  message: string,
): Promise<void> {
  const { state, stream, tracer } = context
  for (const event of translateStreamFailureToResponseEvents(message, state)) {
    tracer.addChunk({ responses: event })
    await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
  }
}

interface NativeFailureContext {
  stream: SseWriter
  tracer: StreamTracer
  tracker: NativeResponsesStreamTracker
}

async function writeNativeFailure(
  context: NativeFailureContext,
  message: string,
): Promise<void> {
  const { stream, tracer, tracker } = context
  for (const event of tracker.fail(message)) {
    tracer.addChunk(event)
    await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
  }
}

function describeStreamError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${prefix}: ${message}`
}
