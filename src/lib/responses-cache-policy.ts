import { createHash } from "node:crypto"

import type {
  ResponseInputMessage,
  ResponsesPayload,
} from "~/routes/responses/responses-types"

// OpenAI documents explicit breakpoints for these model families. Copilot
// acceptance is a separate concern: this policy is opt-in and never probes or
// retries an inference request to discover support.
const EXPLICIT_CACHE_MODELS = new Set([
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
])

interface PolicyContext {
  endpoint: string
  accountType: string
}

export interface CachePolicySummary {
  name: "off" | "prefix-v1"
  status:
    | "disabled"
    | "unsupported_model"
    | "unsupported_endpoint"
    | "client_managed"
    | "continuation"
    | "applied"
    | "key_only"
    | "no_prefix"
  key_source: "client" | "generated" | "absent"
  breakpoint_added: boolean
}

export interface CachePolicyResult {
  payload: ResponsesPayload
  summary: CachePolicySummary
}

/** Apply once, after compatibility transforms and before serializing egress. */
export function applyResponsesCachePolicy(
  payload: ResponsesPayload,
  context: PolicyContext,
): CachePolicyResult {
  const name = process.env.COPILOT_CACHE_POLICY || "off"
  if (name !== "off" && name !== "prefix-v1")
    throw new Error("COPILOT_CACHE_POLICY must be off or prefix-v1")

  const summary: CachePolicySummary = {
    name,
    status: "disabled",
    key_source: payload.prompt_cache_key === undefined ? "absent" : "client",
    breakpoint_added: false,
  }
  const status = skipReason(payload, context, name)
  if (status) return { payload, summary: { ...summary, status } }

  const prefix = findPrefix(payload.input)
  let body = payload
  if (prefix && Array.isArray(payload.input)) {
    const input = [...payload.input]
    input[prefix.index] = prefix.item
    body = { ...body, input }
    summary.breakpoint_added = true
    // Preserve an existing implicit policy verbatim, including its TTL. Keep
    // the implicit end-of-history write alongside one explicit prefix write.
    if (payload.prompt_cache_options === undefined)
      body.prompt_cache_options = { mode: "implicit", ttl: "30m" }
  }

  const namespace = process.env.COPILOT_CACHE_NAMESPACE?.trim()
  if (payload.prompt_cache_key === undefined && namespace) {
    body = { ...body, prompt_cache_key: cacheKey(payload, context, namespace) }
    summary.key_source = "generated"
  }
  summary.status = "no_prefix"
  if (summary.key_source === "generated") summary.status = "key_only"
  if (prefix) summary.status = "applied"
  return { payload: body, summary }
}

function skipReason(
  payload: ResponsesPayload,
  context: PolicyContext,
  name: "off" | "prefix-v1",
): CachePolicySummary["status"] | undefined {
  if (name === "off") return "disabled"
  if (context.endpoint !== "/responses") return "unsupported_endpoint"
  if (!EXPLICIT_CACHE_MODELS.has(payload.model)) return "unsupported_model"
  if (payload.previous_response_id || payload.conversation)
    return "continuation"
  if (clientManagesCaching(payload)) return "client_managed"
}

function clientManagesCaching(payload: ResponsesPayload): boolean {
  if (payload.prompt_cache_retention !== undefined) return true
  const options: unknown = payload.prompt_cache_options
  if (options !== undefined) {
    const value = record(options)
    if (!value) return true
    if (value.mode !== undefined && value.mode !== "implicit") return true
  }
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item) => {
    const value = record(item)
    return hasBreakpoint(value?.content) || hasBreakpoint(value?.output)
  })
}

function hasBreakpoint(value: unknown): boolean {
  return (
    Array.isArray(value)
    && value.some((part) => record(part)?.prompt_cache_breakpoint !== undefined)
  )
}

interface Prefix {
  index: number
  item: ResponseInputMessage
}

function findPrefix(input: ResponsesPayload["input"]): Prefix | undefined {
  if (!Array.isArray(input)) return
  for (const [index, item] of input.entries()) {
    const value = record(item)
    if (!value) return
    if (value.type === "additional_tools") continue
    if (value.type !== undefined && value.type !== "message") return
    if (value.role === "system") continue
    if (value.role !== "developer") return
    const content = prefixContent(value.content)
    if (content)
      return {
        index,
        item: { ...value, content } as unknown as ResponseInputMessage,
      }
  }
}

function prefixContent(content: unknown): Array<unknown> | undefined {
  const value =
    typeof content === "string" ?
      [{ type: "input_text", text: content }]
    : content
  if (!Array.isArray(value) || value.length === 0) return
  const parts: Array<unknown> = value
  const last = record(parts.at(-1))
  if (
    last?.type !== "input_text"
    || typeof last.text !== "string"
    || last.text.length === 0
  )
    return
  return [
    ...parts.slice(0, -1),
    { ...last, prompt_cache_breakpoint: { mode: "explicit" } },
  ]
}

function cacheKey(
  payload: ResponsesPayload,
  context: PolicyContext,
  namespace: string,
): string {
  // Hash only deployment scope and fixed configuration, never the growing
  // history or a short-lived credential. Array order is significant.
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: "prefix-v1",
        namespace,
        account_type: context.accountType,
        endpoint: context.endpoint,
        model: payload.model,
        instructions: payload.instructions,
        tools: payload.tools,
        reasoning: payload.reasoning,
        text: payload.text,
        parallel_tool_calls: payload.parallel_tool_calls,
        tool_choice: payload.tool_choice,
        service_tier: payload.service_tier,
      }),
    )
    .digest("hex")
  return `cp-cache-v1:${digest.slice(0, 48)}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}
