import type { ToolNameMap } from "~/routes/_shared/tool-name"

import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  formatMessagesUsage,
  hasMessagesUsage,
  readMessagesUsage,
} from "./usage-translation"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  toolNames?: ToolNameMap,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  if (state.terminalEmitted) return events
  const usage = readMessagesUsage(chunk.usage, "chat")
  const observed = hasMessagesUsage(usage)
  state.usage = readMessagesUsage(chunk.usage, "chat", state.usage)
  if (state.pendingStopReason) {
    if (
      chunk.choices.some(
        (choice) =>
          choice.delta.content
          || choice.delta.refusal
          || choice.delta.tool_calls?.length,
      )
    )
      return failAnthropicStream(
        "Upstream sent content after finish_reason.",
        state,
      )
    return observed ? finishAnthropicStream(state) : events
  }

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...formatMessagesUsage(usage),
          output_tokens: 0, // Will be updated in message_delta when finished
        },
      },
    })
    state.messageStartSent = true
  }

  const text = (delta.content ?? "") + (delta.refusal ?? "")
  if (delta.refusal) state.refusalSeen = true
  if (text) {
    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text,
      },
    })
  }

  for (const toolCall of delta.tool_calls ?? []) {
    if (!Number.isInteger(toolCall.index) || toolCall.index < 0)
      return [
        ...events,
        ...failAnthropicStream("Invalid tool call index.", state),
      ]
    const info = (state.toolCalls[toolCall.index] ??= { arguments: "" })
    if (toolCall.id) {
      if (info.id && info.id !== toolCall.id)
        return [
          ...events,
          ...failAnthropicStream("Upstream tool call changed id.", state),
        ]
      info.id = toolCall.id
    }
    const name = toolCall.function?.name
    if (name && info.name !== name)
      info.name =
        info.name && !name.startsWith(info.name) ? info.name + name : name
    info.arguments += toolCall.function?.arguments ?? ""
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
      state.contentBlockIndex++
    }

    const tools = Object.entries(state.toolCalls).sort(
      ([left], [right]) => Number(left) - Number(right),
    )
    const emitTools =
      !state.refusalSeen
      && (choice.finish_reason === "tool_calls"
        || choice.finish_reason === "stop")
    if (emitTools && tools.some(([, tool]) => !tool.id || !tool.name))
      return [
        ...events,
        ...failAnthropicStream(
          "Upstream finished with incomplete tool metadata.",
          state,
        ),
      ]
    if (emitTools) {
      for (const [, tool] of tools) {
        if (!tool.id || !tool.name) continue
        const index = state.contentBlockIndex++
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: tool.id,
              name: toolNames?.toOriginal(tool.name) ?? tool.name,
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: tool.arguments || "{}",
            },
          },
          { type: "content_block_stop", index },
        )
      }
    }
    state.pendingStopReason = mapOpenAIStopReasonToAnthropic(
      tools.length > 0 && choice.finish_reason === "stop" ?
        "tool_calls"
      : choice.finish_reason,
    )
    if (state.refusalSeen && choice.finish_reason !== "length")
      state.pendingStopReason = "refusal"
    if (observed) events.push(...finishAnthropicStream(state))
  }

  return events
}

export function finishAnthropicStream(
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  if (state.terminalEmitted || !state.pendingStopReason) return []
  state.terminalEmitted = true
  return [
    {
      type: "message_delta",
      delta: { stop_reason: state.pendingStopReason, stop_sequence: null },
      usage: formatMessagesUsage(
        state.usage ?? readMessagesUsage(undefined, "chat"),
      ),
    },
    { type: "message_stop" },
  ]
}

export function failAnthropicStream(
  message: string,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  if (state.terminalEmitted) return []
  state.terminalEmitted = true
  state.toolCalls = {}
  const events: Array<AnthropicStreamEventData> = []
  if (state.contentBlockOpen) {
    events.push({ type: "content_block_stop", index: state.contentBlockIndex })
    state.contentBlockOpen = false
  }
  events.push({ type: "error", error: { type: "api_error", message } })
  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
