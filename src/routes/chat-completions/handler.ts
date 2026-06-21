import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { pickEgress } from "~/lib/endpoint-router"
import { resolveModelId } from "~/lib/model-identity"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { StreamTracer, traceRequest, traceResponse } from "~/lib/trace"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Normalize the requested model id to a catalog id ONCE (exact id → alias →
  // strip [..] suffix), then route under that id.
  const resolved = resolveModelId(payload.model)
  if (resolved !== payload.model) {
    consola.info(`[OpenAI] Model resolved: "${payload.model}" -> "${resolved}"`)
    payload = { ...payload, model: resolved }
  }
  consola.info(`[OpenAI] Using model: "${payload.model}"`)

  // The OpenAI (/chat/completions) inbound only has a same-protocol egress. If the
  // model doesn't advertise /chat/completions (e.g. the /responses-only gpt-5.5,
  // gpt-5.3-codex), reaching it from a generic OpenAI client is out of scope — fail
  // with a clean 4xx instead of letting the backend reject it with a raw 400.
  const egress = pickEgress("chat", payload.model)
  if (egress !== "/chat/completions") {
    return c.json(
      {
        error: {
          message: `Model "${payload.model}" is not reachable via /v1/chat/completions. Use the /v1/responses endpoint for this model.`,
          type: "invalid_request_error",
          code: "unsupported_api_for_model",
        },
      },
      400,
    )
  }

  // Trace the request
  const traceTimestamp = await traceRequest(payload)

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    // Trace the non-streaming response
    await traceResponse(response, traceTimestamp)
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    const streamTracer = new StreamTracer(traceTimestamp)
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      streamTracer.addChunk(chunk)
      await stream.writeSSE(chunk as SSEMessage)
    }
    await streamTracer.finish()
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
