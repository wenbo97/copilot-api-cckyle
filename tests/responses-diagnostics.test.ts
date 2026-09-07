import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { ResponsesPayload } from "~/routes/responses/responses-types"

import { ResponsesDiagnostics } from "~/lib/responses-diagnostics"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch
const originalEnv = process.env.COPILOT_CACHE_DIAGNOSTICS
const originalState = { ...state }
let info: ReturnType<typeof captureInfo>
const silentLog = Object.assign(() => undefined, { raw: () => undefined })

function captureInfo() {
  return spyOn(consola, "info").mockImplementation(silentLog)
}

beforeEach(() => {
  info = captureInfo()
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  state.copilotToken = "offline-credential-must-not-be-logged"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
})

afterEach(() => {
  info.mockRestore()
  globalThis.fetch = originalFetch
  if (originalEnv === undefined) delete process.env.COPILOT_CACHE_DIAGNOSTICS
  else process.env.COPILOT_CACHE_DIAGNOSTICS = originalEnv
  Object.assign(
    state,
    { copilotToken: undefined, copilotTokenExpiresAt: undefined },
    originalState,
  )
})

function logs(): Array<Record<string, unknown>> {
  return info.mock.calls
    .map(([message]): unknown => message)
    .filter(
      (message): message is string =>
        typeof message === "string"
        && message.startsWith("[cache-diagnostics] "),
    )
    .map(
      (message) =>
        JSON.parse(message.slice("[cache-diagnostics] ".length)) as Record<
          string,
          unknown
        >,
    )
}

function nativeResponse(usage?: unknown) {
  return {
    id: "opaque-response-fixture",
    object: "response",
    model: "gpt-6-astra",
    status: "completed",
    output: [],
    usage,
  }
}

describe("passive native Responses cache diagnostics", () => {
  test("is disabled by default", () => {
    delete process.env.COPILOT_CACHE_DIAGNOSTICS
    expect(
      ResponsesDiagnostics.start({
        ingress: {},
        egress: {},
        serializedBody: "{}",
      }),
    ).toBeUndefined()
    expect(logs()).toEqual([])
  })

  test("observes the actual transformed body without changing requests or usage", async () => {
    const payload: ResponsesPayload = {
      model: "gpt-6-astra",
      input: "私有上下文-must-not-be-logged",
      prompt_cache_key: "private-cache-key",
      tools: [
        { type: "function", name: "tool", description: "", parameters: {} },
      ],
    }
    const upstream = {
      ...nativeResponse({
        input_tokens: 10000,
        input_tokens_details: { cached_tokens: 9000, cache_write_tokens: 500 },
        output_tokens: 20,
      }),
      copilot_usage: { total_nano_aiu: 12345 },
    }
    const sent: Array<string> = []
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected a serialized request")
      sent.push(init.body)
      return Promise.resolve(Response.json(upstream))
    }) as unknown as typeof fetch

    const result: unknown = await createResponses(payload)
    delete process.env.COPILOT_CACHE_DIAGNOSTICS
    const withoutDiagnostics: unknown = await createResponses(payload)
    expect(withoutDiagnostics).toEqual(result)
    expect(result).toEqual(upstream)
    expect(sent[0]).toBe(sent[1])
    expect(payload.tools?.[0]).toMatchObject({ description: "" })
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toMatchObject({
      model: "gpt-6-astra",
      route: "/responses",
      correlation: "uncorrelated",
      request_role: "unknown",
      input_tokens: 10000,
      cached_input_tokens: 9000,
      cache_write_tokens: 500,
      cache_hit_ratio: 0.9,
      usage_complete: true,
      copilot_nano_aiu: 12345,
      upstream_attempts: 1,
      ttft_ms: null,
      request_body_bytes: Buffer.byteLength(sent[0], "utf8"),
      outcome: "completed",
    })
    expect(logs()[0].ingress_fingerprints).not.toEqual(
      logs()[0].egress_fingerprints,
    )
    const text = JSON.stringify(logs())
    for (const secret of [
      payload.input,
      payload.prompt_cache_key,
      state.copilotToken,
      upstream.id,
    ]) {
      if (typeof secret === "string") expect(text).not.toContain(secret)
    }
  })
})

describe("native usage and stream summaries", () => {
  test.each([
    { usage: undefined, cached: null, complete: false },
    { usage: { input_tokens: 100 }, cached: null, complete: false },
    {
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 } },
      cached: 0,
      complete: true,
    },
    {
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 101 },
      },
      cached: null,
      complete: false,
    },
    {
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: -1 } },
      cached: null,
      complete: false,
    },
  ])(
    "distinguishes unknown, zero, and invalid cache counts",
    ({ usage, cached, complete }) => {
      const observer = ResponsesDiagnostics.start({
        ingress: {},
        egress: {},
        serializedBody: "{}",
      })
      observer?.observeResponse(nativeResponse(usage))
      observer?.finish()
      observer?.finish()
      expect(logs()).toHaveLength(1)
      expect(logs()[0]).toMatchObject({
        cached_input_tokens: cached,
        usage_complete: complete,
      })
    },
  )

  test("preserves SSE data and emits one summary from terminal usage", async () => {
    const frames = [
      {
        type: "response.created",
        response: { ...nativeResponse(), status: "in_progress" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "private reasoning",
      },
      { type: "response.output_text.delta", delta: "private answer" },
      {
        type: "response.completed",
        response: nativeResponse({
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 2,
        }),
      },
    ].map((event) => JSON.stringify(event))
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch

    const result = await createResponses({
      model: "gpt-6-astra",
      input: "private prompt",
      stream: true,
    })
    if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
    const forwarded = []
    for await (const event of result) forwarded.push(event.data)
    expect(forwarded).toEqual(frames)
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toMatchObject({
      cached_input_tokens: 80,
      cache_hit_ratio: 0.8,
      outcome: "completed",
    })
    expect(logs()[0].ttft_ms).toBeNumber()
    expect(JSON.stringify(logs())).not.toContain("private")
  })

  test("times custom tool input without counting reasoning or empty deltas", async () => {
    const clock = spyOn(performance, "now").mockReturnValue(1000)
    const frames = [
      { type: "response.created" },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "private reasoning",
      },
      { type: "response.custom_tool_call_input.delta", delta: "" },
      {
        type: "response.custom_tool_call_input.delta",
        delta: "private tool input",
      },
      { type: "response.custom_tool_call_input.delta", delta: " continued" },
      {
        type: "response.completed",
        response: nativeResponse({
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 2,
        }),
      },
    ].map((event) => JSON.stringify(event))
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch

    try {
      const result = await createResponses({
        model: "gpt-6-astra",
        input: "private prompt",
        stream: true,
      })
      if (!(Symbol.asyncIterator in result)) throw new Error("Expected SSE")
      const forwarded = []
      for await (const event of result) {
        forwarded.push(event.data)
        clock.mockReturnValue(1000 + forwarded.length * 100)
      }
      expect(forwarded).toEqual(frames)
      expect(logs()).toHaveLength(1)
      expect(logs()[0]).toMatchObject({
        ttft_ms: 300,
        cached_input_tokens: 80,
        outcome: "completed",
      })
      expect(JSON.stringify(logs())).not.toContain("private")
    } finally {
      clock.mockRestore()
    }
  })

  test("records the screenshot error as unknown usage, with one attempt", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: "input item does not belong to this connection",
              code: "",
            },
          },
          { status: 401 },
        ),
      ),
    ) as unknown as typeof fetch

    const error = await createResponses({
      model: "gpt-5.6-sol-fast",
      input: "private",
    }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "copilot_input_connection_mismatch" })
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toMatchObject({
      outcome: "error",
      upstream_http_status: 401,
      upstream_attempts: 1,
      error_code: "copilot_input_connection_mismatch",
      usage_complete: false,
      input_tokens: null,
      cached_input_tokens: null,
      cache_hit_ratio: null,
    })
  })

  test("does not treat an early consumer close as a successful response", async () => {
    const observer = ResponsesDiagnostics.start({
      ingress: {},
      egress: {},
      serializedBody: "{}",
    })
    if (!observer) throw new Error("Expected diagnostics")
    for await (const _event of observer.iterate(incompleteSource())) break
    expect(logs()[0]).toMatchObject({
      outcome: "stream_ended_without_terminal",
      usage_complete: false,
      ttft_ms: null,
    })
  })
})

async function* incompleteSource() {
  yield await Promise.resolve({
    data: JSON.stringify({ type: "response.created" }),
  })
  yield { data: "[DONE]" }
}
