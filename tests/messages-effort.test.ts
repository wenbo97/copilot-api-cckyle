import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let previousState: State
let sent: Record<string, unknown>

beforeEach(() => {
  previousState = { ...state }
  sent = {}
  state.copilotToken = "offline-fixture"
  state.copilotTokenExpiresAt = Date.now() / 1000 + 3600
  state.rateLimitSeconds = undefined
  state.manualApprove = false
  selectModel("/responses")
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve()
      if (typeof init?.body !== "string") throw new Error("Unexpected fetch")
      sent = JSON.parse(init.body) as Record<string, unknown>
      const endpoint = new URL(
        input instanceof Request ? input.url : String(input),
      ).pathname
      const snapshot = {
        id: "resp_fixture",
        object: "response",
        status: "completed",
        created_at: 1,
        model: "effort-fixture",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "effort-fixture",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
      const chat = {
        id: "chat_fixture",
        object: "chat.completion",
        created: 1,
        model: "effort-fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "READY" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
      const replies: Record<string, unknown> = {
        "/responses": snapshot,
        "/v1/messages": message,
        "/chat/completions": chat,
      }
      if (!sent.stream) return Response.json(replies[endpoint])
      const byEndpoint: Record<string, Array<unknown>> = {
        "/responses": [
          {
            type: "response.created",
            sequence_number: 0,
            response: { ...snapshot, status: "in_progress" },
          },
          {
            type: "response.completed",
            sequence_number: 1,
            response: snapshot,
          },
        ],
        "/v1/messages": [
          { type: "message_start", message },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ],
        "/chat/completions": [
          {
            ...chat,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: "READY" }, finish_reason: "stop" },
            ],
          },
        ],
      }
      const frames = byEndpoint[endpoint]
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
          + (endpoint === "/chat/completions" ? "data: [DONE]\n\n" : ""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
})

function selectModel(endpoint: string, efforts = ["low", "medium", "high"]) {
  const model: Model = {
    id: "effort-fixture",
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
      limits: { max_output_tokens: 4096 },
      supports: { reasoning_effort: efforts },
    },
  }
  state.models = { object: "list", data: [model] }
}

async function request(settings: Record<string, unknown>) {
  return server.request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "effort-fixture",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Reply READY" }],
      ...settings,
    }),
  })
}

test("adaptive Messages forwards explicit low to Responses", async () => {
  const response = await request({
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(sent.reasoning).toEqual({ effort: "low" })
})

test("native Responses preserves long scalar and equivalent message-array text at egress", async () => {
  const text = `ALPHA17\n${"fixed filler\n".repeat(4000)}BETA25`
  for (const input of [text, [{ role: "user", content: text }]]) {
    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "effort-fixture",
        input,
        reasoning: { effort: "low" },
        max_output_tokens: 1024,
      }),
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(sent.input).toEqual(input)
  }
})

for (const endpoint of ["/responses", "/chat/completions", "/v1/messages"]) {
  for (const stream of [false, true]) {
    for (const thinking of [
      undefined,
      { type: "adaptive" },
      { type: "disabled" },
      { type: "enabled", budget_tokens: 3900 },
    ]) {
      test(`${endpoint} stream=${stream} preserves explicit low with ${thinking?.type ?? "absent"} thinking`, async () => {
        selectModel(endpoint)
        const response = await request({
          thinking,
          stream,
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: { type: "object" } },
          },
        })
        expect(response.status).toBe(200)
        const body = await response.text()
        if (stream) expect(body).toContain("message_stop")
        if (endpoint === "/responses")
          expect(sent.reasoning).toEqual({ effort: "low" })
        else if (endpoint === "/chat/completions")
          expect(sent.reasoning_effort).toBe("low")
        else
          expect(sent.output_config).toEqual({
            effort: "low",
            format: { type: "json_schema", schema: { type: "object" } },
          })
      })
    }
  }
}

test("explicit effort clamps down without raising unsupported low", async () => {
  selectModel("/responses", ["medium", "high"])
  const rejected = await request({ output_config: { effort: "low" } })
  expect(rejected.status).toBe(400)
  expect(await rejected.text()).toContain("output_config.effort")
  expect(sent).toEqual({})
  const accepted = await request({ output_config: { effort: "max" } })
  expect(accepted.status).toBe(200)
  await accepted.text()
  expect(sent.reasoning).toEqual({ effort: "high" })
})

test("missing catalog effort set preserves explicit effort", async () => {
  selectModel("/responses", [])
  const response = await request({ output_config: { effort: "low" } })
  expect(response.status).toBe(200)
  await response.text()
  expect(sent.reasoning).toEqual({ effort: "low" })
})

test("invalid explicit effort cannot fall back to a budget or reach upstream", async () => {
  for (const output_config of [
    { effort: "adaptive" },
    { effort: null },
    { effort: 1 },
    null,
    [],
  ]) {
    const response = await request({
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config,
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("output_config")
    expect(sent).toEqual({})
  }
})

test("legacy budget and unspecified defaults remain intact", async () => {
  for (const [settings, expected] of [
    [{ thinking: { type: "enabled", budget_tokens: 1024 } }, { effort: "low" }],
    [{ thinking: { type: "adaptive" } }, undefined],
    [{}, undefined],
  ] as const) {
    const response = await request(settings)
    expect(response.status).toBe(200)
    await response.text()
    expect(sent.reasoning).toEqual(expected)
  }
})
