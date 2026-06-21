import { clampReasoningEffort } from "~/routes/_shared/reasoning-policy"

import type {
  ResponseInputContentPart,
  ResponseInputItem,
  ResponseObject,
  ResponsesPayload,
  ResponseTool,
  ReasoningEffort,
} from "../responses/responses-types"
import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
} from "./anthropic-types"

import { mapThinkingToReasoningEffort } from "./non-stream-translation"

// =============================================================================
// Anthropic Messages  ->  OpenAI Responses   (REQUEST translation)
//
// Lossy, cross-protocol bridge so Claude Code can reach /responses-only models
// (gpt-5.5, gpt-5.3-codex). Documented losses: reasoning original text (the
// backend encrypts it), cache_control, `strict` tool schemas, top_k.
// =============================================================================

export function translateAnthropicToResponses(
  payload: AnthropicMessagesPayload,
): ResponsesPayload {
  const effort = clampReasoningEffort(
    payload.model,
    mapThinkingToReasoningEffort(payload.thinking, payload.max_tokens),
  ) as ReasoningEffort | undefined

  const result: ResponsesPayload = {
    model: payload.model,
    input: translateMessagesToInput(payload.messages),
    instructions: flattenSystem(payload.system),
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: payload.max_tokens,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
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
): Array<ResponseInputItem> {
  const input: Array<ResponseInputItem> = []

  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ role: message.role, content: message.content })
      continue
    }

    // Tool results (user turn) become standalone function_call_output items.
    // Tool uses (assistant turn) become standalone function_call items.
    // All remaining text/image blocks collapse into one message item.
    const contentParts: Array<ResponseInputContentPart> = []

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
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: stringifyToolResult(block.content),
          })
          break
        }
        case "tool_use": {
          // Responses represents a prior assistant tool call as a function_call
          // input item (mirrors what the native API echoes back).
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          } as unknown as ResponseInputItem)
          break
        }
        default: {
          // `thinking` blocks are dropped — the backend never accepts replayed
          // reasoning text (it round-trips only as encrypted_content natively).
          break
        }
      }
    }

    if (contentParts.length > 0) {
      input.push({ role: message.role, content: contentParts })
    }
  }

  return input
}

function stringifyToolResult(
  content: AnthropicToolResultBlock["content"],
): string {
  if (typeof content === "string") return content
  // Anthropic tool_result content can be an array of blocks; concatenate any
  // text, else JSON-encode so nothing is silently lost.
  const text = content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
  return text || JSON.stringify(content)
}

function translateTools(
  tools?: Array<AnthropicTool>,
): Array<ResponseTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))
}

function translateToolChoice(
  tc: AnthropicMessagesPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!tc) return undefined
  switch (tc.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return tc.name ? { type: "function", name: tc.name } : "auto"
    }
    default: {
      return undefined
    }
  }
}

// =============================================================================
// OpenAI Responses  ->  Anthropic Messages   (RESPONSE translation)
// =============================================================================

export function translateResponsesToAnthropic(
  response: ResponseObject,
  model: string,
): AnthropicResponse {
  const content: Array<AnthropicAssistantContentBlock> = []
  let hasToolCall = false

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push({ type: "text", text: part.text })
      }
    } else if (item.type === "function_call") {
      hasToolCall = true
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
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
    stop_reason: deriveStopReason(hasToolCall, response.status),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  }
}

function deriveStopReason(
  hasToolCall: boolean,
  status: ResponseObject["status"],
): AnthropicResponse["stop_reason"] {
  if (hasToolCall) return "tool_use"
  if (status === "incomplete") return "max_tokens"
  return "end_turn"
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return {}
  }
}
