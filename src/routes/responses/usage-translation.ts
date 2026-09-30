import type { ResponseUsage } from "./responses-types"

export function translateChatUsage(value: unknown): ResponseUsage | undefined {
  if (!isRecord(value)) return
  const cached =
    isRecord(value.prompt_tokens_details) ?
      count(value.prompt_tokens_details.cached_tokens)
    : undefined
  const reasoning =
    isRecord(value.completion_tokens_details) ?
      count(value.completion_tokens_details.reasoning_tokens)
    : undefined
  const usage: ResponseUsage = {
    input_tokens: count(value.prompt_tokens),
    output_tokens: count(value.completion_tokens),
    total_tokens: count(value.total_tokens),
    ...(cached === undefined ?
      {}
    : { input_tokens_details: { cached_tokens: cached } }),
    ...(reasoning === undefined ?
      {}
    : { output_tokens_details: { reasoning_tokens: reasoning } }),
  }
  return Object.values(usage).some((field) => field !== undefined) ?
      usage
    : undefined
}

function count(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
