import { spyOn } from "bun:test"
import consola from "consola"

export function captureInfo() {
  return spyOn(consola, "info").mockImplementation(
    Object.assign(() => undefined, { raw: () => undefined }),
  )
}

export function frames(events: Array<unknown>) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

export function completed() {
  return {
    id: "offline-response",
    object: "response",
    created_at: 1,
    model: "gpt-5.6-luna",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
      output_tokens: 2,
    },
  }
}

export function firstChangedInput(
  first: Array<unknown>,
  second: Array<unknown>,
) {
  let index = 0
  while (
    index < first.length
    && index < second.length
    && JSON.stringify(first[index]) === JSON.stringify(second[index])
  )
    index++
  return index
}

export function toolConversations(
  protocol: "messages" | "responses",
): Array<Record<string, unknown>> {
  const schema = { type: "object", properties: { path: { type: "string" } } }
  const changedSchema = {
    type: "object",
    properties: { path: { type: "string" }, encoding: { type: "string" } },
  }
  const callIds = ["call-a", "call-b"]
  const context = { schema, changedSchema, callIds }
  return protocol === "responses" ?
      responsesToolConversations(context)
    : messagesToolConversations(context)
}

interface ToolFixtureContext {
  schema: Record<string, unknown>
  changedSchema: Record<string, unknown>
  callIds: Array<string>
}

function responsesToolConversations({
  schema,
  changedSchema,
  callIds,
}: ToolFixtureContext): Array<Record<string, unknown>> {
  const first = {
    model: "gpt-5.6-luna",
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: schema,
      },
    ],
    input: [
      { role: "developer", content: "private-stable-rules" },
      { role: "user", content: "private-initial-question" },
    ],
  }
  const tools = {
    ...first,
    input: [
      ...first.input,
      {
        type: "reasoning",
        encrypted_content: "private-opaque-reasoning",
        summary: [],
      },
      ...callIds.map((callId) => ({
        type: "function_call",
        call_id: callId,
        name: "read",
        arguments: JSON.stringify({ path: `private-${callId}.ts` }),
      })),
      ...[...callIds].reverse().map((callId) => ({
        type: "function_call_output",
        call_id: callId,
        output: `private-result-${callId}`,
      })),
      {
        role: "assistant",
        content: [{ type: "output_text", text: "private-tool-summary" }],
      },
      { role: "user", content: "private-followup" },
    ],
  }
  return [
    first,
    tools,
    {
      ...tools,
      input: [
        ...tools.input,
        { role: "assistant", content: "private-answer" },
        { role: "user", content: "private-next-question" },
      ],
    },
    {
      ...tools,
      input: [
        ...tools.input.slice(0, -1),
        { role: "user", content: "private-branch-question" },
      ],
    },
    {
      ...first,
      input: [
        first.input[0],
        { role: "user", content: "private-compacted-history" },
      ],
    },
    { ...tools, tools: [{ ...first.tools[0], parameters: changedSchema }] },
  ]
}

function messagesToolConversations({
  schema,
  changedSchema,
  callIds,
}: ToolFixtureContext): Array<Record<string, unknown>> {
  const first = {
    model: "gpt-5.6-luna",
    max_tokens: 64,
    system: "private-stable-rules",
    tools: [{ name: "read", description: "Read a file", input_schema: schema }],
    messages: [{ role: "user", content: "private-initial-question" }],
  }
  const toolResults = [...callIds].reverse().map((callId) => ({
    type: "tool_result",
    tool_use_id: callId,
    content: `private-result-${callId}`,
  }))
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "private-before-tools" },
      {
        type: "tool_use",
        id: "call-a",
        name: "read",
        input: { path: "private-a.ts" },
      },
      { type: "text", text: "private-between-tools" },
      {
        type: "tool_use",
        id: "call-b",
        name: "read",
        input: { path: "private-b.ts" },
      },
    ],
  }
  const tools = {
    ...first,
    messages: [
      ...first.messages,
      assistant,
      {
        role: "user",
        content: [{ type: "text", text: "private-followup" }, ...toolResults],
      },
    ],
  }
  return [
    first,
    tools,
    {
      ...tools,
      messages: [
        ...tools.messages,
        { role: "assistant", content: "private-answer" },
        { role: "user", content: "private-next-question" },
      ],
    },
    {
      ...tools,
      messages: [
        ...tools.messages.slice(0, -1),
        {
          role: "user",
          content: [
            ...toolResults,
            { type: "text", text: "private-branch-question" },
          ],
        },
      ],
    },
    {
      ...first,
      messages: [{ role: "user", content: "private-compacted-history" }],
    },
    { ...tools, tools: [{ ...first.tools[0], input_schema: changedSchema }] },
  ]
}

export function captureLogs(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
  prefix: string,
): Array<Record<string, unknown>> {
  const label = `[${prefix}] `
  return calls
    .map(([message]): unknown => message)
    .filter(
      (message): message is string =>
        typeof message === "string" && message.startsWith(label),
    )
    .map(
      (message) =>
        JSON.parse(message.slice(label.length)) as Record<string, unknown>,
    )
}
