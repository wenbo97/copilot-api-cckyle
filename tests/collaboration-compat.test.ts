import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/routes/responses/responses-types"

import {
  COPILOT_COLLABORATION_NAMESPACE,
  REDACTED_COLLABORATION_MESSAGE,
  redactCollaborationForLogging,
  restoreCollaborationForCodex,
  rewriteCollaborationForCopilot,
} from "../src/routes/_shared/collaboration-compat"

const collaborationNamespace = {
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
        required: ["task_name", "message"],
      },
    },
    {
      type: "function",
      name: "send_message",
      description: "Send a message.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string", encrypted: true },
        },
        required: ["target", "message"],
      },
    },
  ],
}

describe("rewriteCollaborationForCopilot", () => {
  test("aliases top-level and additional_tools schemas without mutating input", () => {
    const payload = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "additional_tools",
          tools: [collaborationNamespace],
        },
        {
          type: "function_call",
          id: "fc_prior",
          call_id: "call_prior",
          namespace: "collaboration",
          name: "send_message",
          arguments: '{"target":"worker","message":"continue"}',
        },
      ],
      tools: [
        collaborationNamespace,
        {
          type: "namespace",
          name: "workspace",
          description: "Workspace tools.",
          tools: [],
        },
      ],
    } as unknown as ResponsesPayload
    const before = structuredClone(payload)

    const rewritten = rewriteCollaborationForCopilot(payload)
    const raw = rewritten as unknown as {
      input: Array<Record<string, unknown>>
      tools: Array<Record<string, unknown>>
    }

    expect(payload).toEqual(before)
    expect(rewritten).not.toBe(payload)
    expect(raw.tools[0].name).toBe(COPILOT_COLLABORATION_NAMESPACE)
    expect(raw.tools[1].name).toBe("workspace")
    expect(readMessageSchema(raw.tools[0]).encrypted).toBe(false)

    const additionalTools = raw.input[0].tools as Array<Record<string, unknown>>
    expect(additionalTools[0].name).toBe(COPILOT_COLLABORATION_NAMESPACE)
    expect(readMessageSchema(additionalTools[0]).encrypted).toBe(false)
    expect(raw.input[1].namespace).toBe(COPILOT_COLLABORATION_NAMESPACE)
  })

  test("returns the original payload when no collaboration shape is present", () => {
    const payload = {
      model: "gpt-5.6-sol",
      input: "hello",
      tools: [
        {
          type: "namespace",
          name: "workspace",
          description: "Workspace tools.",
          tools: [],
        },
      ],
    } as ResponsesPayload

    expect(rewriteCollaborationForCopilot(payload)).toBe(payload)
  })
})

describe("restoreCollaborationForCodex", () => {
  test("restores a non-stream function call and marks its arguments plaintext", () => {
    const upstream = {
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          namespace: COPILOT_COLLABORATION_NAMESPACE,
          name: "spawn_agent",
          arguments: '{"task_name":"canary","message":"TRACE-4821"}',
          status: "completed",
        },
      ],
    }

    const restored = restoreCollaborationForCodex(upstream)

    expect(restored).not.toBe(upstream)
    expect(restored.output[0]).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    })
    expect(upstream.output[0].namespace).toBe(COPILOT_COLLABORATION_NAMESPACE)
    expect("encrypted_function_args" in upstream.output[0]).toBe(false)
  })

  test("restores collaboration items nested in streaming events and snapshots", () => {
    const upstream = {
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            namespace: COPILOT_COLLABORATION_NAMESPACE,
            name: "followup_task",
            arguments: '{"target":"worker","message":"finish"}',
          },
        ],
      },
    }

    expect(restoreCollaborationForCodex(upstream)).toMatchObject({
      response: {
        output: [
          {
            namespace: "collaboration",
            encrypted_function_args: [],
          },
        ],
      },
    })
  })
})

describe("redactCollaborationForLogging", () => {
  test("redacts function arguments and agent payload text without mutating data", () => {
    const value = {
      calls: [
        {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"task_name":"canary","message":"SECRET-FUNCTION-TOKEN"}',
        },
      ],
      input: [
        {
          type: "agent_message",
          content: [
            {
              type: "input_text",
              text: "Message Type: MESSAGE\nPayload:\nSECRET-AGENT-TOKEN",
            },
          ],
        },
      ],
    }

    const redacted = redactCollaborationForLogging(value)
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain("SECRET-FUNCTION-TOKEN")
    expect(serialized).not.toContain("SECRET-AGENT-TOKEN")
    expect(serialized).toContain(REDACTED_COLLABORATION_MESSAGE)
    expect(JSON.stringify(value)).toContain("SECRET-FUNCTION-TOKEN")
    expect(JSON.stringify(value)).toContain("SECRET-AGENT-TOKEN")
  })
})

function readMessageSchema(namespace: Record<string, unknown>): {
  encrypted?: boolean
} {
  const tools = namespace.tools as Array<Record<string, unknown>>
  const parameters = tools[0].parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  return properties.message as { encrypted?: boolean }
}
