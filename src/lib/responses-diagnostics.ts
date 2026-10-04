import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { randomUUID } from "node:crypto"

import type { CachePolicySummary } from "~/lib/responses-cache-policy"
import type {
  ResponsesAttemptCause,
  ResponsesAttemptObserver,
} from "~/services/copilot/request-observer"

import {
  cacheFingerprint as fingerprint,
  cacheDiagnosticProcessScope,
} from "~/lib/cache-fingerprint"
import {
  cacheHintObservation,
  compareCacheHints,
  type CacheHintObservation,
} from "~/lib/cache-hint-observation"
import {
  cacheDiagnosticIdentity,
  cacheHistorySnapshot,
  CacheHistoryTracker,
  type CacheDiagnosticIdentity,
  type CacheHistorySnapshot,
} from "~/lib/cache-history"
import {
  type CacheIngressProtocol,
  type CacheIntentSummary,
  inspectCacheIntent,
} from "~/lib/cache-intent"
import { HTTPError, InvalidRequestError } from "~/lib/error"
import { state } from "~/lib/state"
import { ResponsesUpstreamError } from "~/services/copilot/responses-upstream-error"

// Fingerprints can be compared within this process, but cannot be used to
// dictionary-match prompts against unsalted, persistent content hashes.
const historyTracker = new CacheHistoryTracker()

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
  identity?: CacheDiagnosticIdentity
  history?: CacheHistorySnapshot
  hints?: CacheHintObservation
}

export function responsesDiagnosticOrigin(
  ingressProtocol: CacheIngressProtocol,
  payload: unknown,
  headers?: Headers,
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
      identity: cacheDiagnosticIdentity(payload, headers),
      history: cacheHistorySnapshot(ingress),
      hints: cacheHintObservation(payload, ingressProtocol),
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
  ordinary_input_tokens: Count
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
  history_comparison: JsonRecord
  cache_hint_processing: ReturnType<typeof compareCacheHints> & {
    policy: CachePolicySummary | null
  }
  service_tier: string | null
  prompt_cache_diagnostics: JsonRecord | null
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
  private readonly ingressHistory: CacheHistorySnapshot
  private readonly ingressHints: CacheHintObservation
  private readonly historyTicket: ReturnType<CacheHistoryTracker["begin"]>
  private activeHistory?: CacheHistorySnapshot
  private returnedServiceTier: string | null = null
  private providerDiagnostics: JsonRecord | null = null
  private readonly cachePolicy?: CachePolicySummary

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
    this.cachePolicy = context.cachePolicy
    const origin =
      context.origin ?? responsesDiagnosticOrigin("responses", ingress)
    const ingressObservation = ingressSnapshot(ingress, origin)
    this.requestId = origin?.requestId ?? randomUUID()
    const history = diagnosticHistoryContext(ingress, origin)
    this.ingressHistory = history.ingress
    this.ingressHints = history.hints
    this.historyTicket = history.ticket
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
      ...history.observation,
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
    this.returnedServiceTier = serviceTier(body.service_tier)
    this.providerDiagnostics = providerCacheDiagnostics(
      body.prompt_cache_diagnostics,
    )
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
    this.activeHistory = undefined
    this.attempts++
    if (serializedBody === undefined) return
    if (this.attemptDetails.length >= 16) {
      this.activeAttempt = undefined
      return
    }
    const body: unknown = JSON.parse(serializedBody)
    this.activeHistory = cacheHistorySnapshot(body)
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
      history_comparison: this.historyTicket.compare(
        this.ingressHistory,
        this.activeHistory,
      ),
      cache_hint_processing: {
        ...compareCacheHints(
          this.ingressHints,
          cacheHintObservation(body, "responses"),
        ),
        policy: this.cachePolicy ?? null,
      },
      service_tier: null,
      prompt_cache_diagnostics: null,
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
    if (Object.hasOwn(response, "service_tier"))
      this.activeAttempt.service_tier = serviceTier(response.service_tier)
    if (Object.hasOwn(response, "prompt_cache_diagnostics"))
      this.activeAttempt.prompt_cache_diagnostics = providerCacheDiagnostics(
        response.prompt_cache_diagnostics,
      )
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
    this.passive(() => {
      this.request.history_comparison = this.historyTicket.compare(
        this.ingressHistory,
        this.activeHistory,
      )
      this.historyTicket.finish(
        this.ingressHistory,
        this.activeHistory,
        this.outcome === "completed"
          && this.activeAttempt?.outcome === "completed"
          && !this.incomplete
          && !this.signal?.aborted,
      )
      this.request.history_state = historyTracker.statistics()
    })
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
          returned_service_tier: this.returnedServiceTier,
          prompt_cache_diagnostics: this.providerDiagnostics,
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

function diagnosticHistoryContext(
  ingress: unknown,
  origin: ResponsesDiagnosticOrigin | undefined,
) {
  const protocol = origin?.ingressProtocol ?? "responses"
  const identity = origin?.identity ?? cacheDiagnosticIdentity(ingress)
  const scope =
    fingerprint({
      account: state.accountType,
      endpoint: state.responsesHistoryScope,
      namespace: process.env.COPILOT_CACHE_NAMESPACE,
      protocol,
    }) ?? "process"
  return {
    ingress:
      origin?.history
      ?? cacheHistorySnapshot(ingressForFingerprints(ingress, protocol)),
    hints: origin?.hints ?? cacheHintObservation(ingress, protocol),
    ticket: historyTracker.begin(identity, scope),
    observation: {
      correlation: identity.thread ? "declared_thread" : "uncorrelated",
      request_role: identity.role,
      identity,
      thread_fingerprint: identity.thread,
      correlation_scope: scope,
      process_scope: cacheDiagnosticProcessScope,
      observed_at: new Date().toISOString(),
    },
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
      service_tier: body.service_tier,
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

function serviceTier(value: unknown): string | null {
  return (
      typeof value === "string"
        && ["auto", "default", "fast", "flex", "priority", "scale"].includes(
          value,
        )
    ) ?
      value
    : null
}

function providerCacheDiagnostics(value: unknown): JsonRecord | null {
  const body = record(value)
  if (typeof body.type !== "string") return null
  if (
    ![
      "cache_hit",
      "cache_miss",
      "comparison_response_not_found",
      "unavailable",
    ].includes(body.type)
  )
    return null
  const reasons = [
    "model_changed",
    "prompt_cache_key_changed",
    "service_tier_changed",
    "tools_changed",
    "text_format_changed",
    "reasoning_effort_changed",
    "verbosity_changed",
    "context_compacted",
    "input_changed",
  ]
  return {
    type: body.type,
    reason:
      typeof body.reason === "string" && reasons.includes(body.reason) ?
        body.reason
      : null,
    comparison_reusable_tokens: count(body.comparison_reusable_tokens),
    cache_missed_tokens: count(body.cache_missed_tokens),
  }
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
  const written = observedCount(
    details,
    "cache_write_tokens",
    previous?.cache_write_tokens,
  )
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_tokens: written,
    ordinary_input_tokens: ordinaryTokens(input, cached, written),
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

function ordinaryTokens(input: Count, cached: Count, written: Count): Count {
  return (
      input !== null
        && cached !== null
        && written !== null
        && written <= input - cached
    ) ?
      input - cached - written
    : null
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
