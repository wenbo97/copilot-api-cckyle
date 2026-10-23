import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalDiagnostics = process.env.COPILOT_CACHE_DIAGNOSTICS
let previousState: State

beforeEach(() => {
  previousState = { ...state }
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  Object.assign(state, {
    copilotToken: "offline-credential",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    rateLimitSeconds: undefined,
    manualApprove: false,
    traceEnabled: false,
    models: {
      object: "list",
      data: [
        {
          id: "claude-fixture",
          name: "Fixture",
          object: "model",
          model_picker_enabled: false,
          preview: false,
          vendor: "synthetic",
          version: "1",
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "fixture",
            type: "chat",
            object: "model_capabilities",
            tokenizer: "o200k_base",
            limits: {},
            supports: {},
          },
        },
      ],
    },
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
  if (originalDiagnostics === undefined)
    Reflect.deleteProperty(process.env, "COPILOT_CACHE_DIAGNOSTICS")
  else process.env.COPILOT_CACHE_DIAGNOSTICS = originalDiagnostics
})

const frames: Array<[string, unknown]> = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 97,
          output_tokens: 1,
        },
      },
    },
  ],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]

test("native Messages passthrough diagnostics report Anthropic cache reads and writes", async () => {
  const debug = spyOn(consola, "debug").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
  const success = spyOn(consola, "success").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        new Response(
          frames
            .map(
              ([event, data]) =>
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    { preconnect: originalFetch.preconnect },
  )
  try {
    const response = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-fixture",
        max_tokens: 100,
        stream: true,
        system: [
          {
            type: "text",
            text: "private-system",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "private-prompt" }],
      }),
    })
    await response.text()
    const summaries = debug.mock.calls
      .map(([message]): unknown => message)
      .filter(
        (message): message is string =>
          typeof message === "string"
          && message.startsWith("[messages-usage] "),
      )
    expect(summaries).toHaveLength(1)
    const record = JSON.parse(
      summaries[0].slice("[messages-usage] ".length),
    ) as Record<string, unknown>
    expect(record).toMatchObject({
      source: "messages",
      total_input_tokens: 1000,
      cached_input_tokens: 900,
      output_tokens: 12,
      read_usage_complete: true,
      fallback_reasons: [],
      cache_write_tokens: 97,
      cache_intent: { present: true, marker_count: 1, status: "observed" },
    })
    expect(summaries[0]).not.toContain("private-")

    // The always-on summary line shares the diagnostics request id.
    const line = String(success.mock.calls.at(-1)?.[0]).replaceAll(
      // eslint-disable-next-line no-control-regex
      /\u001B\[[\d;]*m/g,
      "",
    )
    expect(line).toContain("in 1,000 (cached 900 · 90.0%)")
    expect(line).toContain("write 97")
    expect(line).toContain(`#${String(record.request_id).slice(0, 8)}`)
  } finally {
    debug.mockRestore()
    success.mockRestore()
  }
})
