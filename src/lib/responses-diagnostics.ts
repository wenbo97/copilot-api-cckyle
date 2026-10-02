import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { createHmac, randomBytes, randomUUID } from "node:crypto"

import type { CachePolicySummary } from "~/lib/responses-cache-policy"
import type {
  ResponsesAttemptCause,
  ResponsesAttemptObserver,
} from "~/services/copilot/request-observer"

import {
  type CacheIngressProtocol,
  type CacheIntentSummary,
  inspectCacheIntent,
} from "~/lib/cache-intent"
import { HTTPError, InvalidRequestError } from "~/lib/error"
import { ResponsesUpstreamError } from "~/services/copilot/responses-upstream-error"

// Fingerprints can be compared within this process, but cannot be used to
// dictionary-match prompts against unsalted, persistent content hashes.
const fingerprintKey = randomBytes(32)

type JsonRecord = Record<string, unknown>
type Count = number | null

interface DiagnosticsContext {
  ingress: unknown
  egress: unknown
  serializedBody?: string
  signal?: AbortSignal
  cachePolicy?: CachePolicySummary
  origin?: ResponsesDiagnosticOrigin
}

export interface ResponsesDiagnosticOrigin {
  requestId: string
  ingressProtocol: CacheIngressProtocol
  cacheIntent: CacheIntentSummary | null
  ingressFingerprints?: JsonRecord
  ingressStaticPrefix?: JsonRecord
}

export function responsesDiagnosticOrigin(
  ingressProtocol: CacheIngressProtocol,
  payload: unknown,
): ResponsesDiagnosticOrigin | undefined {
  if (!["1", "true"].includes(process.env.COPILOT_CACHE_DIAGNOSTICS ?? ""))
    return
  try {
    const ingress = ingressForFingerprints(payload, ingressProtocol)
    return {
      requestId: randomUUID(),
      ingressProtocol,
      cacheIntent: inspectCacheIntent(payload, ingressProtocol),
      ingressFingerprints: fingerprints(ingress),
      ingressStaticPrefix: staticPrefix(ingress),
    }
  } catch {
    // Optional diagnostics must not turn a valid request into a failure.
    return
  }
}

interface CacheUsage {
  input_tokens: Count
  cached_input_tokens: Count
  cache_write_tokens: Count
  output_tokens: Count
  reasoning_tokens: Count
  usage_complete: boolean
  cache_hit_ratio: number | null
  copilot_nano_aiu: Count
}

interface AttemptSummary extends CacheUsage {
  attempt_id: string
  attempt_index: number
  cause: ResponsesAttemptCause
  request_body_bytes: number
  body_fingerprint: string | null
  egress_fingerprints: JsonRecord
  egress_static_prefix: JsonRecord
  http_status: number | null
  upstream_error_status: number | null
  outcome: string
  error_code: string | null
}

/** Opt-in summaries only; it neither changes the request nor infers a session. */
export class ResponsesDiagnostics {
  private readonly started = performance.now()
  private readonly requestId: string
  private readonly request: JsonRecord
  private usage = readUsage(undefined)
  private outcome?: string
  private errorCode: string | null = null
  private httpStatus: number | null = null
  private firstEventMs: number | null = null
  private ttftMs: number | null = null
  private finished = false
  private attempts = 0
  private readonly attemptDetails: Array<AttemptSummary> = []
  private activeAttempt?: AttemptSummary
  private activeStream = false
  private incomplete = false
  private readonly signal?: AbortSignal

  static start(context: DiagnosticsContext): ResponsesDiagnostics | undefined {
    if (!["1", "true"].includes(process.env.COPILOT_CACHE_DIAGNOSTICS ?? ""))
      return
    try {
      return new ResponsesDiagnostics(context)
    } catch {
      return
    }
  }

  private constructor(context: DiagnosticsContext) {
    const { ingress, egress, serializedBody, signal } = context
    this.signal = signal
    const origin =
      context.origin ?? responsesDiagnosticOrigin("responses", ingress)
    const ingressObservation = ingressSnapshot(ingress, origin)
    this.requestId = origin?.requestId ?? randomUUID()
    const body = record(egress)
    this.request = {
      schema_version: 2,
      route: "/responses",
      source:
        origin?.ingressProtocol === "messages" ?
          "messages_to_responses"
        : "native_responses",
      ingress_protocol: origin?.ingressProtocol ?? "responses",
      egress_endpoint: "/responses",
      egress_snapshot: "prepared_request",
      cache_intent: origin?.cacheIntent ?? null,
      model: body.model,
      stream: body.stream === true,
      request_body_bytes:
        serializedBody === undefined ? null : (
          Buffer.byteLength(serializedBody, "utf8")
        ),
      input_items: Array.isArray(body.input) ? body.input.length : null,
      // Cache keys may be shared across threads. They are not session IDs.
      correlation: "uncorrelated",
      request_role: "unknown",
      cache_key_fingerprint: fingerprint(body.prompt_cache_key),
      ingress_fingerprints: ingressObservation.fingerprints,
      egress_fingerprints: fingerprints(egress),
      ingress_static_prefix: ingressObservation.staticPrefix,
      egress_static_prefix: staticPrefix(egress),
      cache_policy: context.cachePolicy ?? null,
    }
  }

  observeResponse(response: unknown): void {
    const body = record(response)
    this.usage = readUsage(body)
    const status = body.status
    this.outcome =
      status === "completed" || status === "incomplete" || status === "failed" ?
        status
      : "unknown"
  }

  recordAttempt(
    serializedBody?: string,
    cause: ResponsesAttemptCause = "initial",
  ): void {
    this.finishAttempt()
    this.activeAttempt = undefined
    this.attempts++
    if (serializedBody === undefined) return
    if (this.attemptDetails.length >= 16) {
      this.activeAttempt = undefined
      return
    }
    const body: unknown = JSON.parse(serializedBody)
    this.activeStream = record(body).stream === true
    const bytes = Buffer.byteLength(serializedBody, "utf8")
    if (this.attempts === 1) this.request.request_body_bytes ??= bytes
    this.activeAttempt = {
      attempt_id: `${this.requestId}:${this.attempts}`,
      attempt_index: this.attempts,
      cause,
      request_body_bytes: bytes,
      body_fingerprint: fingerprint(body),
      egress_fingerprints: fingerprints(body),
      egress_static_prefix: staticPrefix(body),
      http_status: null,
      upstream_error_status: null,
      outcome: "pending",
      error_code: null,
      ...readUsage(undefined),
    }
    this.attemptDetails.push(this.activeAttempt)
  }

  attemptObserver(): ResponsesAttemptObserver {
    return {
      requestId: this.requestId,
      start: (body, cause) =>
        this.passive(() => this.recordAttempt(body, cause)),
      headers: (status) => this.passive(() => this.observeHeaders(status)),
      value: (value) => this.passive(() => this.observeAttempt(value)),
      failure: (error) => this.passive(() => this.failAttempt(error)),
    }
  }

  private observeHeaders(status: number): void {
    if (!this.activeAttempt) return
    this.activeAttempt.http_status = status
    if (status >= 400) this.activeAttempt.outcome = "error"
  }

  private observeAttempt(value: unknown): void {
    if (!this.activeAttempt) return
    const event = record(value)
    const response =
      Object.hasOwn(event, "response") ? record(event.response) : event
    Object.assign(this.activeAttempt, readUsage(response, this.activeAttempt))
    const terminal =
      !this.activeStream
      || [
        "response.completed",
        "response.failed",
        "response.incomplete",
      ].includes(String(event.type))
    if (
      terminal
      && ["completed", "failed", "incomplete"].includes(String(response.status))
    )
      this.activeAttempt.outcome = String(response.status)
    if (event.type === "error") this.activeAttempt.outcome = "error"
  }

  private failAttempt(error: unknown): void {
    if (!this.activeAttempt) return
    if (["pending", "unknown"].includes(this.activeAttempt.outcome))
      this.activeAttempt.outcome = this.signal?.aborted ? "cancelled" : "error"
    if (error instanceof HTTPError)
      this.activeAttempt.upstream_error_status = error.response.status
    if (error instanceof ResponsesUpstreamError) {
      this.activeAttempt.upstream_error_status = error.status
      this.activeAttempt.error_code = error.code
    }
    if (error instanceof InvalidRequestError)
      this.activeAttempt.error_code = error.code
  }

  private finishAttempt(): void {
    const attempt = this.activeAttempt
    if (!attempt || attempt.outcome !== "pending") return
    attempt.outcome = "unknown"
    if (this.activeStream) attempt.outcome = "stream_ended_without_terminal"
    if (this.signal?.aborted) attempt.outcome = "cancelled"
  }

  private passive(action: () => void): void {
    try {
      action()
    } catch {
      this.incomplete = true
    }
  }

  fail(error: unknown): void {
    this.passive(() => this.failAttempt(error))
    this.outcome = this.signal?.aborted ? "cancelled" : "error"
    if (error instanceof InvalidRequestError) {
      this.errorCode = error.code
      if (error.code === "copilot_input_connection_mismatch")
        this.httpStatus = 401
    }
    if (error instanceof HTTPError) this.httpStatus = error.response.status
    if (error instanceof ResponsesUpstreamError) {
      this.httpStatus = error.status
      this.errorCode = error.code
    }
  }

  async *iterate(
    source: AsyncIterable<ServerSentEventMessage>,
  ): AsyncGenerator<ServerSentEventMessage> {
    try {
      for await (const event of source) {
        this.passive(() => this.observeEvent(event.data))
        yield event
      }
    } catch (error) {
      this.fail(error)
      throw error
    } finally {
      this.finish()
    }
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.finishAttempt()
    this.passive(() =>
      consola.info(
        `[cache-diagnostics] ${JSON.stringify({
          ...this.request,
          request_id: this.requestId,
          upstream_attempts: this.attempts,
          attempt_details: this.attemptDetails,
          attempt_details_truncated: this.attempts > 16,
          diagnostics_incomplete: this.incomplete,
          ...this.usage,
          outcome:
            this.outcome
            ?? (this.signal?.aborted ?
              "cancelled"
            : "stream_ended_without_terminal"),
          error_code: this.errorCode,
          upstream_http_status: this.httpStatus,
          first_event_ms: this.firstEventMs,
          ttft_ms: this.ttftMs,
          duration_ms: elapsed(this.started),
        })}`,
      ),
    )
  }

  private observeEvent(data: string | undefined): void {
    this.firstEventMs ??= elapsed(this.started)
    if (!data || data === "[DONE]") return
    let event: JsonRecord
    try {
      event = record(JSON.parse(data))
    } catch {
      // The protocol handler owns validation and failure events.
      return
    }
    if (
      (event.type === "response.output_text.delta"
        || event.type === "response.function_call_arguments.delta"
        || event.type === "response.custom_tool_call_input.delta")
      && typeof event.delta === "string"
      && event.delta.length > 0
    )
      this.ttftMs ??= elapsed(this.started)

    if (
      event.type === "response.completed"
      || event.type === "response.incomplete"
      || event.type === "response.failed"
    )
      this.observeResponse(event.response)
    else if (event.type === "error") this.outcome = "error"
  }
}

function ingressSnapshot(
  ingress: unknown,
  origin: ResponsesDiagnosticOrigin | undefined,
) {
  const payload = ingressForFingerprints(
    ingress,
    origin?.ingressProtocol ?? "responses",
  )
  return {
    fingerprints: origin?.ingressFingerprints ?? fingerprints(payload),
    staticPrefix: origin?.ingressStaticPrefix ?? staticPrefix(payload),
  }
}

function ingressForFingerprints(
  value: unknown,
  protocol: CacheIngressProtocol,
): unknown {
  if (protocol !== "messages") return value
  const body = record(value)
  return {
    ...body,
    instructions: body.system,
    input: body.messages,
    reasoning: { thinking: body.thinking, output_config: body.output_config },
  }
}

function fingerprints(value: unknown): JsonRecord {
  const body = record(value)
  return {
    instructions: fingerprint(body.instructions),
    tools: fingerprint(body.tools),
    input: fingerprint(body.input),
    settings: fingerprint({
      model: body.model,
      reasoning: body.reasoning,
      text: body.text,
      parallel_tool_calls: body.parallel_tool_calls,
      tool_choice: body.tool_choice,
      prompt_cache_options: body.prompt_cache_options,
      prompt_cache_retention: body.prompt_cache_retention,
    }),
  }
}

/** Structural candidate only: matching digests never establish an upstream hit. */
function staticPrefix(value: unknown): JsonRecord {
  const body = record(value)
  const input = leadingStaticInput(body.input)
  let inputForm = "other"
  if (typeof body.input === "string") inputForm = "string"
  if (Array.isArray(body.input)) inputForm = "array"
  const available =
    input.length > 0
    || (typeof body.instructions === "string" && body.instructions.length > 0)
    || (Array.isArray(body.instructions) && body.instructions.length > 0)
    || (Array.isArray(body.tools) && body.tools.length > 0)
  let boundary = "unavailable"
  if (available) {
    boundary = "before_dynamic_input"
    if (Array.isArray(body.input) && input.length === body.input.length)
      boundary = "full_input"
  }
  return {
    scope: "process",
    input_form: inputForm,
    input_items: input.length,
    boundary,
    fingerprint:
      available ?
        fingerprint({
          model: body.model,
          instructions: body.instructions,
          tools: body.tools,
          reasoning: body.reasoning,
          text: body.text,
          parallel_tool_calls: body.parallel_tool_calls,
          tool_choice: body.tool_choice,
          input_form: inputForm,
          input,
        })
      : null,
  }
}

function leadingStaticInput(value: unknown): Array<unknown> {
  const input: Array<unknown> = []
  if (!Array.isArray(value)) return input
  for (const item of value) {
    const entry = record(item)
    if (
      entry.type !== "additional_tools"
      && ((entry.type !== undefined && entry.type !== "message")
        || (entry.role !== "system" && entry.role !== "developer"))
    )
      break
    input.push(item)
  }
  return input
}

function fingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return createHmac("sha256", fingerprintKey)
    .update(JSON.stringify(value))
    .digest("hex")
}

function readUsage(value: unknown, previous?: CacheUsage): CacheUsage {
  const body = record(value)
  const usage = record(body.usage)
  const details = record(usage.input_tokens_details)
  const input = observedCount(usage, "input_tokens", previous?.input_tokens)
  const reportedCached = observedCount(
    details,
    "cached_tokens",
    previous?.cached_input_tokens,
  )
  const cached =
    input !== null && reportedCached !== null && reportedCached > input ?
      null
    : reportedCached
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_tokens: observedCount(
      details,
      "cache_write_tokens",
      previous?.cache_write_tokens,
    ),
    output_tokens: observedCount(
      usage,
      "output_tokens",
      previous?.output_tokens,
    ),
    reasoning_tokens: observedCount(
      record(usage.output_tokens_details),
      "reasoning_tokens",
      previous?.reasoning_tokens,
    ),
    usage_complete: input !== null && cached !== null,
    cache_hit_ratio:
      input !== null && input > 0 && cached !== null ? cached / input : null,
    copilot_nano_aiu: observedCount(
      record(body.copilot_usage),
      "total_nano_aiu",
      previous?.copilot_nano_aiu,
    ),
  }
}

function observedCount(
  value: JsonRecord,
  key: string,
  previous?: Count,
): Count {
  return Object.hasOwn(value, key) ? count(value[key]) : (previous ?? null)
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as JsonRecord)
    : {}
}

function count(value: unknown): Count {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : null
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started)
}
