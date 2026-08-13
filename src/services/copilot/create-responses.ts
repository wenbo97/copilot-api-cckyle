import consola from "consola"

import type {
  ReasoningEffort,
  ResponseInputItem,
  ResponseObject,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

import { rewriteCollaborationForCopilot } from "~/routes/_shared/collaboration-compat"
import {
  hasEncryptedContentPart,
  isEncryptedPart,
  UNREADABLE_PAYLOAD_MARKER,
} from "~/routes/_shared/encrypted-content"
import { clampReasoningEffort } from "~/routes/_shared/reasoning-policy"

import type { CopilotRequestOptions } from "./create-chat-completions"

import { copilotFetch } from "./copilot-fetch"
import { CopilotStreamLifecycle } from "./stream-lifecycle"

/**
 * Native `POST /responses` egress to the Copilot backend.
 *
 * Mirrors `createChatCompletions` and routes through the shared `copilotFetch`
 * chokepoint so auth, tier selection, and 401-retry stay unchanged. Used by the
 * Codex `/v1/responses` handler to pass requests straight through for
 * `/responses`-native models (gpt-5.3-codex, gpt-5.5, gpt-5.4) with no translation.
 */
export const createResponses = async (
  payload: ResponsesPayload,
  options: CopilotRequestOptions = {},
) => {
  const enableVision = hasVisionContent(payload)
  const isAgentCall = hasAgentMessages(payload)

  const body = rewriteCollaborationForCopilot(
    sanitizeReasoningItems(
      stripEncryptedContentParts(
        normalizeToolDescriptions(normalizeReasoningEffort(payload)),
      ),
    ),
  )

  const extraHeaders: Record<string, string> = {
    "X-Initiator": isAgentCall ? "agent" : "user",
  }
  if (enableVision) extraHeaders["copilot-vision-request"] = "true"

  const streamLifecycle =
    payload.stream ?
      new CopilotStreamLifecycle(options.signal, options.streamTimeouts)
    : undefined

  try {
    const response = await copilotFetch("/responses", {
      method: "POST",
      body: JSON.stringify(body),
      extraHeaders,
      signal: streamLifecycle?.signal ?? options.signal,
      headerTimeoutMs: options.headerTimeoutMs,
    })

    if (streamLifecycle) return streamLifecycle.iterate(response)

    return (await response.json()) as ResponseObject
  } catch (error) {
    streamLifecycle?.dispose(error)
    throw error
  }
}

function normalizeReasoningEffort(payload: ResponsesPayload): ResponsesPayload {
  const requested = payload.reasoning?.effort
  const normalized = clampReasoningEffort(payload.model, requested)
  if (normalized === requested) return payload

  consola.info(
    `[Responses] Reasoning effort normalized for ${payload.model}: ${requested} -> ${normalized}`,
  )
  return {
    ...payload,
    reasoning: { ...payload.reasoning, effort: normalized as ReasoningEffort },
  }
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

/**
 * Normalize tool descriptions before native `/responses` egress.
 *
 * Function descriptions are optional, so an explicit empty string is omitted.
 * Namespace descriptions are required, so an empty value receives a stable
 * fallback. Only protocol-defined tool containers are visited: top-level
 * `tools`, Codex `additional_tools` input items, and namespace children.
 * Arbitrary `tools` properties on other input items remain untouched.
 */
export function normalizeToolDescriptions(
  payload: ResponsesPayload,
): ResponsesPayload {
  let normalizedPayload = payload
  const topLevelTools: unknown = payload.tools
  if (Array.isArray(topLevelTools)) {
    const tools = topLevelTools.map((tool) => normalizeToolDefinition(tool))
    if (!tools.every((tool, index) => tool === topLevelTools[index]))
      normalizedPayload = {
        ...normalizedPayload,
        tools: tools as ResponsesPayload["tools"],
      }
  }

  if (typeof payload.input === "string") return normalizedPayload

  const input = payload.input.map((item) => {
    const rawItem: unknown = item
    if (!isRecord(rawItem) || rawItem.type !== "additional_tools") return item
    const itemTools = rawItem.tools
    if (!Array.isArray(itemTools)) return item

    const tools = itemTools.map((tool) => normalizeToolDefinition(tool))
    if (tools.every((tool, index) => tool === itemTools[index])) return item
    return { ...rawItem, tools } as unknown as ResponseInputItem
  })

  if (input.every((item, index) => item === payload.input[index]))
    return normalizedPayload
  return {
    ...normalizedPayload,
    input: input as ResponsesPayload["input"],
  }
}

function normalizeToolDefinition(tool: unknown): unknown {
  if (!isRecord(tool)) return tool

  if (tool.type === "namespace") {
    const childTools = tool.tools
    let normalized = tool
    if (Array.isArray(childTools)) {
      const tools = childTools.map((child) => normalizeToolDefinition(child))
      if (!tools.every((child, index) => child === childTools[index]))
        normalized = { ...normalized, tools }
    }

    const descriptionIsMissingOrBlank =
      normalized.description === undefined
      || (typeof normalized.description === "string"
        && normalized.description.trim() === "")
    if (!descriptionIsMissingOrBlank) return normalized

    const name =
      typeof normalized.name === "string" && normalized.name.trim() !== "" ?
        normalized.name.trim()
      : undefined
    return {
      ...normalized,
      description:
        name ? `Tools in the "${name}" namespace.` : "Tool namespace.",
    }
  }

  if (
    tool.type !== "function"
    || typeof tool.description !== "string"
    || tool.description.trim() !== ""
  )
    return tool
  const { description: _description, ...withoutDescription } = tool
  return withoutDescription
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
      && content.some((part) => {
        const record = part as {
          type?: string
          filename?: string
          file_data?: string
        }
        if (record.type === "input_image") return true
        if (record.type !== "input_file") return false
        return (
          record.file_data?.startsWith("data:application/pdf") === true
          || record.filename?.toLowerCase().endsWith(".pdf") === true
        )
      })
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
