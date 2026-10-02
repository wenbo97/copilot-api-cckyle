import { expect, test } from "bun:test"

import type { Observation } from "./local-budget"

import { sanitizeStartupDiagnostic } from "./local-runtime"
import {
  observeBody,
  parseEvents,
  validateResponseEvents,
  isNamespaceStatusCall,
} from "./local-wire"

test("observer preserves SSE bytes and retains a usage-only tail", async () => {
  const raw =
    'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":0}}\n\ndata: [DONE]\n\n'
  const events: Array<Observation> = []
  const observed = await observeBody(
    new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    (event) => {
      events.push(event)
      return Promise.resolve()
    },
  )
  expect(await observed.text()).toBe(raw)
  expect(events).toHaveLength(1)
  expect(events[0].usage?.completion_tokens).toBe(0)
})

test("observer cancellation cancels upstream and leaves usage unknown", async () => {
  let cancelled = false
  const observations: Array<Observation> = []
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const response = await observeBody(new Response(source), (event) => {
    observations.push(event)
    return Promise.resolve()
  })
  await response.body?.cancel()
  expect(cancelled).toBe(true)
  expect(observations[0].outcome).toBe("cancelled")
  expect(observations[0].usage).toBeNull()
})

test("SSE parser handles CRLF and rejects malformed data", () => {
  expect(
    parseEvents('event: message\r\ndata: {"type":"ready"}\r\n\r\n')[0].type,
  ).toBe("ready")
  expect(() => parseEvents("data: broken\n\n")).toThrow()
})

test("bodyless upstream responses still finish their observation", async () => {
  const observations: Array<Observation> = []
  const response = await observeBody(
    new Response(null, { status: 204 }),
    async (event) => {
      observations.push(event)
      await Promise.resolve()
    },
  )
  expect(response.status).toBe(204)
  expect(observations).toHaveLength(1)
  expect(observations[0].usage).toBeNull()
})

test("terminal-only and missing-sequence streams cannot pass acceptance", () => {
  expect(() =>
    validateResponseEvents([
      { type: "response.completed", response: { status: "completed" } },
    ]),
  ).toThrow()
  expect(() =>
    validateResponseEvents([
      { type: "response.created", sequence_number: 0 },
      { type: "response.output_text.delta", delta: "READY" },
      {
        type: "response.completed",
        sequence_number: 2,
        response: { status: "completed" },
      },
    ]),
  ).toThrow("sequence")
})

test("namespace assertions require the exact namespace and function", () => {
  expect(
    isNamespaceStatusCall({ type: "function_call", name: "notstatus" }),
  ).toBe(false)
  expect(isNamespaceStatusCall({ type: "function_call", name: "status" })).toBe(
    false,
  )
  expect(
    isNamespaceStatusCall({
      type: "function_call",
      name: "status",
      namespace: "ops",
    }),
  ).toBe(true)
})

test("output after completion and contradictory delta text cannot pass", () => {
  const completed = {
    type: "response.completed",
    sequence_number: 1,
    response: {
      status: "completed",
      output: [{ content: [{ type: "output_text", text: "READY" }] }],
    },
  }
  expect(() =>
    validateResponseEvents([
      { type: "response.created", sequence_number: 0 },
      completed,
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        delta: "CORRUPTED",
      },
    ]),
  ).toThrow("terminal")
  expect(() =>
    validateResponseEvents([
      { type: "response.created", sequence_number: 0 },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "CORRUPTED",
      },
      { ...completed, sequence_number: 2 },
    ]),
  ).toThrow("differs")
})

test("startup diagnostics redact the entire bearer credential", () => {
  const diagnostic = sanitizeStartupDiagnostic(
    "Error: Authorization: Bearer example-secret",
  )
  expect(diagnostic).not.toContain("example-secret")
  expect(diagnostic).toContain("credential redacted")
})

test("a completed Responses frame retains protocol success when cleanup aborts transport", async () => {
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined
  const raw =
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'
  const observations: Array<Observation> = []
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller
      controller.enqueue(new TextEncoder().encode(raw))
    },
  })
  const observed = await observeBody(
    new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }),
    (event) => {
      observations.push(event)
      return Promise.resolve()
    },
  )
  const reader = observed.body?.getReader()
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(raw)
  sourceController?.error(new DOMException("Fixture cleanup", "AbortError"))
  if (!reader) throw new Error("Expected observed response body")
  let streamError: unknown
  try {
    await reader.read()
  } catch (error) {
    streamError = error
  }
  expect(streamError).toBeInstanceOf(DOMException)
  expect(observations[0].outcome).toBe("completed")
  expect(observations[0].protocolOutcome).toBe("completed")
  expect(observations[0].transportOutcome).toBe("transport_error")
  expect(observations[0].usage?.input_tokens).toBe(3)
})

test("EOF before a native Responses terminal is incomplete", async () => {
  const observations: Array<Observation> = []
  const observed = await observeBody(
    new Response(
      'data: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
      {
        headers: { "content-type": "text/event-stream" },
      },
    ),
    (event) => {
      observations.push(event)
      return Promise.resolve()
    },
  )
  await observed.text()
  expect(observations[0].outcome).toBe("incomplete")
  expect(observations[0].transportOutcome).toBe("closed")
})
