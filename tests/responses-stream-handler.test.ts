import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { COPILOT_COLLABORATION_NAMESPACE } from "../src/routes/_shared/collaboration-compat"
import { server } from "../src/server"

const originalFetch = globalThis.fetch

beforeEach(() => {
  state.copilotToken = "test-token"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.traceEnabled = false
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
})

describe("Responses streaming HTTP lifecycle", () => {
  test("keeps native Responses features outside the Chat fallback guard", async () => {
    setModel("gpt-5.6-sol", ["/responses"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "resp_native",
          object: "response",
          created_at: 1,
          model: "gpt-5.6-sol",
          status: "completed",
          output: [],
          error: null,
          incomplete_details: null,
        }),
      ),
    ) as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "continue",
        previous_response_id: "resp_previous",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: "resp_native",
      status: "completed",
    })
  })
})

describe("Responses collaboration compatibility", () => {
  test("restores plaintext collaboration calls in native non-stream responses", async () => {
    setModel("gpt-5.6-sol", ["/responses"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "resp_collaboration",
          object: "response",
          created_at: 1,
          model: "gpt-5.6-sol",
          status: "completed",
          output: [collaborationCall("fc_non_stream")],
          error: null,
          incomplete_details: null,
        }),
      ),
    ) as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "delegate" }),
    })
    const body = (await response.json()) as {
      output: Array<Record<string, unknown>>
    }

    expect(body.output[0]).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    })
  })

  test("restores plaintext collaboration calls before streaming them", async () => {
    setModel("gpt-5.6-sol", ["/responses"])
    const call = collaborationCall("fc_stream")
    const responseObject = {
      id: "resp_collaboration_stream",
      object: "response",
      created_at: 1,
      model: "gpt-5.6-sol",
      status: "completed",
      output: [call],
      error: null,
      incomplete_details: null,
    }
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: call,
          }),
          JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: responseObject,
          }),
        ]),
      ),
    ) as unknown as typeof fetch

    const response = await streamingRequest("gpt-5.6-sol")
    const events = parseSseData(await response.text())
    const added = events[0].item as Record<string, unknown>
    const completedResponse = events[1].response as {
      output: Array<Record<string, unknown>>
    }

    expect(added).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    })
    expect(completedResponse.output[0]).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    })
  })
})

describe("Responses streaming HTTP lifecycle", () => {
  test("turns fallback [DONE] without finish_reason into one response.failed", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({
            id: "chatcmpl_http",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4.1",
            choices: [
              {
                index: 0,
                delta: { content: "partial" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
          "[DONE]",
        ]),
      ),
    ) as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: "hello",
        stream: true,
      }),
    })
    const events = parseSseData(await response.text())
    const terminals = events.filter((event) => isTerminalEvent(event))

    expect(response.status).toBe(200)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        output: [
          {
            type: "message",
            status: "incomplete",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
    })
  })

  test("turns native [DONE] without a terminal event into one response.failed", async () => {
    setModel("gpt-5.6-sol", ["/responses"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({
            type: "response.created",
            sequence_number: 1,
            response: {
              id: "resp_http",
              object: "response",
              created_at: 1,
              model: "gpt-5.6-sol",
              status: "in_progress",
              output: [],
              error: null,
              incomplete_details: null,
            },
          }),
          JSON.stringify({
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          }),
          JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: 3,
            output_index: 0,
            content_index: 0,
            item_id: "msg_1",
            delta: "partial",
          }),
          "[DONE]",
        ]),
      ),
    ) as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "hello",
        stream: true,
      }),
    })
    const events = parseSseData(await response.text())
    const terminals = events.filter((event) => isTerminalEvent(event))

    expect(response.status).toBe(200)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      type: "response.failed",
      sequence_number: 4,
      response: {
        status: "failed",
        output: [
          {
            id: "msg_1",
            status: "incomplete",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
    })
  })

  test("accepts a fallback finish_reason even when [DONE] is missing", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          chatChunk({ content: "complete" }),
          chatChunk({}, "stop"),
        ]),
      ),
    ) as unknown as typeof fetch

    const response = await streamingRequest("gpt-4.1")
    const events = parseSseData(await response.text())
    const terminals = events.filter((event) => isTerminalEvent(event))

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    })
  })

  test("turns fallback EOF without finish_reason into one response.failed", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    globalThis.fetch = mock(() =>
      Promise.resolve(sseResponse([chatChunk({ content: "partial" })])),
    ) as unknown as typeof fetch

    const response = await streamingRequest("gpt-4.1")
    const events = parseSseData(await response.text())
    const terminals = events.filter((event) => isTerminalEvent(event))

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      type: "response.failed",
      response: { status: "failed" },
    })
  })
})

describe("Responses streaming HTTP failures and cancellation", () => {
  test("uses an official error event when fallback JSON fails before creation", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    globalThis.fetch = mock(() =>
      Promise.resolve(sseResponse(["{"])),
    ) as unknown as typeof fetch

    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: "hello",
        stream: true,
      }),
    })
    const events = parseSseData(await response.text())

    expect(events).toEqual([
      {
        type: "error",
        sequence_number: 1,
        code: "invalid_upstream_response",
        message:
          "Upstream Chat Completions stream failed: Upstream SSE contained invalid JSON.",
        param: null,
      },
    ])
  })

  test("uses response.failed when fallback JSON breaks after creation", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    globalThis.fetch = mock(() =>
      Promise.resolve(sseResponse([chatChunk({ content: "partial" }), "{"])),
    ) as unknown as typeof fetch

    const response = await streamingRequest("gpt-4.1")
    const events = parseSseData(await response.text())
    const terminals = events.filter((event) => isTerminalEvent(event))

    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        output: [
          {
            status: "incomplete",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      },
    })
  })

  test("forwards a native official error as the only terminal event", async () => {
    setModel("gpt-5.6-sol", ["/responses"])
    globalThis.fetch = mock(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({
            type: "error",
            sequence_number: 1,
            code: "server_error",
            message: "backend unavailable",
            param: null,
          }),
        ]),
      ),
    ) as unknown as typeof fetch

    const response = await streamingRequest("gpt-5.6-sol")
    const terminals = parseSseData(await response.text()).filter((event) =>
      isTerminalEvent(event),
    )

    expect(terminals).toEqual([
      {
        type: "error",
        sequence_number: 1,
        code: "server_error",
        message: "backend unavailable",
        param: null,
      },
    ])
  })

  test("propagates downstream cancellation without writing a terminal event", async () => {
    setModel("gpt-4.1", ["/chat/completions"])
    let fetchSignal: AbortSignal | undefined
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                fetchSignal?.addEventListener(
                  "abort",
                  () => controller.error(fetchSignal?.reason),
                  { once: true },
                )
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        )
      },
    ) as unknown as typeof fetch

    const downstream = new AbortController()
    const response = await server.request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: "hello",
        stream: true,
      }),
      signal: downstream.signal,
    })
    const bodyPromise = response.text().catch(() => "")
    const reason = new DOMException("client disconnected", "AbortError")
    downstream.abort(reason)
    const body = await bodyPromise

    expect(fetchSignal?.aborted).toBe(true)
    expect(fetchSignal?.reason).toBe(reason)
    expect(body).not.toContain("response.failed")
  })
})

function setModel(id: string, supportedEndpoints: Array<string>): void {
  state.models = {
    object: "list",
    data: [
      {
        id,
        supported_endpoints: supportedEndpoints,
        capabilities: {
          supports: {
            streaming: true,
            tool_calls: true,
            parallel_tool_calls: true,
            structured_outputs: true,
            vision: true,
          },
        },
      },
    ],
  } as unknown as ModelsResponse
}

function collaborationCall(id: string): Record<string, unknown> {
  return {
    type: "function_call",
    id,
    call_id: `call_${id}`,
    namespace: COPILOT_COLLABORATION_NAMESPACE,
    name: "spawn_agent",
    arguments: '{"task_name":"canary","message":"TRACE-4821"}',
    status: "completed",
  }
}

function sseResponse(data: Array<string>): Response {
  return new Response(data.map((value) => `data: ${value}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return JSON.stringify({
    id: "chatcmpl_http",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4.1",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  })
}

async function streamingRequest(model: string): Promise<Response> {
  return server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: true }),
  })
}

function parseSseData(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

function isTerminalEvent(event: Record<string, unknown>): boolean {
  return (
    typeof event.type === "string"
    && [
      "error",
      "response.completed",
      "response.failed",
      "response.incomplete",
    ].includes(event.type)
  )
}
