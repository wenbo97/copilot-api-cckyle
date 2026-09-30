import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { randomUUID } from "node:crypto"

import type {
  ResponseObject,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

import { HTTPError } from "~/lib/error"

import type { CopilotRequestOptions } from "./request-options"

import { copilotFetch } from "./copilot-fetch"
import { readCopilotErrorDetail } from "./input-connection-error"
import { ResponsesHistoryRegistry } from "./responses-history-registry"
import {
  type HistoryRecoverySummary,
  parseResponsesJson,
  responsesUpstreamError,
  ResponsesUpstreamError,
} from "./responses-upstream-error"
import { CopilotStreamLifecycle } from "./stream-lifecycle"

interface Attempt {
  response: Response
  lifecycle?: CopilotStreamLifecycle
}

interface HistoryRequestOptions extends CopilotRequestOptions {
  onAttempt?: () => void
}

// Keep retry state private to one request. Once any Responses event is yielded,
// replay is forbidden, including when a later frame reports an ownership error.
class HistoryRequest {
  private body: ResponsesPayload
  private readonly headers: Record<string, string>
  private readonly options: HistoryRequestOptions
  private readonly registry = new ResponsesHistoryRegistry()
  private readonly requestId = randomUUID()
  private retried = false
  private forwarded = false
  private readonly recovery: HistoryRecoverySummary = {
    attempted: false,
    removed: 0,
  }

  constructor(
    body: ResponsesPayload,
    headers: Record<string, string>,
    options: HistoryRequestOptions,
  ) {
    this.body = body
    this.headers = headers
    this.options = options
  }

  async run(): Promise<
    ResponseObject | AsyncGenerator<ServerSentEventMessage>
  > {
    const first = await this.open()
    return first.lifecycle ? this.stream(first) : this.readJson(first)
  }

  private async recover(error: unknown): Promise<boolean> {
    this.options.signal?.throwIfAborted()
    if (
      (error instanceof ResponsesUpstreamError || error instanceof HTTPError)
      && (isHistoryOwnershipError(error) || this.recovery.attempted)
    )
      error.recovery = this.recovery
    if (
      this.retried
      || this.forwarded
      || !isHistoryOwnershipError(error)
      || typeof this.body.input === "string"
    )
      return false
    // Reserve the single retry before asynchronous receipt lookups.
    this.retried = true
    let removed = 0
    let input: ResponsesPayload["input"]
    try {
      await this.registry.ensureHealthy()
      input = (await Promise.all(
        this.body.input.map(async (item) => {
          const value = item as unknown as Record<string, unknown>
          if (
            value.type !== "reasoning"
            || typeof value.encrypted_content !== "string"
          )
            return item
          if (await this.registry.isIssued(value.encrypted_content)) return item
          const clean = { ...value }
          delete clean.encrypted_content
          removed++
          return clean
        }),
      )) as ResponsesPayload["input"]
    } catch (registryError) {
      this.options.signal?.throwIfAborted()
      this.recovery.disabledReason =
        registryError instanceof Error ?
          registryError.message
        : "history registry unavailable"
      return false
    }
    if (removed === 0) return false
    this.options.signal?.throwIfAborted()
    this.recovery.attempted = true
    this.recovery.removed = removed
    this.body = { ...this.body, input: input }
    consola.warn(
      `[Responses] History recovery request=${this.requestId}, removed=${removed}, retry=1`,
    )
    return true
  }

  private async open(): Promise<Attempt> {
    for (;;) {
      this.options.signal?.throwIfAborted()
      const lifecycle =
        this.body.stream ?
          new CopilotStreamLifecycle(
            this.options.signal,
            this.options.streamTimeouts,
          )
        : undefined
      try {
        const response = await copilotFetch("/responses", {
          method: "POST",
          body: JSON.stringify(this.body),
          extraHeaders: this.headers,
          signal: lifecycle?.signal ?? this.options.signal,
          headerTimeoutMs: this.options.headerTimeoutMs,
          onAttempt: this.options.onAttempt,
        })
        return { response, lifecycle }
      } catch (error) {
        lifecycle?.dispose(error)
        // A retry can fail differently (e.g. 503). Once SSE has started, the
        // HTTP forwarder cannot read that response, so preserve its cause here.
        let failure = error
        if (error instanceof HTTPError && this.recovery.attempted) {
          const detail = await readCopilotErrorDetail(
            error.response,
            this.options.signal,
          )
          if (detail) {
            await error.response.body?.cancel()
            failure = new ResponsesUpstreamError(
              error.response.status,
              detail.message,
              detail.code,
            )
          }
        }
        if (!(await this.recover(failure))) throw failure
      }
    }
  }

  private async readJson(first: Attempt): Promise<ResponseObject> {
    let attempt = first
    for (;;) {
      const value = (await attempt.response.json()) as ResponseObject
      const error = responsesUpstreamError(value)
      if (!error) {
        await this.registry.remember(value)
        return value
      }
      if (!(await this.recover(error))) throw error
      attempt = await this.open()
    }
  }

  private async inspectEvent(event: ServerSentEventMessage): Promise<void> {
    this.options.signal?.throwIfAborted()
    if (!event.data || event.data === "[DONE]") return
    const value = parseResponsesJson(event.data)
    const error = responsesUpstreamError(value)
    const eventType = (value as { type?: unknown } | undefined)?.type
    // Preserve official upstream failures, except for the precise failure
    // handled by our recovery policy. Untyped envelopes become explicit errors.
    if (
      error
      && (error.isHistoryOwnershipError || typeof eventType !== "string")
    )
      throw error
    await this.registry.remember(value)
    this.forwarded = true
  }

  private async *stream(
    first: Attempt,
  ): AsyncGenerator<ServerSentEventMessage> {
    let attempt = first
    for (;;) {
      const lifecycle = attempt.lifecycle
      if (!lifecycle) throw new Error("Missing Responses stream lifecycle")
      try {
        for await (const event of lifecycle.iterate(attempt.response)) {
          await this.inspectEvent(event)
          yield event
        }
        return
      } catch (error) {
        if (!(await this.recover(error))) throw error
      } finally {
        lifecycle.dispose()
      }
      attempt = await this.open()
    }
  }
}

export function requestResponsesWithHistoryRecovery(
  body: ResponsesPayload,
  extraHeaders: Record<string, string>,
  options: HistoryRequestOptions,
): Promise<ResponseObject | AsyncGenerator<ServerSentEventMessage>> {
  return new HistoryRequest(body, extraHeaders, options).run()
}

function isHistoryOwnershipError(error: unknown): boolean {
  return (
    error instanceof ResponsesUpstreamError && error.isHistoryOwnershipError
  )
}
