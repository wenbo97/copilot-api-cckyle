import { afterEach, beforeEach, expect, test } from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const timeoutNames = [
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
]
let previousState: State
let previousTimeouts: Array<string | undefined>
let previousLevel: number
const cleanups: Array<() => void> = []

beforeEach(() => {
  previousState = { ...state }
  previousLevel = consola.level
  consola.level = -999
  previousTimeouts = timeoutNames.map((name) => process.env[name])
  for (const name of timeoutNames) Reflect.deleteProperty(process.env, name)
  Object.assign(state, {
    copilotToken: "offline",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    manualApprove: false,
    traceEnabled: false,
    rateLimitSeconds: undefined,
    accountType: "individual",
  })
  installFetch(() => Promise.reject(new Error("Unexpected network request")))
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.fetch = originalFetch
  Object.assign(state, previousState)
  consola.level = previousLevel
  for (const [index, name] of timeoutNames.entries()) {
    const value = previousTimeouts[index]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

const routes = [
  { ingress: "responses", egress: "/responses" },
  { ingress: "responses", egress: "/chat/completions" },
  { ingress: "chat/completions", egress: "/chat/completions" },
  { ingress: "messages", egress: "/v1/messages" },
  { ingress: "messages", egress: "/chat/completions" },
  { ingress: "messages", egress: "/responses" },
]

test.each(routes)(
  "cancels a queued request before upstream admission: $ingress -> $egress",
  async ({ ingress, egress }) => {
    selectModel(egress)
    state.rateLimitSeconds = 60
    state.rateLimitWait = true
    state.lastRequestTimestamp = Date.now()
    let calls = 0
    installFetch(() => {
      calls++
      return Promise.reject(new Error("Queued cancellation reached upstream"))
    })
    const controller = new AbortController()
    const response = request(ingress, false, controller.signal)
    queueMicrotask(() => controller.abort())
    const cancelled = await bounded(response)
    expect(cancelled.ok).toBe(false)
    await cancelled.text()
    expect(calls).toBe(0)
  },
)

test.each(routes)(
  "cancels header waits: $ingress -> $egress",
  async ({ ingress, egress }) => {
    selectModel(egress)
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const upstream = Promise.withResolvers<Response>()
    installFetch((_url, init) => {
      const signal = init?.signal ?? undefined
      entered.resolve(signal)
      signal?.addEventListener("abort", () => upstream.reject(signal.reason), {
        once: true,
      })
      return upstream.promise
    })
    const caller = new AbortController()
    const pending = request(ingress, true, caller.signal)
    try {
      const signal = await entered.promise
      caller.abort(new DOMException("client left", "AbortError"))
      expect(signal?.aborted).toBe(true)
      await bounded(pending)
    } finally {
      upstream.resolve(new Response("offline cleanup", { status: 503 }))
      await pending
    }
  },
)

test.each(
  routes.flatMap((route) =>
    [false, true].map((cancelReader) => ({ ...route, cancelReader })),
  ),
)(
  "cancels body reads: $ingress -> $egress (reader=$cancelReader)",
  async ({ ingress, egress, cancelReader }) => {
    selectModel(egress)
    let upstreamSignal: AbortSignal | undefined
    installFetch((_url, init) => {
      upstreamSignal = init?.signal ?? undefined
      const frames: Record<string, unknown> = {
        "/responses": {
          type: "response.created",
          response: snapshot("in_progress"),
        },
        "/v1/messages": { type: "message_start", message: { id: "msg_test" } },
        "/chat/completions": {
          id: "chat_test",
          model: "offline-model",
          created: 1,
          choices: [
            { index: 0, delta: { content: "hello" }, finish_reason: null },
          ],
        },
      }
      const initial = frames[egress]
      return Promise.resolve(openStream(initial, upstreamSignal))
    })
    const caller = new AbortController()
    const response = await request(ingress, true, caller.signal)
    if (!response.body) throw new Error("Expected an SSE body")
    const reader = response.body.getReader()
    await bounded(reader.read())
    if (cancelReader) await reader.cancel()
    else caller.abort(new DOMException("client left", "AbortError"))
    expect(upstreamSignal?.aborted).toBe(true)
    await bounded(
      (async () => {
        try {
          while (!(await reader.read()).done) {
            /* drain buffered events */
          }
        } catch {
          /* passthrough streams may propagate cancellation */
        }
      })(),
    )
  },
)

test.each(["COPILOT_HEADER_TIMEOUT_MS", "COPILOT_FIRST_EVENT_TIMEOUT_MS"])(
  "native Messages honors %s",
  async (name) => {
    selectModel("/v1/messages")
    process.env[name] = "15"
    let signal: AbortSignal | undefined
    const upstream = Promise.withResolvers<Response>()
    installFetch((_url, init) => {
      signal = init?.signal ?? undefined
      if (name === "COPILOT_HEADER_TIMEOUT_MS")
        signal?.addEventListener(
          "abort",
          () => upstream.reject(signal?.reason),
          { once: true },
        )
      return name === "COPILOT_HEADER_TIMEOUT_MS" ?
          upstream.promise
        : Promise.resolve(openStream(undefined, signal))
    })
    const pending = request("messages", true).then(async (response) => {
      try {
        await response.text()
      } catch {
        /* expected streaming timeout */
      }
    })
    try {
      await bounded(pending)
      expect(signal?.reason).toMatchObject({ name: "TimeoutError" })
    } finally {
      upstream.resolve(new Response("cleanup", { status: 503 }))
    }
  },
)

test.each([
  { status: "completed", reason: undefined, stop: "end_turn" },
  { status: "incomplete", reason: "max_output_tokens", stop: "max_tokens" },
  { status: "incomplete", reason: "content_filter", stop: "refusal" },
])(
  "Messages bridge closes blocks for $status/$reason",
  async ({ status, reason, stop }) => {
    const terminal = {
      type: `response.${status}`,
      response: snapshot(status, reason),
    }
    const response = await bridge([...textEvents(), terminal, terminal])
    const body = await response.text()
    expect(body.match(/event: content_block_stop/g)).toHaveLength(1)
    expect(body.match(/event: message_stop/g)).toHaveLength(1)
    expect(body).toContain(`"stop_reason":"${stop}"`)
    expect(body.indexOf("event: content_block_stop")).toBeLessThan(
      body.indexOf("event: message_delta"),
    )
  },
)

test.each([
  {
    label: "contradictory terminal",
    tail: [
      {
        type: "response.failed",
        response: {
          ...snapshot("completed"),
          error: { code: "broken", message: "specific cause" },
        },
      },
    ],
    cause: "specific cause",
  },
  {
    label: "failed",
    tail: [
      {
        type: "response.failed",
        response: {
          ...snapshot("failed"),
          error: { code: "upstream_broken", message: "specific cause" },
        },
      },
    ],
    cause: "specific cause",
  },
  {
    label: "error",
    tail: [
      {
        type: "error",
        code: "upstream_broken",
        message: "specific cause",
        param: null,
      },
    ],
    cause: "specific cause",
  },
  { label: "EOF", tail: [], cause: "terminal" },
  { label: "invalid event", tail: ["not-json"], cause: "invalid JSON" },
  {
    label: "unknown incomplete",
    tail: [
      {
        type: "response.incomplete",
        response: snapshot("incomplete", "unknown"),
      },
    ],
    cause: "incomplete",
  },
])(
  "Messages bridge reports $label without successful termination",
  async ({ tail, cause }) => {
    const response = await bridge([...textEvents(), ...tail])
    const body = await response.text()
    expect(body.match(/event: error/g)).toHaveLength(1)
    expect(body.match(/event: content_block_stop/g)).toHaveLength(1)
    expect(body).toContain(cause)
    expect(body).not.toContain("event: message_stop")
  },
)

test("non-stream Messages bridge rejects a failed response", async () => {
  selectModel("/responses")
  installFetch(() =>
    Promise.resolve(
      Response.json({
        ...snapshot("failed"),
        error: { code: "broken", message: "specific cause" },
      }),
    ),
  )
  const response = await request("messages", false)
  expect(response.status).toBe(502)
  expect(await response.text()).toContain("specific cause")
})

function installFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  globalThis.fetch = Object.assign(fn, { preconnect: originalFetch.preconnect })
}

function selectModel(egress: string) {
  state.models = {
    object: "list",
    data: [
      {
        id: "offline-model",
        supported_endpoints: [egress],
        capabilities: { supports: {} },
      },
    ],
  } as unknown as ModelsResponse
}

async function request(ingress: string, stream: boolean, signal?: AbortSignal) {
  return server.request(`http://localhost/v1/${ingress}`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "offline-model",
      stream,
      ...(ingress === "responses" ?
        { input: "hello" }
      : { messages: [{ role: "user", content: "hello" }], max_tokens: 10 }),
    }),
  })
}

function snapshot(status: string, reason?: string) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: "offline-model",
    status,
    output: [],
    ...(reason ? { incomplete_details: { reason } } : {}),
  }
}

function textEvents() {
  return [
    { type: "response.created", response: snapshot("in_progress") },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    },
  ]
}

async function bridge(frames: Array<unknown>) {
  selectModel("/responses")
  installFetch(() =>
    Promise.resolve(
      new Response(
        frames
          .map(
            (frame) =>
              `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  )
  return request("messages", true)
}

function openStream(initial: unknown, signal?: AbortSignal) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (initial)
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(initial)}\n\n`),
          )
        const abort = () =>
          controller.error(signal?.reason ?? new Error("cleanup"))
        signal?.addEventListener("abort", abort, { once: true })
        cleanups.push(() => {
          signal?.removeEventListener("abort", abort)
          controller.error(new Error("cleanup"))
        })
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Request did not settle")),
          500,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
