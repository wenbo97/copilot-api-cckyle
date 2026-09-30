import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import type { State } from "~/lib/state"
import type { ResponsesPayload } from "~/routes/responses/responses-types"

import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import * as token from "~/lib/token"
import { translateToOpenAI } from "~/routes/responses/non-stream-translation"
import { server } from "~/server"
import { copilotFetch } from "~/services/copilot/copilot-fetch"

// These desired-behavior regressions correspond to REVIEW-2026-09-29.md.
// B1/B2/B3/B7 now run as ordinary regressions after their implementation fixes.
const originalFetch = globalThis.fetch
const timeoutVariables = [
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
]
let previousTimeouts: Array<string | undefined>
let previousState: State

beforeEach(() => {
  previousState = { ...state }
  previousTimeouts = timeoutVariables.map((name) => process.env[name])
  for (const name of timeoutVariables) Reflect.deleteProperty(process.env, name)
  globalThis.fetch = Object.assign(
    () =>
      Promise.reject(new Error("Unexpected network request in offline review")),
    { preconnect: originalFetch.preconnect },
  )
  Object.assign(state, {
    copilotToken: "offline-review-token",
    copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    accountType: "individual",
    manualApprove: false,
    traceEnabled: false,
    rateLimitSeconds: undefined,
    models: undefined,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, previousState)
  for (const [index, name] of timeoutVariables.entries()) {
    const value = previousTimeouts[index]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

test("B1: cancellation detaches a caller waiting for shared authentication", async () => {
  const refresh = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const ensure = spyOn(token, "ensureCopilotToken").mockImplementation(() => {
    entered.resolve(undefined)
    return refresh.promise
  })
  const caller = new AbortController()
  const result = copilotFetch("/responses", { signal: caller.signal }).then(
    () => "resolved",
    (error: unknown) => error,
  )
  const reason = new DOMException("client disconnected", "AbortError")
  try {
    await entered.promise
    caller.abort(reason)
    const outcome = await Promise.race([
      result,
      Bun.sleep(100).then(() => "still waiting for authentication"),
    ])
    expect(outcome).toBe(reason)
  } finally {
    refresh.resolve(undefined)
    await result
    ensure.mockRestore()
  }
})

test("B2: Responses fallback preserves the Chat usage tail", async () => {
  const chunk = {
    id: "chat-review",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-review-chat",
  }
  const frames = [
    {
      ...chunk,
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      ...chunk,
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    },
  ]
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        new Response(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
            + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    { preconnect: originalFetch.preconnect },
  )
  // An absent catalog deliberately selects the existing Chat fallback.
  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chunk.model,
      input: "hello",
      stream: true,
    }),
  })
  const body = await response.text()
  const terminalLine = body
    .split("\n")
    .find(
      (line) =>
        line.startsWith("data:") && line.includes('"response.completed"'),
    )
  expect(response.status).toBe(200)
  if (!terminalLine) throw new Error("Expected a response.completed event")
  const terminal = JSON.parse(terminalLine.slice(5)) as {
    response: { usage: unknown }
  }
  expect(terminal.response.usage).toMatchObject({
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    input_tokens_details: { cached_tokens: 50 },
  })
})

test("B3: parallel tool replay keeps calls in one assistant turn", () => {
  const payload: ResponsesPayload = {
    model: "gpt-review-chat",
    input: [
      { type: "function_call", call_id: "a", name: "read", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: "first" },
      { type: "function_call_output", call_id: "b", output: "second" },
    ],
  }
  const { messages } = translateToOpenAI(payload)
  expect(messages).toEqual([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
        {
          id: "b",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "first" },
    { role: "tool", tool_call_id: "b", content: "second" },
  ])
})

test("B7: waiting concurrent requests receive separate rate-limit slots", async () => {
  const limited: State = {
    ...state,
    rateLimitSeconds: 1,
    rateLimitWait: true,
    lastRequestTimestamp: Date.now(),
  }
  const admitted = await Promise.all(
    Array.from({ length: 3 }, async () => {
      await checkRateLimit(limited)
      return performance.now()
    }),
  )
  admitted.sort((left, right) => left - right)
  for (let index = 1; index < admitted.length; index++) {
    expect(admitted[index] - admitted[index - 1]).toBeGreaterThanOrEqual(900)
  }
}, 10000)
