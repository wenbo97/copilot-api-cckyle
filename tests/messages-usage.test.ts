import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const metadata = { id: "chat_fixture", created: 1, model: "usage-fixture" }
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
  completion_tokens: 5,
  prompt_tokens_details: { cached_tokens: 80 },
}

const originalFetch = globalThis.fetch
let previousState: State
let previousEnvironment: Array<string | undefined>
const environment = [
  "COPILOT_CACHE_DIAGNOSTICS",
  "COPILOT_CACHE_POLICY",
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
]

beforeEach(() => {
  previousState = { ...state }
  previousEnvironment = environment.map((key) => process.env[key])
  for (const key of environment) Reflect.deleteProperty(process.env, key)
  Object.assign(state, {
    copilotToken: "offline-credential",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    rateLimitSeconds: undefined,
    manualApprove: false,
    traceEnabled: false,
  })
  installFetch(() => Promise.reject(new Error("Unexpected network request")))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
  for (const [index, key] of environment.entries()) {
    const value = previousEnvironment[index]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

test("Responses JSON reports cached reads separately from uncached input", async () => {
  selectModel("/responses")
  installFetch(() =>
    Promise.resolve(
      Response.json(
        snapshot({
          input_tokens: 100,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 7 },
        }),
      ),
    ),
  )
  const response = await request(false)
  expect(response.status).toBe(200)
  const message = (await response.json()) as AnthropicResponse
  expect(message.usage).toEqual({
    input_tokens: 20,
    output_tokens: 5,
    cache_read_input_tokens: 80,
  })
})

test.each(["/responses", "/chat/completions"])(
  "%s validates JSON usage and preserves measured zero",
  async (endpoint) => {
    selectModel(endpoint)
    for (const cached of [0, -1, 101, 1.5, "80", null, undefined]) {
      installFetch(() =>
        Promise.resolve(
          Response.json(
            endpoint === "/responses" ?
              snapshot({
                input_tokens: 100,
                output_tokens: 0,
                input_tokens_details: { cached_tokens: cached },
              })
            : chatResponse({
                prompt_tokens: 100,
                completion_tokens: 0,
                prompt_tokens_details: { cached_tokens: cached },
              }),
          ),
        ),
      )
      const message = (await (await request(false)).json()) as AnthropicResponse
      expect(message.usage).toEqual(
        cached === 0 ?
          { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0 }
        : { input_tokens: 100, output_tokens: 0 },
      )
    }
  },
)

test("Responses SSE corrects initial placeholders using cumulative terminal input and read usage", async () => {
  selectModel("/responses")
  installFetch(() =>
    Promise.resolve(
      sse([
        {
          type: "response.created",
          response: { ...snapshot(), status: "in_progress" },
        },
        {
          type: "response.completed",
          response: snapshot({
            input_tokens: 100,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 80 },
          }),
        },
      ]),
    ),
  )
  const events = parseEvents(await (await request()).text())
  expect(events[0]).toMatchObject({
    type: "message_start",
    message: { usage: { input_tokens: 0, output_tokens: 0 } },
  })
  expect(events.find((event) => event.type === "message_delta")).toMatchObject({
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 },
  })
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(
    1,
  )
})

test("Chat SSE requests usage and waits through empty frames for the final usage trailer", async () => {
  selectModel("/chat/completions")
  let body: Record<string, unknown> = {}
  installFetch((_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON request")
    body = JSON.parse(init.body) as Record<string, unknown>
    return Promise.resolve(
      sse([
        { ...content, usage: { prompt_tokens: 50, completion_tokens: 1 } },
        finish,
        { ...metadata, choices: [], usage: {} },
        { ...metadata, choices: [], usage: observed },
        "[DONE]",
      ]),
    )
  })
  const events = parseEvents(await (await request()).text())
  expect(body.stream_options).toEqual({ include_usage: true })
  expect(events.find((event) => event.type === "message_delta")).toMatchObject({
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 },
  })
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(
    1,
  )
})

test.each([{ ending: [] }, { ending: ["[DONE]"] }])(
  "Chat finalizes a pending finish at normal termination $ending",
  async ({ ending }) => {
    selectModel("/chat/completions")
    installFetch(() => Promise.resolve(sse([content, finish, ...ending])))
    const events = parseEvents(await (await request()).text())
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 } })
  },
)

test.each([
  { name: "EOF before finish", frames: [content] },
  { name: "DONE before finish", frames: [content, "[DONE]"] },
  { name: "malformed JSON", frames: [content, "not-json"] },
  { name: "content after finish", frames: [content, finish, content] },
  {
    name: "tools after finish",
    frames: [
      content,
      finish,
      {
        ...metadata,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    ],
  },
])(
  "Chat emits one error and no successful stop for $name",
  async ({ frames }) => {
    selectModel("/chat/completions")
    installFetch(() => Promise.resolve(sse(frames)))
    const events = parseEvents(await (await request()).text())
    expect(events.filter((event) => event.type === "error")).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(0)
  },
)

test("Chat bounds missing usage trailer wait to five seconds and releases upstream", async () => {
  selectModel("/chat/completions")
  const originalTimeout = globalThis.setTimeout
  const requested: Array<number | undefined> = []
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof setTimeout>) => {
        requested.push(args[1])
        if (args[1] === 5000) args[1] = 10
        return originalTimeout(...args)
      },
      { __promisify__: originalTimeout.__promisify__ },
    ) as typeof setTimeout,
  )
  let aborted = false
  const client = new AbortController()
  const safety = originalTimeout(() => client.abort(), 200)
  installFetch((_url, init) =>
    Promise.resolve(
      openSse([content, finish], init?.signal, {
        abort: () => {
          aborted = true
        },
      }),
    ),
  )
  try {
    const events = parseEvents(
      await (await request(true, client.signal)).text(),
    )
    expect(requested).toContain(5000)
    expect(events.filter((event) => event.type === "error")).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(0)
    expect(aborted).toBe(true)
  } finally {
    clearTimeout(safety)
    client.abort()
    timer.mockRestore()
  }
})

test.each(["/responses", "/chat/completions"])(
  "%s retains earlier input counters when terminal usage only supplies output",
  async (endpoint) => {
    selectModel(endpoint)
    const frames =
      endpoint === "/responses" ?
        [
          {
            type: "response.created",
            response: {
              ...snapshot({
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 80 },
              }),
              status: "in_progress",
            },
          },
          {
            type: "response.completed",
            response: snapshot({ output_tokens: 5 }),
          },
        ]
      : [
          {
            ...content,
            usage: {
              prompt_tokens: 100,
              prompt_tokens_details: { cached_tokens: 80 },
            },
          },
          finish,
          { ...metadata, choices: [], usage: { completion_tokens: 5 } },
        ]
    installFetch(() => Promise.resolve(sse(frames)))
    const events = parseEvents(await (await request()).text())
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 80,
      },
    })
  },
)

test("Messages diagnostics distinguish unknown from zero and unverified writes without leaking content", async () => {
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  selectModel("/chat/completions")
  const info = spyOn(consola, "info").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
  const summaries = () =>
    info.mock.calls
      .map(([message]): unknown => message)
      .filter(
        (message): message is string =>
          typeof message === "string"
          && message.startsWith("[messages-usage] "),
      )
  try {
    installFetch(() =>
      Promise.resolve(
        Response.json(
          chatResponse({
            prompt_tokens: 100,
            completion_tokens: 0,
            prompt_tokens_details: { cache_write_tokens: 7 },
          }),
        ),
      ),
    )
    await (await request(false)).text()
    expect(summaries()).toHaveLength(1)
    expect(
      JSON.parse(summaries()[0].slice("[messages-usage] ".length)),
    ).toMatchObject({
      source: "chat",
      total_input_tokens: 100,
      cached_input_tokens: null,
      output_tokens: 0,
      read_usage_complete: false,
      billing_complete: false,
      fallback_reasons: ["cache_read_unknown", "unverified_cache_write"],
    })
    expect(summaries()[0]).not.toContain("private-prompt")
    expect(summaries()[0]).not.toContain("offline-credential")
    info.mockClear()
    installFetch(() => Promise.reject(new Error("fetch failed")))
    await (await request(false)).text()
    expect(summaries()).toHaveLength(1)
    expect(
      JSON.parse(summaries()[0].slice("[messages-usage] ".length)),
    ).toMatchObject({
      total_input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
    })
  } finally {
    info.mockRestore()
  }
})

test.each(["/responses", "/chat/completions"])(
  "%s rejects invalid totals and output counts but keeps a measured cached read",
  async (endpoint) => {
    selectModel(endpoint)
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
      installFetch(() =>
        Promise.resolve(
          Response.json(
            endpoint === "/responses" ?
              snapshot({
                input_tokens: invalid,
                output_tokens: invalid,
                input_tokens_details: { cached_tokens: 0 },
              })
            : chatResponse({
                prompt_tokens: invalid,
                completion_tokens: invalid,
                prompt_tokens_details: { cached_tokens: 0 },
              }),
          ),
        ),
      )
      const message = (await (await request(false)).json()) as AnthropicResponse
      expect(message.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      })
    }
  },
)

test("translated Responses diagnostics are opt-in and record terminal cumulative usage once", async () => {
  selectModel("/responses")
  const info = spyOn(consola, "info").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
  const summaries = () =>
    info.mock.calls
      .map(([message]): unknown => message)
      .filter(
        (message): message is string =>
          typeof message === "string"
          && message.startsWith("[messages-usage] "),
      )
  const frames = [
    {
      type: "response.created",
      response: { ...snapshot(), status: "in_progress" },
    },
    {
      type: "response.completed",
      response: snapshot({
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 80 },
      }),
    },
  ]
  try {
    installFetch(() => Promise.resolve(sse(frames)))
    await (await request()).text()
    expect(summaries()).toHaveLength(0)
    process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
    await (await request()).text()
    expect(summaries()).toHaveLength(1)
    expect(
      JSON.parse(summaries()[0].slice("[messages-usage] ".length)),
    ).toMatchObject({
      source: "responses",
      total_input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 5,
      read_usage_complete: true,
      billing_complete: false,
      fallback_reasons: [],
    })
  } finally {
    info.mockRestore()
  }
})

test("Chat upstream body failure emits one error and cleans up its signal", async () => {
  selectModel("/chat/completions")
  let upstream: AbortSignal | null | undefined
  installFetch((_url, init) => {
    upstream = init?.signal
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic body failure"))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })
  const events = parseEvents(await (await request()).text())
  expect(events.filter((event) => event.type === "error")).toHaveLength(1)
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(
    0,
  )
  expect(upstream?.aborted).toBe(true)
})

test("Chat upstream idle timeout wins over the five-second trailer deadline", async () => {
  selectModel("/chat/completions")
  process.env.COPILOT_STREAM_IDLE_TIMEOUT_MS = "10"
  let aborted = false
  installFetch((_url, init) =>
    Promise.resolve(
      openSse([content, finish], init?.signal, {
        abort: () => {
          aborted = true
        },
      }),
    ),
  )
  const events = parseEvents(await (await request()).text())
  const errors = events.filter((event) => event.type === "error")
  expect(errors).toHaveLength(1)
  expect(errors[0].error.message).toContain("SSE idle timeout")
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(
    0,
  )
  expect(aborted).toBe(true)
})

test("Chat usage on the finish frame emits one terminal stop and releases upstream", async () => {
  selectModel("/chat/completions")
  let aborted = false
  installFetch((_url, init) =>
    Promise.resolve(
      openSse([content, { ...finish, usage: observed }], init?.signal, {
        abort: () => {
          aborted = true
        },
      }),
    ),
  )
  const events = parseEvents(await (await request()).text())
  expect(events.filter((event) => event.type === "message_stop")).toHaveLength(
    1,
  )
  expect(events.filter((event) => event.type === "message_delta")).toHaveLength(
    1,
  )
  expect(events.find((event) => event.type === "message_delta")).toMatchObject({
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80 },
  })
  expect(aborted).toBe(true)
})

test("Chat cancellation after finish clears the armed trailer timer without synthetic terminal events", async () => {
  selectModel("/chat/completions")
  const client = new AbortController()
  const timers = spyOn(globalThis, "setTimeout")
  const cleared = spyOn(globalThis, "clearTimeout")
  let aborted = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  installFetch((_url, init) =>
    Promise.resolve(
      openSse([content, finish], init?.signal, {
        abort: () => {
          aborted = true
        },
      }),
    ),
  )
  try {
    const response = await request(true, client.signal)
    const started = await readThroughFinish(response)
    reader = started.reader
    const index = timers.mock.calls.findIndex((args) => args[1] === 5000)
    expect(index).toBeGreaterThanOrEqual(0)
    const handle: unknown = timers.mock.results[index].value
    client.abort()
    const events = parseEvents(started.text + (await readRemaining(reader)))
    expect(
      events.filter(
        (event) => event.type === "message_stop" || event.type === "error",
      ),
    ).toHaveLength(0)
    expect(aborted).toBe(true)
    expect(cleared.mock.calls.some(([timer]) => timer === handle)).toBe(true)
  } finally {
    client.abort()
    await reader?.cancel()
    reader?.releaseLock()
    timers.mockRestore()
    cleared.mockRestore()
  }
})

test("Chat late successful usage trailer clears an already-armed timer and releases upstream", async () => {
  selectModel("/chat/completions")
  const timers = spyOn(globalThis, "setTimeout")
  const cleared = spyOn(globalThis, "clearTimeout")
  let aborted = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let sendTrailer: (() => void) | undefined
  installFetch((_url, init) =>
    Promise.resolve(
      openSse([content, finish], init?.signal, {
        abort: () => {
          aborted = true
        },
        ready: (controller) => {
          sendTrailer = () =>
            controller.enqueue(
              new TextEncoder().encode(
                encode([{ ...metadata, choices: [], usage: observed }]),
              ),
            )
        },
      }),
    ),
  )
  try {
    const started = await readThroughFinish(await request())
    reader = started.reader
    const index = timers.mock.calls.findIndex((args) => args[1] === 5000)
    expect(index).toBeGreaterThanOrEqual(0)
    const handle: unknown = timers.mock.results[index].value
    if (!sendTrailer) throw new Error("Upstream has not started")
    sendTrailer()
    const events = parseEvents(started.text + (await readRemaining(reader)))
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === "error")).toHaveLength(0)
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 80,
      },
    })
    expect(aborted).toBe(true)
    expect(cleared.mock.calls.some(([timer]) => timer === handle)).toBe(true)
  } finally {
    await reader?.cancel()
    reader?.releaseLock()
    timers.mockRestore()
    cleared.mockRestore()
  }
})

async function readThroughFinish(response: Response) {
  if (!response.body) throw new Error("Missing SSE body")
  const reader = response.body.getReader()
  let text = ""
  const decoder = new TextDecoder()
  while (!text.includes("event: content_block_stop")) {
    const part = await reader.read()
    if (part.done) throw new Error("Stream ended before the finish frame")
    text += decoder.decode(part.value)
  }
  return { reader, text }
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = ""
  const decoder = new TextDecoder()
  for (;;) {
    const part = await reader.read()
    if (part.done) return text
    text += decoder.decode(part.value)
  }
}

function selectModel(endpoint: string) {
  const model: Model = {
    id: "usage-fixture",
    name: "Fixture",
    object: "model",
    model_picker_enabled: false,
    preview: false,
    vendor: "synthetic",
    version: "1",
    supported_endpoints: [endpoint],
    capabilities: {
      family: "fixture",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: {},
      supports: {},
    },
  }
  state.models = { object: "list", data: [model] }
}

function snapshot(usage?: unknown) {
  return {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    created_at: 1,
    model: "usage-fixture",
    output: [],
    usage,
  }
}

function chatResponse(usage: unknown) {
  return {
    ...metadata,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage,
  }
}

function parseEvents(body: string): Array<AnthropicStreamEventData> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as AnthropicStreamEventData)
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

function openSse(
  frames: Array<unknown>,
  signal: AbortSignal | null | undefined,
  callbacks: {
    abort: () => void
    ready?: (controller: ReadableStreamDefaultController<Uint8Array>) => void
  },
) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      callbacks.ready?.(controller)
      controller.enqueue(new TextEncoder().encode(encode(frames)))
      signal?.addEventListener(
        "abort",
        () => {
          callbacks.abort()
          controller.error(signal.reason)
        },
        { once: true },
      )
    },
  })
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

function installFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  globalThis.fetch = Object.assign(fn, { preconnect: originalFetch.preconnect })
}

function request(stream = true, signal?: AbortSignal) {
  return server.request("http://localhost/v1/messages", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "usage-fixture",
      max_tokens: 100,
      stream,
      messages: [
        { role: "user", content: "private-prompt-must-not-be-logged" },
      ],
    }),
  })
}
