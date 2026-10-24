import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type GatewayRequestTag,
  gatewayHints,
  gatewayRequestTags,
} from "~/lib/gateway-hints"
import { state } from "~/lib/state"
import { server } from "~/server"

import { completed, frames } from "./fixtures/responses-cache"

const originalFetch = globalThis.fetch
const originalState = { ...state }
let directory: string
let success: ReturnType<typeof captureSuccess>
let warn: ReturnType<typeof captureWarn>
const sent: Array<{ body: BodyInit | null | undefined; headers: Headers }> = []

function captureSuccess() {
  return spyOn(consola, "success").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
}

function captureWarn() {
  return spyOn(consola, "warn").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gateway-hints-"))
  success = captureSuccess()
  warn = captureWarn()
  sent.length = 0
  Object.assign(state, {
    copilotToken: "synthetic-offline-token",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    manualApprove: false,
    rateLimitSeconds: undefined,
    traceEnabled: true,
    traceFolder: directory,
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  success.mockRestore()
  warn.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, originalState)
  await rm(directory, { recursive: true, force: true })
})

test("observations exclude credentials and unbounded hint values", () => {
  const hints = gatewayHints(
    new Headers({
      authorization: "synthetic-secret",
      "x-api-key": "synthetic-secret",
      "x-claude-code-request-class": "subagent",
      "x-claude-code-unbounded": "x".repeat(257),
    }),
  )
  expect(hints).toEqual({ "x-claude-code-request-class": "subagent" })
})

const classificationCases: Array<{
  headers: Record<string, string>
  tags: Array<GatewayRequestTag>
}> = [
  { headers: {}, tags: [] },
  { headers: { "x-claude-code-request-class": "main" }, tags: [] },
  { headers: { "x-claude-code-request-class": "unknown" }, tags: [] },
  { headers: { "x-claude-code-compaction": "unknown" }, tags: [] },
  {
    headers: { "x-claude-code-request-class": "compaction" },
    tags: ["compaction"],
  },
  { headers: { "x-claude-code-compaction": "manual" }, tags: ["compaction"] },
  {
    headers: { "x-claude-code-request-class": "subagent" },
    tags: ["subagent"],
  },
  {
    headers: {
      "x-claude-code-request-class": "subagent",
      "x-claude-code-compaction": "manual",
    },
    tags: ["compaction", "subagent"],
  },
]
test.each(classificationCases)(
  "only confirmed gateway hints are classified (%j)",
  ({ headers, tags }) => {
    expect(gatewayRequestTags(new Headers(headers))).toEqual(tags)
  },
)

test.each([
  { endpoint: "/responses", stream: false },
  { endpoint: "/responses", stream: true },
  { endpoint: "/chat/completions", stream: false },
  { endpoint: "/chat/completions", stream: true },
  { endpoint: "/v1/messages", stream: false },
  { endpoint: "/v1/messages", stream: true },
])(
  "hints do not change upstream bytes or headers (%j)",
  async ({ endpoint, stream }) => {
    state.models = {
      object: "list",
      data: [
        {
          id: "synthetic",
          name: "synthetic",
          object: "model",
          version: "synthetic",
          vendor: "synthetic",
          preview: false,
          model_picker_enabled: true,
          supported_endpoints: [endpoint],
          capabilities: {
            object: "model_capabilities",
            family: "synthetic",
            type: "chat",
            tokenizer: "o200k_base",
            limits: {},
            supports: { streaming: true, tool_calls: true },
          },
        },
      ],
    }
    globalThis.fetch = Object.assign(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        sent.push({ body: init?.body, headers: new Headers(init?.headers) })
        if (endpoint === "/responses")
          return Promise.resolve(
            stream ?
              frames([{ type: "response.completed", response: completed() }])
            : Response.json(completed()),
          )
        if (endpoint === "/chat/completions") {
          const result = {
            id: "synthetic",
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi" },
                delta: { content: "hi" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }
          return Promise.resolve(
            stream ? frames([result]) : Response.json(result),
          )
        }
        const usage = { input_tokens: 10, output_tokens: 2 }
        const message = {
          id: "synthetic",
          type: "message",
          role: "assistant",
          model: "synthetic",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage,
        }
        return Promise.resolve(
          stream ?
            new Response(
              [
                { type: "message_start", message },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage,
                },
              ]
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(message),
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    for (const hinted of [false, true]) {
      const headers = new Headers({ "content-type": "application/json" })
      if (hinted) headers.set("x-claude-code-request-class", "subagent")
      const response = await server.request("http://localhost/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "synthetic",
          max_tokens: 32,
          stream,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(sent).toHaveLength(2)
    expect(sent[0].body).toBe(sent[1].body)
    for (const request of sent) {
      expect(request.headers.has("x-claude-code-request-class")).toBe(false)
      request.headers.delete("x-request-id")
    }
    expect([...sent[0].headers]).toEqual([...sent[1].headers])
    expect(String(success.mock.calls.at(-1)?.[0])).toContain("subagent")
    const traces = await readdir(directory)
    const filename = traces.findLast((f) => f.endsWith(".req"))
    if (!filename) throw new Error("Missing ingress trace")
    const trace: unknown = JSON.parse(
      await readFile(join(directory, filename), "utf8"),
    )
    if (typeof trace !== "object" || trace === null || !("request_id" in trace))
      throw new Error("Missing trace request id")
    expect(trace.request_id).toBeString()
    expect(trace).toMatchObject({
      gateway_hints: { "x-claude-code-request-class": "subagent" },
      log_context: {
        requestId: trace.request_id,
        agent: "claude-code",
        role: "subagent:?",
      },
    })
    const responseTrace: unknown = JSON.parse(
      await readFile(
        join(directory, filename.replace(/\.req$/, ".resp")),
        "utf8",
      ),
    )
    expect(responseTrace).toMatchObject({
      log_context: {
        requestId: trace.request_id,
        agent: "claude-code",
        role: "subagent:?",
      },
    })
  },
)
