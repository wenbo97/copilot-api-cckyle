import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CopilotRequestScope } from "~/services/copilot/request-options"

import { StreamTracer } from "~/lib/trace"
import { parseChatCompletionSseData } from "~/routes/responses/stream-protocol"

import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "./anthropic-types"
import type { MessagesUsageDiagnostics } from "./usage-diagnostics"

import {
  failAnthropicStream,
  finishAnthropicStream,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

interface ChatStreamContext {
  response: AsyncGenerator<ServerSentEventMessage>
  requestOptions: CopilotRequestScope
  trailerController: AbortController
  traceTimestamp: string | null
  diagnostics: MessagesUsageDiagnostics
}

export function streamMessagesFromChat(c: Context, context: ChatStreamContext) {
  const { response, requestOptions, trailerController, traceTimestamp } =
    context
  return streamSSE(c, async (stream) => {
    stream.onAbort(requestOptions.abort)
    const state: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const tracer = new StreamTracer(traceTimestamp)
    let trailerTimer: ReturnType<typeof setTimeout> | undefined
    const write = async (events: Array<AnthropicStreamEventData>) => {
      for (const event of events) {
        tracer.addChunk({ anthropic: event })
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
    try {
      for await (const rawEvent of response) {
        if (requestOptions.signal.aborted) break
        trailerController.signal.throwIfAborted()
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue
        const chunk = parseChatCompletionSseData(rawEvent.data)
        tracer.addChunk({ openai: chunk })
        const events = translateChunkToAnthropicEvents(chunk, state)
        if (
          state.pendingStopReason
          && !state.terminalEmitted
          && trailerTimer === undefined
        ) {
          trailerTimer = setTimeout(
            () =>
              trailerController.abort(
                new DOMException(
                  "Upstream usage trailer timeout after 5000 ms.",
                  "TimeoutError",
                ),
              ),
            5000,
          )
        }
        await write(events)
        if (state.terminalEmitted) break
      }
      if (!requestOptions.signal.aborted && !state.terminalEmitted) {
        trailerController.signal.throwIfAborted()
        await write(
          state.pendingStopReason ?
            finishAnthropicStream(state)
          : failAnthropicStream(
              "Upstream Chat Completions ended before a finish_reason.",
              state,
            ),
        )
      }
    } catch (error) {
      if (!requestOptions.signal.aborted) {
        await write(
          failAnthropicStream(
            error instanceof Error ?
              error.message
            : "Upstream Chat Completions stream failed.",
            state,
          ),
        ).catch(() => undefined)
      }
    } finally {
      if (trailerTimer !== undefined) clearTimeout(trailerTimer)
      context.diagnostics.finish(state.usage)
      await tracer.finish()
    }
  })
}
