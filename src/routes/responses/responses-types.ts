// OpenAI Responses API types
// Reference: https://developers.openai.com/api/reference/resources/responses/methods/create/

// --- Request types ---

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponseInputItem>
  instructions?: string
  stream?: boolean
  temperature?: number
  top_p?: number
  frequency_penalty?: number | null
  presence_penalty?: number | null
  top_logprobs?: number | null
  max_output_tokens?: number
  tools?: Array<ResponseTool>
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
  previous_response_id?: string
  reasoning?: { effort?: ReasoningEffort }
  metadata?: Record<string, string>
  conversation?: string | { id: string } | null
  store?: boolean | null
  truncation?: "auto" | "disabled" | null
  parallel_tool_calls?: boolean | null
  text?: ResponseTextConfig | null
  stream_options?: ResponseStreamOptions | null
  prompt_cache_key?: string | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  prompt_cache_options?: ResponsePromptCacheOptions | null
  safety_identifier?: string | null
  service_tier?:
    | "auto"
    | "default"
    | "flex"
    | "scale"
    | "priority"
    | "fast"
    | null
  user?: string | null
}

export interface ResponseTextConfig {
  format?: ResponseTextFormat | null
  verbosity?: "low" | "medium" | "high" | null
}

export interface ResponseStreamOptions {
  include_obfuscation?: boolean
}

export interface ResponsePromptCacheOptions {
  mode?: "implicit" | "explicit"
  ttl?: "30m"
}

export interface ResponsePromptCacheBreakpoint {
  mode: "explicit"
}

export type ResponseTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema"
      name: string
      description?: string
      schema: Record<string, unknown>
      strict?: boolean
    }

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseInputFunctionCall
  | ResponseInputFunctionCallOutput

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: string | Array<ResponseInputContentPart>
}

// A prior assistant tool *invocation*, echoed back as an input item on the next
// turn. Shares `call_id` with ResponseInputFunctionCallOutput, so consumers MUST
// discriminate by `type` (see responses/non-stream-translation.ts).
export interface ResponseInputFunctionCall {
  type: "function_call"
  call_id: string
  namespace?: string
  name: string
  arguments: string
}

export interface ResponseInputFunctionCallOutput {
  type: "function_call_output"
  call_id: string
  output: string
}

// Content parts carried by an input *message* item. The text variant differs by
// role: user/system/developer messages use `input_text`, assistant messages use
// `output_text` (the backend 400s on an `input_text` part inside an assistant
// message). `input_image` only applies to user input.
export type ResponseInputContentPart =
  | {
      type: "input_text"
      text: string
      prompt_cache_breakpoint?: ResponsePromptCacheBreakpoint
    }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }

// --- Tool types ---

export type ResponseTool = ResponseFunctionTool | ResponseNamespaceTool

export interface ResponseFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponseNamespaceTool {
  type: "namespace"
  name: string
  description: string
  tools: Array<ResponseFunctionTool>
}

// --- Response types (non-streaming) ---

export interface ResponseObject {
  id: string
  object: "response"
  created_at: number
  model: string
  status: "completed" | "failed" | "incomplete" | "in_progress"
  output: Array<ResponseOutputItem>
  usage?: ResponseUsage
  metadata?: Record<string, string>
  incomplete_details?: {
    reason: "max_output_tokens" | "content_filter"
  } | null
  error?: ResponseError | null
}

export interface ResponseError {
  code: string
  message: string
  type?: string
  param?: string | null
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputReasoning

export interface ResponseOutputMessage {
  type: "message"
  id: string
  role: "assistant"
  status: "in_progress" | "completed" | "incomplete"
  content: Array<ResponseOutputContent>
}

// Reasoning items are emitted by /responses-native models (gpt-5.x, codex).
// Their content/text is encrypted by the backend (empty `content`, opaque `id`),
// so consumers skip them — they exist in the type so narrowing is honest.
export interface ResponseOutputReasoning {
  type: "reasoning"
  id: string
  status?: "in_progress" | "completed" | "incomplete"
  content: Array<unknown>
  encrypted_content?: string
}

export type ResponseOutputContent = ResponseOutputText

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations?: Array<unknown>
}

export interface ResponseOutputFunctionCall {
  type: "function_call"
  id: string
  call_id: string
  namespace?: string
  name: string
  arguments: string
  encrypted_function_args?: Array<string>
  status: "in_progress" | "completed" | "incomplete"
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

// --- Streaming types ---

export interface ResponseStreamState {
  responseId: string
  model: string
  createdAt?: number
  // The next output index to reserve. Keeping this counter in the shared state
  // lets text and tool items safely interleave while retaining first-seen order.
  outputItemIndex: number
  contentPartIndex: number
  messageStarted: boolean
  nextSequenceNumber?: number
  terminalEmitted?: boolean
  protocolError?: string
  usage?: ResponseUsage
  metadata?: Record<string, string>
  // Accumulated assistant text, so the terminal output_text.done / output_item.done
  // can carry the real message instead of an empty placeholder. Optional so the
  // handler's state literal needs no change (the translator defaults it).
  textContent?: string
  // Whether a text message output item was opened (text arrived before any tool
  // call). Drives whether we emit the text .done frames at finish.
  messageItemOpen?: boolean
  messageOutputItemIndex?: number
  messageItemId?: string
  toolCalls: Record<
    number,
    {
      id?: string
      callId?: string
      name?: string
      // Reserved only when enough identity is known to emit output_item.added.
      // Partial tool fragments must not take an index ahead of an item that
      // actually opens first.
      outputItemIndex?: number
      // Accumulated arguments fragments, closed out at finish.
      arguments: string
      pendingArgumentDeltas?: Array<string>
      itemAdded?: boolean
    }
  >
}

// Streaming event types
export type ResponseStreamEvent =
  | (ResponseStreamEventBase & {
      type: "response.created"
      response: ResponseObject
    })
  | (ResponseStreamEventBase & {
      type: "response.in_progress"
      response: ResponseObject
    })
  | {
      type: "response.output_item.added"
      sequence_number?: number
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.output_item.done"
      sequence_number?: number
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.content_part.added"
      sequence_number?: number
      item_id?: string
      output_index: number
      content_index: number
      part: ResponseOutputContent
    }
  | {
      type: "response.content_part.done"
      sequence_number?: number
      item_id?: string
      output_index: number
      content_index: number
      part: ResponseOutputContent
    }
  | {
      type: "response.output_text.delta"
      sequence_number?: number
      item_id?: string
      output_index: number
      content_index: number
      delta: string
    }
  | {
      type: "response.output_text.done"
      sequence_number?: number
      item_id?: string
      output_index: number
      content_index: number
      text: string
    }
  | {
      type: "response.function_call_arguments.delta"
      sequence_number?: number
      item_id?: string
      output_index: number
      delta: string
    }
  | {
      type: "response.function_call_arguments.done"
      sequence_number?: number
      item_id?: string
      output_index: number
      arguments: string
    }
  | (ResponseStreamEventBase & {
      type: "response.completed"
      response: ResponseObject
    })
  | (ResponseStreamEventBase & {
      type: "response.incomplete"
      response: ResponseObject
    })
  | (ResponseStreamEventBase & {
      type: "response.failed"
      response: ResponseObject
    })
  | (ResponseStreamEventBase & {
      type: "error"
      code: string
      message: string
      param: string | null
    })

type ResponseStreamEventBase = {
  // Native upstream events always carry this field. It stays optional in the
  // shared type because the same union is also used to parse legacy fixtures;
  // the synthetic emitter always assigns it and contract tests enforce that.
  sequence_number?: number
}
