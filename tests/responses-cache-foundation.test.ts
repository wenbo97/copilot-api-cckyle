import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { state, type State } from "~/lib/state"
import { server } from "~/server"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

import {
  captureInfo,
  captureLogs,
  completed,
  firstChangedInput,
  frames,
  toolConversations,
} from "./fixtures/responses-cache"

const originalFetch = globalThis.fetch
const environment = [
  "COPILOT_CACHE_DIAGNOSTICS",
  "COPILOT_CACHE_POLICY",
  "COPILOT_CACHE_NAMESPACE",
  "COPILOT_FOREIGN_REASONING_MANIFEST",
]
let previousState: State
let previousEnvironment: Array<string | undefined>
let info: ReturnType<typeof captureInfo>
const sent: Array<string> = []
const headers: Array<Array<string | null>> = []
let directory: string
let reply: (
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
) => Response

beforeEach(async () => {
  previousState = { ...state }
  previousEnvironment = environment.map((key) => process.env[key])
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  process.env.COPILOT_CACHE_POLICY = "off"
  delete process.env.COPILOT_FOREIGN_REASONING_MANIFEST
  delete process.env.COPILOT_CACHE_NAMESPACE
  directory = await mkdtemp(join(tmpdir(), "cache-foundation-"))
  reply = () => Response.json(completed())
  info = captureInfo()
  sent.length = 0
  headers.length = 0
  Object.assign(state, {
    copilotToken: "private-offline-credential",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    githubToken: undefined,
    responsesHistoryDirectory: directory,
    responsesHistoryScope: "https://offline.example/v1",
    manualApprove: false,
    rateLimitSeconds: undefined,
    traceEnabled: false,
    models: {
      object: "list",
      data: [{ id: "gpt-5.6-luna", supported_endpoints: ["/responses"] }],
    },
  })
  globalThis.fetch = Object.assign(
    (_url: string | URL | Request, init?: RequestInit) => {
      const url = _url instanceof Request ? _url.url : _url.toString()
      if (url.endsWith("/token"))
        return Promise.resolve(
          Response.json({
            token: "private-refreshed-credential",
            expires_at: Date.now() / 1000 + 3600,
            refresh_in: 3600,
          }),
        )
      if (typeof init?.body !== "string")
        throw new Error("Unexpected offline request")
      sent.push(init.body)
      const requestHeaders = new Headers(init.headers)
      headers.push([
        requestHeaders.get("content-type"),
        requestHeaders.get("x-initiator"),
        requestHeaders.get("copilot-vision-request"),
      ])
      return Promise.resolve(
        reply(JSON.parse(init.body) as Record<string, unknown>, init.signal),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(async () => {
  info.mockRestore()
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
  for (const [index, key] of environment.entries()) {
    const value = previousEnvironment[index]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  await rm(directory, { recursive: true, force: true })
})

test("attributes recovered history to the actual second body without leaking ciphertext", async () => {
  reply = () =>
    sent.length === 1 ?
      Response.json(
        { error: { message: "input item does not belong to this connection" } },
        { status: 401 },
      )
    : Response.json(completed())
  const response = await request("responses", {
    model: "gpt-5.6-luna",
    input: [
      { role: "developer", content: "private-stable-rules" },
      {
        type: "reasoning",
        encrypted_content: "private-foreign-ciphertext",
        summary: [],
      },
      { role: "user", content: "private-question" },
    ],
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(completed())
  expect(sent).toHaveLength(2)
  expect(sent[0]).toContain("private-foreign-ciphertext")
  expect(sent[1]).not.toContain("encrypted_content")
  const summaries = logs("cache-diagnostics")
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({
    source: "native_responses",
    upstream_attempts: 2,
    attempt_details: [
      {
        attempt_index: 1,
        cause: "initial",
        http_status: 401,
        outcome: "error",
        cached_input_tokens: null,
      },
      {
        attempt_index: 2,
        cause: "history_recovery",
        http_status: 200,
        outcome: "completed",
        cached_input_tokens: 80,
      },
    ],
  })
  const attempts = summaries[0].attempt_details as Array<
    Record<string, unknown>
  >
  expect(attempts[0].attempt_id).toBe(`${String(summaries[0].request_id)}:1`)
  expect(attempts[1].attempt_id).toBe(`${String(summaries[0].request_id)}:2`)
  expect(attempts[0].egress_fingerprints).toEqual(
    summaries[0].egress_fingerprints,
  )
  expect(attempts[0].egress_fingerprints).not.toEqual(
    attempts[1].egress_fingerprints,
  )
  expect(attempts[0].egress_static_prefix).toEqual(
    attempts[1].egress_static_prefix,
  )
  expect(JSON.stringify(summaries)).not.toContain("private-")
})

test("Messages bridge retains caller cache intent without changing egress", async () => {
  const payload = {
    model: "gpt-5.6-luna",
    max_tokens: 64,
    cache_control: { type: "ephemeral" },
    system: [
      {
        type: "text",
        text: "private-system",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ],
    tools: [
      {
        name: "read",
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "private-question",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  }
  const first = await request("messages", payload)
  delete process.env.COPILOT_CACHE_DIAGNOSTICS
  const second = await request("messages", payload)
  expect(await first.json()).toEqual(await second.json())
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
  expect(sent[0]).not.toContain("cache_control")
  expect(sent[0]).not.toContain("cache_intent")
  const summaries = logs("cache-diagnostics")
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({
    schema_version: 2,
    source: "messages_to_responses",
    ingress_protocol: "messages",
    egress_endpoint: "/responses",
    correlation: "uncorrelated",
    cache_intent: {
      present: true,
      marker_count: 4,
      paths: [
        "cache_control",
        "system[0].cache_control",
        "tools[0].cache_control",
        "messages[0].content[0].cache_control",
      ],
      ttl_present: true,
      malformed_or_unknown: false,
      truncated: false,
      status: "cache_hint_not_portable",
    },
  })
  expect(logs("messages-usage")[0].request_id).toBe(summaries[0].request_id)
  expect(JSON.stringify(summaries)).not.toContain("private-")
})

test.each(["messages", "responses"] as const)(
  "%s keeps JSON and SSE bodies, headers and client output unchanged under both policies",
  async (protocol) => {
    for (const policy of ["off", "prefix-v1"]) {
      process.env.COPILOT_CACHE_POLICY = policy
      for (const stream of [false, true]) {
        reply = () =>
          stream ?
            frames([
              {
                type: "response.created",
                sequence_number: 0,
                response: {
                  ...completed(),
                  status: "in_progress",
                  usage: undefined,
                },
              },
              {
                type: "response.completed",
                sequence_number: 1,
                response: completed(),
              },
            ])
          : Response.json(completed())
        const payload =
          protocol === "messages" ?
            {
              model: "gpt-5.6-luna",
              max_tokens: 64,
              stream,
              system: [
                {
                  type: "text",
                  text: "private-rules",
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: [{ role: "user", content: "private-question" }],
            }
          : {
              model: "gpt-5.6-luna",
              stream,
              prompt_cache_key: "private-client-key",
              prompt_cache_options: {
                mode: "implicit",
                ttl: "30m",
                caller_extension: true,
              },
              input: [
                {
                  role: "developer",
                  content: [{ type: "input_text", text: "private-rules" }],
                },
                { role: "user", content: "private-question" },
              ],
            }
        const before = sent.length
        const reportCount = logs("cache-diagnostics").length
        process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
        const enabled = await (await request(protocol, payload)).text()
        delete process.env.COPILOT_CACHE_DIAGNOSTICS
        const disabled = await (await request(protocol, payload)).text()
        expect(enabled).toBe(disabled)
        expect(sent.length - before).toBe(2)
        expect(sent[before]).toBe(sent[before + 1])
        expect(headers[before]).toEqual(headers[before + 1])
        expect(sent[before]).not.toContain("responsesDiagnostics")
        const reports = logs("cache-diagnostics")
        expect(reports.length - reportCount).toBe(1)
        expect(reports.at(-1)).toMatchObject({
          upstream_attempts: 1,
          attempt_details: [
            {
              attempt_index: 1,
              cause: "initial",
              outcome: "completed",
              cached_input_tokens: 80,
            },
          ],
        })
        if (protocol === "responses")
          expect(reports.at(-1)).toMatchObject({
            cache_intent: { present: true, malformed_or_unknown: true },
            cache_policy: { status: policy === "off" ? "disabled" : "applied" },
          })
      }
    }
    expect(JSON.stringify(logs("cache-diagnostics"))).not.toContain("private-")
  },
)

test.each([
  null,
  "private-malformed-hint",
  { type: "ephemeral", ttl: "private-invalid-ttl" },
  { type: "ephemeral", private_option: "private-value" },
])(
  "reports malformed or unknown hints without rejecting or exposing their value",
  async (hint) => {
    const response = await request("messages", {
      model: "gpt-5.6-luna",
      max_tokens: 64,
      cache_control: hint,
      messages: [{ role: "user", content: "private-question" }],
    })
    expect(response.status).toBe(200)
    expect(logs("cache-diagnostics")[0].cache_intent).toMatchObject({
      present: true,
      marker_count: 1,
      malformed_or_unknown: true,
      status: "cache_hint_not_portable",
    })
    expect(JSON.stringify(logs("cache-diagnostics"))).not.toContain("private-")
  },
)

test("inspects nested tool-result markers and native caller breakpoints without walking arguments", async () => {
  await request("messages", {
    model: "gpt-5.6-luna",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call",
            name: "read",
            input: { cache_control: "private-argument" },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            cache_control: { type: "ephemeral" },
            content: [
              {
                type: "text",
                text: "private-result",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
        ],
      },
    ],
  })
  expect(logs("cache-diagnostics")[0].cache_intent).toMatchObject({
    marker_count: 3,
    ttl_present: true,
    malformed_or_unknown: false,
  })
  await request("responses", {
    model: "gpt-5.6-luna",
    prompt_cache_key: null,
    prompt_cache_retention: "24h",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "private-rules",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call",
        output: [
          {
            type: "input_text",
            text: "private-result",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ],
  })
  expect(logs("cache-diagnostics")[1].cache_intent).toMatchObject({
    present: true,
    marker_count: 2,
    ttl_present: true,
    malformed_or_unknown: false,
    status: "observed",
  })
  expect(JSON.stringify(logs("cache-diagnostics"))).not.toContain("private-")
})

test.each([false, true])(
  "distinguishes authentication and history recovery within one request (stream=%s)",
  async (stream) => {
    reply = () => {
      if (sent.length === 1)
        return Response.json({ error: { message: "expired" } }, { status: 401 })
      if (sent.length === 2)
        return stream ?
            frames([
              {
                status: 401,
                body: JSON.stringify({
                  error: {
                    message: "input item does not belong to this connection",
                  },
                }),
              },
            ])
          : Response.json({
              error: {
                message: "input item does not belong to this connection",
              },
            })
      return stream ?
          frames([
            {
              type: "response.completed",
              sequence_number: 0,
              response: completed(),
            },
          ])
        : Response.json(completed())
    }
    const response = await request("responses", {
      model: "gpt-5.6-luna",
      stream,
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-foreign-ciphertext",
          summary: [],
        },
        { role: "user", content: "private-question" },
      ],
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(sent).toHaveLength(3)
    expect(sent[0]).toBe(sent[1])
    expect(sent[2]).not.toContain("encrypted_content")
    expect(logs("cache-diagnostics")).toHaveLength(1)
    expect(logs("cache-diagnostics")[0]).toMatchObject({
      upstream_attempts: 3,
      attempt_details: [
        {
          cause: "initial",
          http_status: 401,
          outcome: "error",
          cached_input_tokens: null,
        },
        {
          cause: "auth_refresh",
          http_status: 200,
          upstream_error_status: 401,
          outcome: "error",
          cached_input_tokens: null,
        },
        {
          cause: "history_recovery",
          http_status: 200,
          outcome: "completed",
          cached_input_tokens: 80,
        },
      ],
    })
  },
)

test("keeps cumulative usage within one attempt and clears explicitly invalid counters", async () => {
  reply = () =>
    frames([
      {
        type: "response.created",
        response: { ...completed(), status: "in_progress" },
      },
      {
        type: "response.in_progress",
        response: {
          ...completed(),
          status: "in_progress",
          usage: { output_tokens: 1 },
        },
      },
      {
        type: "response.completed",
        response: {
          ...completed(),
          usage: {
            output_tokens: 2,
            input_tokens_details: { cached_tokens: null },
          },
        },
      },
    ])
  const response = await request("responses", {
    model: "gpt-5.6-luna",
    stream: true,
    input: "private-question",
  })
  await response.text()
  expect(logs("cache-diagnostics")[0]).toMatchObject({
    attempt_details: [
      {
        input_tokens: 100,
        cached_input_tokens: null,
        cache_write_tokens: 10,
        output_tokens: 2,
        usage_complete: false,
      },
    ],
  })
})

test.each(["messages", "responses"] as const)(
  "%s diagnostics logging failures do not change the response",
  async (protocol) => {
    info.mockImplementation(
      Object.assign(
        (message: unknown) => {
          if (
            typeof message === "string"
            && (message.startsWith("[cache-diagnostics]")
              || message.startsWith("[messages-usage]"))
          )
            throw new Error("offline diagnostic sink failed")
        },
        { raw: () => undefined },
      ),
    )
    const payload =
      protocol === "messages" ?
        {
          model: "gpt-5.6-luna",
          max_tokens: 64,
          messages: [{ role: "user", content: "question" }],
        }
      : { model: "gpt-5.6-luna", input: "question" }
    const response = await request(protocol, payload)
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
  },
)

function request(
  protocol: "messages" | "responses",
  payload: unknown,
  signal?: AbortSignal,
) {
  return server.request(`http://localhost/v1/${protocol}`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

test.each(["messages", "responses"] as const)(
  "%s tool histories remain append-only and identify branch, compaction and tool changes",
  async (protocol) => {
    const fixtures = toolConversations(protocol)
    const original = JSON.stringify(fixtures)
    for (const fixture of fixtures) {
      const response = await request(protocol, fixture)
      expect(response.status).toBe(200)
      await response.text()
    }
    const bodies = sent.map(
      (body) => JSON.parse(body) as { input: Array<unknown> },
    )
    const [initial, tools, appended, branch, compacted, changedTools] = bodies
    expect(firstChangedInput(initial.input, tools.input)).toBe(
      protocol === "responses" ? 2 : 1,
    )
    expect(firstChangedInput(tools.input, appended.input)).toBe(
      protocol === "responses" ? 9 : 7,
    )
    expect(firstChangedInput(tools.input, branch.input)).toBe(
      protocol === "responses" ? 8 : 6,
    )
    expect(firstChangedInput(tools.input, compacted.input)).toBe(
      protocol === "responses" ? 1 : 0,
    )
    expect(changedTools.input).toEqual(tools.input)
    if (protocol === "responses")
      expect(tools.input[2]).toMatchObject({
        encrypted_content: "private-opaque-reasoning",
      })
    for (const callId of ["call-a", "call-b"])
      expect(tools.input).toContainEqual({
        type: "function_call_output",
        call_id: callId,
        output: `private-result-${callId}`,
      })
    const reports = logs("cache-diagnostics")
    expect(reports).toHaveLength(6)
    for (const report of reports.slice(1, 5))
      expect(report.egress_static_prefix).toEqual(
        reports[0].egress_static_prefix,
      )
    expect(reports[5].egress_static_prefix).not.toEqual(
      reports[0].egress_static_prefix,
    )
    expect(JSON.stringify(reports)).not.toContain("private-")
    expect(JSON.stringify(fixtures)).toBe(original)
  },
)

test("cancellation keeps attempt usage unknown and never retries", async () => {
  reply = (_body, signal) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { ...completed(), status: "in_progress", usage: undefined } })}\n\n`,
            ),
          )
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const controller = new AbortController()
  const response = await request(
    "responses",
    { model: "gpt-5.6-luna", stream: true, input: "private-question" },
    controller.signal,
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Expected a streaming response")
  await reader.read()
  controller.abort(
    new DOMException("offline downstream cancelled", "AbortError"),
  )
  await reader.cancel().catch(() => undefined)
  for (
    let index = 0;
    index < 20 && logs("cache-diagnostics").length === 0;
    index++
  )
    await Bun.sleep(5)
  expect(sent).toHaveLength(1)
  expect(logs("cache-diagnostics")).toHaveLength(1)
  expect(logs("cache-diagnostics")[0]).toMatchObject({
    outcome: "cancelled",
    upstream_attempts: 1,
    attempt_details: [
      {
        outcome: "cancelled",
        input_tokens: null,
        cached_input_tokens: null,
        usage_complete: false,
      },
    ],
  })
})

test("records an HTTP rejection without consuming the error body", async () => {
  reply = () =>
    Response.json(
      { error: { message: "offline fixture rejected" } },
      { status: 400 },
    )
  const response = await request("responses", {
    model: "gpt-5.6-luna",
    input: "private-question",
  })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("offline fixture rejected")
  expect(sent).toHaveLength(1)
  expect(logs("cache-diagnostics")[0]).toMatchObject({
    attempt_details: [
      {
        http_status: 400,
        upstream_error_status: 400,
        outcome: "error",
        input_tokens: null,
        cached_input_tokens: null,
      },
    ],
  })
})

test("never carries usage or billing from rejected history into its retry", async () => {
  reply = () =>
    sent.length === 1 ?
      Response.json({
        error: { message: "input item does not belong to this connection" },
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 90 },
          output_tokens: 1,
        },
        copilot_usage: { total_nano_aiu: 5 },
      })
    : Response.json({ ...completed(), usage: { output_tokens: 2 } })
  await (
    await request("responses", {
      model: "gpt-5.6-luna",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-foreign-cipher",
          summary: [],
        },
      ],
    })
  ).text()
  expect(logs("cache-diagnostics")[0]).toMatchObject({
    upstream_attempts: 2,
    attempt_details: [
      { input_tokens: 100, cached_input_tokens: 90, copilot_nano_aiu: 5 },
      {
        input_tokens: null,
        cached_input_tokens: null,
        copilot_nano_aiu: null,
        output_tokens: 2,
        usage_complete: false,
      },
    ],
  })
})

test("isolates observer errors while preserving a business admission failure", async () => {
  const failure = new Error("offline admission stopped")
  const rejected = await copilotFetch("/responses", {
    onAttempt: () => {
      throw failure
    },
  }).catch((error: unknown) => error)
  expect(rejected).toBe(failure)
  expect(sent).toHaveLength(0)
  const failedObservation = () => {
    throw new Error("offline observer failure")
  }
  const response = await copilotFetch("/responses", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "question" }),
    observer: {
      start: failedObservation,
      headers: failedObservation,
      failure: failedObservation,
    },
  })
  expect(await response.json()).toEqual(completed())
  expect(sent).toHaveLength(1)
})

function logs(prefix: string) {
  return captureLogs(info.mock.calls, prefix)
}
