import { deriveAnthropicStopReason } from "~/routes/_shared/stop-reason"

import type {
  ResponseObject,
  ResponseStreamEvent,
} from "../responses/responses-types"
import type { AnthropicStreamEventData } from "./anthropic-types"

// =============================================================================
// OpenAI Responses stream  ->  Anthropic Messages stream
//
// Reverse of routes/responses/stream-translation.ts. Consumes the NATIVE
// Responses SSE events coming back from the backend (whose `.delta` events carry
// real text / argument fragments) and emits Anthropic stream events. Reasoning
// items are skipped (the backend never exposes reasoning text). Lossy bridge.
// =============================================================================

export interface ResponsesToAnthropicStreamState {
  messageStartSent: boolean
  model: string
  responseId: string
  nextBlockIndex: number
  // Maps a Responses `output_index` to its Anthropic content-block bookkeeping.
  // Reasoning items are never registered here (they consume an output_index but
  // produce no Anthropic block).
  items: Record<
    number,
    { blockIndex: number; kind: "text" | "tool"; open: boolean }
  >
  sawToolCall: boolean
}

export function createResponsesToAnthropicState(
  model: string,
): ResponsesToAnthropicStreamState {
  return {
    messageStartSent: false,
    model,
    responseId: "",
    nextBlockIndex: 0,
    items: {},
    sawToolCall: false,
  }
}

export function translateResponsesEventToAnthropicEvents(
  event: ResponseStreamEvent,
  state: ResponsesToAnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

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

    case "response.content_part.added": {
      // Opens the text block (if a message item was registered for this index).
      openTextBlock(event.output_index, state, events)
      break
    }

    case "response.output_text.delta": {
      // Lazily open in case the backend skipped content_part.added.
      const info = openTextBlock(event.output_index, state, events)
      if (info) {
        events.push({
          type: "content_block_delta",
          index: info.blockIndex,
          delta: { type: "text_delta", text: event.delta },
        })
      }
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
      // Close whichever block this index opened (text or tool).
      closeBlock(lookupItem(state, event.output_index), events)
      break
    }

    case "response.completed": {
      emitFinish(event.response, state, events)
      break
    }

    case "error": {
      events.push({
        type: "error",
        error: { type: event.error.type, message: event.error.message },
      })
      break
    }

    // content_part.done / output_text.done / function_call_arguments.done carry
    // no extra Anthropic signal (block close happens on output_item.done).
    default: {
      break
    }
  }

  return events
}

type BlockInfo = { blockIndex: number; kind: "text" | "tool"; open: boolean }

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
        name: item.name ?? "",
        input: {},
      },
    })
  } else if (item.type === "message") {
    // Register a text block; open it lazily on the first text signal.
    state.items[outputIndex] = {
      blockIndex: state.nextBlockIndex++,
      kind: "text",
      open: false,
    }
  }
  // `reasoning` items are intentionally not registered (skipped).
}

function emitFinish(
  response: ResponseObject,
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  // Safety: close any still-open blocks before finishing.
  for (const info of Object.values(state.items)) {
    closeBlock(info, events)
  }
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: deriveAnthropicStopReason(
          state.sawToolCall,
          response.status,
        ),
        stop_sequence: null,
      },
      usage: {
        output_tokens: response.usage?.output_tokens ?? 0,
      },
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
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: 0,
      },
    },
  })
}

// Opens (once) the text content block registered for an output_index, returning
// its bookkeeping. Returns undefined if no text item is registered there.
function openTextBlock(
  outputIndex: number,
  state: ResponsesToAnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): BlockInfo | undefined {
  const info = lookupItem(state, outputIndex)
  if (!info || info.kind !== "text") return info
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
