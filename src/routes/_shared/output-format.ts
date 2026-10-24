import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { InvalidRequestError } from "~/lib/error"
import { state } from "~/lib/state"

const formatPath = "output_config.format"
const scalarTypes = ["string", "integer", "number", "boolean", "null"]
const schemaTypes = new Set(["object", "array", ...scalarTypes])

function invalid(path: string): never {
  throw new InvalidRequestError(
    `Malformed structured output value at ${path}.`,
    "invalid_value",
    path,
  )
}

function unsupported(path: string): never {
  throw new InvalidRequestError(
    `Structured output constraint at ${path} is not supported by this GPT bridge.`,
    "unsupported_feature",
    path,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function messagesOutputFormat(payload: AnthropicMessagesPayload) {
  const format: unknown = payload.output_config?.format
  if (format === undefined) return
  if (!isRecord(format) || typeof format.type !== "string") invalid(formatPath)
  if (format.type !== "json_schema") unsupported(`${formatPath}.type`)
  for (const key of Object.keys(format))
    if (key !== "type" && key !== "schema") unsupported(`${formatPath}.${key}`)
  validateSchema(format.schema, `${formatPath}.schema`, true)
  const model = state.models?.data.find((entry) => entry.id === payload.model)
  if (model?.capabilities.supports.structured_outputs !== true)
    unsupported(formatPath)
  // Validation never edits the schema: changing required/nullability would
  // silently weaken the caller's contract.
  return {
    type: "json_schema" as const,
    name: "messages_output",
    schema: format.schema,
    strict: true,
  }
}

function validateSchema(
  value: unknown,
  path: string,
  root = false,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid(path)
  checkKeywords(
    value,
    [
      "title",
      "description",
      "type",
      "anyOf",
      "enum",
      "properties",
      "required",
      "additionalProperties",
      "items",
    ],
    path,
  )
  validateAnnotations(value, path)

  if (Object.hasOwn(value, "anyOf")) {
    validateUnion(value, path, root)
    return
  }

  const types = readTypes(value.type, `${path}.type`)
  const type = types.find((item) => item !== "null") ?? "null"
  if (root && (type !== "object" || types.length !== 1))
    unsupported(`${path}.type`)
  const keywords = ["title", "description", "type"]
  if (type === "object")
    keywords.push("properties", "required", "additionalProperties")
  else if (type === "array") keywords.push("items")
  else keywords.push("enum")
  checkKeywords(value, keywords, path)

  if (type === "object") validateObject(value, path)
  else if (type === "array") validateSchema(value.items, `${path}.items`)
  else if (Object.hasOwn(value, "enum"))
    validateEnum(value.enum, types, `${path}.enum`)
}

function validateEnum(value: unknown, types: Array<string>, path: string) {
  if (!Array.isArray(value) || value.length === 0) invalid(path)
  if (
    !value.every((item: unknown) =>
      types.some((declared) => matchesType(item, declared)),
    )
  )
    invalid(path)
}

function validateAnnotations(value: Record<string, unknown>, path: string) {
  for (const annotation of ["title", "description"])
    if (
      value[annotation] !== undefined
      && typeof value[annotation] !== "string"
    )
      invalid(`${path}.${annotation}`)
}

function validateUnion(
  value: Record<string, unknown>,
  path: string,
  root: boolean,
) {
  if (!Array.isArray(value.anyOf) || value.anyOf.length === 0)
    invalid(`${path}.anyOf`)
  if (root) unsupported(`${path}.anyOf`)
  checkKeywords(value, ["title", "description", "anyOf"], path)
  for (const [index, branch] of value.anyOf.entries())
    validateSchema(branch, `${path}.anyOf[${index}]`)
}

function checkKeywords(
  value: Record<string, unknown>,
  allowed: Array<string>,
  path: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) unsupported(`${path}.${key}`)
}

function readTypes(value: unknown, path: string): Array<string> {
  if (typeof value === "string" && schemaTypes.has(value)) return [value]
  if (!Array.isArray(value)) invalid(path)
  const types = value.map((item: unknown) => {
    if (typeof item !== "string" || !schemaTypes.has(item)) invalid(path)
    return item
  })
  if (
    types.length !== 2
    || new Set(types).size !== 2
    || !types.includes("null")
  )
    invalid(path)
  return types
}

function validateObject(value: Record<string, unknown>, path: string) {
  if (!isRecord(value.properties)) invalid(`${path}.properties`)
  for (const [key, child] of Object.entries(value.properties))
    validateSchema(child, `${path}.properties.${key}`)

  const required = value.required
  if (
    !Array.isArray(required)
    || required.some((key: unknown) => typeof key !== "string")
  )
    invalid(`${path}.required`)
  const keys = Object.keys(value.properties)
  if (
    new Set(required).size !== required.length
    || required.some((key: string) => !keys.includes(key))
  )
    invalid(`${path}.required`)
  if (keys.some((key) => !required.includes(key)))
    unsupported(`${path}.required`)

  if (value.additionalProperties !== false) {
    if (
      value.additionalProperties !== undefined
      && typeof value.additionalProperties !== "boolean"
      && !isRecord(value.additionalProperties)
    )
      invalid(`${path}.additionalProperties`)
    unsupported(`${path}.additionalProperties`)
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": {
      return value === null
    }
    case "integer": {
      return typeof value === "number" && Number.isInteger(value)
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value)
    }
    case "string": {
      return typeof value === "string"
    }
    case "boolean": {
      return typeof value === "boolean"
    }
    default: {
      return false
    }
  }
}
