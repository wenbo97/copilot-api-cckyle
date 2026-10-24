const OBSERVED_HEADERS = [
  "x-claude-code-request-class",
  "x-claude-code-compaction",
  "x-claude-code-session-id",
  "x-claude-code-prompt-id",
  "x-claude-code-agent-id",
  "x-claude-code-agent-type",
] as const

export type GatewayRequestTag = "compaction" | "subagent"

/** Local-only allowlist; never copy credentials or forward these upstream. */
export function gatewayHints(headers: Headers): Record<string, string> {
  const hints: Record<string, string> = {}
  for (const name of OBSERVED_HEADERS) {
    const value = headers.get(name)
    if (value && value.length <= 256) hints[name] = value
  }
  return hints
}

export function gatewayRequestTags(headers: Headers): Array<GatewayRequestTag> {
  const requestClass = headers.get("x-claude-code-request-class")
  const tags: Array<GatewayRequestTag> = []
  if (
    requestClass === "compaction"
    || headers.get("x-claude-code-compaction") === "manual"
  )
    tags.push("compaction")
  if (requestClass === "subagent") tags.push("subagent")
  return tags
}
