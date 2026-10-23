import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { colors } from "consola/utils"
import { randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { ResponsesUpstreamError } from "~/services/copilot/responses-upstream-error"

export type SummaryProtocol = "messages" | "responses" | "chat"

/** Exact counters as reported upstream; undefined means "not reported". */
export interface SummaryUsage {
  totalInput?: number
  cachedInput?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

type JsonRecord = Record<string, unknown>

const OUTPUT_DELTAS = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
])
const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
])

/**
 * One always-on console line per upstream request. It observes only — it never
 * changes a request or a response, and every observation is exception-safe.
 */
export class RequestSummary {
  private readonly started = performance.now()
  private readonly ingress: SummaryProtocol
  private readonly model: string
  private egress?: SummaryProtocol
  private requestId: string = randomUUID()
  private signal?: AbortSignal
  private bodyBytes?: number
  private items?: number
  private attempts = 0
  private ttftMs?: number
  private outcome?: string
  private errorDetail?: string
  private finished = false
  // Anthropic reports input / cache-read / cache-write as separate counters.
  private anthropic: {
    input?: number
    read?: number
    write?: number
  } = {}

  usage: SummaryUsage = {}

  constructor(ingress: SummaryProtocol, model: string) {
    this.ingress = ingress
    this.model = model
  }

  useRequestId(requestId: string | undefined): void {
    if (requestId) this.requestId = requestId
  }

  get id(): string {
    return this.requestId
  }

  /** Bind the downstream-scoped signal used to classify cancellation. */
  bind(signal: AbortSignal): void {
    this.signal = signal
  }

  /**
   * Record the exact serialized body of one logical upstream attempt. State
   * observed from an earlier attempt (usage, outcome, TTFT) is discarded so a
   * retry reports only what the final attempt returned.
   */
  attempt(
    egress: SummaryProtocol,
    serializedBody: string,
    items: number | undefined,
  ): void {
    this.safe(() => {
      this.egress = egress
      this.bodyBytes = Buffer.byteLength(serializedBody, "utf8")
      this.items = items
      this.ttftMs = undefined
      this.outcome = undefined
      this.errorDetail = undefined
      this.anthropic = {}
      this.usage = {}
    })
  }

  /** Count one real HTTP fetch (pass as `copilotFetch`'s `onAttempt`). */
  readonly fetched = (): void => {
    this.attempts++
  }

  /** Observe one parsed upstream value (non-stream body or SSE event data). */
  observe(value: unknown): void {
    this.safe(() => {
      const body = record(value)
      if (this.egress === "messages") this.observeMessages(body)
      else if (this.egress === "chat") this.observeChat(body)
      else this.observeResponses(body)
    })
  }

  /** Wrap a raw SSE stream; parse only frames that can carry usage or TTFT. */
  async *stream(
    source: AsyncIterable<ServerSentEventMessage>,
    parse = true,
  ): AsyncGenerator<ServerSentEventMessage> {
    try {
      for await (const event of source) {
        if (parse) this.safe(() => this.observeSse(event))
        yield event
      }
    } catch (error) {
      this.fail(error)
      throw error
    } finally {
      this.finish()
    }
  }

  fail(error: unknown): void {
    this.safe(() => {
      if (this.outcome && this.outcome !== "completed") return
      if (this.signal?.aborted || isAbort(error)) {
        this.outcome = "cancelled"
        return
      }
      this.outcome = "error"
      this.errorDetail = describeError(error)
    })
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.safe(() => {
      if (!this.outcome)
        this.outcome =
          this.signal?.aborted ? "cancelled" : "stream_ended_without_terminal"
      const line = formatSummary({
        ok: this.outcome === "completed",
        model: this.model,
        route: routeLabel(this.ingress, this.egress),
        usage: this.usage,
        contextLimit: promptLimit(this.model),
        ttftMs: this.ttftMs,
        durationMs: performance.now() - this.started,
        bodyBytes: this.bodyBytes,
        items: this.items,
        attempts: this.attempts,
        outcome: this.outcome,
        errorDetail: this.errorDetail,
        requestId: this.requestId,
      })
      if (this.outcome === "completed") consola.success(line)
      else consola.warn(line)
    })
  }

  private observeSse(event: ServerSentEventMessage): void {
    const data = event.data
    if (!data || data === "[DONE]") return
    if (this.egress === "messages") {
      // Anthropic names every frame; only these can carry usage, TTFT or errors.
      const name = event.event
      if (
        name === "message_start"
        || name === "message_delta"
        || name === "error"
        || (name === "content_block_delta" && this.ttftMs === undefined)
      )
        this.observe(JSON.parse(data))
      return
    }
    this.observe(JSON.parse(data))
  }

  private observeMessages(body: JsonRecord): void {
    const type = body.type
    switch (type) {
      case "message": {
        this.readAnthropicUsage(body.usage)
        this.outcome = "completed"

        break
      }
      case "message_start": {
        this.readAnthropicUsage(record(body.message).usage)

        break
      }
      case "message_delta": {
        this.readAnthropicUsage(body.usage)
        if (record(body.delta).stop_reason) this.outcome = "completed"

        break
      }
      case "content_block_delta": {
        const delta = record(body.delta)
        if (
          (delta.type === "text_delta" && nonEmpty(delta.text))
          || (delta.type === "input_json_delta" && nonEmpty(delta.partial_json))
        )
          this.ttft()

        break
      }
      case "error": {
        this.outcome = "error"
        this.errorDetail = upstreamErrorText(body.error)

        break
      }
      // No default
    }
  }

  private readAnthropicUsage(value: unknown): void {
    const usage = record(value)
    const input = count(usage.input_tokens)
    const read = count(usage.cache_read_input_tokens)
    const write = count(usage.cache_creation_input_tokens)
    const output = count(usage.output_tokens)
    if (input !== undefined) this.anthropic.input = input
    if (read !== undefined) this.anthropic.read = read
    if (write !== undefined) this.anthropic.write = write
    if (output !== undefined) this.usage.output = output
    const { input: base, read: cacheRead, write: created } = this.anthropic
    if (base === undefined) return
    this.usage.totalInput = base + (cacheRead ?? 0) + (created ?? 0)
    // Without any cache counter the cached share is unknown, not zero.
    this.usage.cachedInput =
      cacheRead === undefined && created === undefined ?
        undefined
      : (cacheRead ?? 0)
    this.usage.cacheWrite = created
  }

  private observeChat(body: JsonRecord): void {
    const choices = Array.isArray(body.choices) ? body.choices : []
    for (const raw of choices) {
      const choice = record(raw)
      // Only streamed deltas mark first-token time; a full message does not.
      const delta = record(choice.delta)
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      if (
        nonEmpty(delta.content)
        || toolCalls.some((call) =>
          nonEmpty(record(record(call).function).arguments),
        )
      )
        this.ttft()
      if (choice.finish_reason) this.outcome = "completed"
    }
    const usage = record(body.usage)
    if (Object.keys(usage).length === 0) return
    const prompt = record(usage.prompt_tokens_details)
    this.setOpenAIUsage({
      total: count(usage.prompt_tokens),
      cached: count(prompt.cached_tokens),
      write: count(prompt.cache_write_tokens),
      output: count(usage.completion_tokens),
      reasoning: count(
        record(usage.completion_tokens_details).reasoning_tokens,
      ),
    })
  }

  private observeResponses(body: JsonRecord): void {
    const type = body.type
    if (typeof type === "string" && OUTPUT_DELTAS.has(type)) {
      if (typeof body.delta === "string" && body.delta.length > 0) this.ttft()
      return
    }
    if (type === "error") {
      this.outcome = "error"
      this.errorDetail = upstreamErrorText(body)
      return
    }
    // Non-stream bodies are untyped; stream terminals wrap the response.
    if (typeof type === "string" && !TERMINAL_EVENTS.has(type)) return
    const response =
      Object.hasOwn(body, "response") ? record(body.response) : body
    this.observeResponsesTerminal(response)
  }

  private observeResponsesTerminal(response: JsonRecord): void {
    const status = response.status
    if (
      status === "completed"
      || status === "incomplete"
      || status === "failed"
    )
      this.outcome = status
    if (status === "failed")
      this.errorDetail = upstreamErrorText(response.error)
    const usage = record(response.usage)
    if (Object.keys(usage).length === 0) return
    const input = record(usage.input_tokens_details)
    this.setOpenAIUsage({
      total: count(usage.input_tokens),
      cached: count(input.cached_tokens),
      write: count(input.cache_write_tokens),
      output: count(usage.output_tokens),
      reasoning: count(record(usage.output_tokens_details).reasoning_tokens),
    })
  }

  private setOpenAIUsage(usage: {
    total?: number
    cached?: number
    write?: number
    output?: number
    reasoning?: number
  }): void {
    this.usage.totalInput = usage.total
    this.usage.cacheWrite = usage.write
    // A cached count above the total is not a credible observation.
    this.usage.cachedInput =
      (
        usage.total !== undefined
        && usage.cached !== undefined
        && usage.cached > usage.total
      ) ?
        undefined
      : usage.cached
    this.usage.output = usage.output
    this.usage.reasoning = usage.reasoning
  }

  private ttft(): void {
    this.ttftMs ??= performance.now() - this.started
  }

  private safe(action: () => void): void {
    try {
      action()
    } catch {
      // Summaries are observational and must never affect a request.
    }
  }
}

export interface SummaryLine {
  ok: boolean
  model: string
  route: string
  usage: SummaryUsage
  /** Upstream input cap for the model (catalog `max_prompt_tokens`). */
  contextLimit?: number
  ttftMs?: number
  durationMs: number
  bodyBytes?: number
  items?: number
  attempts: number
  outcome: string
  errorDetail?: string
  requestId: string
}

export function formatSummary(line: SummaryLine): string {
  const { usage } = line
  const parts = [colors.bold(line.model), colors.dim(line.route)]
  let input = `in ${integer(usage.totalInput)}`
  const cached = `cached ${integer(usage.cachedInput)}`
  const ratio = hitRatio(usage.totalInput, usage.cachedInput)
  input +=
    ratio === undefined ?
      ` (${cached})`
    : ` (${cached} · ${colorRatio(ratio, `${ratio.toFixed(1)}%`)})`
  parts.push(input)
  if (usage.cacheWrite !== undefined && usage.cacheWrite > 0)
    parts.push(`write ${integer(usage.cacheWrite)}`)
  const context = contextUsage(usage.totalInput, line.contextLimit)
  if (context) parts.push(context)
  let output = `out ${integer(usage.output)}`
  if (usage.reasoning !== undefined)
    output += ` (reasoning ${integer(usage.reasoning)})`
  parts.push(output)
  if (line.ttftMs !== undefined) parts.push(`ttft ${seconds(line.ttftMs)}`)
  parts.push(`total ${seconds(line.durationMs)}`)
  if (line.bodyBytes !== undefined)
    parts.push(
      `${bytes(line.bodyBytes)}${line.items === undefined ? "" : `/${integer(line.items)} items`}`,
    )
  if (line.attempts > 1) parts.push(`attempts ${line.attempts}`)
  const outcome =
    line.errorDetail ? `${line.outcome}: ${line.errorDetail}` : line.outcome
  parts.push(
    line.ok ? colors.green(outcome) : colors.yellow(outcome),
    colors.dim(`#${line.requestId.slice(0, 8)}`),
  )
  return parts.join("  ")
}

/** Percentage truncated (never rounded up) to one decimal place. */
export function hitRatio(
  total: number | undefined,
  cached: number | undefined,
): number | undefined {
  if (total === undefined || cached === undefined || total === 0) return
  return Math.floor((cached * 1000) / total) / 10
}

/** `ctx used/limit pct` — shown only when both sides are known. */
function contextUsage(
  used: number | undefined,
  limit: number | undefined,
): string | undefined {
  if (used === undefined || limit === undefined || limit === 0) return
  const pct = Math.floor((used * 1000) / limit) / 10
  const text = `${pct.toFixed(1)}%`
  let colored = colors.green(text)
  if (pct >= 85) colored = colors.red(text)
  else if (pct >= 60) colored = colors.yellow(text)
  return `ctx ${integer(used)}/${integer(limit)} ${colored}`
}

function promptLimit(model: string): number | undefined {
  const limits = state.models?.data.find((m) => m.id === model)?.capabilities
    .limits
  return limits?.max_prompt_tokens ?? limits?.max_context_window_tokens
}

function colorRatio(ratio: number, text: string): string {
  if (ratio >= 80) return colors.green(text)
  if (ratio >= 30) return colors.yellow(text)
  return colors.red(text)
}

function integer(value: number | undefined): string {
  return value === undefined ? "?" : value.toLocaleString("en-US")
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

function bytes(value: number): string {
  if (value < 1000) return `${value}B`
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}kB`
  return `${(value / 1_000_000).toFixed(2)}MB`
}

function routeLabel(
  ingress: SummaryProtocol,
  egress: SummaryProtocol | undefined,
): string {
  if (!egress || egress === ingress) return `${ingress} native`
  return `${ingress}→${egress}`
}

function describeError(error: unknown): string {
  if (error instanceof ResponsesUpstreamError)
    return `${error.status} ${error.code}`
  if (error instanceof HTTPError) return `HTTP ${error.response.status}`
  if (error instanceof DOMException && error.name === "TimeoutError")
    return error.message
  if (error instanceof Error) return truncate(error.message)
  return truncate(String(error))
}

function upstreamErrorText(value: unknown): string | undefined {
  const error = record(value)
  const text = [error.code, error.type, error.message].find(
    (field): field is string => typeof field === "string",
  )
  return text === undefined ? undefined : truncate(text)
}

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0
}

function count(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as JsonRecord)
    : {}
}

/** Egress helpers keep optional summaries out of the services' control flow. */
export function summarizeJson<T>(
  summary: RequestSummary | undefined,
  value: T,
): T {
  if (summary) {
    summary.observe(value)
    summary.finish()
  }
  return value
}

export function summarizeStream(
  summary: RequestSummary | undefined,
  events: AsyncGenerator<ServerSentEventMessage>,
  parse = true,
): AsyncGenerator<ServerSentEventMessage> {
  return summary ? summary.stream(events, parse) : events
}

export function summarizeFailure(
  summary: RequestSummary | undefined,
  error: unknown,
): void {
  if (!summary) return
  summary.fail(error)
  summary.finish()
}
