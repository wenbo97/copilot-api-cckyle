import { events } from "fetch-event-stream"

import type {
  ResponseObject,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

import { copilotFetch } from "./copilot-fetch"

/**
 * Native `POST /responses` egress to the Copilot backend.
 *
 * Mirrors `createChatCompletions` and routes through the shared `copilotFetch`
 * chokepoint so auth, tier selection, and 401-retry stay unchanged. Used by the
 * Codex `/v1/responses` handler to pass requests straight through for
 * `/responses`-native models (gpt-5.3-codex, gpt-5.5, gpt-5.4) with no translation.
 */
export const createResponses = async (payload: ResponsesPayload) => {
  const enableVision = hasVisionContent(payload)
  const isAgentCall = hasAgentMessages(payload)

  const extraHeaders: Record<string, string> = {
    "X-Initiator": isAgentCall ? "agent" : "user",
  }
  if (enableVision) extraHeaders["copilot-vision-request"] = "true"

  const response = await copilotFetch("/responses", {
    method: "POST",
    body: JSON.stringify(payload),
    extraHeaders,
  })

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponseObject
}

// The wire shape of `input` items is looser than the strict request union
// (Codex echoes `function_call` items, images arrive as `input_image` parts),
// so these heuristics probe the raw shape rather than the narrowed type.
function hasVisionContent(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some((item) => {
    const content = (item as { content?: unknown }).content
    return (
      Array.isArray(content)
      && content.some(
        (part) => (part as { type?: string }).type === "input_image",
      )
    )
  })
}

function hasAgentMessages(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some((item) => {
    const { role, type } = item as { role?: string; type?: string }
    return (
      role === "assistant"
      || type === "function_call"
      || type === "function_call_output"
    )
  })
}
