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

import {
  ResponsesDiagnostics,
  responsesDiagnosticOrigin,
} from "~/lib/responses-diagnostics"
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

test("Messages ingress fingerprints include system and fixed thinking configuration", () => {
  const base = {
    model: "gpt-6-astra",
    system: "synthetic-private-system-a",
    tools: [{ name: "synthetic_tool", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "synthetic-question-a" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  }
  for (const ingress of [
    base,
    { ...base, system: "synthetic-private-system-b" },
    { ...base, output_config: { effort: "high" } },
    { ...base, messages: [{ role: "user", content: "synthetic-question-b" }] },
  ]) {
    ResponsesDiagnostics.start({
      ingress,
      egress: { model: "gpt-6-astra", input: "Synthetic transformed request" },
      origin: responsesDiagnosticOrigin("messages", ingress),
    })?.finish()
  }
  const [first, changedSystem, changedEffort, changedQuestion] = logs()
  expect(first.ingress_static_prefix).not.toEqual(
    changedSystem.ingress_static_prefix,
  )
  expect(first.ingress_static_prefix).not.toEqual(
    changedEffort.ingress_static_prefix,
  )
  expect(first.ingress_static_prefix).toEqual(
    changedQuestion.ingress_static_prefix,
  )
  expect(first.ingress_fingerprints).not.toEqual(
    changedQuestion.ingress_fingerprints,
  )
  const serialized = JSON.stringify(logs())
  expect(serialized).not.toContain("synthetic-private-system")
  expect(serialized).not.toContain("synthetic-question")
})

test("a Messages system block array without tools still has an observable static prefix", () => {
  const ingress = {
    model: "gpt-6-astra",
    system: [{ type: "text", text: "synthetic-private-system-block" }],
    messages: [{ role: "user", content: "Synthetic dynamic question" }],
  }
  ResponsesDiagnostics.start({
    ingress,
    egress: { model: "gpt-6-astra", input: "Synthetic transformed request" },
    origin: responsesDiagnosticOrigin("messages", ingress),
  })?.finish()
  const prefix = logs()[0].ingress_static_prefix
  expect(prefix).toHaveProperty("input_form", "array")
  expect(prefix).toHaveProperty("boundary", "before_dynamic_input")
  expect(prefix).toHaveProperty("fingerprint")
  expect(JSON.stringify(prefix)).not.toContain('"fingerprint":null')
  expect(JSON.stringify(logs())).not.toContain("synthetic-private-system-block")
})

test("bounds original caller marker paths and ignores cache-looking schema properties", () => {
  const payload = {
    model: "gpt-5.6-luna",
    tools: [
      {
        name: "read",
        input_schema: {
          type: "object",
          properties: { cache_control: { type: "string" } },
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: Array.from({ length: 40 }, () => ({
          type: "text",
          text: "private-text",
          cache_control: { type: "ephemeral" },
        })),
      },
    ],
  }
  ResponsesDiagnostics.start({
    ingress: payload,
    egress: { model: payload.model, input: [] },
    origin: responsesDiagnosticOrigin("messages", payload),
  })?.finish()
  expect(logs()[0].cache_intent).toMatchObject({
    marker_count: 40,
    truncated: true,
    malformed_or_unknown: false,
  })
  const intent = logs()[0].cache_intent as { paths: Array<string> }
  expect(intent.paths).toHaveLength(32)
  expect(intent.paths.at(-1)).toBe("messages[0].content[31].cache_control")
  expect(JSON.stringify(logs())).not.toContain("private-")
})

describe("passive native Responses cache diagnostics", () => {
  test("distinguishes preserved static prefixes from changed dynamic suffixes", () => {
    const base = {
      model: "gpt-5.6-luna",
      instructions: "private stable instructions",
      tools: [{ type: "function", name: "private_tool", parameters: {} }],
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: "private system" },
        { role: "developer", content: "private stable prefix" },
        { role: "user", content: "private dynamic question" },
      ],
    }
    const suffix = {
      ...base,
      input: [
        ...base.input.slice(0, 2),
        { role: "user", content: "new suffix" },
      ],
    }
    const changedPrefix = {
      ...base,
      input: [
        base.input[0],
        { role: "developer", content: "changed prefix" },
        base.input[2],
      ],
    }
    for (const payload of [
      base,
      suffix,
      changedPrefix,
      { ...base, tools: [] },
    ]) {
      ResponsesDiagnostics.start({
        ingress: payload,
        egress: payload,
        serializedBody: JSON.stringify(payload),
      })?.finish()
    }
    const [first, second, third, fourth] = logs()
    expect(first.egress_static_prefix).toMatchObject({
      input_items: 2,
      boundary: "before_dynamic_input",
      scope: "process",
    })
    expect(first.egress_static_prefix).toEqual(second.egress_static_prefix)
    expect(first.egress_fingerprints).not.toEqual(second.egress_fingerprints)
    expect(first.egress_static_prefix).not.toEqual(third.egress_static_prefix)
    expect(first.egress_static_prefix).not.toEqual(fourth.egress_static_prefix)
    expect(JSON.stringify(logs())).not.toContain("private")
    expect(base.input[2].content).toBe("private dynamic question")
  })

  test("keeps scalar and message-array prefix observations distinct", () => {
    const base = { model: "gpt-5.6-luna", instructions: "static instructions" }
    for (const input of ["question", [{ role: "user", content: "question" }]]) {
      const payload = { ...base, input }
      ResponsesDiagnostics.start({
        ingress: payload,
        egress: payload,
        serializedBody: JSON.stringify(payload),
      })?.finish()
    }
    expect(logs()[0].egress_static_prefix).toMatchObject({
      input_form: "string",
      input_items: 0,
    })
    expect(logs()[1].egress_static_prefix).toMatchObject({
      input_form: "array",
      input_items: 0,
    })
    expect(logs()[0].egress_static_prefix).not.toEqual(
      logs()[1].egress_static_prefix,
    )
  })

  test("does not call assistant or tool history a leading static prefix", () => {
    const payload = {
      input: [
        { role: "developer", content: "static" },
        { type: "function_call_output", call_id: "opaque", output: "dynamic" },
        { role: "developer", content: "later dynamic instructions" },
      ],
    }
    ResponsesDiagnostics.start({
      ingress: payload,
      egress: payload,
      serializedBody: JSON.stringify(payload),
    })?.finish()
    expect(logs()[0].egress_static_prefix).toMatchObject({
      input_items: 1,
      boundary: "before_dynamic_input",
    })
  })

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
      input: "private-context-must-not-be-logged",
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

test("a completed-looking snapshot on a nonterminal frame does not complete an attempt", () => {
  const payload = { model: "gpt-6-astra", input: "question", stream: true }
  const diagnostics = ResponsesDiagnostics.start({
    ingress: payload,
    egress: payload,
  })
  if (!diagnostics) throw new Error("Expected enabled diagnostics")
  const observer = diagnostics.attemptObserver()
  observer.start(JSON.stringify(payload), "initial")
  observer.headers(200)
  observer.value({ type: "response.created", response: nativeResponse() })
  diagnostics.finish()
  expect(logs()[0]).toMatchObject({
    attempt_details: [{ outcome: "stream_ended_without_terminal" }],
  })
})

test("caps attempt details without losing the total or overwriting the last retained attempt", () => {
  const payload = { model: "gpt-6-astra", input: "private-bounded-fixture" }
  const diagnostics = ResponsesDiagnostics.start({
    ingress: payload,
    egress: payload,
    serializedBody: JSON.stringify(payload),
  })
  if (!diagnostics) throw new Error("Expected enabled diagnostics")
  const observer = diagnostics.attemptObserver()
  for (let index = 0; index < 17; index++) {
    observer.start(JSON.stringify(payload), "initial")
    observer.headers(index === 16 ? 503 : 200)
    observer.value(
      nativeResponse({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 2,
      }),
    )
  }
  diagnostics.finish()
  diagnostics.finish()
  expect(logs()).toHaveLength(1)
  expect(logs()[0]).toMatchObject({
    upstream_attempts: 17,
    attempt_details_truncated: true,
  })
  const details = logs()[0].attempt_details as Array<Record<string, unknown>>
  expect(details).toHaveLength(16)
  expect(details.at(-1)).toMatchObject({
    attempt_index: 16,
    http_status: 200,
    outcome: "completed",
    cached_input_tokens: 80,
  })
  expect(JSON.stringify(logs())).not.toContain("private-")
})
