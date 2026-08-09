import type { CopilotStreamTimeouts } from "./stream-lifecycle"

import { copilotFetch } from "./copilot-fetch"
import { CopilotStreamLifecycle } from "./stream-lifecycle"

export interface CopilotRequestOptions {
  signal?: AbortSignal
  headerTimeoutMs?: number
  streamTimeouts?: CopilotStreamTimeouts
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: CopilotRequestOptions = {},
) => {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
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
    const response = await copilotFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
      extraHeaders,
      signal: streamLifecycle?.signal ?? options.signal,
      headerTimeoutMs: options.headerTimeoutMs,
    })

    if (streamLifecycle) return streamLifecycle.iterate(response)

    return (await response.json()) as ChatCompletionResponse
  } catch (error) {
    streamLifecycle?.dispose(error)
    throw error
  }
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  // Copilot's Chat SSE omits `object` even though OpenAI includes it.
  object?: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  // Copilot omits this field on non-terminal chunks and supplies it only on the
  // final choice frame.
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | {
        type: "json_schema"
        json_schema: {
          name: string
          description?: string
          schema: Record<string, unknown>
          strict?: boolean
        }
      }
    | null
  seed?: number | null
  tools?: Array<Tool> | null
  parallel_tool_calls?: boolean | null
  stream_options?: {
    include_obfuscation?: boolean
    include_usage?: boolean
  } | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  safety_identifier?: string | null
  service_tier?:
    | "auto"
    | "default"
    | "flex"
    | "scale"
    | "priority"
    | "fast"
    | null
  reasoning_effort?:
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra"
    | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
