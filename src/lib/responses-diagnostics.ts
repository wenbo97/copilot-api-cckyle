import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { createHmac, randomBytes, randomUUID } from "node:crypto"

import type { CachePolicySummary } from "~/lib/responses-cache-policy"

import { HTTPError, InvalidRequestError } from "~/lib/error"

// Fingerprints can be compared within this process, but cannot be used to
// dictionary-match prompts against unsalted, persistent content hashes.
const fingerprintKey = randomBytes(32)

type JsonRecord = Record<string, unknown>
type Count = number | null

interface DiagnosticsContext {
  ingress: unknown
  egress: unknown
  serializedBody: string
  signal?: AbortSignal
  cachePolicy?: CachePolicySummary
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

/** Opt-in summaries only; it neither changes the request nor infers a session. */
export class ResponsesDiagnostics {
  private readonly started = performance.now()
  private readonly requestId = randomUUID()
  private readonly request: JsonRecord
  private usage = readUsage(undefined)
  private outcome?: string
  private errorCode: string | null = null
  private httpStatus: number | null = null
  private firstEventMs: number | null = null
  private ttftMs: number | null = null
  private finished = false
  private attempts = 0
  private readonly signal?: AbortSignal

  static start(context: DiagnosticsContext): ResponsesDiagnostics | undefined {
    if (!["1", "true"].includes(process.env.COPILOT_CACHE_DIAGNOSTICS ?? ""))
      return
    return new ResponsesDiagnostics(context)
  }

  private constructor(context: DiagnosticsContext) {
    const { ingress, egress, serializedBody, signal } = context
    this.signal = signal
    const body = record(egress)
    this.request = {
      route: "/responses",
      model: body.model,
      stream: body.stream === true,
      request_body_bytes: Buffer.byteLength(serializedBody, "utf8"),
      input_items: Array.isArray(body.input) ? body.input.length : null,
      // Cache keys may be shared across threads. They are not session IDs.
      correlation: "uncorrelated",
      request_role: "unknown",
      cache_key_fingerprint: fingerprint(body.prompt_cache_key),
      ingress_fingerprints: fingerprints(ingress),
      egress_fingerprints: fingerprints(egress),
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

  recordAttempt(): void {
    this.attempts++
  }

  fail(error: unknown): void {
    this.outcome = this.signal?.aborted ? "cancelled" : "error"
    if (error instanceof InvalidRequestError) {
      this.errorCode = error.code
      if (error.code === "copilot_input_connection_mismatch")
        this.httpStatus = 401
    }
    if (error instanceof HTTPError) this.httpStatus = error.response.status
  }

  async *iterate(
    source: AsyncIterable<ServerSentEventMessage>,
  ): AsyncGenerator<ServerSentEventMessage> {
    try {
      for await (const event of source) {
        this.observeEvent(event.data)
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
    consola.info(
      `[cache-diagnostics] ${JSON.stringify({
        ...this.request,
        request_id: this.requestId,
        upstream_attempts: this.attempts,
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

function fingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return createHmac("sha256", fingerprintKey)
    .update(JSON.stringify(value))
    .digest("hex")
}

function readUsage(value: unknown): CacheUsage {
  const body = record(value)
  const usage = record(body.usage)
  const details = record(usage.input_tokens_details)
  const input = count(usage.input_tokens)
  const reportedCached = count(details.cached_tokens)
  const cached =
    input !== null && reportedCached !== null && reportedCached > input ?
      null
    : reportedCached
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_tokens: count(details.cache_write_tokens),
    output_tokens: count(usage.output_tokens),
    reasoning_tokens: count(
      record(usage.output_tokens_details).reasoning_tokens,
    ),
    usage_complete: input !== null && cached !== null,
    cache_hit_ratio:
      input !== null && input > 0 && cached !== null ? cached / input : null,
    copilot_nano_aiu: count(record(body.copilot_usage).total_nano_aiu),
  }
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
