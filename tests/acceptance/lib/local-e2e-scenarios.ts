import type { Scenario } from "./local-scenarios"

import { record, stringValue } from "./local-budget"
import { codex, runClaudeCase, runCodexToolCase } from "./local-clients"
import { E2E_KINDS, E2E_MODELS, type E2eKind } from "./local-e2e-authorization"
import { AcceptanceRuntime, assert } from "./local-runtime"
import { parseEvents, responseText } from "./local-wire"

async function responsesCase(
  runtime: AcceptanceRuntime,
  id: string,
  options: { model: string; stream: boolean },
): Promise<string> {
  const { model, stream } = options
  const body =
    stream ?
      {
        input: "Reply with exactly READY. Do not use tools.",
        stream: true,
      }
    : {
        input: "Return status=ok and count=7 as strict JSON.",
        text: {
          format: {
            type: "json_schema",
            name: "status",
            strict: true,
            schema: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["ok"] },
                count: { type: "integer", enum: [7] },
              },
              required: ["status", "count"],
              additionalProperties: false,
            },
          },
        },
      }
  const result = await runtime.responses(id, {
    model,
    max_output_tokens: 512,
    ...body,
  })
  const answer = responseText(result).trim()
  if (stream) assert(answer === "READY", "Responses SSE final answer mismatch")
  else {
    const value = record(JSON.parse(answer))
    assert(
      value.status === "ok"
        && value.count === 7
        && Object.keys(value).length === 2,
      "Responses strict JSON answer mismatch",
    )
  }
  const usage = record(result.usage)
  assert(
    Number.isSafeInteger(usage.input_tokens)
      && Number.isSafeInteger(usage.output_tokens),
    "Responses usage coverage missing",
  )
  return stream ?
      "Completed SSE with exact text and usage"
    : "Strict JSON with exact fields and usage"
}

async function messagesCase(
  runtime: AcceptanceRuntime,
  id: string,
  options: { model: string; stream: boolean },
): Promise<string> {
  const { model, stream } = options
  const result = await runtime.post(
    id,
    {
      model,
      max_tokens: 512,
      stream,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: "Reply with exactly READY. Do not use tools.",
        },
      ],
    },
    { phase: "functional", route: "messages" },
  )
  const raw = await result.text()
  assert(result.ok, `Messages HTTP ${result.status}`)
  if (stream) {
    const events = parseEvents(raw)
    assert(
      events.at(-1)?.type === "message_stop"
        && events.filter((event) => event.type === "message_stop").length === 1
        && !events.some((event) => event.type === "error"),
      "Messages SSE terminal invalid",
    )
    const answer = events
      .map((event) => stringValue(record(event.delta).text))
      .join("")
      .trim()
    assert(answer === "READY", "Messages SSE final answer mismatch")
    assert(
      events.some((event) => record(event.delta).stop_reason === "end_turn"),
      "Messages SSE stop reason mismatch",
    )
  } else {
    const value = record(JSON.parse(raw))
    const answer = (Array.isArray(value.content) ? value.content : [])
      .map((part) => stringValue(record(part).text))
      .join("")
      .trim()
    assert(
      answer === "READY" && value.stop_reason === "end_turn",
      "Messages JSON final answer or stop reason mismatch",
    )
  }
  return "Messages bridge final answer and terminal verified"
}

async function parallelTools(
  runtime: AcceptanceRuntime,
  id: string,
  model: string,
): Promise<string> {
  const user = {
    role: "user",
    content:
      "Call alpha and beta exactly once each in the same turn. Do not answer directly.",
  }
  const tools = ["alpha", "beta"].map((name) => ({
    type: "function",
    name,
    description: `Return ${name}`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  }))
  const first = await runtime.responses(id, {
    model,
    input: [user],
    tools,
    tool_choice: "required",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 512,
  })
  const output =
    Array.isArray(first.output) ? (first.output as Array<unknown>) : []
  const calls = output
    .map((item) => record(item))
    .filter((item) => item.type === "function_call")
  assert(
    calls.length === 2
      && new Set(calls.map((call) => call.name)).size === 2
      && calls.every(
        (call) =>
          ["alpha", "beta"].includes(String(call.name))
          && typeof call.call_id === "string"
          && typeof call.arguments === "string"
          && Object.keys(record(JSON.parse(call.arguments))).length === 0,
      ),
    "Parallel tool names, IDs or arguments invalid",
  )
  const second = await runtime.responses(id, {
    model,
    input: [
      user,
      ...output,
      ...calls.map((call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: [
          { type: "input_text", text: call.name === "alpha" ? "A=17" : "B=25" },
        ],
      })),
      {
        role: "user",
        content: "Add A and B. Reply only with the sum as decimal digits.",
      },
    ],
    tools,
    tool_choice: "none",
    stream: true,
    max_output_tokens: 512,
  })
  assert(
    responseText(second).trim() === "42",
    "Parallel tool result replay lost values",
  )
  return "Two tool calls and exact result replay"
}

function assertNoCodexTools(items: Array<Record<string, unknown>>) {
  assert(
    items.every((item) =>
      ["agent_message", "reasoning"].includes(String(item.type)),
    ),
    "History diagnostic attempted a tool",
  )
}

async function history(
  runtime: AcceptanceRuntime,
  id: string,
  model: string,
): Promise<string> {
  const seed = await codex(runtime, id, {
    model,
    noTools: true,
    prompt:
      "Do not use tools. Remember this marker: ACCEPTANCE_42. Reply with exactly READY.",
  })
  assertNoCodexTools(seed.items)
  assert(
    seed.text === "READY" && typeof seed.thread === "string",
    "Codex history seed failed",
  )
  const prompt =
    "Do not use tools. What marker did I ask you to remember? Reply only with that marker."
  const fork = await codex(runtime, id, {
    model,
    mode: "fork",
    noTools: true,
    thread: seed.thread,
    prompt,
  })
  assertNoCodexTools(fork.items)
  assert(
    fork.text === "ACCEPTANCE_42" && typeof fork.thread === "string",
    "Codex history fork failed",
  )
  for (let index = 0; index < 2; index++) {
    const resumed = await codex(runtime, id, {
      model,
      mode: "resume",
      noTools: true,
      thread: fork.thread,
      prompt,
    })
    assertNoCodexTools(resumed.items)
    assert(
      resumed.text === "ACCEPTANCE_42",
      "Independent Codex resume lost marker",
    )
  }
  const previousPid = runtime.child?.pid
  await runtime.stopProxy()
  await runtime.startProxy()
  assert(
    runtime.child?.pid !== previousPid,
    "Owned proxy restart did not create a new process",
  )
  const restarted = await codex(runtime, id, {
    model,
    mode: "resume",
    noTools: true,
    thread: fork.thread,
    prompt,
  })
  assertNoCodexTools(restarted.items)
  assert(
    restarted.text === "ACCEPTANCE_42",
    "Codex resume after proxy restart lost marker",
  )
  return "Seed, fork, two independent resumes and owned-proxy restart retained marker"
}

async function cancelAndRecover(
  runtime: AcceptanceRuntime,
  id: string,
  model: string,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let cancellationFailure: string | undefined
  try {
    const response = await runtime.post(
      id,
      {
        model,
        reasoning: { effort: "low" },
        max_output_tokens: 512,
        stream: true,
        input:
          "Write integers from 1 through 300, one per line. Do not summarize.",
      },
      { phase: "operations", route: "responses", signal: controller.signal },
    )
    assert(response.ok && response.body, "Cannot open cancellation stream")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    while (!pending.includes("response.output_text.delta")) {
      const next = await reader.read()
      assert(!next.done, "Stream completed before cancellation")
      pending += decoder.decode(next.value, { stream: true })
    }
    assert(
      !pending.includes("response.completed"),
      "Stream completed before cancellation",
    )
    controller.abort()
    await reader.cancel().catch(() => undefined)
    const deadline = Date.now() + 8000
    for (;;) {
      const health = await runtime.management("health")
      const grant = runtime.ledger.grants.findLast(
        (entry) => entry.caseId === id,
      )
      const observation =
        grant ? runtime.ledger.observations.get(grant.id) : undefined
      if (
        health.active === 0
        && observation?.upstreamSignalAborted === true
        && observation.protocolOutcome !== "completed"
      )
        break
      if (Date.now() >= deadline)
        throw new Error("Cancelled upstream body did not release")
      await Bun.sleep(100)
    }
  } catch (error) {
    cancellationFailure =
      error instanceof Error ? error.message : "Cancellation failed"
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
  const recovered = await runtime.responses(
    id,
    {
      model,
      input: "Reply with exactly READY.",
      max_output_tokens: 512,
      stream: true,
    },
    "operations",
  )
  assert(
    responseText(recovered).trim() === "READY",
    "Request after cancellation failed",
  )
  if (cancellationFailure) throw new Error(cancellationFailure)
  return "Cancelled upstream released; next streamed request completed"
}

async function refresh(
  runtime: AcceptanceRuntime,
  id: string,
  model: string,
): Promise<string> {
  try {
    await runtime.management("configure", {
      caseId: id,
      phase: "operations",
      refresh: true,
    })
  } catch (error) {
    // The runner owns this state; setting it true is safe after the refresh await.
    // eslint-disable-next-line require-atomic-updates
    runtime.halted = true
    runtime.ledger.halt("Bridge refresh failed")
    throw error
  }
  const result = await runtime.responses(
    id,
    { model, input: "Reply with exactly READY.", max_output_tokens: 512 },
    "operations",
  )
  assert(
    responseText(result).trim() === "READY",
    "Request after bridge refresh failed",
  )
  return "Bridge refresh and real upstream request completed"
}

async function runKind(
  runtime: AcceptanceRuntime,
  scenario: { id: string; model: string; kind: E2eKind },
): Promise<string> {
  const { id, model, kind } = scenario
  switch (kind) {
    case "responses-json": {
      return responsesCase(runtime, id, { model, stream: false })
    }
    case "responses-stream": {
      return responsesCase(runtime, id, { model, stream: true })
    }
    case "messages-json": {
      return messagesCase(runtime, id, { model, stream: false })
    }
    case "messages-stream": {
      return messagesCase(runtime, id, { model, stream: true })
    }
    case "parallel-tools": {
      return parallelTools(runtime, id, model)
    }
    case "claude-a":
    case "claude-b": {
      return runClaudeCase(runtime, id, { model, withTool: true })
    }
    case "codex-tool": {
      return runCodexToolCase(runtime, id, model)
    }
    case "history": {
      return history(runtime, id, model)
    }
    case "cancel": {
      return cancelAndRecover(runtime, id, model)
    }
    case "refresh": {
      return refresh(runtime, id, model)
    }
    default: {
      throw new Error("Unknown E2E scenario")
    }
  }
}

export interface E2eScenario extends Scenario {
  model: string
  kind: E2eKind
}
export const E2E_MATRIX: Array<E2eScenario> = E2E_MODELS.flatMap((model) =>
  (Object.keys(E2E_KINDS) as Array<E2eKind>).map((kind) => {
    const id = `e2e-${model}-${kind}`
    return {
      id,
      model,
      kind,
      phase: E2E_KINDS[kind].phase,
      run: (runtime: AcceptanceRuntime) =>
        runKind(runtime, { id, model, kind }),
    }
  }),
)
