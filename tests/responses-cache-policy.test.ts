import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResponsesPayload } from "~/routes/responses/responses-types"

import { applyResponsesCachePolicy } from "~/lib/responses-cache-policy"
import { state } from "~/lib/state"
import { validateResponsesFallback } from "~/routes/responses/fallback-capabilities"
import { createResponses } from "~/services/copilot/create-responses"

const originalPolicy = process.env.COPILOT_CACHE_POLICY
const originalNamespace = process.env.COPILOT_CACHE_NAMESPACE
const originalFetch = globalThis.fetch
const originalState = { ...state }
const context = { endpoint: "/responses", accountType: "enterprise" }

beforeEach(() => {
  process.env.COPILOT_CACHE_POLICY = "prefix-v1"
  process.env.COPILOT_CACHE_NAMESPACE = "test-account:test-workspace"
  state.copilotToken = "offline-token"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
})

afterEach(() => {
  restoreEnv("COPILOT_CACHE_POLICY", originalPolicy)
  restoreEnv("COPILOT_CACHE_NAMESPACE", originalNamespace)
  globalThis.fetch = originalFetch
  Object.assign(
    state,
    { copilotToken: undefined, copilotTokenExpiresAt: undefined },
    originalState,
  )
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}

function payload(overrides: Partial<ResponsesPayload> = {}): ResponsesPayload {
  return {
    model: "gpt-6-astra",
    instructions: "Fixed instructions",
    reasoning: { effort: "high" },
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {},
      },
    ],
    input: [
      { role: "developer", content: "Stable repository rules" },
      { role: "user", content: "Fix the first issue" },
    ],
    ...overrides,
  }
}

describe("opt-in native Responses prefix caching", () => {
  test("is disabled by default and preserves the exact payload", () => {
    delete process.env.COPILOT_CACHE_POLICY
    const request = payload()
    const result = applyResponsesCachePolicy(request, context)
    expect(result.payload).toBe(request)
    expect(result.summary.status).toBe("disabled")
  })

  test("adds one stable breakpoint without moving instructions or changing content", () => {
    const request = payload()
    const original = structuredClone(request)
    const result = applyResponsesCachePolicy(request, context)
    expect(request).toEqual(original)
    expect(result.payload.instructions).toBe(request.instructions)
    expect(result.payload.tools).toBe(request.tools)
    expect(result.payload.reasoning).toBe(request.reasoning)
    expect(result.payload.input[0]).toEqual({
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "Stable repository rules",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    })
    expect(result.payload.input[1]).toBe(request.input[1])
    expect(result.payload.prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    })
    expect(result.summary).toEqual({
      name: "prefix-v1",
      status: "applied",
      key_source: "generated",
      breakpoint_added: true,
    })
  })

  test("keeps converted history, tools, opaque reasoning and key stable across appends", () => {
    const request = payload()
    if (!Array.isArray(request.input)) throw new Error("Expected history items")
    const history = [
      ...request.input,
      {
        type: "reasoning",
        id: "opaque-id",
        encrypted_content: "opaque-reasoning",
        summary: [],
      },
      {
        type: "function_call",
        name: "read_file",
        call_id: "call1",
        arguments: "{}",
      },
    ]
    const first = applyResponsesCachePolicy(
      { ...request, input: history } as unknown as ResponsesPayload,
      context,
    ).payload
    const next = applyResponsesCachePolicy(
      {
        ...request,
        input: [
          ...history,
          { type: "function_call_output", call_id: "call1", output: "result" },
        ],
      } as unknown as ResponsesPayload,
      context,
    ).payload
    expect(first.prompt_cache_key).toBe(next.prompt_cache_key)
    expect(first.tools).toBe(next.tools)
    expect(first.input).toEqual(next.input.slice(0, history.length))
    const preservedReasoning: unknown = first.input[2]
    expect(preservedReasoning).toBe(history[2])
    expect(first.prompt_cache_key?.length).toBeLessThanOrEqual(64)
    expect(first.prompt_cache_key).not.toContain("test-account")
  })

  test("preserves caller key and implicit options exactly", () => {
    const request = payload({
      prompt_cache_key: "client-key",
      prompt_cache_options: { mode: "implicit" },
    })
    const result = applyResponsesCachePolicy(request, context)
    expect(result.payload.prompt_cache_key).toBe("client-key")
    expect(result.payload.prompt_cache_options).toBe(
      request.prompt_cache_options,
    )
    expect(result.summary.breakpoint_added).toBe(true)
  })

  test.each([
    { prompt_cache_options: { mode: "explicit" } },
    { prompt_cache_options: null },
    { prompt_cache_retention: "24h" },
  ] satisfies Array<Partial<ResponsesPayload>>)(
    "leaves client-managed policy untouched",
    (overrides) => {
      const request = payload(overrides)
      const result = applyResponsesCachePolicy(request, context)
      expect(result.payload).toBe(request)
      expect(result.summary.status).toBe("client_managed")
    },
  )

  test("does not compete with existing client breakpoints", () => {
    const request = payload({
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "rules",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
      ],
    })
    expect(applyResponsesCachePolicy(request, context).payload).toBe(request)
  })

  test("is idempotent when the caller reuses a policy-adapted payload", () => {
    const first = applyResponsesCachePolicy(payload(), context).payload
    expect(applyResponsesCachePolicy(first, context).payload).toBe(first)
  })

  test("does not mistake a JSON schema property for a client breakpoint", () => {
    const request = payload({
      tools: [
        {
          type: "function",
          name: "tool",
          parameters: {
            properties: { prompt_cache_breakpoint: { type: "string" } },
          },
        },
      ],
    })
    expect(applyResponsesCachePolicy(request, context).summary.status).toBe(
      "applied",
    )
  })
})

describe("cache scope and protocol boundaries", () => {
  test("changes generated keys when scope or fixed configuration changes", () => {
    const base = payload()
    const first = applyResponsesCachePolicy(base, context).payload
      .prompt_cache_key
    for (const change of [
      { instructions: "New instructions" },
      { model: "gpt-5.6-sol" },
      { reasoning: { effort: "medium" as const } },
      { tools: [] },
    ]) {
      expect(
        applyResponsesCachePolicy({ ...base, ...change }, context).payload
          .prompt_cache_key,
      ).not.toBe(first)
    }
    expect(
      applyResponsesCachePolicy(base, { ...context, accountType: "individual" })
        .payload.prompt_cache_key,
    ).not.toBe(first)
    process.env.COPILOT_CACHE_NAMESPACE = "another-account"
    expect(
      applyResponsesCachePolicy(base, context).payload.prompt_cache_key,
    ).not.toBe(first)
  })

  test("preserves tool order and treats reordered tools as a new configuration", () => {
    const a = { type: "function" as const, name: "a", parameters: {} }
    const b = { type: "function" as const, name: "b", parameters: {} }
    const first = applyResponsesCachePolicy(
      payload({ tools: [a, b] }),
      context,
    ).payload
    const second = applyResponsesCachePolicy(
      payload({ tools: [b, a] }),
      context,
    ).payload
    expect(second.tools).toEqual([b, a])
    expect(first.prompt_cache_key).not.toBe(second.prompt_cache_key)
  })

  test("never invents a cross-user key without a configured namespace", () => {
    delete process.env.COPILOT_CACHE_NAMESPACE
    const result = applyResponsesCachePolicy(payload(), context)
    expect(result.payload.prompt_cache_key).toBeUndefined()
    expect(result.summary.key_source).toBe("absent")
    expect(result.summary.breakpoint_added).toBe(true)
  })

  test("preserves an explicit null key", () => {
    expect(
      applyResponsesCachePolicy(payload({ prompt_cache_key: null }), context)
        .payload.prompt_cache_key,
    ).toBeNull()
  })

  test.each(["gpt-5.5", "gpt-4.1", "claude-sonnet-5", "unknown-model"])(
    "does not guess support for %s",
    (model) => {
      const request = payload({ model })
      expect(applyResponsesCachePolicy(request, context).payload).toBe(request)
    },
  )

  test("never applies this policy to Chat Completions", () => {
    const request = payload()
    expect(
      applyResponsesCachePolicy(request, {
        ...context,
        endpoint: "/chat/completions",
      }).payload,
    ).toBe(request)
  })

  test.each([
    { previous_response_id: "response-id" },
    { conversation: "conversation-id" },
  ])("leaves server-side continuation state untouched", (overrides) => {
    const request = payload(overrides)
    expect(applyResponsesCachePolicy(request, context).payload).toBe(request)
  })

  test("does not move instructions or put a static-prefix marker after user input", () => {
    const request = payload({
      input: [
        { role: "user", content: "dynamic" },
        { role: "developer", content: "later rules" },
      ],
    })
    const result = applyResponsesCachePolicy(request, context)
    expect(result.payload.input).toBe(request.input)
    expect(result.payload.instructions).toBe(request.instructions)
    expect(result.payload.prompt_cache_options).toBeUndefined()
    expect(result.summary.status).toBe("key_only")
  })

  test("reports no eligible prefix when only a raw string and no scope are available", () => {
    delete process.env.COPILOT_CACHE_NAMESPACE
    const request = payload({ input: "hello" })
    const result = applyResponsesCachePolicy(request, context)
    expect(result.payload).toBe(request)
    expect(result.summary.status).toBe("no_prefix")
  })
})

describe("cache policy egress", () => {
  test("different user suffixes keep the same marked prefix and key", () => {
    const first = applyResponsesCachePolicy(payload(), context).payload
    const second = applyResponsesCachePolicy(
      payload({
        input: [
          { role: "developer", content: "Stable repository rules" },
          { role: "user", content: "Fix another issue" },
        ],
      }),
      context,
    ).payload
    expect(first.input[0]).toEqual(second.input[0])
    expect(first.input[1]).not.toEqual(second.input[1])
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key)
    expect(first.prompt_cache_options?.mode).toBe("implicit")
  })

  test("adds a marker to the last text block without changing earlier blocks", () => {
    const parts = [
      { type: "input_text" as const, text: "first" },
      { type: "input_text" as const, text: "second" },
    ]
    const request = payload({ input: [{ role: "developer", content: parts }] })
    const result = applyResponsesCachePolicy(request, context).payload
    expect(result.input[0]).toEqual({
      role: "developer",
      content: [
        parts[0],
        { ...parts[1], prompt_cache_breakpoint: { mode: "explicit" } },
      ],
    })
    expect(request.input[0]).toEqual({ role: "developer", content: parts })
  })

  test("rejects a mistyped policy before making an upstream request", async () => {
    process.env.COPILOT_CACHE_POLICY = "prefix-typo"
    const upstream = mock(() => Promise.resolve(Response.json({})))
    globalThis.fetch = upstream as unknown as typeof fetch
    const error = await createResponses(payload()).catch(
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({
      message: "COPILOT_CACHE_POLICY must be off or prefix-v1",
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  test("uses normalized tools in its key and sends the breakpoint on the real egress path", async () => {
    const bodies: Array<unknown> = []
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON")
      const body: unknown = JSON.parse(init.body)
      bodies.push(body)
      return Promise.resolve(Response.json({ object: "response", output: [] }))
    }) as unknown as typeof fetch
    const request = payload({
      tools: [
        { type: "function", name: "tool", description: "", parameters: {} },
      ],
    })
    await createResponses(request)
    await createResponses({
      ...request,
      tools: [{ type: "function", name: "tool", parameters: {} }],
    })
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
      input: [
        {
          role: "developer",
          content: [{ prompt_cache_breakpoint: { mode: "explicit" } }],
        },
        { role: "user", content: "Fix the first issue" },
      ],
    })
  })

  test("does not retry when Copilot rejects a cache parameter", async () => {
    const upstream = mock(() =>
      Promise.resolve(
        Response.json(
          { error: { message: "Unsupported prompt_cache_options" } },
          { status: 400 },
        ),
      ),
    )
    globalThis.fetch = upstream as unknown as typeof fetch
    const error = await createResponses(payload()).catch(
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({ response: { status: 400 } })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  test("rejects cache breakpoints at the fallback boundary instead of silently dropping them", () => {
    const request = payload({
      model: "gpt-4.1",
      reasoning: undefined,
      tools: undefined,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "rules",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
      ],
    })
    expect(validateResponsesFallback(request)?.param).toBe(
      "input[0].content[0].prompt_cache_breakpoint",
    )
  })

  test("preserves caller tool-result breakpoints on native and rejects them on fallback", () => {
    const request = payload({
      reasoning: undefined,
      tools: undefined,
      input: [
        {
          type: "function_call_output",
          call_id: "call1",
          output: [
            {
              type: "input_text",
              text: "result",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
      ],
    } as unknown as Partial<ResponsesPayload>)
    expect(applyResponsesCachePolicy(request, context).payload).toBe(request)
    expect(
      validateResponsesFallback({ ...request, model: "gpt-4.1" })?.param,
    ).toBe("input[0].output[0].prompt_cache_breakpoint")
  })
})
