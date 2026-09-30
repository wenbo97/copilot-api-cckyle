import { stringValue } from "./local-budget"
import { record, type Json, type Observation } from "./local-budget"

export function parseEvents(text: string): Array<Json> {
  const events: Array<Json> = []
  for (const block of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data || data === "[DONE]") continue
    events.push(record(JSON.parse(data)))
  }
  return events
}

export function responseText(response: Json): string {
  const output = Array.isArray(response.output) ? response.output : []
  return output
    .flatMap((item) => {
      const content = record(item).content
      return Array.isArray(content) ?
          content.map((part) => stringValue(record(part).text))
        : []
    })
    .join("")
}

export function usageOf(value: unknown): Json | null {
  const outer = record(value)
  const response = outer.response ? record(outer.response) : outer
  const usage = record(response.usage)
  return Object.keys(usage).length > 0 ? usage : null
}

/** A transparent, bounded observer: never stores prompts, tokens, or ciphertext. */
export async function observeBody(
  response: Response,
  finish: (event: Observation) => Promise<void>,
  observeEvent?: (event: Json) => void,
): Promise<Response> {
  const reader = response.body?.getReader()
  if (!reader) {
    await finish({
      outcome: response.ok ? "completed" : "http_error",
      status: response.status,
      durationMs: 0,
      usage: null,
    })
    return response
  }
  const started = performance.now()
  const decoder = new TextDecoder()
  const streaming = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
  let pending = ""
  let usage: Json | null = null
  let outcome = response.ok ? "completed" : "http_error"
  let finished = false
  let cancelled = false
  const complete = async (state: string) => {
    if (finished) return
    finished = true
    await finish({
      outcome: state,
      status: response.status,
      usage,
      durationMs: Math.round(performance.now() - started),
    })
  }
  const consume = (data: string) => {
    try {
      const values = streaming ? parseEvents(data) : [record(JSON.parse(data))]
      for (const value of values) {
        observeEvent?.(value)
        usage = usageOf(value) ?? usage
        const status = record(value.response).status
        if (typeof status === "string") outcome = status
      }
    } catch {
      // Protocol validation remains the responsibility of the real handler.
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (cancelled) return
        if (next.done) {
          pending += decoder.decode()
          consume(pending)
          await complete(outcome)
          controller.close()
          return
        }
        pending += decoder.decode(next.value, { stream: true })
        if (streaming) {
          pending = pending.replaceAll("\r\n", "\n")
          const boundary = pending.lastIndexOf("\n\n")
          if (boundary !== -1) {
            consume(pending.slice(0, boundary + 2))
            pending = pending.slice(boundary + 2)
          }
        }
        if (pending.length > 2_000_000) pending = ""
        controller.enqueue(next.value)
      } catch (error) {
        await complete("transport_error")
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      try {
        await reader.cancel(reason)
      } finally {
        await complete("cancelled")
      }
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function validateResponseEvents(events: Array<Json>): Json {
  if (events.some((event) => event.type === "error"))
    throw new Error("Stream emitted an error")
  const responseEvents = events.filter((event) =>
    String(event.type).startsWith("response."),
  )
  if (
    responseEvents[0]?.type !== "response.created"
    || responseEvents.filter((event) => event.type === "response.created")
      .length !== 1
  )
    throw new Error("Creation must be the first and unique lifecycle event")
  if (!responseEvents.some((event) => event.type === "response.created"))
    throw new Error("Missing response.created")
  if (
    !responseEvents.some((event) =>
      [
        "response.custom_tool_call_input.delta",
        "response.function_call_arguments.delta",
        "response.output_text.delta",
      ].includes(String(event.type)),
    )
  )
    throw new Error("Stream contained no output deltas")
  let previous = -1
  for (const event of responseEvents) {
    const sequence = event.sequence_number
    if (
      typeof sequence !== "number"
      || !Number.isSafeInteger(sequence)
      || sequence <= previous
    )
      throw new Error("Missing or non-monotonic SSE sequence")
    previous = sequence
  }
  const terminal = responseEvents.filter((event) =>
    ["response.completed", "response.failed", "response.incomplete"].includes(
      String(event.type),
    ),
  )
  if (terminal.length !== 1 || terminal[0].type !== "response.completed")
    throw new Error("Expected exactly one completed terminal event")
  if (responseEvents.at(-1) !== terminal[0])
    throw new Error("Output after terminal event")
  const response = record(terminal[0].response)
  const textEvents = responseEvents.filter(
    (event) => event.type === "response.output_text.delta",
  )
  if (textEvents.some((event) => typeof event.delta !== "string"))
    throw new Error("Malformed text delta")
  if (
    textEvents.map((event) => stringValue(event.delta)).join("")
    !== responseText(response)
  )
    throw new Error("Streamed text differs from terminal output")
  return response
}

export function isNamespaceStatusCall(value: unknown): boolean {
  const call = record(value)
  return (
    call.type === "function_call"
    && (call.name === "ops.status"
      || (call.name === "status" && call.namespace === "ops"))
  )
}
