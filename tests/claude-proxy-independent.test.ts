import { afterEach, beforeEach, expect, test } from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { truncateToolName } from "~/routes/_shared/tool-name"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const previousState = { ...state }
const previousLevel = consola.level
const longName = `mcp__isolated__${"private_tool_".repeat(8)}`
type Json = Record<string, unknown>
let outbound: Array<Json>

beforeEach(() => {
  outbound = []
  consola.level = -999
  Object.assign(state, {
    copilotToken: "offline-independent",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    accountType: "individual",
    manualApprove: false,
    traceEnabled: false,
    rateLimitSeconds: undefined,
    models: {
      object: "list",
      data: [
        {
          id: "offline-independent",
          supported_endpoints: ["/responses"],
          capabilities: { supports: {} },
        },
      ],
    } as unknown as ModelsResponse,
  })
  globalThis.fetch = Object.assign(
    (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request")
      const body = JSON.parse(init.body) as Json
      outbound.push(body)
      const tools = body.tools as Array<{ name: string }> | undefined
      return Promise.resolve(
        Response.json({
          id: "resp_independent",
          object: "response",
          created_at: 1,
          model: "offline-independent",
          status: "completed",
          output:
            tools?.length ?
              [
                {
                  type: "function_call",
                  call_id: "call_next",
                  name: tools[0].name,
                  arguments: "{}",
                },
              ]
            : [],
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, previousState)
  consola.level = previousLevel
})

function request(extra: Json) {
  return server.request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "offline-independent",
      max_tokens: 20,
      stream: false,
      messages: [{ role: "user", content: "continue" }],
      ...extra,
    }),
  })
}

test("independent: long tool mapping covers definition, forced choice, history and JSON return", async () => {
  const result = await request({
    tools: [{ name: longName, input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: longName },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_before", name: longName, input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_before" }],
      },
    ],
  })
  expect(result.status).toBe(200)
  const body = (await result.json()) as { content: Array<{ name?: string }> }
  expect(body.content[0].name).toBe(longName)
  const translated = outbound[0] as {
    tools: Array<{ name: string }>
    tool_choice: { name: string }
    input: Array<{ name?: string; output?: unknown }>
  }
  expect(translated.tools[0].name).toBe(truncateToolName(longName))
  expect(translated.tool_choice.name).toBe(translated.tools[0].name)
  expect(translated.input[0].name).toBe(translated.tools[0].name)
  expect(translated.input[1].output).toBe("")

  // A new request may intentionally define the former upstream alias as its own name.
  const alias = truncateToolName(longName)
  const second = await request({
    tools: [{ name: alias, input_schema: { type: "object" } }],
  })
  expect(second.status).toBe(200)
  const secondBody = (await second.json()) as {
    content: Array<{ name?: string }>
  }
  expect(secondBody.content[0].name).toBe(alias)
})

test("independent: a literal name colliding with a shortened long name fails before fetch", async () => {
  const response = await request({
    tools: [longName, truncateToolName(longName)].map((name) => ({
      name,
      input_schema: { type: "object" },
    })),
  })
  expect(response.status).toBe(400)
  expect(outbound).toHaveLength(0)
})

test.each([
  {
    type: "image",
    source: { type: "url", url: "https://example.invalid/image.png" },
  },
  { type: "image", source: { type: "base64", media_type: "image/png" } },
  {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "QQ==" },
  },
])(
  "independent: unsupported nested tool result is local400: %j",
  async (block) => {
    const response = await request({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_before",
              content: [block],
            },
          ],
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(outbound).toHaveLength(0)
  },
)

test("independent: mixed tool-result image/text and enclosing message order survive", async () => {
  const response = await request({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "before result" },
          {
            type: "tool_result",
            tool_use_id: "call_image",
            content: [
              { type: "text", text: "before image" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
              { type: "text", text: "after image" },
            ],
          },
          { type: "text", text: "after result" },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(outbound[0].input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "before result" }] },
    {
      type: "function_call_output",
      call_id: "call_image",
      output: [
        { type: "input_text", text: "before image" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,iVBORw0KGgo=",
        },
        { type: "input_text", text: "after image" },
      ],
    },
    { role: "user", content: [{ type: "input_text", text: "after result" }] },
  ])
})
