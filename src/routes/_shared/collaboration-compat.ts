import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

const CODEX_COLLABORATION_NAMESPACE = "collaboration"

export const COPILOT_COLLABORATION_NAMESPACE = "codex_collaboration_proxy"
export const REDACTED_COLLABORATION_MESSAGE = "[collaboration payload redacted]"

const PLAINTEXT_MESSAGE_FUNCTIONS = new Set([
  "followup_task",
  "send_message",
  "spawn_agent",
])

/**
 * Copilot reserves Codex's `collaboration` namespace and requires its exact
 * encrypted-argument schema. Rename that namespace before egress so Copilot
 * treats it as an ordinary tool namespace, then explicitly request plaintext
 * for the message-bearing functions. Historical function calls are renamed as
 * well so replayed calls still match the tool catalog sent in the same request.
 */
export function rewriteCollaborationForCopilot(
  payload: ResponsesPayload,
): ResponsesPayload {
  let rewritten = payload

  if (Array.isArray(payload.tools)) {
    const tools = rewriteToolList(payload.tools)
    if (tools !== payload.tools) {
      rewritten = {
        ...rewritten,
        tools: tools as ResponsesPayload["tools"],
      }
    }
  }

  if (typeof payload.input === "string") return rewritten

  const input = payload.input.map((item) => {
    const rawItem: unknown = item
    if (!isRecord(rawItem)) return item

    if (rawItem.type === "additional_tools" && Array.isArray(rawItem.tools)) {
      const tools = rewriteToolList(rawItem.tools)
      if (tools === rawItem.tools) return item
      return { ...rawItem, tools } as unknown as ResponseInputItem
    }

    if (
      rawItem.type === "function_call"
      && rawItem.namespace === CODEX_COLLABORATION_NAMESPACE
    ) {
      return {
        ...rawItem,
        namespace: COPILOT_COLLABORATION_NAMESPACE,
      } as unknown as ResponseInputItem
    }

    return item
  })

  if (input.every((item, index) => item === payload.input[index]))
    return rewritten
  return { ...rewritten, input }
}

/** Restore the proxy-only namespace to the wire contract Codex understands. */
export function restoreCollaborationForCodex<T>(value: T): T {
  return mapDeep(value, (record) => {
    if (
      record.type !== "function_call"
      || record.namespace !== COPILOT_COLLABORATION_NAMESPACE
    ) {
      return record
    }

    const restored: Record<string, unknown> = {
      ...record,
      namespace: CODEX_COLLABORATION_NAMESPACE,
    }
    if (
      typeof record.name === "string"
      && PLAINTEXT_MESSAGE_FUNCTIONS.has(record.name)
    ) {
      restored.encrypted_function_args = []
    }
    return restored
  })
}

/**
 * Produce an immutable logging/trace copy with inter-agent task bodies removed.
 * Actual request and response payloads must never pass through this function.
 */
export function redactCollaborationForLogging<T>(value: T): T {
  return mapDeep(value, (record) => {
    if (record.type === "agent_message") return redactAgentMessage(record)

    if (record.type === "response.function_call_arguments.delta") {
      return typeof record.delta === "string" ?
          { ...record, delta: REDACTED_COLLABORATION_MESSAGE }
        : record
    }
    if (record.type === "response.function_call_arguments.done") {
      return typeof record.arguments === "string" ?
          { ...record, arguments: REDACTED_COLLABORATION_MESSAGE }
        : record
    }

    if (
      record.type !== "function_call"
      || !isCollaborationNamespace(record.namespace)
      || typeof record.name !== "string"
      || !PLAINTEXT_MESSAGE_FUNCTIONS.has(record.name)
      || typeof record.arguments !== "string"
    ) {
      return record
    }

    return {
      ...record,
      arguments: redactFunctionArguments(record.arguments),
    }
  })
}

function rewriteToolList(tools: Array<unknown>): Array<unknown> {
  const rewritten = tools.map((tool) => {
    return rewriteToolDefinition(tool)
  })
  return rewritten.every((tool, index) => tool === tools[index]) ? tools : (
      rewritten
    )
}

function rewriteToolDefinition(tool: unknown): unknown {
  if (
    !isRecord(tool)
    || tool.type !== "namespace"
    || tool.name !== CODEX_COLLABORATION_NAMESPACE
  ) {
    return tool
  }

  const childTools =
    Array.isArray(tool.tools) ?
      tool.tools.map((child) => rewriteCollaborationFunction(child))
    : tool.tools
  return {
    ...tool,
    name: COPILOT_COLLABORATION_NAMESPACE,
    ...(Array.isArray(childTools) ? { tools: childTools } : {}),
  }
}

function rewriteCollaborationFunction(tool: unknown): unknown {
  if (
    !isRecord(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !PLAINTEXT_MESSAGE_FUNCTIONS.has(tool.name)
    || !isRecord(tool.parameters)
    || !isRecord(tool.parameters.properties)
    || !isRecord(tool.parameters.properties.message)
  ) {
    return tool
  }

  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        message: {
          ...tool.parameters.properties.message,
          encrypted: false,
        },
      },
    },
  }
}

function redactAgentMessage(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof record.content === "string") {
    const content = redactPayloadText(record.content)
    return content === record.content ? record : { ...record, content }
  }
  if (!Array.isArray(record.content)) return record

  const originalContent: Array<unknown> = record.content
  const content = originalContent.map((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return part
    const text = redactPayloadText(part.text)
    if (text === part.text) return part
    return { ...part, text }
  })
  return content.every((part, index) => part === originalContent[index]) ?
      record
    : { ...record, content }
}

function redactPayloadText(text: string): string {
  const match = /\bPayload:[ \t]*/i.exec(text)
  if (!match) return text
  const payloadStart = match.index + match[0].length
  const newline = /^\r?\n/.exec(text.slice(payloadStart))?.[0] ?? ""
  return text.slice(0, payloadStart) + newline + REDACTED_COLLABORATION_MESSAGE
}

function redactFunctionArguments(argumentsJson: string): string {
  let value: unknown
  try {
    value = JSON.parse(argumentsJson)
  } catch {
    return REDACTED_COLLABORATION_MESSAGE
  }
  if (!isRecord(value) || typeof value.message !== "string") {
    return argumentsJson
  }
  return JSON.stringify({ ...value, message: REDACTED_COLLABORATION_MESSAGE })
}

function isCollaborationNamespace(value: unknown): boolean {
  return (
    value === CODEX_COLLABORATION_NAMESPACE
    || value === COPILOT_COLLABORATION_NAMESPACE
  )
}

function mapDeep<T>(
  value: T,
  transform: (record: Record<string, unknown>) => Record<string, unknown>,
): T {
  return mapDeepValue(value, transform) as T
}

function mapDeepValue(
  value: unknown,
  transform: (record: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) {
    const original: Array<unknown> = value
    const mapped = value.map((item) => {
      return mapDeepValue(item, transform)
    })
    return mapped.every((item, index) => item === original[index]) ? value : (
        mapped
      )
  }
  if (!isRecord(value)) return value

  let changed = false
  const mapped: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const next = mapDeepValue(child, transform)
    mapped[key] = next
    if (next !== child) changed = true
  }
  return transform(changed ? mapped : value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
