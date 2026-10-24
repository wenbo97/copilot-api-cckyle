import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import {
  createRequestLogContext,
  observeRequestLogIdentity,
  requestLogContext,
  requestLogLabel,
  requestLogStorage,
} from "~/lib/request-log-context"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  captureDiagnostics,
  captureLogs,
  completed,
  frames,
} from "./fixtures/responses-cache"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const originalDiagnostics = process.env.COPILOT_CACHE_DIAGNOSTICS
let access: ReturnType<typeof captureAccess>
let summary: ReturnType<typeof captureSummary>
let diagnostics: ReturnType<typeof captureDiagnostics>
const sessionId = "11111111-1111-4111-8111-111111111111"

function captureAccess() {
  return spyOn(console, "log").mockImplementation(() => undefined)
}

function captureSummary() {
  return spyOn(consola, "success").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
}

beforeEach(() => {
  access = captureAccess()
  summary = captureSummary()
  diagnostics = captureDiagnostics()
  process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
  Object.assign(state, {
    copilotToken: "synthetic-only",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    manualApprove: false,
    rateLimitSeconds: undefined,
    traceEnabled: false,
    models: {
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
          supported_endpoints: ["/responses"],
          capabilities: {
            object: "model_capabilities",
            family: "synthetic",
            type: "chat",
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
  access.mockRestore()
  summary.mockRestore()
  diagnostics.mockRestore()
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, originalState)
  if (originalDiagnostics === undefined)
    delete process.env.COPILOT_CACHE_DIAGNOSTICS
  else process.env.COPILOT_CACHE_DIAGNOSTICS = originalDiagnostics
})

test("original session identifies the client conversation while subagent IDs stay distinct", () => {
  const contexts = ["", "agent-one", "agent-two"].map((agent) =>
    createRequestLogContext(
      new Headers({
        "x-claude-code-session-id": sessionId,
        "x-claude-code-request-class": agent ? "subagent" : "main",
        ...(agent ?
          {
            "x-claude-code-agent-id": agent,
            "x-claude-code-agent-type": "general-purpose",
          }
        : {}),
      }),
    ),
  )
  expect(new Set(contexts.map((context) => context.session)).size).toBe(1)
  expect(new Set(contexts.map((context) => context.role)).size).toBe(3)
  expect(contexts[0].role).toBe("main")
  expect(contexts.every((context) => context.agent === "claude-code")).toBe(
    true,
  )
  expect(contexts[1].agentType).toBe("general-purpose")
  expect(contexts.every((context) => context.session === sessionId)).toBe(true)
  expect(JSON.stringify(contexts)).not.toContain("agent-one")
})

test("legacy Claude session fallback agrees with headers without inferring a main agent", () => {
  const expected = createRequestLogContext(
    new Headers({ "x-claude-code-session-id": sessionId }),
  )
  for (const userId of [
    JSON.stringify({ session_id: sessionId }),
    `user_hash_account_account_session_${sessionId}`,
  ]) {
    const context = createRequestLogContext(new Headers())
    requestLogStorage.run(context, () =>
      observeRequestLogIdentity(
        { metadata: { user_id: userId } },
        new Headers(),
      ),
    )
    expect(context.session).toBe(expected.session)
    expect(context.role).toBe("?")
  }
})

test("Codex uses explicit thread projections and does not invent individual subagent IDs", () => {
  const headers = new Headers({
    "thread-id": "synthetic-thread",
    "x-codex-parent-thread-id": "synthetic-parent",
  })
  const context = createRequestLogContext(headers)
  expect(context.session).not.toBe("?")
  expect(context.agent).toBe("codex")
  expect(context.role).toBe("subagent:?")
  expect(context.session).toBe("synthetic-thread")
  const unknown = createRequestLogContext(new Headers())
  requestLogStorage.run(unknown, () =>
    observeRequestLogIdentity(
      { prompt_cache_key: "not-a-session", model: "not-an-agent" },
      new Headers(),
    ),
  )
  expect(unknown.session).toBe("?")
  expect(unknown.agent).toBe("unknown")
  expect(unknown.role).toBe("?")
})

test("invalid and unknown declarations cannot inject raw text into log labels", () => {
  const context = createRequestLogContext(
    new Headers({
      "x-claude-code-session-id": "x".repeat(257),
      "x-claude-code-agent-id": "has space",
      "x-claude-code-agent-type": "not a safe type",
    }),
  )
  expect(requestLogLabel(context)).toBe(
    "[agent=claude-code session=? role=subagent:?]",
  )
  expect(requestLogLabel(createRequestLogContext(new Headers()))).toBe(
    "[agent=unknown session=? role=?]",
  )
})

test.each([
  { userAgent: "claude-cli/2.1.308 (external, cli)", agent: "claude-code" },
  { userAgent: "codex_cli_rs/0.99.0 (Windows)", agent: "codex" },
  { userAgent: "codex/0.99.0", agent: "codex" },
  { userAgent: "curl/8.0", agent: "other" },
  { userAgent: "not-codex/1.0", agent: "other" },
  { userAgent: "", agent: "unknown" },
])(
  "agent names the CLI, not the model or subagent role (%j)",
  ({ userAgent, agent }) => {
    const context = createRequestLogContext(
      new Headers({ "user-agent": userAgent }),
    )
    expect(context).toMatchObject({ agent })
    expect(context.role).toBe("?")
  },
)

test("conflicting CLI signals remain unknown and Codex metadata preserves the original session ID", () => {
  const conflict = createRequestLogContext(
    new Headers({
      "user-agent": "codex_cli_rs/0.99.0",
      "x-claude-code-request-class": "main",
    }),
  )
  expect(conflict.agent).toBe("unknown")
  const context = createRequestLogContext(
    new Headers({ "user-agent": "codex_cli_rs/0.99.0" }),
  )
  requestLogStorage.run(context, () =>
    observeRequestLogIdentity(
      {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: sessionId,
            request_kind: "turn",
          }),
        },
      },
      new Headers(),
    ),
  )
  expect(context.agent).toBe("codex")
  expect(context.session).toBe(sessionId)
  expect(context.role).toBe("main")
})

test("conflicting or malformed Codex metadata cannot retain a misleading session ID", () => {
  for (const value of [
    JSON.stringify({ thread_id: "different-thread", request_kind: "turn" }),
    "{",
  ]) {
    const headers = new Headers({
      "user-agent": "codex_cli_rs/0.99.0",
      "thread-id": sessionId,
    })
    const context = createRequestLogContext(headers)
    expect(context.session).toBe(sessionId)
    requestLogStorage.run(context, () =>
      observeRequestLogIdentity(
        {
          client_metadata: { "x-codex-turn-metadata": value },
        },
        headers,
      ),
    )
    expect(context.session).toBe("?")
    expect(context.role).toBe("?")
  }
})

test("concurrent streaming requests keep access, summary and diagnostics IDs aligned", async () => {
  const observed: Array<{
    context: ReturnType<typeof requestLogContext>
    body: string
  }> = []
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body !== "string")
        throw new Error("Missing fixture body")
      const context = requestLogContext()
      await Bun.sleep(context?.role === "main" ? 15 : 1)
      observed.push({ context, body: init.body })
      return frames([{ type: "response.completed", response: completed() }])
    },
    { preconnect: originalFetch.preconnect },
  )
  await Promise.all(
    ["main", "subagent"].map(async (role) => {
      const response = await server.request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(role === "main" ?
            {
              "x-claude-code-session-id": sessionId,
              "x-claude-code-request-class": "main",
            }
          : {
              "user-agent": "codex_cli_rs/0.99.0",
              "thread-id": "22222222-2222-4222-8222-222222222222",
              "x-codex-parent-thread-id": sessionId,
            }),
        },
        body: JSON.stringify({
          model: "synthetic",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "same payload" }],
        }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }),
  )
  expect(summary.mock.calls).toHaveLength(2)
  const records = captureLogs(diagnostics.mock.calls, "cache-diagnostics")
  expect(records).toHaveLength(2)
  expect(new Set(observed.map(({ context }) => context?.agent)).size).toBe(2)
  expect(new Set(observed.map(({ context }) => context?.session)).size).toBe(2)
  for (const { context, body } of observed) {
    if (!context) throw new Error("Missing request context")
    const prefix = requestLogLabel(context)
    const id = `#${context.requestId.slice(0, 8)}`
    const accessLines = access.mock.calls.map(([message]) => String(message))
    expect(accessLines.filter((line) => line.includes(id))).toHaveLength(2)
    expect(
      accessLines
        .filter((line) => line.includes(id))
        .every((line) => line.includes(prefix)),
    ).toBe(true)
    const summaries = summary.mock.calls.map(([message]) => String(message))
    expect(summaries.find((line) => line.includes(id))).toContain(prefix)
    expect(
      records.some((record) => record.request_id === context.requestId),
    ).toBe(true)
    expect(body).not.toContain("log_context")
  }
  expect(requestLogContext()).toBeUndefined()
})
