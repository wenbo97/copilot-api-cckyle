import type { AnthropicResponse } from "./anthropic-types"

export interface MessagesUsage {
  totalInput?: number
  cachedInput?: number
  output?: number
  unverifiedWrite: boolean
}

export function readMessagesUsage(
  value: unknown,
  source: "chat" | "responses",
  previous?: MessagesUsage,
): MessagesUsage {
  const usage = record(value)
  const details = record(
    source === "chat" ?
      usage.prompt_tokens_details
    : usage.input_tokens_details,
  )
  const totalInput = readCount(
    usage,
    source === "chat" ? "prompt_tokens" : "input_tokens",
    previous?.totalInput,
  )
  const reportedCached = readCount(
    details,
    "cached_tokens",
    previous?.cachedInput,
  )
  return {
    totalInput,
    cachedInput:
      (
        totalInput !== undefined
        && reportedCached !== undefined
        && reportedCached > totalInput
      ) ?
        undefined
      : reportedCached,
    output: readCount(
      usage,
      source === "chat" ? "completion_tokens" : "output_tokens",
      previous?.output,
    ),
    // Copilot's write field has not been verified as an Anthropic creation count.
    unverifiedWrite:
      Object.hasOwn(details, "cache_write_tokens") ?
        details.cache_write_tokens !== 0
      : (previous?.unverifiedWrite ?? false),
  }
}

function readCount(
  value: Record<string, unknown>,
  key: string,
  previous?: number,
): number | undefined {
  return Object.hasOwn(value, key) ? count(value[key]) : previous
}

export function hasMessagesUsage(usage: MessagesUsage): boolean {
  return (
    usage.totalInput !== undefined
    || usage.cachedInput !== undefined
    || usage.output !== undefined
  )
}

export function formatMessagesUsage(
  usage: MessagesUsage,
): AnthropicResponse["usage"] {
  return {
    // Required wire numbers retain compatibility placeholders; the observed
    // counters above stay unknown and must never be replaced by these zeros.
    input_tokens:
      usage.totalInput === undefined ?
        0
      : usage.totalInput - (usage.cachedInput ?? 0),
    output_tokens: usage.output ?? 0,
    ...(usage.cachedInput === undefined ?
      {}
    : { cache_read_input_tokens: usage.cachedInput }),
  }
}

function count(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}
