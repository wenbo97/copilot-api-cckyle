import { expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Json } from "./acceptance/lib/local-budget"

import {
  clientVerdict,
  projectClientEvents,
  projectWireEvent,
  readArguments,
  textEvidence,
} from "./acceptance/lib/local-client-evidence"
import {
  parseCodexTurn,
  prepareClientFixtures,
} from "./acceptance/lib/local-clients"
import { observeBody } from "./acceptance/lib/local-wire"

test("client fixtures isolate model homes and explicitly cap Claude output", () => {
  const models = ["gpt-5.6-luna", "gpt-6-astra"]
  const fixtures = models.map((model) => prepareClientFixtures(model))
  try {
    expect(fixtures[0]?.directory).not.toBe(fixtures[1]?.directory)
    for (const [index, fixture] of fixtures.entries()) {
      const settings = JSON.parse(
        readFileSync(
          path.join(fixture.claudeHome, "acceptance-settings.json"),
          "utf8",
        ),
      ) as { env: Record<string, string> }
      expect(settings.env.ANTHROPIC_MODEL).toBe(models[index])
      expect(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048")
      expect(
        readFileSync(path.join(fixture.directory, "marker.txt"), "utf8"),
      ).toBe("LOCAL_TOOL_42\n")
    }
  } finally {
    for (const fixture of fixtures) {
      if (
        path.dirname(path.resolve(fixture.directory)) !== path.resolve(tmpdir())
        || !path.basename(fixture.directory).startsWith("copilot-local-client-")
      )
        continue // Never delete an unexpected path, even when a test assertion fails.
      rmSync(fixture.directory, { recursive: true })
    }
  }
})

test("Read validation, execution and exact final remain separate", () => {
  const events = projectClientEvents([
    {
      message: {
        content: [
          {
            type: "tool_use",
            id: "read1",
            name: "Read",
            input: { file_path: "marker.txt", pages: "" },
          },
        ],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read1",
            is_error: true,
            content: "Invalid pages parameter",
          },
        ],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_use",
            id: "read2",
            name: "Read",
            input: { file_path: "marker.txt" },
          },
        ],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read2",
            content: "0\tLOCAL_TOOL_42\n1\t",
          },
        ],
      },
    },
    { type: "result", result: "0\tLOCAL_TOOL_42", usage: { input_tokens: 0 } },
  ])
  expect(clientVerdict("claude", events)).toEqual({
    validArguments: false,
    toolExecution: true,
    exactFinal: false,
    blocked: false,
  })
  expect(events.at(-1)?.usage).toEqual({ input_tokens: 0 })
})

test("Read requires matching execution result and preserves unknown versus zero", () => {
  expect(readArguments('{"file_path":"marker.txt","pages":"1"}')).toMatchObject(
    { validJson: true, markerPath: true, pages: "1" },
  )
  expect(readArguments("{broken")).toEqual({ validJson: false })
  const evidence = projectClientEvents([
    { type: "result", result: "LOCAL_TOOL_42" },
  ])
  expect(clientVerdict("claude", evidence).toolExecution).toBe(false)
  expect(
    projectWireEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 0 }, status: "completed" },
    }).usage,
  ).toEqual({ input_tokens: 0 })
  expect(
    projectWireEvent({ type: "response.completed", response: {} }).usage,
  ).toBeUndefined()
})

test("current custom calls retain local policy blocks without false tool success", () => {
  const events = projectClientEvents([
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "c1",
        name: "exec",
        input: String.raw`const r = await tools.exec_command({cmd:"Get-Content -Raw .\marker.txt",login:false}); text(r);`,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          {
            type: "input_text",
            text: "Script error: rejected: blocked by policy",
          },
        ],
      },
    },
  ])
  expect(clientVerdict("codex", events)).toMatchObject({
    blocked: true,
    toolExecution: false,
  })
  expect(JSON.stringify(events)).not.toContain("tools.exec_command")
})

test("custom shell requires correlated call, zero exit and exact final", () => {
  const raw: Array<Json> = [
    {
      type: "custom_tool_call",
      call_id: "c1",
      name: "exec",
      input: String.raw`tools.exec_command({cmd:"Get-Content -Raw .\marker.txt"})`,
    },
    {
      type: "custom_tool_call_output",
      call_id: "c1",
      output: [
        {
          type: "input_text",
          text: 'Script completed\n{"exit_code":0,"output":"LOCAL_TOOL_42"}',
        },
      ],
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "LOCAL_TOOL_42" },
    },
  ]
  expect(clientVerdict("codex", projectClientEvents(raw))).toMatchObject({
    toolExecution: true,
    exactFinal: true,
    blocked: false,
  })
  raw[1] = { ...raw[1], call_id: "different" }
  expect(clientVerdict("codex", projectClientEvents(raw)).toolExecution).toBe(
    false,
  )
})

test("arbitrary output and reasoning are omitted", () => {
  const evidence = projectClientEvents([
    {
      type: "item.completed",
      item: { type: "agent_message", text: "secret value" },
    },
    { type: "reasoning", text: "secret reasoning" },
  ])
  expect(JSON.stringify(evidence)).not.toContain("secret")
})

test("native shell evidence rejects echoing the expected marker", () => {
  const base = {
    type: "command_execution",
    status: "completed",
    exit_code: 0,
    aggregated_output: "LOCAL_TOOL_42",
  }
  expect(
    clientVerdict(
      "codex",
      projectClientEvents([{ ...base, command: "echo LOCAL_TOOL_42" }]),
    ).toolExecution,
  ).toBe(false)
  expect(
    clientVerdict(
      "codex",
      projectClientEvents([
        { ...base, command: String.raw`Get-Content -Raw .\marker.txt` },
      ]),
    ).toolExecution,
  ).toBe(true)
})

test("wire capture observes usage without changing bytes or missing-zero meaning", async () => {
  const raw =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\ndata: {"type":"message_stop"}\n\n'
  const events: Array<Json> = []
  const response = await observeBody(
    new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    () => Promise.resolve(),
    (event) => {
      events.push(event)
    },
  )
  expect(await response.text()).toBe(raw)
  expect(events).toHaveLength(2)
  expect(events[0]?.message).toEqual({ usage: { input_tokens: 0 } })
  expect(events[1]?.usage).toBeUndefined()
})

test("a nested synthetic Codex tool output retains the real command exit code", () => {
  const evidence = textEvidence([
    [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      {
        type: "input_text",
        text: JSON.stringify({ exit_code: 0, output: "LOCAL_TOOL_42\n" }),
      },
    ],
  ])
  expect(evidence.markerPresent).toBe(true)
  expect(evidence.exitCodeZero).toBe(true)
  expect(evidence.blocked).toBe(false)
})

test("Codex final text excludes intermediate assistant progress messages", () => {
  const events: Array<Json> = [
    { type: "thread.started", thread_id: "synthetic-thread" },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Reading the synthetic marker now.",
      },
    },
    {
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "LOCAL_TOOL_42" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "LOCAL_TOOL_42\n" },
    },
    { type: "turn.completed" },
  ]
  const result = parseCodexTurn(events)
  expect(result.text).toBe("LOCAL_TOOL_42")
  expect(result.thread).toBe("synthetic-thread")
  expect(result.items).toHaveLength(3)
  expect(result.events).toBe(events)
})

test("a tool result is not substituted for a missing or failed Codex final answer", () => {
  const events: Array<Json> = [
    {
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "LOCAL_TOOL_42" },
    },
    { type: "turn.completed" },
  ]
  expect(parseCodexTurn(events).text).toBe("")
  expect(() => parseCodexTurn([{ type: "turn.failed" }])).toThrow(
    "Codex did not complete the turn",
  )
})
