import type { ServerSentEventMessage } from "fetch-event-stream"

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import { hitRatio, RequestSummary } from "~/lib/request-summary"

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[\d;]*m/g
let lines: Array<{ level: "success" | "warn"; text: string }> = []
let spies: Array<{ mockRestore: () => void }> = []

function capture(level: "success" | "warn") {
  return Object.assign(
    (message: unknown) => {
      lines.push({ level, text: String(message).replaceAll(ANSI, "") })
    },
    { raw: () => undefined },
  )
}

beforeEach(() => {
  lines = []
  spies = [
    spyOn(consola, "success").mockImplementation(capture("success")),
    spyOn(consola, "warn").mockImplementation(capture("warn")),
  ]
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
})

async function* sse(
  frames: Array<[string | undefined, unknown]>,
): AsyncGenerator<ServerSentEventMessage> {
  for (const [event, data] of frames) {
    await Promise.resolve()
    yield { event, data: JSON.stringify(data) } as ServerSentEventMessage
  }
}

async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of source) {
    // consume
  }
}

test("hit ratio truncates instead of rounding and needs both counts", () => {
  expect(hitRatio(400_445, 400_032)).toBe(99.8)
  expect(hitRatio(1000, 999)).toBe(99.9)
  expect(hitRatio(1000, 1000)).toBe(100)
  expect(hitRatio(undefined, 5)).toBeUndefined()
  expect(hitRatio(10, undefined)).toBeUndefined()
  expect(hitRatio(0, 0)).toBeUndefined()
})

test("anthropic stream sums input, cache read and cache write", async () => {
  const summary = new RequestSummary("messages", "claude-x")
  summary.attempt("messages", "x".repeat(1500), 12)
  await drain(
    summary.stream(
      sse([
        [
          "message_start",
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 9_000,
                cache_creation_input_tokens: 990,
                output_tokens: 1,
              },
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hi" },
          },
        ],
        ["ping", { type: "ping" }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 42 },
          },
        ],
      ]),
    ),
  )
  expect(summary.usage).toEqual({
    totalInput: 10_000,
    cachedInput: 9_000,
    cacheWrite: 990,
    output: 42,
  })
  expect(lines).toHaveLength(1)
  const [line] = lines
  expect(line.level).toBe("success")
  expect(line.text).toContain("claude-x")
  expect(line.text).toContain("messages native")
  expect(line.text).toContain("in 10,000 (cached 9,000 · 90.0%)")
  expect(line.text).toContain("write 990")
  expect(line.text).toContain("out 42")
  expect(line.text).not.toContain("reasoning")
  expect(line.text).toContain("ttft ")
  expect(line.text).toContain("1.5kB/12 items")
  expect(line.text).toContain("completed")
})

test("responses usage reads cached and reasoning tokens", () => {
  const summary = new RequestSummary("messages", "gpt-x")
  summary.attempt("responses", "{}", 3)
  summary.observe({
    type: "response.completed",
    response: {
      status: "completed",
      usage: {
        input_tokens: 2048,
        input_tokens_details: { cached_tokens: 1024 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  })
  summary.finish()
  expect(lines[0].text).toContain("messages→responses")
  expect(lines[0].text).toContain("in 2,048 (cached 1,024 · 50.0%)")
  expect(lines[0].text).toContain("out 7 (reasoning 5)")
})

test("chat usage without cache details shows unknown, not zero", () => {
  const summary = new RequestSummary("chat", "gpt-x")
  summary.attempt("chat", "{}", 1)
  summary.observe({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 3 },
  })
  summary.finish()
  expect(lines[0].text).toContain("in 100 (cached ?)")
  expect(lines[0].text).not.toContain("%")
  expect(lines[0].text).not.toContain("ttft")
})

test("finish is idempotent", () => {
  const summary = new RequestSummary("chat", "m")
  summary.finish()
  summary.finish()
  expect(lines).toHaveLength(1)
})

test("aborted requests finish as cancelled and errors as warnings", () => {
  const controller = new AbortController()
  const cancelled = new RequestSummary("responses", "m")
  cancelled.bind(controller.signal)
  controller.abort()
  cancelled.fail(new Error("boom"))
  cancelled.finish()

  const failed = new RequestSummary("responses", "m")
  failed.fail(new Error("upstream exploded"))
  failed.finish()

  expect(lines.map((line) => line.level)).toEqual(["warn", "warn"])
  expect(lines[0].text).toContain("cancelled")
  expect(lines[1].text).toContain("error: upstream exploded")
})

test("a stream without a terminal event is reported as such", async () => {
  const summary = new RequestSummary("responses", "m")
  summary.attempt("responses", "{}", 1)
  await drain(
    summary.stream(
      sse([[undefined, { type: "response.output_text.delta", delta: "a" }]]),
    ),
  )
  expect(lines[0].level).toBe("warn")
  expect(lines[0].text).toContain("stream_ended_without_terminal")
})
