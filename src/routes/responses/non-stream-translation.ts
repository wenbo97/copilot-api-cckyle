import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  ResponseInputContentPart,
  ResponseInputFunctionCall,
  ResponseInputFunctionCallOutput,
  ResponseInputItem,
  ResponseObject,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponsesPayload,
} from "./responses-types"

// --- Request translation: Responses API → Chat Completions ---

export function translateToOpenAI(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages = translateInputToMessages(payload.input, payload.instructions)

  return {
    model: payload.model,
    messages,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
  }
}

function translateInputToMessages(
  input: string | Array<ResponseInputItem>,
  instructions?: string,
): Array<Message> {
  const messages: Array<Message> = []

  if (instructions) {
    messages.push({ role: "system", content: instructions })
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return messages
  }

  for (const item of input) {
    if (isFunctionCallOutput(item)) {
      // Tool *result* (user turn) -> a role:tool message.
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      })
    } else if (isFunctionCall(item)) {
      // Tool *invocation* (assistant turn) -> an assistant message carrying
      // tool_calls. Both items share `call_id`, so they MUST be told apart by
      // `type`, not by key presence (the old "call_id" in item check misrouted
      // this as a second role:tool message).
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      })
    } else {
      const msg = item
      const role = msg.role === "developer" ? "system" : msg.role
      messages.push({
        role: role as Message["role"],
        content: translateContent(msg.content),
      })
    }
  }

  return messages
}

function isFunctionCallOutput(
  item: ResponseInputItem,
): item is ResponseInputFunctionCallOutput {
  return (item as { type?: string }).type === "function_call_output"
}

function isFunctionCall(
  item: ResponseInputItem,
): item is ResponseInputFunctionCall {
  return (item as { type?: string }).type === "function_call"
}

function translateContent(
  content: string | Array<ResponseInputContentPart>,
): string | Array<ContentPart> {
  if (typeof content === "string") return content

  return content.map((part): ContentPart => {
    if (part.type === "input_text" || part.type === "output_text") {
      return { type: "text", text: part.text }
    }
    return {
      type: "image_url",
      image_url: {
        url: part.image_url,
        detail: part.detail,
      },
    }
  })
}

function translateTools(
  tools?: ResponsesPayload["tools"],
): Array<Tool> | undefined {
  if (!tools) return undefined
  const result: Array<Tool> = []
  for (const tool of tools) {
    // `payload` is unvalidated JSON, so inspect each tool as a loose record to
    // tolerate either the Responses ({ name, parameters }) or a stray
    // Chat-Completions ({ function: { name } }) shape.
    const t = tool as unknown as Record<string, unknown>
    // Chat Completions format: { type: "function", function: { name, ... } }
    if (t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>
      if (fn.name && typeof fn.name === "string") {
        result.push(tool as unknown as Tool)
        continue
      }
    }
    // Responses API format: { type: "function", name: "...", parameters: {...} }
    if (t.name && typeof t.name === "string") {
      result.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description as string | undefined,
          parameters: (t.parameters ?? t.input_schema ?? {}) as Record<
            string,
            unknown
          >,
        },
      })
      continue
    }
    // Skip non-function tools (e.g., code_interpreter, computer_use) — unsupported by Copilot
  }
  return result.length > 0 ? result : undefined
}

function translateToolChoice(
  tc: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!tc) return undefined
  if (typeof tc === "string") return tc === "required" ? "required" : tc
  return { type: "function", function: { name: tc.name } }
}

// --- Response translation: Chat Completions → Responses API ---

export function translateToResponses(
  response: ChatCompletionResponse,
): ResponseObject {
  const output: Array<ResponseOutputItem> = []
  const choice = response.choices[0]

  // Text content → message output item
  if (choice.message.content) {
    const msg: ResponseOutputMessage = {
      type: "message",
      id: `msg_${response.id}`,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        },
      ],
    }
    output.push(msg)
  }

  // Tool calls → function_call output items
  for (const tc of choice.message.tool_calls ?? []) {
    const fc: ResponseOutputFunctionCall = {
      type: "function_call",
      id: `fc_${tc.id}`,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: "completed",
    }
    output.push(fc)
  }

  return {
    id: response.id,
    object: "response",
    created_at: response.created,
    model: response.model,
    status: "completed",
    output,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
    error: null,
  }
}
