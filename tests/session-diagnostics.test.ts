import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state, type State } from "~/lib/state"
import * as token from "~/lib/token"
import { server } from "~/server"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

const originalFetch = globalThis.fetch
let previousState: State
let sent: Record<string, unknown>
let reply: () => Response
const model = "historical-diagnostic-fixture"
const numbered = "0\tLOCAL_TOOL_42\n1\t"
// A minimized schema, not a claim that the historical client's schema was saved.
const readSchema = {
  type: "object",
  properties: { file_path: { type: "string" }, pages: { type: "string" } },
  required: ["file_path"],
}

function snapshot(output: Array<unknown> = []) {
  return {
    id: "resp_diagnostic",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output,
    usage: { input_tokens: 10, output_tokens: 3 },
  }
}

beforeEach(() => {
  previousState = { ...state }
  state.copilotToken = "offline-only-fixture"
  state.copilotTokenExpiresAt = Date.now() / 1000 + 3600
  state.rateLimitSeconds = undefined
  state.manualApprove = false
  state.traceEnabled = false
  const fixture: Model = {
    id: model,
    name: model,
    object: "model",
    model_picker_enabled: false,
    preview: false,
    vendor: "synthetic",
    version: "1",
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "fixture",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: { max_output_tokens: 4096 },
      supports: { reasoning_effort: ["low"] },
    },
  }
  state.models = { object: "list", data: [fixture] }
  sent = {}
  reply = () => Response.json(snapshot())
  // No delegation to the real fetch: unexpected requests fail closed.
  globalThis.fetch = Object.assign(
    (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Unexpected offline fetch")
      sent = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(reply())
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
})

function messages(extra: Record<string, unknown>) {
  return server.request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Read marker.txt" }],
      ...extra,
    }),
  })
}

function sse(events: Array<Record<string, unknown>>) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

test("Messages optional Read fields opt out of Responses implicit strict normalization", async () => {
  const result = await messages({
    tools: [{ name: "Read", input_schema: readSchema }],
  })
  expect(result.status).toBe(200)
  const tools = sent.tools as Array<Record<string, unknown>>
  expect(tools[0].strict).toBe(false)
  expect(tools[0].parameters).toEqual(readSchema)
  expect(readSchema.required).toEqual(["file_path"])
})

for (const pages of [undefined, "", "1"]) {
  for (const stream of [false, true]) {
    test(`Read pages=${JSON.stringify(pages)} survives actual Messages handler stream=${stream}`, async () => {
      const args = {
        file_path: "marker.txt",
        ...(pages === undefined ? {} : { pages }),
      }
      const serialized = JSON.stringify(args)
      const item = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "Read",
        arguments: serialized,
      }
      reply = () =>
        stream ?
          sse([
            {
              type: "response.created",
              response: { ...snapshot(), status: "in_progress" },
            },
            { type: "response.output_item.added", output_index: 0, item },
            ...Array.from(serialized, (delta) => ({
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: "fc_1",
              delta,
            })),
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: snapshot([item]) },
          ])
        : Response.json(snapshot([item]))
      const result = await messages({
        stream,
        tools: [{ name: "Read", input_schema: readSchema }],
      })
      expect(result.status).toBe(200)
      expect(sent.tools).toEqual([
        {
          type: "function",
          name: "Read",
          parameters: readSchema,
          strict: false,
        },
      ])
      if (!stream) {
        const body = (await result.json()) as {
          content: Array<{ input: unknown }>
        }
        expect(body.content[0].input).toEqual(args)
      } else {
        const text = await result.text()
        const deltas = text
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data: "))
          .map(
            (line) =>
              JSON.parse(line.slice(6)) as {
                delta?: { partial_json?: string }
              },
          )
          .map((event) => event.delta?.partial_json ?? "")
          .join("")
        expect(JSON.parse(deltas)).toEqual(args)
        expect(text).toContain("message_stop")
      }
    })
  }
}

for (const stream of [false, true]) {
  test(`Read display and final numbered text are preserved, not manufactured stream=${stream}`, async () => {
    const item = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: numbered, annotations: [] }],
    }
    reply = () =>
      stream ?
        sse([
          {
            type: "response.created",
            response: { ...snapshot(), status: "in_progress" },
          },
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: "msg_1",
            delta: numbered,
          },
          { type: "response.completed", response: snapshot([item]) },
        ])
      : Response.json(snapshot([item]))
    const response = await messages({
      stream,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: { file_path: "marker.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: numbered },
          ],
        },
      ],
    })
    expect(sent.input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: '{"file_path":"marker.txt"}',
      },
      { type: "function_call_output", call_id: "call_1", output: numbered },
    ])
    if (!stream) {
      const body = (await response.json()) as {
        content: Array<{ text: string }>
      }
      expect(body.content[0].text).toBe(numbered)
    } else {
      expect(await response.text()).toContain(JSON.stringify(numbered))
    }
  })
}

test("long scalar and both user-array shapes retain fixed options and upstream 503", async () => {
  const text = `The first marker is ALPHA17.\n${"irrelevant fixed filler line\n".repeat(1500)}\nThe final marker is BETA25. Reply with the two markers separated by one space.`
  for (const input of [
    text,
    [{ role: "user", content: text }],
    [{ role: "user", content: [{ type: "input_text", text }] }],
  ]) {
    reply = () =>
      Response.json(
        { error: { message: "synthetic upstream unavailable" } },
        { status: 503 },
      )
    const payload = {
      model,
      input,
      reasoning: { effort: "low" },
      max_output_tokens: 1024,
    }
    const result = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(result.status).toBe(503)
    await result.text()
    expect(sent).toEqual(payload)
  }
})

function controlledTimers() {
  let now = 0
  let nextId = 1
  type Timer = ReturnType<typeof setTimeout>
  const pending = new Map<Timer, { at: number; run: () => void }>()
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (callback: unknown, delay?: number) => {
        if (typeof callback !== "function")
          throw new Error("Expected timer callback")
        const id = nextId++ as unknown as Timer & number
        pending.set(id, {
          at: now + (delay ?? 0),
          run: () => {
            Reflect.apply(callback, undefined, [])
          },
        })
        return id
      },
      { __promisify__: setTimeout.__promisify__ },
    ),
  )
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
    if (id !== undefined) pending.delete(id as Timer)
  })
  return {
    advance(ms: number) {
      now += ms
      for (const [id, timer] of pending) {
        if (timer.at <= now) {
          pending.delete(id)
          timer.run()
        }
      }
    },
    count: () => pending.size,
    restore() {
      schedule.mockRestore()
      clear.mockRestore()
    },
  }
}

async function flushUntil(ready: () => boolean) {
  for (let step = 0; step < 100 && !ready(); step++) await Promise.resolve()
  expect(ready()).toBe(true)
}

function waitingFetch(signals: Array<AbortSignal>, first401 = false) {
  globalThis.fetch = Object.assign(
    (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error("Missing upstream signal")
      signals.push(signal)
      if (first401 && signals.length === 1)
        return Promise.resolve(new Response("unauthorized", { status: 401 }))
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error(String(signal.reason))),
          { once: true },
        )
      })
    },
    { preconnect: originalFetch.preconnect },
  )
}

for (const first401 of [false, true]) {
  test(`controlled 30000ms header boundary, retry=${first401}`, async () => {
    const timers = controlledTimers()
    const refresh = spyOn(token, "ensureCopilotToken").mockResolvedValue(
      undefined,
    )
    const signals: Array<AbortSignal> = []
    waitingFetch(signals, first401)
    try {
      const result = copilotFetch("/responses", {
        headerTimeoutMs: 30000,
      }).then(() => "unexpected success", String)
      await flushUntil(() => signals.length === (first401 ? 2 : 1))
      expect(timers.count()).toBe(1)
      timers.advance(29999)
      expect(signals.at(-1)?.aborted).toBe(false)
      timers.advance(1)
      expect(await result).toContain("header timeout after 30000 ms")
      expect(signals.at(-1)?.aborted).toBe(true)
      expect(timers.count()).toBe(0)
      if (first401) {
        expect(signals[0].aborted).toBe(false)
        expect(refresh).toHaveBeenLastCalledWith(true)
      }
    } finally {
      refresh.mockRestore()
      timers.restore()
    }
  })
}

test("headers clear the timer, but caller cancellation still reaches the body", async () => {
  const timers = controlledTimers()
  let signal: AbortSignal | undefined
  globalThis.fetch = Object.assign(
    (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return Promise.resolve(new Response("body"))
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const caller = new AbortController()
    const response = await copilotFetch("/responses", {
      headerTimeoutMs: 30000,
      signal: caller.signal,
    })
    expect(timers.count()).toBe(0)
    timers.advance(30001)
    expect(signal?.aborted).toBe(false)
    expect(await response.text()).toBe("body")
    caller.abort()
    expect(signal?.aborted).toBe(true)
  } finally {
    timers.restore()
  }
})
