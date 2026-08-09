import { state } from "~/lib/state"

import type { ResponsesPayload } from "./responses-types"

export interface ResponsesFallbackError {
  type: "invalid_request_error"
  code: "unsupported_feature"
  param: string
  message: string
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "top_logprobs",
  "max_output_tokens",
  "tools",
  "tool_choice",
  "previous_response_id",
  "reasoning",
  "metadata",
  "conversation",
  "store",
  "truncation",
  "parallel_tool_calls",
  "text",
  "stream_options",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "user",
])

const REPLAY_ITEM_TYPES = new Set(["reasoning", "additional_tools"])
const MESSAGE_ITEM_TYPES = new Set(["message", "agent_message"])
const TEXT_PART_TYPES = new Set(["input_text", "output_text"])

/**
 * Validate the semantic boundary before translating a Responses request to
 * Chat Completions. Native /responses requests deliberately bypass this check.
 *
 * This is not a schema validator. It only prevents translation from silently
 * deleting or changing a feature that Chat Completions cannot represent.
 */
export function validateResponsesFallback(
  payload: ResponsesPayload,
): ResponsesFallbackError | undefined {
  const record = payload as unknown as Record<string, unknown>
  const supports = getModelSupports(payload.model)

  return (
    validateTopLevel(payload, record, supports)
    ?? validateStreamOptions(payload, record.stream_options)
    ?? validateTopLogprobs(payload, record.top_logprobs)
    ?? validateReasoning(payload, record.reasoning, supports)
    ?? validateText(payload, record.text, supports)
    ?? validateInput(payload, record.input, supports)
    ?? validateTools(payload, record.tools, supports)
    ?? validateToolChoice(payload, record.tool_choice)
  )
}

function validateTopLogprobs(
  payload: ResponsesPayload,
  value: unknown,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null || value === 0) return
  return fail(payload, "top_logprobs")
}

function validateStreamOptions(
  payload: ResponsesPayload,
  value: unknown,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null) return
  if (!isRecord(value)) return fail(payload, "stream_options")

  const unsupportedKey = findUnsupportedKey(
    value,
    new Set(["include_obfuscation"]),
  )
  if (unsupportedKey) return fail(payload, `stream_options.${unsupportedKey}`)

  const includeObfuscation = value.include_obfuscation
  if (includeObfuscation === true)
    return fail(payload, "stream_options.include_obfuscation")
  if (
    includeObfuscation !== undefined
    && includeObfuscation !== null
    && typeof includeObfuscation !== "boolean"
  )
    return fail(payload, "stream_options.include_obfuscation")
}

type ModelSupports = {
  parallel_tool_calls?: boolean
  reasoning_effort?: Array<string>
  structured_outputs?: boolean
  tool_calls?: boolean
  vision?: boolean
}

function getModelSupports(modelId: string): ModelSupports {
  const model = state.models?.data.find((candidate) => candidate.id === modelId)
  const looseModel = model as unknown as
    | { capabilities?: { supports?: ModelSupports } }
    | undefined
  return looseModel?.capabilities?.supports ?? {}
}

function validateTopLevel(
  payload: ResponsesPayload,
  record: Record<string, unknown>,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key) && !isNoop(value))
      return fail(payload, key)
  }

  if (!isNoop(record.previous_response_id))
    return fail(payload, "previous_response_id")
  if (!isNoop(record.conversation)) return fail(payload, "conversation")
  if (
    record.store !== undefined
    && record.store !== null
    && record.store !== false
  )
    return fail(payload, "store")
  if (
    record.truncation !== undefined
    && record.truncation !== null
    && record.truncation !== "disabled"
  )
    return fail(payload, "truncation")
  if (
    record.parallel_tool_calls === true
    && supports.parallel_tool_calls !== true
  )
    return fail(payload, "parallel_tool_calls")
}

function validateReasoning(
  payload: ResponsesPayload,
  value: unknown,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null) return
  if (!isRecord(value)) return fail(payload, "reasoning")

  for (const [key, nested] of Object.entries(value)) {
    const supportedDefault = key === "context" && nested === "current_turn"
    if (key !== "effort" && !supportedDefault && !isNoop(nested))
      return fail(payload, `reasoning.${key}`)
  }

  const effort = value.effort
  if (effort === undefined || effort === null) return
  if (
    typeof effort !== "string"
    || !supports.reasoning_effort?.includes(effort)
  )
    return fail(payload, "reasoning.effort")
}

function validateText(
  payload: ResponsesPayload,
  value: unknown,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null) return
  if (!isRecord(value)) return fail(payload, "text")

  for (const [key, nested] of Object.entries(value)) {
    const supportedDefault = key === "verbosity" && nested === "medium"
    if (key !== "format" && !supportedDefault && !isNoop(nested))
      return fail(payload, `text.${key}`)
  }

  const format = value.format
  if (format === undefined || format === null) return
  return validateTextFormat(payload, format, supports)
}

function validateTextFormat(
  payload: ResponsesPayload,
  format: unknown,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  if (!isRecord(format) || typeof format.type !== "string")
    return fail(payload, "text.format")
  const allowedKeys =
    format.type === "json_schema" ?
      new Set(["type", "name", "description", "schema", "strict"])
    : new Set(["type"])
  const unsupportedKey = findUnsupportedKey(format, allowedKeys)
  if (unsupportedKey) return fail(payload, `text.format.${unsupportedKey}`)

  if (format.type === "text") return
  const structured =
    format.type === "json_object" || format.type === "json_schema"
  if (!structured || supports.structured_outputs !== true)
    return fail(payload, "text.format")
  if (format.type !== "json_schema") return
  if (typeof format.name !== "string" || !isRecord(format.schema))
    return fail(payload, "text.format")
}

function validateInput(
  payload: ResponsesPayload,
  value: unknown,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  if (typeof value === "string") return
  if (!Array.isArray(value)) return fail(payload, "input")

  for (const [itemIndex, item] of value.entries()) {
    if (!isRecord(item)) return fail(payload, `input[${itemIndex}]`)
    const type = typeof item.type === "string" ? item.type : "message"

    if (REPLAY_ITEM_TYPES.has(type)) continue
    if (type === "function_call" || type === "function_call_output") continue
    if (!MESSAGE_ITEM_TYPES.has(type))
      return fail(payload, `input[${itemIndex}].type`)

    const contentError = validateContent(item.content, {
      itemIndex,
      payload,
      supports,
    })
    if (contentError) return contentError
  }
}

function validateContent(
  value: unknown,
  context: {
    itemIndex: number
    payload: ResponsesPayload
    supports: ModelSupports
  },
): ResponsesFallbackError | undefined {
  const { itemIndex, payload, supports } = context
  if (typeof value === "string") return
  if (!Array.isArray(value)) return fail(payload, `input[${itemIndex}].content`)

  for (const [partIndex, part] of value.entries()) {
    const param = `input[${itemIndex}].content[${partIndex}]`
    if (!isRecord(part) || typeof part.type !== "string")
      return fail(payload, param)
    if (TEXT_PART_TYPES.has(part.type) || part.type === "encrypted_content")
      continue
    if (part.type === "input_image") {
      if (supports.vision !== true) return fail(payload, param)
      continue
    }
    return fail(payload, param)
  }
}

function validateTools(
  payload: ResponsesPayload,
  value: unknown,
  supports: ModelSupports,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) return fail(payload, "tools")

  for (const [index, tool] of value.entries()) {
    const param = `tools[${index}]`
    const error = validateTool(tool, { param, payload, supports })
    if (error) return error
  }
}

interface ToolValidationContext {
  param: string
  payload: ResponsesPayload
  supports: ModelSupports
}

function validateTool(
  value: unknown,
  context: ToolValidationContext,
): ResponsesFallbackError | undefined {
  const { param, payload, supports } = context
  if (!isRecord(value) || value.type !== "function") return fail(payload, param)
  if (supports.tool_calls !== true) return fail(payload, param)

  const nested = isRecord(value.function) ? value.function : undefined
  const toolAllowedKeys =
    nested ?
      new Set(["type", "function"])
    : new Set(["type", "name", "description", "parameters", "strict"])
  const toolUnsupportedKey = findUnsupportedKey(value, toolAllowedKeys)
  if (toolUnsupportedKey) return fail(payload, `${param}.${toolUnsupportedKey}`)
  if (nested) {
    const nestedUnsupportedKey = findUnsupportedKey(
      nested,
      new Set(["name", "description", "parameters", "strict"]),
    )
    if (nestedUnsupportedKey)
      return fail(payload, `${param}.function.${nestedUnsupportedKey}`)
  }

  const shape = { context, nested, tool: value }
  return (
    validateToolName(shape)
    ?? validateToolParameters(shape)
    ?? validateToolStrict(shape)
  )
}

interface FunctionToolShape {
  context: ToolValidationContext
  nested?: Record<string, unknown>
  tool: Record<string, unknown>
}

function validateToolName(
  shape: FunctionToolShape,
): ResponsesFallbackError | undefined {
  const { param, payload } = shape.context
  const name = shape.nested?.name ?? shape.tool.name
  if (typeof name !== "string" || name.length === 0) return fail(payload, param)
}

function validateToolParameters(
  shape: FunctionToolShape,
): ResponsesFallbackError | undefined {
  const { param, payload } = shape.context
  const parameters = shape.nested?.parameters ?? shape.tool.parameters
  if (!isRecord(parameters)) return fail(payload, `${param}.parameters`)
}

function validateToolStrict(
  shape: FunctionToolShape,
): ResponsesFallbackError | undefined {
  const { param, payload, supports } = shape.context
  const strict = shape.nested?.strict ?? shape.tool.strict
  if (strict !== undefined && typeof strict !== "boolean")
    return fail(payload, `${param}.strict`)
  if (strict === true && supports.structured_outputs !== true)
    return fail(payload, `${param}.strict`)
}

function validateToolChoice(
  payload: ResponsesPayload,
  value: unknown,
): ResponsesFallbackError | undefined {
  if (value === undefined || value === null) return
  if (value === "auto" || value === "none" || value === "required") return
  if (
    isRecord(value)
    && value.type === "function"
    && typeof value.name === "string"
    && value.name.length > 0
  )
    return
  return fail(payload, "tool_choice")
}

function fail(
  payload: ResponsesPayload,
  param: string,
): ResponsesFallbackError {
  return {
    type: "invalid_request_error",
    code: "unsupported_feature",
    param,
    message: `${param} requires native Responses support; model "${payload.model}" is using the /chat/completions fallback.`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNoop(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "")
    return true
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

function findUnsupportedKey(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.entries(record).find(
    ([key, value]) => !allowed.has(key) && !isNoop(value),
  )?.[0]
}
