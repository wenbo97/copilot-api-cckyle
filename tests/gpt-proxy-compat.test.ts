/* eslint-disable max-lines -- The six HTTP stories share one isolated provider fixture. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import consola from "consola"

import type { AnthropicStreamEventData } from "~/routes/messages/anthropic-types"
import type {
  ResponseStreamEvent,
  ResponseOutputReasoning,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
} from "~/routes/responses/responses-types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { state, type State } from "~/lib/state"
import { truncateToolName } from "~/routes/_shared/tool-name"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let previousState: State
let previousLevel: number
let previousEnvironment: Array<string | undefined>
const variables = [
  "COPILOT_CACHE_POLICY",
  "COPILOT_CACHE_DIAGNOSTICS",
  "COPILOT_FOREIGN_REASONING_MANIFEST",
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
]
const sent: Array<Record<string, unknown>> = []
let reply: (body: Record<string, unknown>) => Response
let providerSignal: AbortSignal | null | undefined

beforeEach(() => {
  previousState = { ...state }
  previousLevel = consola.level
  consola.level = -999
  previousEnvironment = variables.map((key) => process.env[key])
  for (const key of variables) Reflect.deleteProperty(process.env, key)
  process.env.COPILOT_CACHE_POLICY = "off"
  process.env.COPILOT_CACHE_DIAGNOSTICS = "0"
  sent.length = 0
  reply = () => {
    throw new Error("Unexpected provider request")
  }
  Object.assign(state, {
    copilotToken: "offline-test",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    accountType: "individual",
    manualApprove: false,
    traceEnabled: false,
    rateLimitSeconds: undefined,
    models: {
      object: "list",
      data: ["/chat/completions", "/responses", "/v1/messages"].map(
        (endpoint, index) => ({
          id: ["gpt-chat", "gpt-responses", "native-messages"][index],
          supported_endpoints: [endpoint],
          capabilities: {
            family: "test",
            limits: {},
            object: "model_capabilities",
            supports: {
              tool_calls: true,
              structured_outputs: true,
              reasoning_effort: ["low", "high"],
            },
            tokenizer: "test",
            type: "chat",
          },
          model_picker_enabled: true,
          name: "Offline",
          object: "model",
          preview: false,
          vendor: "test",
          version: "1",
        }),
      ),
    },
  })
  globalThis.fetch = Object.assign(
    (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Unexpected non-generation request")
      const body = JSON.parse(init.body) as Record<string, unknown>
      providerSignal = init.signal
      sent.push(body)
      return Promise.resolve(reply(body))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
  consola.level = previousLevel
  for (const [index, key] of variables.entries()) {
    const value = previousEnvironment[index]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function request(
  payload: Record<string, unknown>,
  ingress = "messages",
  signal?: AbortSignal,
) {
  return server.request(`http://localhost/v1/${ingress}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-chat",
      ...(ingress === "messages" ?
        {
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        }
      : { input: "hello", max_output_tokens: 100 }),
      ...payload,
    }),
    signal,
  })
}

function chunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chat_test",
    created: 1,
    model: "gpt-chat",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  }
}

function sse(frames: Array<unknown>) {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function messagesEvents(response: Response) {
  expect(response.status).toBe(200)
  return decodeSse<AnthropicStreamEventData>(await response.text())
}

function decodeSse<T>(text: string): Array<T> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as T)
}

function toolArguments(events: Array<AnthropicStreamEventData>) {
  const open = new Set<number>()
  const seen = new Set<number>()
  const tools = new Map<number, { id: string; name: string; args: string }>()
  for (const event of events) {
    switch (event.type) {
      case "content_block_start": {
        expect(open.size).toBe(0)
        expect(seen.has(event.index)).toBe(false)
        seen.add(event.index)
        open.add(event.index)
        if (event.content_block.type === "tool_use")
          tools.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: "",
          })

        break
      }
      case "content_block_delta": {
        expect(open.has(event.index)).toBe(true)
        if (event.delta.type === "input_json_delta") {
          const tool = tools.get(event.index)
          if (!tool) throw new Error("Arguments without tool start")
          tool.args += event.delta.partial_json
        }

        break
      }
      case "content_block_stop": {
        expect(open.delete(event.index)).toBe(true)

        break
      }
      case "message_stop": {
        expect(open.size).toBe(0)
        break
      }
      default: {
        break
      }
    }
  }
  expect(open.size).toBe(0)
  return [...tools.values()]
}

test("US1: interleaved tool arguments reach the CLI in complete sequential blocks", async () => {
  reply = () =>
    sse([
      chunk({ content: "Checking." }),
      chunk({
        content: "Still working",
        tool_calls: [
          {
            index: 0,
            id: "a",
            function: { name: "read_a", arguments: '{"path":' },
          },
          {
            index: 1,
            id: "b",
            function: { name: "read_b", arguments: '{"path":' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '"a"}' } },
          { index: 1, function: { arguments: '"b"}' } },
        ],
      }),
      chunk({}, "tool_calls"),
      {
        ...chunk({}),
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ])
  const events = await messagesEvents(await request({ stream: true }))
  expect(toolArguments(events)).toEqual([
    { id: "a", name: "read_a", args: '{"path":"a"}' },
    { id: "b", name: "read_b", args: '{"path":"b"}' },
  ])
  expect(events).toContainEqual({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { input_tokens: 10, output_tokens: 5 },
  })
})

test.each(["length", null] as const)(
  "US1: unfinished tools never become successful tool use (%s)",
  async (finish) => {
    reply = () =>
      sse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "a",
              function: { name: "read", arguments: '{"path":' },
            },
          ],
        }),
        ...(finish ? [chunk({}, finish)] : []),
      ])
    const events = await messagesEvents(await request({ stream: true }))
    expect(toolArguments(events)).toEqual([])
    if (finish)
      expect(events).toContainEqual({
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    else {
      expect(events.some((event) => event.type === "error")).toBe(true)
      expect(events.some((event) => event.type === "message_stop")).toBe(false)
    }
  },
)

test("US1: arguments before names, empty fragments and tool indices remain correlated", async () => {
  reply = () =>
    sse([
      chunk({
        tool_calls: [
          { index: 2, function: { arguments: '{"value":' } },
          { index: 0, id: "empty", function: { name: "noop", arguments: "" } },
        ],
      }),
      chunk({
        tool_calls: [{ index: 2, id: "second", function: { name: "read_" } }],
      }),
      chunk({
        tool_calls: [{ index: 2, function: { name: "file", arguments: "2}" } }],
      }),
      chunk({}, "tool_calls"),
    ])
  const events = await messagesEvents(await request({ stream: true }))
  expect(toolArguments(events)).toEqual([
    { id: "empty", name: "noop", args: "{}" },
    { id: "second", name: "read_file", args: '{"value":2}' },
  ])
})

test("US1: downstream cancellation abandons buffered tools and cancels upstream", async () => {
  reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          providerSignal?.addEventListener("abort", () => controller.close(), {
            once: true,
          })
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(chunk({ content: "Still working", tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "{" } }] }))}\n\n`,
            ),
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const controller = new AbortController()
  const response = await request(
    { stream: true },
    "messages",
    controller.signal,
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing response stream")
  let text = ""
  try {
    while (!text.includes("Still working")) {
      const result = await bounded(reader.read())
      if (result.done) throw new Error("Text stream ended early")
      text += new TextDecoder().decode(result.value)
    }
    expect(text).not.toContain('"type":"tool_use"')
    controller.abort()
    await bounded(reader.cancel())
    await Bun.sleep(20)
    expect(providerSignal?.aborted).toBe(true)
  } finally {
    controller.abort()
    await reader.cancel()
  }
})

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test stream did not settle.")),
          1000,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test.each(["messages", "responses"])(
  "US3: %s refusal-only and terminal precedence",
  async (ingress) => {
    for (const stream of [false, true]) {
      for (const finish of [
        "stop",
        "length",
        "content_filter",
        null,
      ] as const) {
        reply = () =>
          stream ?
            sse([
              chunk({ refusal: "Cannot " }),
              chunk({ refusal: "comply." }),
              ...(finish ? [chunk({}, finish)] : []),
            ])
          : chatReply({ refusal: "Cannot comply." }, finish ?? "stop")
        const response = await request({ stream }, ingress)
        if (ingress === "messages") {
          if (stream) {
            const events = await messagesEvents(response)
            expect(
              events
                .flatMap((event) =>
                  (
                    event.type === "content_block_delta"
                    && event.delta.type === "text_delta"
                  ) ?
                    [event.delta.text]
                  : [],
                )
                .join(""),
            ).toBe("Cannot comply.")
            expect(
              events.some(
                (event) =>
                  event.type === "message_delta"
                  && event.delta.stop_reason
                    === (finish === "length" ? "max_tokens" : "refusal"),
              ),
            ).toBe(Boolean(finish))
            expect(events.some((event) => event.type === "error")).toBe(!finish)
          } else
            expect(await response.json()).toMatchObject({
              content: [{ type: "text", text: "Cannot comply." }],
              stop_reason: finish === "length" ? "max_tokens" : "refusal",
            })
        } else if (stream) {
          const events = decodeSse<ResponseStreamEvent>(await response.text())
          expect(
            events
              .filter((event) => event.type === "response.refusal.delta")
              .map((event) => event.delta)
              .join(""),
          ).toBe("Cannot comply.")
          let terminalType: ResponseStreamEvent["type"] = "response.incomplete"
          if (!finish) terminalType = "response.failed"
          else if (finish === "stop") terminalType = "response.completed"
          expect(events.at(-1)?.type).toBe(terminalType)
        } else
          expect(await response.json()).toMatchObject({
            status:
              finish === "length" || finish === "content_filter" ?
                "incomplete"
              : "completed",
            output: [
              { content: [{ type: "refusal", refusal: "Cannot comply." }] },
            ],
          })
      }
    }
  },
)

test.each(["messages", "responses"])(
  "US3: %s refusal after finish is a protocol failure",
  async (ingress) => {
    reply = () =>
      sse([
        chunk({ content: "Text" }),
        chunk({}, "stop"),
        chunk({ refusal: "late" }),
      ])
    const response = await request({ stream: true }, ingress)
    if (ingress === "messages") {
      const events = await messagesEvents(response)
      expect(events.at(-1)?.type).toBe("error")
      expect(events.some((event) => event.type === "message_stop")).toBe(false)
    } else
      expect(
        decodeSse<ResponseStreamEvent>(await response.text()).at(-1)?.type,
      ).toBe("response.failed")
  },
)

const outputSchema = {
  type: "object",
  properties: {
    result: {
      type: ["string", "null"],
      enum: ["ok", null],
      description: "Result",
    },
    values: {
      type: ["array", "null"],
      items: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
    },
    nested: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  required: ["nested", "result", "values"],
  additionalProperties: false,
}

test.each(["gpt-chat", "gpt-responses"])(
  "US4: %s preserves strict output schema and effort",
  async (model) => {
    reply = () =>
      model === "gpt-chat" ? chatReply({ content: "{}" }) : responsesReply()
    const response = await request({
      model,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: outputSchema },
      },
    })
    expect(response.status).toBe(200)
    const format = {
      name: "messages_output",
      strict: true,
      schema: outputSchema,
    }
    expect(sent[0]).toMatchObject(
      model === "gpt-chat" ?
        {
          response_format: { type: "json_schema", json_schema: format },
          reasoning_effort: "high",
        }
      : {
          text: { format: { type: "json_schema", ...format } },
          reasoning: { effort: "high" },
        },
    )
  },
)

const invalidFormats: Array<[unknown, string, string]> = [
  [
    { type: "json_schema", schema: { $ref: "#/$defs/result" } },
    "unsupported_feature",
    "output_config.format.schema.$ref",
  ],
  [
    { type: "json_schema", schema: { anyOf: [{ type: "string" }] } },
    "unsupported_feature",
    "output_config.format.schema.anyOf",
  ],
  [
    { type: "json_schema", schema: { type: ["string", "integer"] } },
    "invalid_value",
    "output_config.format.schema.type",
  ],
  [null, "invalid_value", "output_config.format"],
  [
    { type: "json_schema", schema: [] },
    "invalid_value",
    "output_config.format.schema",
  ],
  [{ type: "text" }, "unsupported_feature", "output_config.format.type"],
  [
    { type: "json_schema", schema: { ...outputSchema, required: ["result"] } },
    "unsupported_feature",
    "output_config.format.schema.required",
  ],
  [
    {
      type: "json_schema",
      schema: { ...outputSchema, additionalProperties: true },
    },
    "unsupported_feature",
    "output_config.format.schema.additionalProperties",
  ],
  [
    {
      type: "json_schema",
      schema: { ...outputSchema, required: ["result", "result", "values"] },
    },
    "invalid_value",
    "output_config.format.schema.required",
  ],
  [
    {
      type: "json_schema",
      schema: {
        ...outputSchema,
        properties: { result: { type: "string", minLength: 1 } },
      },
    },
    "unsupported_feature",
    "output_config.format.schema.properties.result.minLength",
  ],
  [
    {
      type: "json_schema",
      schema: {
        ...outputSchema,
        properties: { result: { type: "array", items: [] } },
      },
    },
    "invalid_value",
    "output_config.format.schema.properties.result.items",
  ],
  [
    {
      type: "json_schema",
      schema: {
        ...outputSchema,
        properties: { result: { type: "string", enum: [1] } },
      },
    },
    "invalid_value",
    "output_config.format.schema.properties.result.enum",
  ],
]
for (const model of ["gpt-chat", "gpt-responses"]) {
  test.each(invalidFormats)(
    `US4: ${model} rejects unrepresentable output (%j)`,
    async (format, code, param) => {
      const response = await request({ model, output_config: { format } })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code, param } })
      expect(sent).toHaveLength(0)
    },
  )

  test.each([false, undefined])(
    `US4: ${model} requires advertised structured output (%s)`,
    async (capability) => {
      const selected = state.models?.data.find((item) => item.id === model)
      if (!selected) throw new Error("Missing model")
      selected.capabilities.supports.structured_outputs = capability
      const response = await request({
        model,
        output_config: {
          format: { type: "json_schema", schema: outputSchema },
        },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported_feature", param: "output_config.format" },
      })
      expect(sent).toHaveLength(0)
    },
  )
}

test("US4: native Messages retains provider-specific format without GPT validation", async () => {
  reply = () =>
    Response.json({
      id: "native",
      type: "message",
      role: "assistant",
      content: [],
      model: "native-messages",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  const format = {
    type: "json_schema",
    schema: { type: "string", minLength: 1 },
  }
  const response = await request({
    model: "native-messages",
    output_config: { format },
  })
  expect(response.status).toBe(200)
  expect(sent[0]).toMatchObject({ output_config: { format } })
})

for (const model of ["gpt-chat", "gpt-responses"]) {
  test(`US5: ${model} keeps serial-only independent of selection and capability`, async () => {
    const name = "long_forced_tool_".repeat(6)
    reply = () =>
      model === "gpt-chat" ? chatReply({ content: "ok" }) : responsesReply()
    for (const parallelCapability of [undefined, false]) {
      const selected = state.models?.data.find((item) => item.id === model)
      if (!selected) throw new Error("Missing model")
      selected.capabilities.supports.parallel_tool_calls = parallelCapability
      for (const type of ["auto", "any", "tool", "none"]) {
        for (const disable of [true, false, undefined]) {
          const response = await request({
            model,
            tools: [{ name, input_schema: { type: "object" } }],
            tool_choice: {
              type,
              ...(type === "tool" ? { name } : {}),
              disable_parallel_tool_use: disable,
            },
          })
          expect(response.status).toBe(200)
          expect(sent.at(-1)?.parallel_tool_calls).toBe(
            disable ? false : undefined,
          )
          const forced =
            model === "gpt-chat" ?
              { type: "function", function: { name: truncateToolName(name) } }
            : { type: "function", name: truncateToolName(name) }
          const selection = type === "any" ? "required" : type
          expect(sent.at(-1)?.tool_choice).toEqual(
            type === "tool" ? forced : selection,
          )
        }
      }
    }
  })
  test.each([null, 1, "true"])(
    `US5: ${model} rejects invalid serial control (%s)`,
    async (disable) => {
      const response = await request({
        model,
        tool_choice: { type: "auto", disable_parallel_tool_use: disable },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {
          code: "invalid_value",
          param: "tool_choice.disable_parallel_tool_use",
        },
      })
      expect(sent).toHaveLength(0)
    },
  )
  test(`US5: ${model} forwards serial-control rejection without permissive retry`, async () => {
    reply = () =>
      Response.json(
        {
          error: { message: "Provider cannot apply parallel_tool_calls=false" },
        },
        { status: 422 },
      )
    const response = await request({
      model,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
    expect(response.status).toBe(422)
    expect(await response.text()).toContain("Provider cannot apply")
    expect(sent).toHaveLength(1)
    expect(sent[0].parallel_tool_calls).toBe(false)
  })
}

test.each(["completed", "incomplete", "failed", "eof"] as const)(
  "US6: native identity anchors survive %s",
  async (status) => {
    const reasoning: ResponseOutputReasoning = {
      id: "reason_original",
      type: "reasoning",
      content: [],
      encrypted_content: "opaque_ciphertext",
    }
    const call: ResponseOutputFunctionCall = {
      id: "tool_original",
      type: "function_call",
      call_id: "call_stable",
      name: "read",
      arguments: '{"id":"nested_untouched"}',
      status: "completed",
    }
    const unanchored: ResponseOutputMessage = {
      id: "unanchored",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello" }],
    }
    const snapshot = {
      id: "response_stable",
      object: "response",
      created_at: 1,
      model: "gpt-responses",
      status: "in_progress",
      output: [],
      metadata: { id: "metadata_untouched" },
    }
    reply = () =>
      sse([
        { type: "response.created", response: snapshot },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: reasoning,
        },
        { type: "response.output_item.added", output_index: 1, item: call },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...call, id: "repeated_drift" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "delta_drift",
          delta: call.arguments,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...reasoning, id: "reason_done_drift" },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { ...call, id: "tool_done_drift" },
        },
        ...(status === "eof" ?
          []
        : [
            {
              type: `response.${status}`,
              response: {
                ...snapshot,
                status,
                output: [
                  { ...reasoning, id: "reason_terminal_drift" },
                  { ...call, id: "tool_terminal_drift" },
                  unanchored,
                ],
              },
            },
          ]),
      ])
    const response = await request(
      { model: "gpt-responses", stream: true },
      "responses",
    )
    expect(response.status).toBe(200)
    const events = decodeSse<ResponseStreamEvent>(await response.text())
    expect(
      events
        .filter((event) => event.type === "response.output_item.added")
        .map((event) => event.item.id),
    ).toEqual(["reason_original", "tool_original", "tool_original"])
    expect(
      events.filter(
        (event) => event.type === "response.function_call_arguments.delta",
      ),
    ).toMatchObject([{ item_id: "tool_original" }])
    const terminal = events.at(-1)
    if (!terminal || !("response" in terminal))
      throw new Error("Missing terminal response")
    expect(terminal.response.id).toBe("response_stable")
    expect(terminal.response.output.slice(0, 2)).toEqual([reasoning, call])
    expect(terminal.response.metadata).toEqual(snapshot.metadata)
    if (status !== "eof")
      expect(terminal.response.output[2]).toEqual(unanchored)
    else expect(terminal.type).toBe("response.failed")
  },
)

function responsesReply(
  output: Array<Record<string, unknown>> = [
    {
      id: "m",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "{}" }],
    },
  ],
) {
  return Response.json({
    id: "r",
    object: "response",
    created_at: 1,
    model: "gpt-responses",
    status: "completed",
    output,
  })
}

function chatReply(message: Record<string, unknown>, finishReason = "stop") {
  return Response.json({
    id: "chat_test",
    object: "chat.completion",
    created: 1,
    model: "gpt-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, ...message },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

test.each([false, true])(
  "US2: Chat long names round trip in JSON/SSE (%s)",
  async (stream) => {
    const name = "read_file_".repeat(10)
    const alias = truncateToolName(name)
    reply = () =>
      stream ?
        sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "new",
                function: { name: alias, arguments: "{}" },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ])
      : chatReply(
          {
            tool_calls: [
              {
                id: "new",
                type: "function",
                function: { name: alias, arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        )
    const response = await request({
      stream,
      tools: [{ name, input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "old", name, input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "old", content: "ok" }],
        },
      ],
    })
    expect(sent[0]).toMatchObject({
      tools: [{ function: { name: alias } }],
      tool_choice: { function: { name: alias } },
      messages: [
        { tool_calls: [{ function: { name: alias } }] },
        { tool_call_id: "old" },
      ],
    })
    if (stream)
      expect(toolArguments(await messagesEvents(response))[0]?.name).toBe(name)
    else
      expect(await response.json()).toMatchObject({
        content: [{ type: "tool_use", name }],
      })
  },
)

test.each(["gpt-chat", "gpt-responses"])(
  "US2: alias collisions fail locally (%s)",
  async (model) => {
    const name = "long_tool_".repeat(10)
    const response = await request({
      model,
      tools: [
        { name, input_schema: { type: "object" } },
        { name: truncateToolName(name), input_schema: { type: "object" } },
      ],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "tool_name_collision" },
    })
    expect(sent).toHaveLength(0)
  },
)

test.each([false, true])(
  "US2: Responses long-name wire identities and replies (%s)",
  async (stream) => {
    const name = "responses_tool_".repeat(8)
    const alias = truncateToolName(name)
    const tool = {
      id: "f",
      type: "function_call",
      call_id: "new",
      name: alias,
      arguments: "{}",
      status: "completed",
    }
    reply = () =>
      stream ?
        sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...tool, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "f",
            delta: "{}",
          },
          { type: "response.output_item.done", output_index: 0, item: tool },
          {
            type: "response.completed",
            response: {
              id: "r",
              model: "gpt-responses",
              status: "completed",
              output: [tool],
            },
          },
        ])
      : responsesReply([tool])
    const response = await request({
      model: "gpt-responses",
      stream,
      tools: [{ name, input_schema: {} }],
      tool_choice: { type: "tool", name },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "old", name, input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "old", content: "ok" }],
        },
      ],
    })
    expect(sent[0]).toMatchObject({
      tools: [{ name: alias }],
      tool_choice: { name: alias },
      input: [
        { type: "function_call", name: alias },
        { type: "function_call_output", call_id: "old" },
      ],
    })
    if (stream)
      expect(toolArguments(await messagesEvents(response))[0]?.name).toBe(name)
    else
      expect(await response.json()).toMatchObject({
        content: [{ type: "tool_use", name }],
      })
  },
)

test("US2: concurrent maps never restore another request's original name", async () => {
  const long = "isolated_".repeat(10)
  const alias = truncateToolName(long)
  reply = () =>
    chatReply(
      {
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: { name: alias, arguments: "{}" },
          },
        ],
      },
      "tool_calls",
    )
  const results = await Promise.all(
    [long, alias].map(async (name) => {
      const response = await request({ tools: [{ name, input_schema: {} }] })
      return response.json() as Promise<{ content: Array<{ name: string }> }>
    }),
  )
  expect(results.map((result) => result.content[0].name)).toEqual([long, alias])
})

for (const ingress of ["messages", "responses"]) {
  for (const stream of [false, true]) {
    test.each([null, "", "No."])(
      `US3: ${ingress} refusal-only and mixed content, stream=${stream}, refusal=%s`,
      async (refusal) => {
        reply = () =>
          stream ?
            sse([
              {
                ...chunk({ content: "Visible. " }),
                choices: [
                  {
                    index: 0,
                    delta: { content: "Visible. ", refusal },
                    finish_reason: null,
                  },
                ],
              },
              chunk({}, "stop"),
              {
                ...chunk({}),
                choices: [],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              },
            ])
          : chatReply({ content: "Visible. ", refusal })
        const response = await request(
          {
            stream,
            ...(ingress === "responses" ?
              { input: "hello", messages: undefined }
            : {}),
          },
          ingress,
        )
        if (ingress === "messages") {
          if (stream) {
            const events = await messagesEvents(response)
            const text = events
              .flatMap((event) =>
                (
                  event.type === "content_block_delta"
                  && event.delta.type === "text_delta"
                ) ?
                  [event.delta.text]
                : [],
              )
              .join("")
            expect(text).toBe("Visible. " + (refusal ?? ""))
            expect(events).toContainEqual({
              type: "message_delta",
              delta: {
                stop_reason: refusal ? "refusal" : "end_turn",
                stop_sequence: null,
              },
              usage: { input_tokens: 10, output_tokens: 5 },
            })
          } else {
            const result = (await response.json()) as {
              content: Array<{ text: string }>
              stop_reason: string
            }
            expect(result.content.map((part) => part.text).join("")).toBe(
              "Visible. " + (refusal ?? ""),
            )
            expect(result.stop_reason).toBe(refusal ? "refusal" : "end_turn")
          }
        } else if (stream) {
          const events = decodeSse<ResponseStreamEvent>(await response.text())
          expect(
            events
              .filter((event) => event.type === "response.refusal.delta")
              .map((event) => event.delta)
              .join(""),
          ).toBe(refusal ?? "")
          const terminal = events.find(
            (event) => event.type === "response.completed",
          )
          expect(terminal?.response.output[0]).toMatchObject({
            content: [
              { type: "output_text", text: "Visible. " },
              ...(refusal ? [{ type: "refusal", refusal }] : []),
            ],
          })
          expect(terminal?.response.usage).toMatchObject({
            input_tokens: 10,
            output_tokens: 5,
          })
        } else {
          expect(await response.json()).toMatchObject({
            status: "completed",
            output: [
              {
                content: [
                  { type: "output_text", text: "Visible. " },
                  ...(refusal ? [{ type: "refusal", refusal }] : []),
                ],
              },
            ],
          })
        }
      },
    )
  }
}
