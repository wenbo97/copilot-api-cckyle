// OpenAI Responses API types
// Reference: https://platform.openai.com/docs/api-reference/responses

// --- Request types ---

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponseInputItem>
  instructions?: string
  stream?: boolean
  temperature?: number
  top_p?: number
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
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }

// --- Tool types ---

export interface ResponseTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
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
  error?: { code: string; message: string } | null
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputReasoning

export interface ResponseOutputMessage {
  type: "message"
  id: string
  role: "assistant"
  status: "completed"
  content: Array<ResponseOutputContent>
}

// Reasoning items are emitted by /responses-native models (gpt-5.x, codex).
// Their content/text is encrypted by the backend (empty `content`, opaque `id`),
// so consumers skip them — they exist in the type so narrowing is honest.
export interface ResponseOutputReasoning {
  type: "reasoning"
  id: string
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
  name: string
  arguments: string
  status: "completed"
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
  outputItemIndex: number
  contentPartIndex: number
  messageStarted: boolean
  // Accumulated assistant text, so the terminal output_text.done / output_item.done
  // can carry the real message instead of an empty placeholder. Optional so the
  // handler's state literal needs no change (the translator defaults it).
  textContent?: string
  // Whether a text message output item was opened (text arrived before any tool
  // call). Drives whether we emit the text .done frames at finish.
  messageItemOpen?: boolean
  toolCalls: Record<
    number,
    {
      id: string
      callId: string
      name: string
      outputItemIndex: number
      // Accumulated arguments fragments, closed out at finish.
      arguments: string
    }
  >
}

// Streaming event types
export type ResponseStreamEvent =
  | { type: "response.created"; response: ResponseObject }
  | { type: "response.in_progress"; response: ResponseObject }
  | {
      type: "response.output_item.added"
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.output_item.done"
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.content_part.added"
      output_index: number
      content_index: number
      part: ResponseOutputContent
    }
  | {
      type: "response.content_part.done"
      output_index: number
      content_index: number
      part: ResponseOutputContent
    }
  | {
      type: "response.output_text.delta"
      output_index: number
      content_index: number
      delta: string
    }
  | {
      type: "response.output_text.done"
      output_index: number
      content_index: number
      text: string
    }
  | {
      type: "response.function_call_arguments.delta"
      output_index: number
      delta: string
    }
  | {
      type: "response.function_call_arguments.done"
      output_index: number
      arguments: string
    }
  | { type: "response.completed"; response: ResponseObject }
  | { type: "error"; error: { type: string; message: string } }
