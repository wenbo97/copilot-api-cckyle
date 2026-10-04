import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

import { captureInfo, captureLogs, completed } from "./fixtures/responses-cache"

const originalFetch = globalThis.fetch
const environment = [
  "COPILOT_CACHE_DIAGNOSTICS",
  "COPILOT_CACHE_POLICY",
  "COPILOT_CACHE_NAMESPACE",
  "COPILOT_FOREIGN_REASONING_MANIFEST",
]
let previousEnvironment: Array<string | undefined>
let previousState: State
let directory: string
let info: ReturnType<typeof captureInfo>
const sent: Array<string> = []
let reply: () => Response
beforeEach(async () => {
  previousState = { ...state }
  previousEnvironment = environment.map((key) => process.env[key])
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  process.env.COPILOT_CACHE_POLICY = "off"
  delete process.env.COPILOT_CACHE_NAMESPACE
  delete process.env.COPILOT_FOREIGN_REASONING_MANIFEST
  directory = await mkdtemp(join(tmpdir(), "cache-history-route-"))
  info = captureInfo()
  sent.length = 0
  reply = () => Response.json(completed())
  Object.assign(state, {
    copilotToken: "private-offline-credential",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    githubToken: undefined,
    responsesHistoryDirectory: directory,
    responsesHistoryScope: "https://offline.example/history-diagnostics",
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
      if (typeof init?.body !== "string")
        throw new Error("Unexpected offline request")
      sent.push(init.body)
      return Promise.resolve(reply())
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
function logs(prefix: string) {
  return captureLogs(info.mock.calls, prefix)
}
function request(
  protocol: "messages" | "responses",
  payload: unknown,
  diagnosticHeaders: Record<string, string> = {},
) {
  return server.request(`http://localhost/v1/${protocol}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...diagnosticHeaders },
    body: JSON.stringify(payload),
  })
}

test("route diagnostics correlate declared threads, locate block changes and preserve all wire data", async () => {
  const base = {
    model: "gpt-5.6-luna",
    prompt_cache_options: { mode: "implicit", ttl: "30m" },
    input: [
      {
        role: "developer",
        content: [
          { type: "input_text", text: "private-stable-block" },
          {
            type: "input_text",
            text: "private-variable-a",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ],
  }
  const diagnosticHeaders = {
    "thread-id": "private-route-thread",
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "private-route-thread",
      request_kind: "turn",
    }),
  }
  const responseBody = {
    ...completed(),
    service_tier: "fast",
    prompt_cache_diagnostics: {
      type: "cache_miss",
      reason: "input_changed",
      cache_missed_tokens: 12,
      raw_prompt: "private-provider-debug",
    },
  }
  reply = () => Response.json(responseBody)
  const changed = {
    ...base,
    input: [
      {
        ...base.input[0],
        content: [
          base.input[0].content[0],
          { ...base.input[0].content[1], text: "private-variable-b" },
        ],
      },
    ],
  }
  for (const body of [
    base,
    changed,
    {
      ...changed,
      input: [...changed.input, { role: "user", content: "private-next" }],
    },
  ]) {
    const response = await request("responses", body, diagnosticHeaders)
    expect(await response.json()).toEqual(responseBody)
    expect(JSON.parse(sent.at(-1) ?? "null") as unknown).toEqual(body)
  }
  const reports = logs("cache-diagnostics")
  expect(reports[0]).toMatchObject({
    correlation: "declared_thread",
    request_role: "main",
    history_comparison: { egress: { status: "no_baseline" } },
  })
  expect(reports[1]).toMatchObject({
    history_comparison: {
      ingress: { first_changed_block: 1 },
      egress: {
        relation: "modified",
        first_changed_item: 0,
        first_changed_block: 1,
      },
    },
    returned_service_tier: "fast",
    prompt_cache_diagnostics: {
      type: "cache_miss",
      reason: "input_changed",
      cache_missed_tokens: 12,
    },
  })
  expect(reports[2]).toMatchObject({
    history_comparison: { egress: { relation: "appended", matched_items: 1 } },
  })
  expect(reports[0].process_scope).toBe(reports[2].process_scope)
  expect(JSON.stringify(reports)).not.toContain("private-")
})

test("Messages conversion reports removed caller TTL and native cache options per actual attempt", async () => {
  const body = {
    model: "gpt-5.6-luna",
    max_tokens: 64,
    system: [
      {
        type: "text",
        text: "private-system",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: "private-question" }],
  }
  const response = await request("messages", body)
  expect(response.status).toBe(200)
  await response.text()
  const attempt = (
    logs("cache-diagnostics")[0].attempt_details as Array<
      Record<string, unknown>
    >
  )[0]
  expect(attempt.cache_hint_processing).toMatchObject({
    ingress: {
      fields: [
        { path: "system[0].cache_control", ttl: "1h", mode: "ephemeral" },
      ],
    },
    egress: { intent: { present: false } },
    changes: [{ path: "system[0].cache_control", action: "removed" }],
  })
  expect(JSON.stringify(attempt)).not.toContain("private-")
})

test("malformed metadata and hint enums stay unknown at the route boundary", async () => {
  const body = {
    model: "gpt-5.6-luna",
    input: [],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: 42,
        request_kind: "turn",
      }),
    },
    prompt_cache_options: { mode: ["explicit"], ttl: ["30m"] },
  }
  const response = await request("responses", body, {
    "thread-id": "private-valid-header",
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(JSON.parse(sent[0]) as unknown).toEqual(body)
  const reports = logs("cache-diagnostics")
  expect(reports[0]).toMatchObject({
    correlation: "uncorrelated",
    request_role: "unknown",
    identity: { metadata_incomplete: true, thread: null },
  })
  const attempt = (
    reports[0].attempt_details as Array<Record<string, unknown>>
  )[0]
  expect(attempt.cache_hint_processing).toMatchObject({
    ingress: {
      fields: [{ path: "prompt_cache_options", mode: null, ttl: null }],
    },
  })
  expect(JSON.stringify(reports)).not.toContain("private-")
})
