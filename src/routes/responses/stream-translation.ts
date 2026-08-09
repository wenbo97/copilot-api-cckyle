import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import type {
  ResponseObject,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseStreamState,
} from "./responses-types"

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence_number"> : never
type UnsequencedResponseStreamEvent = WithoutSequence<ResponseStreamEvent>

interface ToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

type ToolCallState = ResponseStreamState["toolCalls"][number]
type OutputItemStatus = ResponseOutputMessage["status"]

export function translateChunkToResponseEvents(
  chunk: ChatCompletionChunk,
  state: ResponseStreamState,
): Array<ResponseStreamEvent> {
  const events: Array<ResponseStreamEvent> = []
  if (state.terminalEmitted) return events

  updateStreamMetadata(chunk, state)
  if (chunk.choices.length === 0) return events

  const choice = chunk.choices[0]
  emitResponseStart(state, events)
  emitTextDelta(choice.delta, state, events)
  emitToolCallDeltas(choice.delta, state, events)

  if (choice.finish_reason) {
    emitFinish(choice.finish_reason, state, events)
  }

  return events
}

export function translateStreamFailureToResponseEvents(
  message: string,
  state: ResponseStreamState,
): Array<ResponseStreamEvent> {
  const events: Array<ResponseStreamEvent> = []
  if (state.terminalEmitted) return events

  state.nextSequenceNumber ??= 1
  if (!state.messageStarted) {
    pushEvent(state, events, {
      type: "error",
      code: "invalid_upstream_response",
      message,
      param: null,
    })
    state.terminalEmitted = true
    return events
  }

  const output = closeOutputItems(state, "incomplete", events)
  const response = makeResponse(state, "failed", output)
  response.error = {
    code: "invalid_upstream_response",
    type: "server_error",
    message,
    param: null,
  }
  pushEvent(state, events, { type: "response.failed", response })
  state.terminalEmitted = true
  return events
}

function updateStreamMetadata(
  chunk: ChatCompletionChunk,
  state: ResponseStreamState,
): void {
  state.responseId ||= chunk.id
  state.model ||= chunk.model
  state.createdAt ??= chunk.created
  state.nextSequenceNumber ??= 1
  state.terminalEmitted ??= false

  if (chunk.usage) {
    state.usage = {
      input_tokens: chunk.usage.prompt_tokens,
      output_tokens: chunk.usage.completion_tokens,
      total_tokens: chunk.usage.total_tokens,
    }
  }
}

function emitResponseStart(
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): void {
  if (state.messageStarted) return

  const response = makeResponse(state, "in_progress", [])
  pushEvent(state, events, { type: "response.created", response })
  pushEvent(state, events, {
    type: "response.in_progress",
    response: { ...response },
  })
  state.messageStarted = true
}

function emitTextDelta(
  delta: { content?: string | null },
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): void {
  if (!delta.content) return

  if (!state.messageItemOpen) {
    state.messageOutputItemIndex = reserveOutputIndex(state)
    state.messageItemId = `msg_${state.responseId}`
    state.messageItemOpen = true
    state.textContent = ""

    const item = makeMessageItem(state, "in_progress")
    pushEvent(state, events, {
      type: "response.output_item.added",
      output_index: state.messageOutputItemIndex,
      item,
    })
    pushEvent(state, events, {
      type: "response.content_part.added",
      item_id: state.messageItemId,
      output_index: state.messageOutputItemIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })
  }

  state.textContent = (state.textContent ?? "") + delta.content
  pushEvent(state, events, {
    type: "response.output_text.delta",
    item_id: requireMessageItemId(state),
    output_index: requireMessageOutputIndex(state),
    content_index: 0,
    delta: delta.content,
  })
}

function emitToolCallDeltas(
  delta: { tool_calls?: Array<ToolCallDelta> },
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): void {
  if (!delta.tool_calls) return

  for (const toolCallDelta of delta.tool_calls) {
    const info = getOrCreateToolCallState(toolCallDelta.index, state)
    mergeToolIdentity(toolCallDelta, info, state)

    const argumentsDelta = toolCallDelta.function?.arguments
    if (argumentsDelta !== undefined) {
      info.arguments += argumentsDelta
      if (argumentsDelta) {
        if (info.itemAdded && info.id) {
          pushEvent(state, events, {
            type: "response.function_call_arguments.delta",
            item_id: info.id,
            output_index: requireToolOutputIndex(info),
            delta: argumentsDelta,
          })
        } else {
          ;(info.pendingArgumentDeltas ??= []).push(argumentsDelta)
        }
      }
    }

    // A function name may itself be split across frames. Treat the appearance
    // of the arguments field as the point where metadata is complete enough to
    // open the item; finish handling also opens zero-argument calls.
    if (argumentsDelta !== undefined) ensureToolItemAdded(info, state, events)
  }
}

function getOrCreateToolCallState(
  toolIndex: number,
  state: ResponseStreamState,
): ToolCallState {
  const existing = state.toolCalls[toolIndex] as ToolCallState | undefined
  if (existing) return existing

  const created: ToolCallState = {
    arguments: "",
    pendingArgumentDeltas: [],
    itemAdded: false,
  }
  state.toolCalls[toolIndex] = created
  return created
}

function mergeToolIdentity(
  delta: ToolCallDelta,
  info: ToolCallState,
  state: ResponseStreamState,
): void {
  if (delta.id) {
    if (info.callId && info.callId !== delta.id) {
      state.protocolError =
        `Tool call at index ${delta.index} changed id from `
        + `"${info.callId}" to "${delta.id}".`
    } else {
      info.callId = delta.id
      info.id = `fc_${delta.id}`
    }
  }

  const nameDelta = delta.function?.name
  if (!nameDelta) return

  if (!info.name) {
    info.name = nameDelta
    return
  }
  if (info.name === nameDelta) return

  if (info.itemAdded) {
    state.protocolError =
      `Tool call "${info.callId ?? delta.index}" changed its function name `
      + `after response.output_item.added.`
    return
  }

  // Chat Completions may split a function name across delta frames.
  info.name =
    nameDelta.startsWith(info.name) ? nameDelta : info.name + nameDelta
}

function ensureToolItemAdded(
  info: ToolCallState,
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): boolean {
  if (info.itemAdded) return true
  if (!info.id || !info.callId || !info.name) return false

  info.outputItemIndex = reserveOutputIndex(state)
  info.itemAdded = true
  pushEvent(state, events, {
    type: "response.output_item.added",
    output_index: requireToolOutputIndex(info),
    item: makeFunctionCallItem(info, "in_progress"),
  })

  for (const delta of info.pendingArgumentDeltas ?? []) {
    pushEvent(state, events, {
      type: "response.function_call_arguments.delta",
      item_id: info.id,
      output_index: requireToolOutputIndex(info),
      delta,
    })
  }
  info.pendingArgumentDeltas = []
  return true
}

function emitFinish(
  finishReason: string,
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): void {
  if (state.terminalEmitted) return

  const malformedTools = openPendingToolItems(state, events)
  const protocolError =
    state.protocolError
    ?? getFinishReasonError(finishReason)
    ?? getMalformedToolsError(malformedTools)
  const terminalStatus = classifyTerminalStatus(finishReason, protocolError)
  const itemStatus: OutputItemStatus =
    terminalStatus === "completed" ? "completed" : "incomplete"

  const output = closeOutputItems(state, itemStatus, events)
  const response = makeResponse(state, terminalStatus, output)

  if (terminalStatus === "incomplete") {
    response.incomplete_details = {
      reason: getIncompleteReason(finishReason),
    }
    pushEvent(state, events, { type: "response.incomplete", response })
  } else if (terminalStatus === "failed") {
    response.error = {
      code: "invalid_upstream_response",
      type: "server_error",
      message: protocolError ?? "The upstream stream was malformed.",
      param: null,
    }
    pushEvent(state, events, { type: "response.failed", response })
  } else {
    pushEvent(state, events, { type: "response.completed", response })
  }

  state.terminalEmitted = true
}

function openPendingToolItems(
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
): Array<number> {
  const malformedTools: Array<number> = []
  for (const [toolIndex, info] of sortedToolCalls(state)) {
    if (!ensureToolItemAdded(info, state, events))
      malformedTools.push(toolIndex)
  }
  return malformedTools
}

function getFinishReasonError(finishReason: string): string | undefined {
  if (
    finishReason === "stop"
    || finishReason === "length"
    || finishReason === "tool_calls"
    || finishReason === "content_filter"
  )
    return
  return `Unknown upstream finish reason "${finishReason}".`
}

function getMalformedToolsError(
  malformedTools: Array<number>,
): string | undefined {
  if (malformedTools.length === 0) return
  const indexLabel = malformedTools.length === 1 ? "index" : "indexes"
  return `Upstream finished with incomplete tool call metadata at ${indexLabel} ${malformedTools.join(", ")}.`
}

function classifyTerminalStatus(
  finishReason: string,
  protocolError?: string,
): ResponseObject["status"] {
  if (protocolError) return "failed"
  if (finishReason === "length" || finishReason === "content_filter")
    return "incomplete"
  return "completed"
}

function getIncompleteReason(
  finishReason: string,
): NonNullable<ResponseObject["incomplete_details"]>["reason"] {
  return finishReason === "content_filter" ? "content_filter" : (
      "max_output_tokens"
    )
}

function closeOutputItems(
  state: ResponseStreamState,
  status: OutputItemStatus,
  events: Array<ResponseStreamEvent>,
): Array<ResponseOutputItem> {
  const closers: Array<{
    outputIndex: number
    close: () => ResponseOutputItem
  }> = []

  if (state.messageItemOpen) {
    closers.push({
      outputIndex: requireMessageOutputIndex(state),
      close: () => closeMessageItem(state, status, events),
    })
  }

  for (const [, info] of sortedToolCalls(state)) {
    if (!info.itemAdded || !info.id || !info.callId || !info.name) continue
    closers.push({
      outputIndex: requireToolOutputIndex(info),
      close: () => closeToolItem(info, { events, state, status }),
    })
  }

  return closers
    .toSorted((left, right) => left.outputIndex - right.outputIndex)
    .map(({ close }) => close())
}

function closeMessageItem(
  state: ResponseStreamState,
  status: OutputItemStatus,
  events: Array<ResponseStreamEvent>,
): ResponseOutputMessage {
  const itemId = requireMessageItemId(state)
  const outputIndex = requireMessageOutputIndex(state)
  const text = state.textContent ?? ""
  const item = makeMessageItem(state, status)

  pushEvent(state, events, {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    text,
  })
  pushEvent(state, events, {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text, annotations: [] },
  })
  pushEvent(state, events, {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  })
  return item
}

interface CloseToolContext {
  events: Array<ResponseStreamEvent>
  state: ResponseStreamState
  status: OutputItemStatus
}

function closeToolItem(
  info: ToolCallState,
  context: CloseToolContext,
): ResponseOutputFunctionCall {
  const { events, state, status } = context
  const item = makeFunctionCallItem(info, status)
  pushEvent(state, events, {
    type: "response.function_call_arguments.done",
    item_id: item.id,
    output_index: requireToolOutputIndex(info),
    arguments: info.arguments,
  })
  pushEvent(state, events, {
    type: "response.output_item.done",
    output_index: requireToolOutputIndex(info),
    item,
  })
  return item
}

function makeMessageItem(
  state: ResponseStreamState,
  status: OutputItemStatus,
): ResponseOutputMessage {
  return {
    type: "message",
    id: requireMessageItemId(state),
    role: "assistant",
    status,
    content:
      status === "in_progress" ?
        []
      : [
          {
            type: "output_text",
            text: state.textContent ?? "",
            annotations: [],
          },
        ],
  }
}

function makeFunctionCallItem(
  info: ToolCallState,
  status: OutputItemStatus,
): ResponseOutputFunctionCall {
  if (!info.id || !info.callId || !info.name) {
    throw new Error("Cannot construct a function call item without identity")
  }
  return {
    type: "function_call",
    id: info.id,
    call_id: info.callId,
    name: info.name,
    arguments: status === "in_progress" ? "" : info.arguments,
    status,
  }
}

function makeResponse(
  state: ResponseStreamState,
  status: ResponseObject["status"],
  output: Array<ResponseOutputItem>,
): ResponseObject {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt ?? 0,
    model: state.model,
    status,
    output,
    metadata: state.metadata,
    usage: state.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    incomplete_details: null,
    error: null,
  }
}

function sortedToolCalls(
  state: ResponseStreamState,
): Array<[number, ToolCallState]> {
  return Object.entries(state.toolCalls)
    .map(([index, info]) => [Number(index), info] as [number, ToolCallState])
    .toSorted(
      ([leftIndex, left], [rightIndex, right]) =>
        (left.outputItemIndex ?? Number.POSITIVE_INFINITY)
          - (right.outputItemIndex ?? Number.POSITIVE_INFINITY)
        || leftIndex - rightIndex,
    )
}

function reserveOutputIndex(state: ResponseStreamState): number {
  const outputIndex = state.outputItemIndex
  state.outputItemIndex++
  return outputIndex
}

function requireMessageItemId(state: ResponseStreamState): string {
  if (!state.messageItemId) {
    throw new Error("Message item id is unavailable before the item is opened")
  }
  return state.messageItemId
}

function requireMessageOutputIndex(state: ResponseStreamState): number {
  if (state.messageOutputItemIndex === undefined) {
    throw new Error(
      "Message output index is unavailable before the item is opened",
    )
  }
  return state.messageOutputItemIndex
}

function requireToolOutputIndex(info: ToolCallState): number {
  if (info.outputItemIndex === undefined) {
    throw new Error(
      "Tool output index is unavailable before the item is opened",
    )
  }
  return info.outputItemIndex
}

function pushEvent(
  state: ResponseStreamState,
  events: Array<ResponseStreamEvent>,
  event: UnsequencedResponseStreamEvent,
): void {
  const sequenceNumber = state.nextSequenceNumber ?? 1
  state.nextSequenceNumber = sequenceNumber + 1
  events.push({
    ...event,
    sequence_number: sequenceNumber,
  } as ResponseStreamEvent)
}
