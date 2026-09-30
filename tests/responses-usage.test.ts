import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponseObject } from "~/routes/responses/responses-types"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let previousState: State
const timeoutNames = [
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
]
let previousTimeouts: Array<string | undefined>
beforeEach(() => {
  previousState = { ...state }
  previousTimeouts = timeoutNames.map((name) => process.env[name])
  for (const name of timeoutNames) Reflect.deleteProperty(process.env, name)
  Object.assign(state, {
    copilotToken: "offline",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    models: undefined,
    manualApprove: false,
    rateLimitSeconds: undefined,
    traceEnabled: false,
  })
  globalThis.fetch = Object.assign(
    () => Promise.reject(new Error("Unexpected network request")),
    { preconnect: originalFetch.preconnect },
  )
})
afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, previousState)
  for (const [index, name] of timeoutNames.entries()) {
    const value = previousTimeouts[index]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

const metadata = { id: "chat_usage", created: 1, model: "offline-model" }
const content = {
  ...metadata,
  choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
}
const finish = {
  ...metadata,
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
}
const observed = {
  prompt_tokens: 100,
  completion_tokens: 10,
  total_tokens: 110,
  prompt_tokens_details: { cached_tokens: 50 },
  completion_tokens_details: { reasoning_tokens: 7 },
}
const expected = {
  input_tokens: 100,
  output_tokens: 10,
  total_tokens: 110,
  input_tokens_details: { cached_tokens: 50 },
  output_tokens_details: { reasoning_tokens: 7 },
}

test("an empty usage frame cannot hide a later observed tail", async () => {
  installFetch(() =>
    Promise.resolve(
      sse([
        content,
        finish,
        { ...metadata, choices: [], usage: {} },
        { ...metadata, choices: [], usage: observed },
        "[DONE]",
      ]),
    ),
  )
  expect(terminal(await (await request()).text()).usage).toEqual(expected)
})

test.each([true, false])(
  "usage mapping is shared across stream=%s",
  async (stream) => {
    let body: Record<string, unknown> | undefined
    installFetch((_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected a JSON request body")
      body = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        stream ?
          sse([
            content,
            finish,
            { ...metadata, choices: [], usage: observed },
            "[DONE]",
          ])
        : Response.json({
            ...metadata,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
              },
            ],
            usage: observed,
          }),
      )
    })
    const response = await request(stream)
    const result =
      stream ?
        terminal(await response.text())
      : ((await response.json()) as ResponseObject)
    expect(result.usage).toEqual(expected)
    if (stream) expect(body?.stream_options).toEqual({ include_usage: true })
    else expect(body?.stream_options).toBeUndefined()
  },
)

test.each([{ ending: [] }, { ending: ["[DONE]"] }])(
  "finish without usage preserves unknown at normal EOF or DONE",
  async ({ ending }) => {
    installFetch(() => Promise.resolve(sse([content, finish, ...ending])))
    const body = await (await request()).text()
    expect(terminal(body).usage).toBeUndefined()
    expect(body.match(/event: response.completed/g)).toHaveLength(1)
  },
)

test("usage on the finish frame preserves real zero and omits invalid fields", async () => {
  installFetch(() =>
    Promise.resolve(
      sse([
        content,
        {
          ...finish,
          usage: {
            prompt_tokens: 0,
            completion_tokens: -1,
            total_tokens: "unknown",
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: null },
          },
        },
      ]),
    ),
  )
  expect(terminal(await (await request()).text()).usage).toEqual({
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
  })
})

test.each([
  {
    frames: [content, { ...metadata, choices: [], usage: observed }, "[DONE]"],
    label: "usage without finish",
  },
  { frames: [content, finish, "malformed-json"], label: "malformed tail" },
  { frames: [content, finish, content], label: "content after finish" },
])("reports $label as failure", async ({ frames }) => {
  installFetch(() => Promise.resolve(sse(frames)))
  const body = await (await request()).text()
  expect(terminal(body).status).toBe("failed")
  expect(body).not.toContain("event: response.completed")
  expect(body.match(/event: response.output_item.done/g)).toHaveLength(1)
})

test.each(["timeout", "network", "cancel"])(
  "does not invent success when usage wait ends with %s",
  async (mode) => {
    process.env.COPILOT_STREAM_IDLE_TIMEOUT_MS = "30"
    const caller = new AbortController()
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined
    let signal: AbortSignal | undefined
    installFetch((_url, init) => {
      signal = init?.signal ?? undefined
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              controller.enqueue(
                new TextEncoder().encode(encode([content, finish])),
              )
              signal?.addEventListener(
                "abort",
                () => controller.error(signal?.reason),
                { once: true },
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    })
    const response = await request(true, caller.signal)
    if (!response.body) throw new Error("Expected an SSE body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ""
    try {
      while (!body.includes("event: response.output_item.done")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("Stream ended before content completed")
        body += decoder.decode(chunk.value)
      }
      if (mode === "network")
        streamController?.error(new Error("tail disconnected"))
      if (mode === "cancel") caller.abort()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        body += decoder.decode(chunk.value)
      }
      expect(body).not.toContain("event: response.completed")
      if (mode !== "cancel") expect(terminal(body).status).toBe("failed")
      else expect(body).not.toContain("event: response.failed")
    } finally {
      caller.abort()
      await reader.cancel()
    }
  },
)

function terminal(body: string): ResponseObject {
  const lines = body.split("\n").filter((line) => line.startsWith("data:"))
  const events = lines.map(
    (line) =>
      JSON.parse(line.slice(5)) as { type: string; response?: ResponseObject },
  )
  const result = events.find((event) =>
    ["response.completed", "response.failed", "response.incomplete"].includes(
      event.type,
    ),
  )?.response
  if (!result) throw new Error("Missing terminal response")
  return result
}
function installFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  globalThis.fetch = Object.assign(fn, { preconnect: originalFetch.preconnect })
}
async function request(stream = true, signal?: AbortSignal) {
  return server.request("http://localhost/v1/responses", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "offline-model", input: "hello", stream }),
  })
}
function encode(frames: Array<unknown>) {
  return frames
    .map(
      (frame) =>
        `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
    )
    .join("")
}
function sse(frames: Array<unknown>) {
  return new Response(encode(frames), {
    headers: { "content-type": "text/event-stream" },
  })
}
