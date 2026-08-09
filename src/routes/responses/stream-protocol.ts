import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import type {
  ResponseObject,
  ResponseOutputContent,
  ResponseOutputItem,
  ResponseOutputMessage,
} from "./responses-types"

const CHAT_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
])

export type NativeResponsesSseEvent = Record<string, unknown> & {
  type: string
  sequence_number?: number
  response?: ResponseObject
}

export function parseChatCompletionSseData(data: string): ChatCompletionChunk {
  const value = parseJsonObject(data)
  if (
    (value.object !== undefined && value.object !== "chat.completion.chunk")
    || typeof value.id !== "string"
    || typeof value.created !== "number"
    || typeof value.model !== "string"
    || !Array.isArray(value.choices)
    || !value.choices.every((choice) => isChatChoice(choice))
  ) {
    throw new Error("Upstream SSE contained an invalid Chat Completions chunk.")
  }
  return value as unknown as ChatCompletionChunk
}

export function parseNativeResponsesSseData(
  data: string,
): NativeResponsesSseEvent {
  const value = parseJsonObject(data)
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error("Upstream SSE contained an invalid Responses event.")
  }
  if (!hasValidKnownResponsesShape(value)) {
    throw new Error("Upstream SSE contained an invalid Responses event.")
  }
  return value as NativeResponsesSseEvent
}

export class NativeResponsesStreamTracker {
  private createdResponse?: ResponseObject
  private nextSequenceNumber = 1
  private readonly outputItems = new Map<number, ResponseOutputItem>()
  private terminal = false

  get terminalSeen(): boolean {
    return this.terminal
  }

  observe(event: NativeResponsesSseEvent): void {
    if (
      typeof event.sequence_number === "number"
      && Number.isInteger(event.sequence_number)
    ) {
      this.nextSequenceNumber = Math.max(
        this.nextSequenceNumber,
        event.sequence_number + 1,
      )
    }

    if (
      event.type === "response.created"
      || event.type === "response.in_progress"
    ) {
      if (isResponseObject(event.response)) {
        this.createdResponse = cloneResponse(event.response)
        this.seedOutputItems(event.response.output)
      }
      return
    }

    if (
      event.type === "response.output_item.added"
      || event.type === "response.output_item.done"
    ) {
      const outputIndex = event.output_index
      if (typeof outputIndex === "number" && isLooseOutputItem(event.item)) {
        this.outputItems.set(
          outputIndex,
          cloneOutputItem(event.item as unknown as ResponseOutputItem),
        )
      }
      return
    }

    if (event.type === "response.output_text.delta") {
      this.appendText(event.output_index, event.delta)
      return
    }
    if (event.type === "response.output_text.done") {
      this.setText(event.output_index, event.text)
      return
    }
    if (event.type === "response.function_call_arguments.delta") {
      this.appendArguments(event.output_index, event.delta)
      return
    }
    if (event.type === "response.function_call_arguments.done") {
      this.setArguments(event.output_index, event.arguments)
      return
    }

    if (isNativeTerminalType(event.type)) {
      if (isResponseObject(event.response)) {
        this.createdResponse = cloneResponse(event.response)
        this.seedOutputItems(event.response.output)
      }
      this.terminal = true
    }
  }

  fail(message: string): Array<NativeResponsesSseEvent> {
    if (this.terminal) return []
    this.terminal = true

    if (!this.createdResponse) {
      return [
        {
          type: "error",
          sequence_number: this.takeSequenceNumber(),
          code: "invalid_upstream_response",
          message,
          param: null,
        },
      ]
    }

    const output = this.sortedOutput().map((item) => markIncompleteIfOpen(item))
    const response: ResponseObject = {
      ...this.createdResponse,
      status: "failed",
      output,
      incomplete_details: null,
      error: {
        code: "invalid_upstream_response",
        type: "server_error",
        message,
        param: null,
      },
    }
    return [
      {
        type: "response.failed",
        sequence_number: this.takeSequenceNumber(),
        response,
      },
    ]
  }

  private seedOutputItems(output: Array<ResponseOutputItem>): void {
    for (const [index, item] of output.entries()) {
      if (!this.outputItems.has(index))
        this.outputItems.set(index, cloneOutputItem(item))
    }
  }

  private sortedOutput(): Array<ResponseOutputItem> {
    if (this.outputItems.size === 0) {
      return (
        this.createdResponse?.output.map((item) => cloneOutputItem(item)) ?? []
      )
    }
    return [...this.outputItems.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([, item]) => cloneOutputItem(item))
  }

  private appendText(outputIndex: unknown, delta: unknown): void {
    if (typeof outputIndex !== "number" || typeof delta !== "string") return
    const item = this.outputItems.get(outputIndex)
    if (!item || item.type !== "message") return
    const current = getMessageText(item)
    this.setText(outputIndex, current + delta)
  }

  private setText(outputIndex: unknown, text: unknown): void {
    if (typeof outputIndex !== "number" || typeof text !== "string") return
    const item = this.outputItems.get(outputIndex)
    if (!item || item.type !== "message") return
    this.outputItems.set(outputIndex, {
      ...item,
      content: [{ type: "output_text" as const, text, annotations: [] }],
    })
  }

  private appendArguments(outputIndex: unknown, delta: unknown): void {
    if (typeof outputIndex !== "number" || typeof delta !== "string") return
    const item = this.outputItems.get(outputIndex)
    if (!item || item.type !== "function_call") return
    this.setArguments(
      outputIndex,
      (typeof item.arguments === "string" ? item.arguments : "") + delta,
    )
  }

  private setArguments(outputIndex: unknown, value: unknown): void {
    if (typeof outputIndex !== "number" || typeof value !== "string") return
    const item = this.outputItems.get(outputIndex)
    if (!item || item.type !== "function_call") return
    this.outputItems.set(outputIndex, { ...item, arguments: value })
  }

  private takeSequenceNumber(): number {
    const sequenceNumber = this.nextSequenceNumber
    this.nextSequenceNumber++
    return sequenceNumber
  }
}

function isNativeTerminalType(type: string): boolean {
  return (
    type === "response.completed"
    || type === "response.incomplete"
    || type === "response.failed"
    || type === "error"
  )
}

function isResponseObject(value: unknown): value is ResponseObject {
  return (
    isRecord(value)
    && value.object === "response"
    && typeof value.id === "string"
    && typeof value.created_at === "number"
    && typeof value.model === "string"
    && typeof value.status === "string"
    && Array.isArray(value.output)
  )
}

function isLooseOutputItem(value: unknown): value is Record<string, unknown> & {
  id: string
  type: string
} {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.type === "string"
  )
}

function cloneResponse(response: ResponseObject): ResponseObject {
  return {
    ...response,
    output: response.output.map((item) => cloneOutputItem(item)),
  }
}

function cloneOutputItem(item: ResponseOutputItem): ResponseOutputItem {
  const loose = item as unknown as Record<string, unknown>
  if (item.type === "message" && Array.isArray(loose.content)) {
    return {
      ...item,
      content: (loose.content as Array<ResponseOutputContent>).map((content) =>
        cloneOutputContent(content),
      ),
    }
  }
  if (item.type === "function_call") return { ...item }
  if (item.type === "reasoning" && Array.isArray(loose.content)) {
    return { ...item, content: [...item.content] }
  }
  return { ...loose } as unknown as ResponseOutputItem
}

function cloneOutputContent(
  content: ResponseOutputContent,
): ResponseOutputContent {
  return {
    ...content,
    annotations: content.annotations ? [...content.annotations] : [],
  }
}

function getMessageText(item: ResponseOutputMessage): string {
  const rawContent = (item as unknown as { content?: unknown }).content
  return (Array.isArray(rawContent) ? rawContent : [])
    .filter(
      (part): part is { text: string; type: "output_text" } =>
        isRecord(part)
        && part.type === "output_text"
        && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
}

function markIncompleteIfOpen(item: ResponseOutputItem): ResponseOutputItem {
  const status = (item as unknown as { status?: unknown }).status
  return status === "in_progress" ?
      ({ ...item, status: "incomplete" } as ResponseOutputItem)
    : item
}

function parseJsonObject(data: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error("Upstream SSE contained invalid JSON.")
  }
  if (!isRecord(value)) throw new Error("Upstream SSE data must be an object.")
  return value
}

function isChatChoice(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.delta)) return false
  return (
    typeof value.index === "number"
    && (value.finish_reason === undefined
      || value.finish_reason === null
      || (typeof value.finish_reason === "string"
        && CHAT_FINISH_REASONS.has(value.finish_reason)))
  )
}

const RESPONSE_SNAPSHOT_EVENTS = new Set([
  "response.completed",
  "response.created",
  "response.failed",
  "response.in_progress",
  "response.incomplete",
])
const OUTPUT_ITEM_EVENTS = new Set([
  "response.output_item.added",
  "response.output_item.done",
])
const CONTENT_PART_EVENTS = new Set([
  "response.content_part.added",
  "response.content_part.done",
])

function hasValidKnownResponsesShape(value: Record<string, unknown>): boolean {
  const type = value.type as string
  if (RESPONSE_SNAPSHOT_EVENTS.has(type))
    return isResponseObject(value.response)
  if (OUTPUT_ITEM_EVENTS.has(type)) return hasOutputItemShape(value)
  if (CONTENT_PART_EVENTS.has(type)) return hasContentPartShape(value)
  if (type === "response.output_text.delta") return hasTextDeltaShape(value)
  if (type === "response.output_text.done") return hasTextDoneShape(value)
  if (type === "response.function_call_arguments.delta")
    return hasArgumentsDeltaShape(value)
  if (type === "response.function_call_arguments.done")
    return hasArgumentsDoneShape(value)
  if (type === "error") return hasErrorShape(value)
  return true
}

function hasOutputItemShape(value: Record<string, unknown>): boolean {
  return isOutputIndex(value.output_index) && isLooseOutputItem(value.item)
}

function hasContentPartShape(value: Record<string, unknown>): boolean {
  return (
    isOutputIndex(value.output_index)
    && isOutputIndex(value.content_index)
    && typeof value.item_id === "string"
    && isRecord(value.part)
  )
}

function hasTextDeltaShape(value: Record<string, unknown>): boolean {
  return hasTextEventIdentity(value) && typeof value.delta === "string"
}

function hasTextDoneShape(value: Record<string, unknown>): boolean {
  return hasTextEventIdentity(value) && typeof value.text === "string"
}

function hasTextEventIdentity(value: Record<string, unknown>): boolean {
  return (
    isOutputIndex(value.output_index)
    && isOutputIndex(value.content_index)
    && typeof value.item_id === "string"
  )
}

function hasArgumentsDeltaShape(value: Record<string, unknown>): boolean {
  return hasItemEventIdentity(value) && typeof value.delta === "string"
}

function hasArgumentsDoneShape(value: Record<string, unknown>): boolean {
  return hasItemEventIdentity(value) && typeof value.arguments === "string"
}

function hasItemEventIdentity(value: Record<string, unknown>): boolean {
  return isOutputIndex(value.output_index) && typeof value.item_id === "string"
}

function hasErrorShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.code === "string"
    && typeof value.message === "string"
    && (value.param === null || typeof value.param === "string")
  )
}

function isOutputIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
