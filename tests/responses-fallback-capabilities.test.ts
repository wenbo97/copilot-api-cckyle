import { afterEach, describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { validateResponsesFallback } from "../src/routes/responses/fallback-capabilities"
import {
  translateToOpenAI,
  translateToResponses,
} from "../src/routes/responses/non-stream-translation"
import { server } from "../src/server"

const setChatModel = (supports: Record<string, unknown> = {}) => {
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-4.1",
        supported_endpoints: ["/chat/completions"],
        capabilities: { supports },
      },
    ],
  } as unknown as ModelsResponse
}

const payload = (overrides: Record<string, unknown> = {}): ResponsesPayload =>
  ({ model: "gpt-4.1", input: "hello", ...overrides }) as ResponsesPayload

afterEach(() => {
  state.models = undefined
})

describe("Responses -> Chat fallback capability matrix", () => {
  test("maps parallel tools, strict functions, supported reasoning, and JSON Schema", () => {
    setChatModel({
      parallel_tool_calls: true,
      reasoning_effort: ["low", "medium", "high"],
      structured_outputs: true,
      tool_calls: true,
    })
    const request = payload({
      parallel_tool_calls: true,
      reasoning: { effort: "medium" },
      text: {
        format: {
          type: "json_schema",
          name: "result",
          description: "A result object.",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    })

    expect(validateResponsesFallback(request)).toBeUndefined()
    const translated = translateToOpenAI(request)
    expect(translated.parallel_tool_calls).toBe(true)
    expect(translated.reasoning_effort).toBe("medium")
    expect(translated.tools?.[0].function.strict).toBe(true)
    expect(translated.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "result",
        description: "A result object.",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
        strict: true,
      },
    })
  })

  test("allows explicit defaults and preserves metadata in a non-stream response", () => {
    setChatModel()
    const request = payload({
      store: false,
      truncation: "disabled",
      text: { format: { type: "text" } },
      metadata: { request_id: "local-1" },
      previous_response_id: null,
      conversation: null,
    })

    expect(validateResponsesFallback(request)).toBeUndefined()
    expect(
      translateToResponses(
        {
          id: "chatcmpl_1",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        },
        request.metadata,
      ).metadata,
    ).toEqual({ request_id: "local-1" })
  })

  test("maps common Chat-compatible Responses controls and allows Codex defaults", () => {
    setChatModel()
    const request = payload({
      stream: true,
      stream_options: { include_obfuscation: false },
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      prompt_cache_key: "workspace-a",
      prompt_cache_retention: "in_memory",
      safety_identifier: "local-user",
      service_tier: "fast",
      user: "local-user",
      reasoning: { context: "current_turn", summary: null },
      text: { format: { type: "text" }, verbosity: "medium" },
    })

    expect(validateResponsesFallback(request)).toBeUndefined()
    expect(translateToOpenAI(request)).toMatchObject({
      stream: true,
      stream_options: { include_obfuscation: false },
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      prompt_cache_key: "workspace-a",
      prompt_cache_retention: "in_memory",
      safety_identifier: "local-user",
      service_tier: "fast",
      user: "local-user",
    })
  })
})

describe("Responses -> Chat fallback rejection and replay rules", () => {
  test.each([
    ["previous_response_id", { previous_response_id: "resp_previous" }],
    ["conversation", { conversation: "conv_1" }],
    ["store", { store: true }],
    ["truncation", { truncation: "auto" }],
    ["background", { background: true }],
  ])("rejects unsupported top-level feature %s", (param, overrides) => {
    setChatModel()
    expect(validateResponsesFallback(payload(overrides))).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_feature",
      param,
    })
  })

  test("the HTTP handler applies the guard after selecting Chat fallback", async () => {
    setChatModel()
    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: "continue",
        previous_response_id: "resp_previous",
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unsupported_feature",
        param: "previous_response_id",
        message:
          'previous_response_id requires native Responses support; model "gpt-4.1" is using the /chat/completions fallback.',
      },
    })
  })

  test("rejects input_file and non-function tools instead of dropping them", () => {
    setChatModel({ tool_calls: true })
    const fileRequest = payload({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,AAAA",
            },
          ],
        },
      ],
    })
    expect(validateResponsesFallback(fileRequest)).toMatchObject({
      code: "unsupported_feature",
      param: "input[0].content[0]",
    })

    for (const type of ["mcp", "computer", "file_search", "namespace"]) {
      expect(
        validateResponsesFallback(
          payload({ tools: [{ type, name: "unsupported" }] }),
        ),
      ).toMatchObject({
        code: "unsupported_feature",
        param: "tools[0]",
      })
    }
  })

  test("rejects unsupported reasoning and structured output for the target model", () => {
    setChatModel({ reasoning_effort: ["low"] })
    expect(
      validateResponsesFallback(payload({ reasoning: { effort: "high" } })),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "reasoning.effort",
    })
    expect(
      validateResponsesFallback(
        payload({
          text: {
            format: {
              type: "json_schema",
              name: "result",
              schema: { type: "object" },
            },
          },
        }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "text.format",
    })
    expect(
      validateResponsesFallback(
        payload({ text: { format: { type: "text" }, verbosity: "high" } }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "text.verbosity",
    })
    expect(
      validateResponsesFallback(
        payload({ reasoning: { context: "all_previous_turns" } }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "reasoning.context",
    })
    expect(
      validateResponsesFallback(
        payload({ stream: true, stream_options: { include_usage: true } }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "stream_options.include_usage",
    })
    expect(
      validateResponsesFallback(
        payload({
          stream: true,
          stream_options: { include_obfuscation: true },
        }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "stream_options.include_obfuscation",
    })
    expect(
      validateResponsesFallback(payload({ top_logprobs: 2 })),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "top_logprobs",
    })
  })
})

describe("Responses -> Chat fallback advertised capabilities and replay", () => {
  test("fails closed when the catalog does not advertise requested capabilities", () => {
    setChatModel()

    expect(
      validateResponsesFallback(payload({ parallel_tool_calls: true })),
    ).toMatchObject({ param: "parallel_tool_calls" })
    expect(
      validateResponsesFallback(
        payload({
          tools: [
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      ),
    ).toMatchObject({ param: "tools[0]" })
    expect(
      validateResponsesFallback(
        payload({
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: "data:image/png;base64,AA" },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({ param: "input[0].content[0]" })
  })

  test("rejects strict function tools unless structured outputs are advertised", () => {
    setChatModel({ tool_calls: true })
    expect(
      validateResponsesFallback(
        payload({
          tools: [
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "unsupported_feature", param: "tools[0].strict" })
  })

  test("rejects unknown semantic fields nested inside mapped formats and tools", () => {
    setChatModel({ structured_outputs: true, tool_calls: true })
    expect(
      validateResponsesFallback(
        payload({
          text: { format: { type: "text", future_mode: "semantic" } },
        }),
      ),
    ).toMatchObject({ param: "text.format.future_mode" })

    expect(
      validateResponsesFallback(
        payload({
          tools: [
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: {} },
              defer_loading: true,
            },
          ],
        }),
      ),
    ).toMatchObject({ param: "tools[0].defer_loading" })
  })

  test("accepts known Codex replay artifacts but rejects an unknown semantic item", () => {
    setChatModel()
    const replay = payload({
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque",
          summary: [],
        },
        {
          type: "additional_tools",
          role: "developer",
          tools: [],
        },
        {
          type: "agent_message",
          content: [{ type: "input_text", text: "delegated result" }],
        },
      ],
    })
    expect(validateResponsesFallback(replay)).toBeUndefined()
    expect(translateToOpenAI(replay).messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "delegated result" }],
      },
    ])

    expect(
      validateResponsesFallback(
        payload({
          input: [{ type: "future_semantic_item", value: "meaningful" }],
        }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "input[0].type",
    })

    expect(
      validateResponsesFallback(
        payload({
          input: [
            {
              role: "user",
              content: [{ type: "future_text", text: "do not silently map" }],
            },
          ],
        }),
      ),
    ).toMatchObject({
      code: "unsupported_feature",
      param: "input[0].content[0]",
    })
  })
})
