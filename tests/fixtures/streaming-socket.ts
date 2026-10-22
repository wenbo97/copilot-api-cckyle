import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import { serve } from "srvx"

import type { ModelsResponse } from "../../src/services/copilot/get-models"

import { state } from "../../src/lib/state"
import { createListenOptions } from "../../src/start"

const nativeFetch = globalThis.fetch
const encoder = new TextEncoder()
const slow = process.argv.includes("--slow")
const checks: Array<string> = []
let requests = 0
let released = 0
let headerDelay = 0
let frames: Array<{ after: number; data: string }> = []
let finishBody = true
let disabled = 0
const upstreamBodies: Array<ReadableStream<Uint8Array>> = []

state.copilotToken = "local-socket-test"
state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  data: [
    model("claude-socket", ["/v1/messages"]),
    model("gpt-socket-responses", ["/responses"]),
    model("gpt-socket-chat", ["/chat/completions"]),
  ],
} as ModelsResponse

function model(id: string, endpoints: Array<string>) {
  return {
    id,
    name: id,
    supported_endpoints: endpoints,
    capabilities: {
      type: "chat",
      family: id,
      tokenizer: "o200k_base",
      limits: { max_output_tokens: 100 },
    },
  }
}

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    requests++
    let done = false
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const release = () => {
      if (done) return
      done = true
      released++
      for (const timer of timers) clearTimeout(timer)
    }
    request.signal.addEventListener("abort", release, { once: true })
    const payload = (await request.json()) as { stream?: boolean }
    if (headerDelay) await Bun.sleep(headerDelay)
    if (!payload.stream) {
      release()
      return Response.json({
        id: "msg_socket",
        type: "message",
        role: "assistant",
        content: [],
      })
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Bun flushes headers with the first body bytes. A comment exercises
        // the first-event deadline without pretending an SSE event arrived.
        controller.enqueue(encoder.encode(": headers received\n\n"))
        const scenarioFrames = [...frames]
        for (const frame of scenarioFrames) {
          timers.push(
            setTimeout(() => {
              if (done) return
              controller.enqueue(encoder.encode(frame.data))
            }, frame.after),
          )
        }
        if (finishBody)
          timers.push(
            setTimeout(
              () => {
                if (done) return
                controller.close()
                release()
              },
              (scenarioFrames.at(-1)?.after ?? 0) + 10,
            ),
          )
      },
      cancel: release,
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    )
    if (url.hostname.endsWith("githubcopilot.com")) {
      assert.ok(typeof init?.body === "string")
      const payload = JSON.parse(init.body) as { stream?: boolean }
      assert.equal(
        (init as RequestInit & { timeout?: false }).timeout,
        payload.stream === true ? false : undefined,
      )
      return nativeFetch(new URL(url.pathname, upstream.url), init).then(
        (response) => {
          if (response.body) upstreamBodies.push(response.body)
          return response
        },
      )
    }
    return nativeFetch(input, init)
  },
  { preconnect: nativeFetch.preconnect },
)

const listenerOptions = createListenOptions(0, slow ? 255 : 1)
interface TimeoutRequest extends Request {
  runtime?: {
    bun?: { server: { timeout(raw: Request, seconds: number): void } }
  }
}
const listener = serve({
  ...listenerOptions,
  silent: true,
  fetch(request) {
    const bun = (request as TimeoutRequest).runtime?.bun
    assert.ok(bun, "srvx must attach the native Bun server")
    const nativeServer = bun.server
    bun.server = new Proxy(nativeServer, {
      get(target, property) {
        if (property === "timeout")
          return (raw: Request, seconds: number) => {
            assert.equal(raw, request)
            assert.equal(seconds, 0)
            disabled++
            nativeServer.timeout(raw, seconds)
          }
        return Reflect.get(target, property) as unknown
      },
    })
    return listenerOptions.fetch(request)
  },
})
await listener.ready()
const origin = listener.url
assert.ok(origin)

function frame(data: unknown, event?: string) {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
}

function terminalCount(body: string, marker: string): number {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:") && line.includes(marker)).length
}

const messageStop = frame({ type: "message_stop" }, "message_stop")
const responseCompleted = frame(
  {
    type: "response.completed",
    response: {
      id: "resp_socket",
      object: "response",
      created_at: 1,
      model: "gpt-socket-responses",
      status: "completed",
      output: [],
      error: null,
      incomplete_details: null,
    },
  },
  "response.completed",
)
const chatDone = frame("[DONE]")
const routes = [
  {
    path: "/v1/messages",
    model: "claude-socket",
    terminal: messageStop,
    marker: "message_stop",
  },
  {
    path: "/v1/responses",
    model: "gpt-socket-responses",
    terminal: responseCompleted,
    marker: "response.completed",
  },
  {
    path: "/v1/chat/completions",
    model: "gpt-socket-chat",
    terminal: chatDone,
    marker: "[DONE]",
  },
]

async function request(
  route = routes[0],
  streaming = true,
  signal?: AbortSignal,
) {
  return nativeFetch(new URL(route.path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      messages: [{ role: "user", content: "hello" }],
      input: "hello",
      max_tokens: 20,
      stream: streaming,
    }),
    signal: signal ?? AbortSignal.timeout(slow ? 450_000 : 10_000),
  })
}

async function waitUntil(predicate: () => boolean, timeout = 1500) {
  const end = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < end, "upstream did not release request resources")
    await Bun.sleep(10)
  }
}

function configure(
  timeouts: {
    header?: number
    first?: number
    idle?: number
    total?: number
  } = {},
) {
  process.env.COPILOT_HEADER_TIMEOUT_MS = String(timeouts.header ?? 5000)
  process.env.COPILOT_FIRST_EVENT_TIMEOUT_MS = String(timeouts.first ?? 300_000)
  process.env.COPILOT_STREAM_IDLE_TIMEOUT_MS = String(timeouts.idle ?? 300_000)
  process.env.COPILOT_TOTAL_TIMEOUT_MS = String(timeouts.total ?? 0)
  headerDelay = 0
  frames = []
  finishBody = true
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
}

async function check(name: string, action: () => Promise<void>) {
  await action()
  await waitUntil(
    () => requests === released && upstreamBodies.every((body) => !body.locked),
  )
  checks.push(name)
  console.log(`PASS ${name}`)
}

try {
  if (slow) {
    configure()
    for (const name of [
      "COPILOT_HEADER_TIMEOUT_MS",
      "COPILOT_FIRST_EVENT_TIMEOUT_MS",
      "COPILOT_STREAM_IDLE_TIMEOUT_MS",
      "COPILOT_TOTAL_TIMEOUT_MS",
    ])
      Reflect.deleteProperty(process.env, name)
    const began = Date.now()
    frames = Array.from({ length: 34 }, (_, index) => {
      let data = responseCompleted
      if (index === 0)
        data = frame(
          {
            type: "response.created",
            response: {
              id: "resp_socket",
              object: "response",
              created_at: 1,
              model: "gpt-socket-responses",
              status: "in_progress",
              output: [],
              error: null,
              incomplete_details: null,
            },
          },
          "response.created",
        )
      else if (index < 33)
        data = frame(
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_socket",
            output_index: 0,
            summary_index: 0,
            delta: ".",
          },
          "response.reasoning_summary_text.delta",
        )
      return { after: index * 10_000, data }
    })
    // Bun fetch has its own 300s silent-body timeout independent of AbortSignal.
    // node:http with an explicit outer deadline observes the server's lifetime.
    const { body, longestSilenceMs } = await new Promise<{
      body: string
      longestSilenceMs: number
    }>((resolve, reject) => {
      let body = ""
      let lastChunk = Date.now()
      let longestSilenceMs = 0
      const client = httpRequest(
        new URL("/v1/messages", origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          response.setTimeout(0)
          assert.equal(response.statusCode, 200)
          response.setEncoding("utf8")
          response.on("data", (chunk: string) => {
            longestSilenceMs = Math.max(
              longestSilenceMs,
              Date.now() - lastChunk,
            )
            lastChunk = Date.now()
            body += chunk
          })
          response.on("error", reject)
          response.on("end", () => {
            clearTimeout(deadline)
            resolve({ body, longestSilenceMs })
          })
        },
      )
      client.setTimeout(0)
      const deadline = setTimeout(
        () =>
          client.destroy(new Error("450s local acceptance deadline exceeded")),
        450_000,
      )
      client.on("error", (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      client.end(
        JSON.stringify({
          model: "gpt-socket-responses",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 20,
          stream: true,
        }),
      )
    })
    assert.equal(terminalCount(body, "message_stop"), 1)
    await waitUntil(() => released === requests)
    await waitUntil(() =>
      upstreamBodies.every((upstreamBody) => !upstreamBody.locked),
    )
    assert.equal(requests, 1)
    assert.equal(disabled, 1)
    assert.ok(Date.now() - began >= 330_000)
    assert.ok(
      longestSilenceMs >= 320_000,
      "downstream must remain silent across the listener window",
    )
    checks.push(
      "330s reasoning-only stream crosses default 255s listener window",
    )
    console.log(
      JSON.stringify({
        elapsedMs: Date.now() - began,
        requests,
        released,
        terminalCount: terminalCount(body, "message_stop"),
        longestSilenceMs,
        checks,
      }),
    )
  } else {
    for (const route of routes) {
      await check(
        `${route.path} disables listener timeout before headers`,
        async () => {
          configure()
          headerDelay = 2400
          frames = [{ after: 0, data: route.terminal }]
          const before = disabled
          const response = await request(route)
          assert.equal(terminalCount(await response.text(), route.marker), 1)
          assert.equal(disabled, before + 1)
        },
      )
      await check(
        `${route.path} disables listener timeout before admission wait`,
        async () => {
          configure()
          state.rateLimitSeconds = 2.4
          state.rateLimitWait = true
          state.lastRequestTimestamp = Date.now()
          frames = [{ after: 0, data: route.terminal }]
          const before = disabled
          const pending = request(route)
          await Bun.sleep(100)
          assert.equal(
            disabled,
            before + 1,
            "listener timeout must be disabled while still queued",
          )
          const response = await pending
          assert.equal(terminalCount(await response.text(), route.marker), 1)
        },
      )
    }
    await check("non-streaming keeps listener timeout", async () => {
      configure()
      state.rateLimitSeconds = 1.6
      state.rateLimitWait = true
      state.lastRequestTimestamp = Date.now()
      const before = disabled
      assert.equal((await request(routes[0], false)).status, 200)
      assert.equal(disabled, before)
    })
    await check(
      "text, reasoning, tool, and usage events refresh upstream idle deadline",
      async () => {
        configure({ first: 200, idle: 200 })
        const activity = [
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "." },
          },
          {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "." },
          },
          {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
          { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
        ]
        frames = Array.from({ length: 10 }, (_, index) => ({
          after: index * 80,
          data: frame(
            activity[index % activity.length],
            activity[index % activity.length]?.type,
          ),
        }))
        frames.push({ after: 850, data: messageStop })
        assert.equal(
          terminalCount(await (await request()).text(), "message_stop"),
          1,
        )
      },
    )
    for (const phase of ["header", "first", "idle", "total"] as const) {
      await check(
        `${phase} deadline aborts and releases without successful terminal`,
        async () => {
          configure({ [phase]: 100 })
          if (phase === "header") headerDelay = 350
          finishBody = false
          if (phase === "idle")
            frames = [{ after: 0, data: frame({ type: "ping" }, "ping") }]
          if (phase === "total")
            frames = Array.from({ length: 12 }, (_, index) => ({
              after: index * 30,
              data: frame({ type: "ping" }, "ping"),
            }))
          const target = requests + 1
          const began = Date.now()
          let body = ""
          let status: number | undefined
          try {
            const response = await request()
            status = response.status
            body = await response.text()
          } catch (error) {
            assert.ok(error instanceof Error)
            assert.match(
              error.message,
              /abort|closed|terminated|socket|connection/i,
            )
          }
          assert.equal(
            requests,
            target,
            "timeout scenario must reach the upstream",
          )
          assert.ok(!body.includes("message_stop"))
          assert.ok(
            Date.now() - began < 1200,
            "must fail on the configured phase deadline",
          )
          if (phase === "header") assert.equal(status, 500)
          else if (status !== undefined) assert.equal(status, 200)
          await waitUntil(() => released >= target)
        },
      )
    }
    await check("client cancel before headers releases upstream", async () => {
      configure()
      headerDelay = 350
      finishBody = false
      const target = requests + 1
      const abort = new AbortController()
      const pending = request(routes[0], true, abort.signal)
      await waitUntil(() => requests >= target)
      abort.abort()
      await assert.rejects(pending)
      await waitUntil(() => released >= target)
    })
    await check("client cancel during SSE releases upstream", async () => {
      configure()
      finishBody = false
      frames = [{ after: 0, data: frame({ type: "ping" }, "ping") }]
      const target = requests + 1
      const abort = new AbortController()
      const response = await request(routes[0], true, abort.signal)
      assert.ok(response.body)
      const reader = response.body.getReader()
      await reader.read()
      abort.abort()
      await reader.cancel().catch(() => undefined)
      await waitUntil(() => released >= target)
    })
    await check("early terminal cancels unbounded upstream body", async () => {
      configure()
      finishBody = false
      frames = [{ after: 0, data: responseCompleted }]
      const target = requests + 1
      assert.ok(
        (await (await request(routes[1])).text()).includes(
          "response.completed",
        ),
      )
      await waitUntil(() => released >= target)
    })
    console.log(JSON.stringify({ requests, released, checks }))
  }
} finally {
  globalThis.fetch = nativeFetch
  await listener.close(true)
  await upstream.stop(true)
}
