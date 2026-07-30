import { events } from "fetch-event-stream"

import type {
  ResponseInputItem,
  ResponseObject,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

import {
  hasEncryptedContentPart,
  isEncryptedPart,
  UNREADABLE_PAYLOAD_MARKER,
} from "~/routes/_shared/encrypted-content"

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

  const body = sanitizeReasoningItems(stripEncryptedContentParts(payload))

  const extraHeaders: Record<string, string> = {
    "X-Initiator": isAgentCall ? "agent" : "user",
  }
  if (enableVision) extraHeaders["copilot-vision-request"] = "true"

  const response = await copilotFetch("/responses", {
    method: "POST",
    body: JSON.stringify(body),
    extraHeaders,
  })

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponseObject
}

// Apply sanitizeReasoningItem to every reasoning item in the input so multi-turn
// replay preserves encrypted_content and never forwards a null status. Returns
// the payload unchanged when input is a bare string or carries no reasoning items.
function sanitizeReasoningItems(payload: ResponsesPayload): ResponsesPayload {
  if (typeof payload.input === "string") return payload
  if (!payload.input.some((item) => isReasoningItem(item))) return payload

  const input = payload.input.map((item) =>
    isReasoningItem(item) ?
      sanitizeReasoningItem(item as unknown as ReasoningItem)
    : item,
  )
  return { ...payload, input: input as ResponsesPayload["input"] }
}

function isReasoningItem(item: unknown): boolean {
  return (item as { type?: string }).type === "reasoning"
}

/**
 * Replace `encrypted_content` CONTENT PARTS with a short marker.
 *
 * Codex's sub-agent turns (skills, multi-agent) replay as `agent_message` items
 * whose real payload sits in a content part of type `encrypted_content` — a
 * Fernet blob Codex mints locally. The Copilot backend accepts that part at
 * schema level but cannot decrypt it, and then aborts the whole response with a
 * bare `response.failed` (error: null, no usage, no output) which Codex surfaces
 * as "stream disconnected before completion: response.failed event received".
 * Because such items stay in the conversation forever, one sub-agent turn bricks
 * every later turn of the session.
 *
 * The blob is unreadable to the backend either way, so nothing is lost by not
 * forwarding it. We substitute a marker rather than deleting the part outright
 * so the model sees "a message was sent, its body is unavailable" instead of an
 * empty `Payload:` that reads as "the sub-agent said nothing".
 *
 * Only CONTENT PARTS are touched. The top-level `encrypted_content` FIELD on
 * `reasoning` items is a different mechanism that the backend mints and verifies
 * itself — it must round-trip untouched (see `sanitizeReasoningItem`).
 */
export function stripEncryptedContentParts(
  payload: ResponsesPayload,
): ResponsesPayload {
  if (typeof payload.input === "string") return payload
  if (!payload.input.some((item) => hasEncryptedContentPart(item)))
    return payload

  const input = payload.input.map((item) => {
    if (!hasEncryptedContentPart(item)) return item

    const record = item as unknown as Record<string, unknown>
    const parts = record.content as Array<unknown>
    // An assistant-role item must use `output_text`; everything else uses
    // `input_text`. Mirror whichever the item's own text parts already use so
    // the marker cannot become the one part the backend rejects.
    const textType =
      parts.some((p) => (p as { type?: string }).type === "output_text") ?
        "output_text"
      : "input_text"

    const content = parts.map((part) =>
      isEncryptedPart(part) ?
        { type: textType, text: UNREADABLE_PAYLOAD_MARKER }
      : part,
    )
    return { ...record, content } as unknown as ResponseInputItem
  })

  return { ...payload, input: input as ResponsesPayload["input"] }
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
