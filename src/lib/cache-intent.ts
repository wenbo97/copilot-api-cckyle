export type CacheIngressProtocol = "messages" | "responses"

export interface CacheIntentSummary {
  present: boolean
  marker_count: number
  paths: Array<string>
  ttl_present: boolean
  malformed_or_unknown: boolean
  truncated: boolean
  status: "absent" | "observed" | "cache_hint_not_portable"
}

/** Inspect protocol locations only, never schemas, prompt values or cache keys. */
export function inspectCacheIntent(
  payload: unknown,
  protocol: CacheIngressProtocol,
): CacheIntentSummary {
  const inspector = new IntentInspector()
  const body = record(payload)
  if (protocol === "messages") inspector.messages(body)
  else inspector.responses(body)
  const summary = inspector.summary
  if (summary.present)
    summary.status =
      protocol === "messages" ? "cache_hint_not_portable" : "observed"
  return summary
}

class IntentInspector {
  readonly summary: CacheIntentSummary = {
    present: false,
    marker_count: 0,
    paths: [],
    ttl_present: false,
    malformed_or_unknown: false,
    truncated: false,
    status: "absent",
  }

  messages(body: Record<string, unknown>): void {
    this.control(body, "")
    for (const field of ["system", "tools"])
      for (const [index, block] of array(body[field]).entries())
        this.control(record(block), `${field}[${index}]`)
    for (const [index, message] of array(body.messages).entries())
      this.blocks(record(message).content, `messages[${index}].content`)
  }

  responses(body: Record<string, unknown>): void {
    for (const key of ["prompt_cache_key", "prompt_cache_retention"])
      if (Object.hasOwn(body, key)) {
        this.location(key)
        this.summary.malformed_or_unknown ||= !validCacheField(key, body[key])
      }
    if (Object.hasOwn(body, "prompt_cache_options")) {
      this.location("prompt_cache_options")
      const options = record(body.prompt_cache_options)
      this.summary.ttl_present ||= Object.hasOwn(options, "ttl")
      this.summary.malformed_or_unknown ||= !validOptions(
        body.prompt_cache_options,
      )
    }
    for (const [index, item] of array(body.input).entries())
      for (const field of ["content", "output"])
        for (const [partIndex, part] of array(record(item)[field]).entries()) {
          const block = record(part)
          if (!Object.hasOwn(block, "prompt_cache_breakpoint")) continue
          this.location(
            `input[${index}].${field}[${partIndex}].prompt_cache_breakpoint`,
            true,
          )
          const marker = record(block.prompt_cache_breakpoint)
          this.summary.malformed_or_unknown ||=
            marker.mode !== "explicit" || unknownKeys(marker, ["mode"])
        }
  }

  private blocks(value: unknown, path: string): void {
    for (const [index, part] of array(value).entries()) {
      const block = record(part)
      const blockPath = `${path}[${index}]`
      this.control(block, blockPath)
      if (block.type === "tool_result")
        for (const [contentIndex, content] of array(block.content).entries())
          this.control(record(content), `${blockPath}.content[${contentIndex}]`)
    }
  }

  private control(block: Record<string, unknown>, path: string): void {
    if (!Object.hasOwn(block, "cache_control")) return
    this.location(path ? `${path}.cache_control` : "cache_control", true)
    const control = record(block.cache_control)
    this.summary.ttl_present ||= Object.hasOwn(control, "ttl")
    this.summary.malformed_or_unknown ||= !validControl(control)
  }

  private location(path: string, marker = false): void {
    this.summary.present = true
    if (marker) this.summary.marker_count++
    if (this.summary.paths.length < 32) this.summary.paths.push(path)
    else this.summary.truncated = true
  }
}

function validControl(control: Record<string, unknown>): boolean {
  return (
    control.type === "ephemeral"
    && !unknownKeys(control, ["type", "ttl"])
    && (!Object.hasOwn(control, "ttl")
      || control.ttl === "5m"
      || control.ttl === "1h")
  )
}

function validOptions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const options = record(value)
  return (
    !unknownKeys(options, ["mode", "ttl"])
    && (!Object.hasOwn(options, "mode")
      || options.mode === "implicit"
      || options.mode === "explicit")
    && (!Object.hasOwn(options, "ttl") || options.ttl === "30m")
  )
}

function validCacheField(key: string, value: unknown): boolean {
  if (value === null) return true
  if (key === "prompt_cache_key") return typeof value === "string"
  return value === "in_memory" || value === "24h"
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: Array<string>,
): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key))
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function array(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}
