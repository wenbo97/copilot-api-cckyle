import { InvalidRequestError } from "~/lib/error"
import {
  clampReasoningEffort,
  resolveMessagesReasoningEffort,
} from "~/routes/_shared/reasoning-policy"
import { deriveAnthropicStopReason } from "~/routes/_shared/stop-reason"
import { createToolNameMap, type ToolNameMap } from "~/routes/_shared/tool-name"
import {
  anthropicToolsToResponses,
  anthropicToolChoiceToResponses,
} from "~/routes/_shared/tool-translation"

import type {
  ResponseInputContentPart,
  ResponseInputItem,
  ResponseToolOutputPart,
  ResponseObject,
  ResponsesPayload,
  ReasoningEffort,
} from "../responses/responses-types"
import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "./anthropic-types"

import { formatMessagesUsage, readMessagesUsage } from "./usage-translation"

// =============================================================================
// Anthropic Messages  ->  OpenAI Responses   (REQUEST translation)
//
// Lossy, cross-protocol bridge so Claude Code can reach /responses-only models
// (gpt-5.5, gpt-5.3-codex). Documented losses: reasoning original text (the
// backend encrypts it), cache_control, top_k. Tool schemas default to non-strict
// so optional Anthropic fields remain optional; explicit strict is preserved.
// =============================================================================

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
  toolNames: ToolNameMap = createToolNameMap(payload),
): ResponsesPayload {
  const effort = clampReasoningEffort(
    payload.model,
    resolveMessagesReasoningEffort(payload),
  ) as ReasoningEffort | undefined

  const result: ResponsesPayload = {
    model: payload.model,
    input: translateMessagesToInput(payload.messages, toolNames),
    instructions: flattenSystem(payload.system),
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: payload.max_tokens,
    tools: anthropicToolsToResponses(payload.tools, toolNames),
    tool_choice: anthropicToolChoiceToResponses(payload.tool_choice, toolNames),
  }

  if (effort) result.reasoning = { effort }
  return result
}

function flattenSystem(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n\n")
}

function translateMessagesToInput(
  messages: Array<AnthropicMessage>,
  toolNames: ToolNameMap,
): Array<ResponseInputItem> {
  const input: Array<ResponseInputItem> = []

  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ role: message.role, content: message.content })
      continue
    }

    // Tool results (user turn) become standalone function_call_output items.
    // Tool uses (assistant turn) become standalone function_call items.
    // Flush each contiguous text/image run before standalone tool items.
    let contentParts: Array<ResponseInputContentPart> = []
    const flushContent = () => {
      if (contentParts.length > 0) {
        input.push({ role: message.role, content: contentParts })
        contentParts = []
      }
    }

    for (const block of message.content) {
      switch (block.type) {
        case "text": {
          // Role decides the part type: assistant history must use output_text,
          // user/system input uses input_text. Sending input_text inside an
          // assistant message makes the Responses backend 400, which broke every
          // conversation past the first turn.
          contentParts.push(
            message.role === "assistant" ?
              { type: "output_text", text: block.text }
            : { type: "input_text", text: block.text },
          )
          break
        }
        case "image": {
          contentParts.push({
            type: "input_image",
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          })
          break
        }
        case "tool_result": {
          flushContent()
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: stringifyToolResult(block.content),
          })
          break
        }
        case "tool_use": {
          flushContent()
          // Responses represents a prior assistant tool call as a function_call
          // input item (mirrors what the native API echoes back).
          input.push({
            type: "function_call",
            call_id: block.id,
            name: toolNames.toUpstream(block.name),
            arguments: JSON.stringify(block.input),
          })
          break
        }
        default: {
          // `thinking` blocks are dropped — the backend never accepts replayed
          // reasoning text (it round-trips only as encrypted_content natively).
          break
        }
      }
    }

    flushContent()
  }

  return input
}

function stringifyToolResult(
  content: unknown,
): string | Array<ResponseToolOutputPart> {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw unsupportedToolResult()
  if (content.length === 0) return ""
  return content.map((block: unknown) => {
    if (!isRecord(block)) throw unsupportedToolResult()
    if (block.type === "text" && typeof block.text === "string")
      return { type: "input_text", text: block.text }
    if (
      block.type === "image"
      && isRecord(block.source)
      && block.source.type === "base64"
      && typeof block.source.media_type === "string"
      && ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
        block.source.media_type,
      )
      && typeof block.source.data === "string"
      && block.source.data.length > 0
    )
      return {
        type: "input_image",
        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      }
    throw unsupportedToolResult()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unsupportedToolResult(): InvalidRequestError {
  return new InvalidRequestError(
    "Unsupported tool_result content: expected text or a supported base64 image.",
    "unsupported_tool_result_content",
    "messages",
  )
}

// =============================================================================
// OpenAI Responses  ->  Anthropic Messages   (RESPONSE translation)
// =============================================================================

export function translateResponsesToAnthropic(
  response: ResponseObject,
  model: string,
  toolNames?: ToolNameMap,
): AnthropicResponse {
  const content: Array<AnthropicAssistantContentBlock> = []
  let hasToolCall = false

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push({
          type: "text",
          text: part.type === "refusal" ? part.refusal : part.text,
        })
      }
    } else if (item.type === "function_call") {
      hasToolCall = true
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: toolNames?.toOriginal(item.name) ?? item.name,
        input: safeParseArgs(item.arguments),
      })
    }
    // `reasoning` items carry no usable text (encrypted) — skipped.
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: deriveAnthropicStopReason(hasToolCall, response),
    stop_sequence: null,
    usage: formatMessagesUsage(readMessagesUsage(response.usage, "responses")),
  }
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return {}
  }
}
