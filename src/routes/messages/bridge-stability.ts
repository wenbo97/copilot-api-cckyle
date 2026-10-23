import type { AnthropicMessagesPayload } from "./anthropic-types"

import { bridgeFlagEnabled } from "./bridge-reasoning"

// Claude Code adds this tool only while MCP servers are still connecting, so it
// appears on a fresh process's first request(s) and then vanishes. Tools sit at
// the front of the upstream prompt, so that flap re-bills the whole prefix.
const TRANSIENT_TOOLS = new Set(["WaitForMcpServers"])

/** Drops Claude Code's transient tools on the Messages→Responses bridge (`COPILOT_BRIDGE_STABLE_TOOLS=0` disables). */
export function stabilizeBridgeTools(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  if (!payload.tools || !bridgeFlagEnabled("COPILOT_BRIDGE_STABLE_TOOLS"))
    return payload
  const forced =
    payload.tool_choice?.type === "tool" ? payload.tool_choice.name : undefined
  const tools = payload.tools.filter(
    (tool) => tool.name === forced || !TRANSIENT_TOOLS.has(tool.name),
  )
  return tools.length === payload.tools.length ? payload : { ...payload, tools }
}
