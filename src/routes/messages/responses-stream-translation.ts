import type { ToolNameMap } from "~/routes/_shared/tool-name"

import { deriveAnthropicStopReason } from "~/routes/_shared/stop-reason"

import type {
  ResponseObject,
  ResponseOutputContent,
  ResponseStreamEvent,
} from "../responses/responses-types"
import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "./anthropic-types"

import { encodeBridgeReasoning } from "./bridge-reasoning"
import {
  formatMessagesUsage,
  readMessagesUsage,
  type MessagesUsage,
} from "./usage-translation"

// =============================================================================
// OpenAI Responses stream  ->  Anthropic Messages stream
//
// Reverse of routes/responses/stream-translation.ts. Consumes the NATIVE
// Responses SSE events coming back from the backend (whose `.delta` events carry
// real text / argument fragments) and emits Anthropic stream events. Reasoning
// items are skipped (the backend never exposes reasoning text). Lossy bridge.
// =============================================================================

export interface ResponsesToAnthropicStreamState {
  toolNames?: ToolNameMap
  usage?: MessagesUsage
  terminalSeen: boolean
  messageStartSent: boolean
  model: string
  responseId: string
  nextBlockIndex: number
  // Tool blocks use output indices; visible parts use output/content index pairs.
  items: Record<
    number,
    { blockIndex: number; kind: "text" | "tool"; open: boolean }
  >
  sawToolCall: boolean
  sawRefusal: boolean
  textParts: Record<string, TextBlockInfo>
}

export function createResponsesToAnthropicState(
  model: string,
  toolNames?: ToolNameMap,
): ResponsesToAnthropicStreamState {
  return {
    toolNames,
    terminalSeen: false,
    messageStartSent: false,
    model,
    responseId: "",
    nextBlockIndex: 0,
    items: {},
    sawToolCall: false,
    sawRefusal: false,
    textParts: {},
  }
}

export function translateResponsesEventToAnthropicEvents(
  event: ResponseStreamEvent,
  state: ResponsesToAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  if (state.terminalSeen) return events
  if ("response" in event)
    state.usage = readMessagesUsage(
      event.response.usage,
      "responses",
      state.usage,
    )

  if (handleTextEvent(event, state, events)) return events
  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      emitMessageStart(event.response, state, events)
      break
    }

    case "response.output_item.added": {
      handleOutputItemAdded(event, state, events)
      break
    }

    case "response.function_call_arguments.delta": {
      const info = lookupItem(state, event.output_index)
      if (info) {
        events.push({
          type: "content_block_delta",
          index: info.blockIndex,
          delta: { type: "input_json_delta", partial_json: event.delta },
        })
      }
      break
    }

    case "response.output_item.done": {
      if (event.item.type === "reasoning") {
        emitReasoning(event.item, state, events)
        break
      }
      if (event.item.type === "message") {
        emitMessageContent(
          { outputIndex: event.output_index, content: event.item.content },
          state,
          events,
        )
        closeTextParts(event.output_index, state, events)
      }
      // Close whichever block this index opened (text or tool).
      closeBlock(lookupItem(state, event.output_index), events)
      break
    }

    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      emitFinish(event, state, events)
      break
    }

    case "error": {
      events.push(
        ...translateResponsesFailureToAnthropicEvents(event.message, state),
      )
      break
    }

    // Function argument snapshots carry no extra signal after their deltas.
    default: {
      break
    }
  }

  return events
}

export function translateResponsesFailureToAnthropicEvents(
  message: string,
  state: ResponsesToAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  if (state.terminalSeen) return []
  state.terminalSeen = true
  const events: Array<AnthropicStreamEventData> = []
  for (const info of Object.values(state.items)) closeBlock(info, events)
  for (const info of Object.values(state.textParts)) closeBlock(info, events)
  events.push({ type: "error", error: { type: "api_error", message } })
  return events
}

type BlockInfo = { blockIndex: number; kind: "text" | "tool"; open: boolean }
type TextBlockInfo = BlockInfo & { text: string; closed: boolean }

// Record index-access is typed as always-present but returns undefined for a
// missing key at runtime — look up defensively.
function lookupItem(
  state: ResponsesToAnthropicStreamState,
  outputIndex: number,
): BlockInfo | undefined {
  return state.items[outputIndex] as BlockInfo | undefined
}

function closeBlock(
  info: BlockInfo | undefined,
  events: Array<AnthropicStreamEventData>,
): void {
  if (info?.open) {
    info.open = false
    events.push({ type: "content_block_stop", index: info.blockIndex })
  }
}

function handleOutputItemAdded(
  event: {
    output_index: number
    item: { type: string; call_id?: string; name?: string }
  },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  const { output_index: outputIndex, item } = event
  if (item.type === "function_call") {
    // Open a tool_use content block immediately (id + name are known here).
    state.sawToolCall = true
    const blockIndex = state.nextBlockIndex++
    state.items[outputIndex] = { blockIndex, kind: "tool", open: true }
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: item.call_id ?? "",
        name: state.toolNames?.toOriginal(item.name ?? "") ?? item.name ?? "",
        input: {},
      },
    })
  }
  // `reasoning` items are emitted whole on output_item.done (emitReasoning).
}

// Encrypted reasoning arrives complete, so it becomes a self-contained block.
function emitReasoning(
  item: { id?: string; encrypted_content?: string | null },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  const data = encodeBridgeReasoning(item)
  if (!data) return
  const index = state.nextBlockIndex++
  events.push(
    {
      type: "content_block_start",
      index,
      content_block: { type: "redacted_thinking", data },
    },
    { type: "content_block_stop", index },
  )
}

function emitFinish(
  event: { type: string; response: ResponseObject },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  const { response, type: terminalType } = event
  if (terminalType !== `response.${response.status}`) {
    events.push(
      ...translateResponsesFailureToAnthropicEvents(
        response.error?.message
          ?? "Upstream Responses terminal event disagrees with its response status.",
        state,
      ),
    )
    return
  }
  let stopReason: AnthropicResponse["stop_reason"]
  try {
    stopReason = deriveAnthropicStopReason(
      state.sawToolCall,
      response,
      state.sawRefusal,
    )
  } catch (error) {
    events.push(
      ...translateResponsesFailureToAnthropicEvents(
        error instanceof Error ? error.message : String(error),
        state,
      ),
    )
    return
  }
  emitMessageStart(response, state, events)
  for (const [outputIndex, item] of response.output.entries())
    if (item.type === "message")
      emitMessageContent({ outputIndex, content: item.content }, state, events)
  state.terminalSeen = true
  // Safety: close any still-open blocks before finishing.
  for (const info of Object.values(state.items)) {
    closeBlock(info, events)
  }
  for (const info of Object.values(state.textParts)) closeBlock(info, events)
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: formatMessagesUsage(
        state.usage ?? readMessagesUsage(undefined, "responses"),
      ),
    },
    { type: "message_stop" },
  )
}

function emitMessageStart(
  response: ResponseObject,
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (state.messageStartSent) return
  state.responseId = response.id || state.responseId
  state.messageStartSent = true
  events.push({
    type: "message_start",
    message: {
      id: state.responseId || "msg_stream",
      type: "message",
      role: "assistant",
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        ...formatMessagesUsage(readMessagesUsage(response.usage, "responses")),
        output_tokens: 0,
      },
    },
  })
}

// Text and refusal parts share a visible block keyed by both upstream indices.
// Closed parts stay registered so repeated done snapshots cannot replay text.
function openTextBlock(
  identity: { outputIndex: number; contentIndex: number },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): TextBlockInfo {
  const key = `${identity.outputIndex}:${identity.contentIndex}`
  let info = state.textParts[key] as TextBlockInfo | undefined
  if (!info) {
    info = {
      blockIndex: state.nextBlockIndex++,
      kind: "text",
      open: false,
      text: "",
      closed: false,
    }
    state.textParts[key] = info
  }
  if (info.closed) return info
  if (!info.open) {
    info.open = true
    events.push({
      type: "content_block_start",
      index: info.blockIndex,
      content_block: { type: "text", text: "" },
    })
  }
  return info
}

function handleTextEvent(
  event: ResponseStreamEvent,
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): boolean {
  switch (event.type) {
    case "response.output_text.delta":
    case "response.refusal.delta": {
      if (event.type === "response.refusal.delta") state.sawRefusal = true
      emitText(
        {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          text: event.delta,
          snapshot: false,
        },
        state,
        events,
      )
      return true
    }
    case "response.output_text.done":
    case "response.refusal.done": {
      if (event.type === "response.refusal.done") state.sawRefusal = true
      emitText(
        {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          text:
            event.type === "response.refusal.done" ? event.refusal : event.text,
          snapshot: true,
        },
        state,
        events,
      )
      return true
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      emitContentPart(
        {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          part: event.part,
        },
        state,
        events,
      )
      if (event.type === "response.content_part.done") {
        const info =
          state.textParts[`${event.output_index}:${event.content_index}`]
        closeBlock(info, events)
        info.closed = true
      }
      return true
    }
    default: {
      return false
    }
  }
}

function emitText(
  value: {
    outputIndex: number
    contentIndex: number
    text: string
    snapshot: boolean
  },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  const info = openTextBlock(value, state, events)
  if (info.closed) return
  let delta = value.text
  if (value.snapshot)
    delta =
      value.text.startsWith(info.text) ? value.text.slice(info.text.length) : ""
  if (!delta) return
  info.text += delta
  events.push({
    type: "content_block_delta",
    index: info.blockIndex,
    delta: { type: "text_delta", text: delta },
  })
}

function emitContentPart(
  value: {
    outputIndex: number
    contentIndex: number
    part: ResponseOutputContent
  },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  const { part } = value
  if (part.type === "refusal") state.sawRefusal = true
  emitText(
    {
      ...value,
      text: part.type === "refusal" ? part.refusal : part.text,
      snapshot: true,
    },
    state,
    events,
  )
}

function emitMessageContent(
  value: { outputIndex: number; content: Array<ResponseOutputContent> },
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  for (const [contentIndex, part] of value.content.entries())
    emitContentPart(
      { outputIndex: value.outputIndex, contentIndex, part },
      state,
      events,
    )
}

function closeTextParts(
  outputIndex: number,
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  for (const [key, info] of Object.entries(state.textParts)) {
    if (!key.startsWith(`${outputIndex}:`)) continue
    closeBlock(info, events)
    info.closed = true
  }
}
