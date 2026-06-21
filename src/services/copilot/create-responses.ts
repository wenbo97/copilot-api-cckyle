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

// A reasoning item as it arrives on the wire (loose: fields are optional and may
// be null). Only the shape we read/forward is named.
export interface ReasoningItem {
  type: "reasoning"
  id?: string
  status?: string | null
  encrypted_content?: string | null
  [key: string]: unknown
}

/**
 * Normalize a `reasoning` item for multi-turn replay to the Copilot /responses
 * backend (port of litellm `_handle_reasoning_item`).
 *
 * Copilot reasoning items carry `encrypted_content`, the opaque blob that lets
 * the backend verify and continue an earlier chain of thought. The naive path
 * drops it (→ "encrypted content could not be verified" on the next turn). We
 * keep `encrypted_content` when present, drop `status` when it is null (OpenAI
 * rejects a null status), and keep every other non-null field as-is.
 */
export function sanitizeReasoningItem(
  item: ReasoningItem,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    // Drop null fields outright (e.g. status: null, summary: null). The backend
    // 400s on a null status, and a null elsewhere carries no information.
    if (value === null) continue
    cleaned[key] = value
  }
  return cleaned
}
