import { test, expect, mock, beforeEach, describe } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"

import { state } from "../src/lib/state"
import { COPILOT_COLLABORATION_NAMESPACE } from "../src/routes/_shared/collaboration-compat"
import { UNREADABLE_PAYLOAD_MARKER } from "../src/routes/_shared/encrypted-content"
import { server } from "../src/server"
import {
  createResponses,
  sanitizeReasoningItem,
  stripEncryptedContentParts,
} from "../src/services/copilot/create-responses"

// Mock state so copilotFetch's ensureCopilotToken() short-circuits (valid,
// non-expiring token) and we never hit the real token-refresh path.
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600

const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => ({
    ok: true,
    status: 200,
    json: () => ({ id: "resp_1", object: "response", output: [] }),
    headers: opts.headers,
  }),
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
  state.models = undefined
})

const callArgs = () =>
  fetchMock.mock.calls[0] as unknown as [
    string,
    { headers: Record<string, string>; body: string; method: string },
  ]

test("POSTs to the /responses endpoint", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: "hello",
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const [url, opts] = callArgs()
  expect(url).toEndWith("/responses")
  expect(opts.method).toBe("POST")
})

test("forwards the payload body unchanged", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.5",
    input: "hi",
    temperature: 0.5,
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(JSON.parse(opts.body)).toEqual(payload)
})

test("maps ultra to the catalog max tier before Responses egress", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-5.6-sol",
        capabilities: {
          supports: {
            reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
    ],
  } as unknown as NonNullable<typeof state.models>

  await createResponses({
    model: "gpt-5.6-sol",
    input: "hi",
    reasoning: { effort: "ultra" },
  } as unknown as ResponsesPayload)

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as { reasoning: { effort: string } }
  expect(body.reasoning.effort).toBe("max")
})

test("rejects an unknown Responses reasoning effort before Copilot egress", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-5.6-sol",
        supported_endpoints: ["/responses"],
        capabilities: {
          supports: {
            reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
    ],
  } as unknown as NonNullable<typeof state.models>

  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "hi",
      reasoning: { effort: "ludicrous" },
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      message: 'Unknown reasoning effort "ludicrous".',
      type: "invalid_request_error",
      code: "invalid_reasoning_effort",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("exposes live model capabilities and limits from /v1/models", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        vendor: "OpenAI",
        supported_endpoints: ["/responses", "ws:/responses"],
        capabilities: {
          family: "gpt-5.6-sol",
          limits: {
            max_context_window_tokens: 1_050_000,
            max_output_tokens: 128_000,
          },
          object: "model_capabilities",
          supports: {
            tool_calls: true,
            parallel_tool_calls: true,
            reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
            streaming: true,
            structured_outputs: true,
            vision: true,
          },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  } as unknown as NonNullable<typeof state.models>

  const response = await server.request("http://localhost/v1/models")
  const body = (await response.json()) as {
    data: Array<Record<string, unknown>>
  }

  expect(response.status).toBe(200)
  expect(body.data[0].capabilities).toEqual({
    family: "gpt-5.6-sol",
    limits: {
      max_context_window_tokens: 1_050_000,
      max_output_tokens: 128_000,
    },
    object: "model_capabilities",
    supports: {
      tool_calls: true,
      parallel_tool_calls: true,
      reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
      streaming: true,
      structured_outputs: true,
      vision: true,
    },
    tokenizer: "o200k_base",
    type: "chat",
  })
})

test("fills an empty namespace description before Responses egress", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: "hi",
    tools: [
      {
        type: "namespace",
        name: "workspace",
        description: "",
        tools: [
          {
            type: "function",
            name: "search_code",
            description: "Searches source code.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
  })

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    tools: Array<Record<string, unknown>>
  }
  expect(body.tools[0].description).toBe('Tools in the "workspace" namespace.')
})

test("leaves arbitrary agent_message tools unchanged", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "agent_message",
        content: [{ type: "input_text", text: "hi" }],
        tools: [
          {
            type: "function",
            name: "search_code",
            description: "",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
  } as unknown as ResponsesPayload)

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    input: Array<{ tools: Array<Record<string, unknown>> }>
  }
  expect(body.input[0].tools[0].description).toBe("")
})

test("normalizes Codex additional_tools items before Responses egress", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              {
                type: "function",
                name: "shell_command",
                description: "",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as ResponsesPayload)

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    input: Array<{ tools: Array<Record<string, unknown>> }>
  }
  expect(body.input[0].tools[0].description).toBe(
    'Tools in the "functions" namespace.',
  )
  const children = body.input[0].tools[0].tools as Array<
    Record<string, unknown>
  >
  expect("description" in children[0]).toBe(false)
})

test("aliases collaboration and disables message encryption before Responses egress", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: "hi",
    tools: [
      {
        type: "namespace",
        name: "collaboration",
        description: "Coordinate sub-agents.",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            description: "Spawn an agent.",
            parameters: {
              type: "object",
              properties: {
                task_name: { type: "string" },
                message: { type: "string", encrypted: true },
              },
            },
          },
        ],
      },
    ],
  } as unknown as ResponsesPayload)

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    tools: Array<{
      name: string
      tools: Array<{
        parameters: {
          properties: { message: { encrypted?: boolean } }
        }
      }>
    }>
  }
  expect(body.tools[0].name).toBe(COPILOT_COLLABORATION_NAMESPACE)
  expect(body.tools[0].tools[0].parameters.properties.message.encrypted).toBe(
    false,
  )
})

test("omits blank function descriptions before Responses egress", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "empty_description",
        description: "",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "whitespace_description",
        description: "   ",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "described",
        description: "Reads a local file.",
        parameters: { type: "object", properties: {} },
      },
    ],
  })

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    tools: Array<Record<string, unknown>>
  }
  expect("description" in body.tools[0]).toBe(false)
  expect("description" in body.tools[1]).toBe(false)
  expect(body.tools[2].description).toBe("Reads a local file.")
})

test("enables Copilot vision for image and PDF Responses input", async () => {
  for (const part of [
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    {
      type: "input_file",
      filename: "sample.pdf",
      file_data: "data:application/pdf;base64,AAAA",
    },
  ]) {
    fetchMock.mockClear()
    await createResponses({
      model: "gpt-5.6-sol",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Read the attachment." }, part],
        },
      ],
    } as unknown as ResponsesPayload)

    const [, opts] = callArgs()
    expect(opts.headers["copilot-vision-request"]).toBe("true")
  }
})

test("fills missing or blank namespace descriptions and normalizes children", async () => {
  await createResponses({
    model: "gpt-5.6-sol",
    input: "hi",
    tools: [
      {
        type: "namespace",
        name: "workspace",
        tools: [],
      },
      {
        type: "namespace",
        name: "",
        description: "   ",
        tools: [
          {
            type: "function",
            name: "search_code",
            description: "   ",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ],
  } as unknown as ResponsesPayload)

  const [, opts] = callArgs()
  const body = JSON.parse(opts.body) as {
    tools: Array<Record<string, unknown>>
  }
  expect(body.tools[0].description).toBe('Tools in the "workspace" namespace.')
  expect(body.tools[1].description).toBe("Tool namespace.")
  const children = body.tools[1].tools as Array<Record<string, unknown>>
  expect("description" in children[0]).toBe(false)
})

test("sets X-Initiator to user for a plain user request", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: [{ role: "user", content: "hi" }],
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when an assistant message is present", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.3-codex",
    input: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "previous turn" },
    ],
  }
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to agent when a function_call_output is present", async () => {
  const payload = {
    model: "gpt-5.3-codex",
    input: [
      { role: "user", content: "hi" },
      { type: "function_call_output", call_id: "c1", output: "42" },
    ],
  } as ResponsesPayload
  await createResponses(payload)
  const [, opts] = callArgs()
  expect(opts.headers["X-Initiator"]).toBe("agent")
})

describe("sanitizeReasoningItem (litellm port)", () => {
  test("preserves encrypted_content; drops status:null", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: null,
      encrypted_content: "BLOB",
      content: [],
    })
    expect(cleaned.encrypted_content).toBe("BLOB")
    expect("status" in cleaned).toBe(false)
  })

  test("keeps a non-null status", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: "completed",
      encrypted_content: "BLOB",
    })
    expect(cleaned.status).toBe("completed")
  })

  test("drops other null fields but keeps non-null ones", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      encrypted_content: "BLOB",
      summary: null,
      content: [{ type: "reasoning_text", text: "x" }],
    })
    expect("summary" in cleaned).toBe(false)
    expect(cleaned.content).toEqual([{ type: "reasoning_text", text: "x" }])
    expect(cleaned.type).toBe("reasoning")
    expect(cleaned.id).toBe("r")
  })

  test("omits encrypted_content when it is absent (does not invent a key)", () => {
    const cleaned = sanitizeReasoningItem({
      type: "reasoning",
      id: "r",
      status: "completed",
    })
    expect("encrypted_content" in cleaned).toBe(false)
  })
})

// Regression: a Codex sub-agent (skill) turn replays as an `agent_message` item
// carrying an `encrypted_content` content part. Copilot accepts it at schema
// level, fails to decrypt it, and kills the response with a bare
// `response.failed` (error: null) — Codex reports "stream disconnected before
// completion". Verified against the live backend: the same request goes green
// once the part is removed, and red again with a 3-byte ciphertext, so it is the
// part TYPE that is fatal, not its size.
describe("stripEncryptedContentParts", () => {
  const agentMessage = {
    type: "agent_message",
    id: "amsg_1",
    author: "/root/command_skills",
    recipient: "/root",
    content: [
      { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAABqar7I..." },
    ],
  }

  test("replaces the encrypted part with a marker, keeping the item's other fields", () => {
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [agentMessage],
    } as unknown as ResponsesPayload)

    const [item] = out.input as unknown as Array<Record<string, unknown>>
    expect(item.content).toEqual([
      { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
      { type: "input_text", text: UNREADABLE_PAYLOAD_MARKER },
    ])
    expect(item.type).toBe("agent_message")
    expect(item.author).toBe("/root/command_skills")
  })

  test("keeps an item whose only part was ciphertext, as a lone marker", () => {
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [
        { ...agentMessage, content: [agentMessage.content[1]] },
        { role: "user", content: "hi" },
      ],
    } as unknown as ResponsesPayload)

    const items = out.input as unknown as Array<Record<string, unknown>>
    expect(items[0].content).toEqual([
      { type: "input_text", text: UNREADABLE_PAYLOAD_MARKER },
    ])
    expect(items[1]).toEqual({ role: "user", content: "hi" })
  })

  // An assistant-role item may only carry `output_text`; an `input_text` marker
  // inside one is exactly the shape the backend 400s on.
  test("uses output_text for the marker when the item's own text parts do", () => {
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "prior turn" },
            { type: "encrypted_content", encrypted_content: "gAAAA" },
          ],
        },
      ],
    } as unknown as ResponsesPayload)

    const [item] = out.input as unknown as Array<Record<string, unknown>>
    expect(item.content).toEqual([
      { type: "output_text", text: "prior turn" },
      { type: "output_text", text: UNREADABLE_PAYLOAD_MARKER },
    ])
  })

  test("leaves the top-level encrypted_content FIELD on reasoning items alone", () => {
    const reasoning = {
      type: "reasoning",
      id: "r",
      encrypted_content: "COPILOT_BLOB",
      summary: [],
    }
    const out = stripEncryptedContentParts({
      model: "gpt-5.6-sol",
      input: [reasoning],
    } as unknown as ResponsesPayload)

    expect(out.input).toEqual([
      reasoning,
    ] as unknown as ResponsesPayload["input"])
  })

  test("returns the payload untouched when no encrypted part is present", () => {
    const payload = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hi" }],
    } as unknown as ResponsesPayload

    expect(stripEncryptedContentParts(payload)).toBe(payload)
  })

  test("createResponses never puts an encrypted_content part on the wire", async () => {
    await createResponses({
      model: "gpt-5.6-sol",
      input: [agentMessage, { role: "user", content: "hi" }],
    } as unknown as ResponsesPayload)

    const [, opts] = callArgs()
    expect(opts.body).not.toContain("encrypted_content")
  })
})
