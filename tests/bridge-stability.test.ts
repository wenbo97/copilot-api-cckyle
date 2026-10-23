import { afterEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { stabilizeBridgeTools } from "~/routes/messages/bridge-stability"
import { translateAnthropicToResponses } from "~/routes/messages/responses-translation"

const flags = ["COPILOT_BRIDGE_STABLE_TOOLS"]
const previous = flags.map((flag) => process.env[flag])
afterEach(() => {
  for (const [index, flag] of flags.entries()) {
    const value = previous[index]
    if (value === undefined) Reflect.deleteProperty(process.env, flag)
    else process.env[flag] = value
  }
})

const tool = (name: string) => ({
  name,
  description: name,
  input_schema: { type: "object", properties: {} },
})

const payload = (names: Array<string>): AnthropicMessagesPayload => ({
  model: "gpt-6.1-sol",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
  tools: names.map((name) => tool(name)),
})

test("tools match byte-for-byte before and after MCP servers finish connecting", () => {
  delete process.env.COPILOT_BRIDGE_STABLE_TOOLS
  const connecting = translateAnthropicToResponses(
    stabilizeBridgeTools(payload(["Bash", "WaitForMcpServers", "Read"])),
  )
  const connected = translateAnthropicToResponses(
    stabilizeBridgeTools(payload(["Bash", "Read"])),
  )
  expect(JSON.stringify(connecting.tools)).toBe(JSON.stringify(connected.tools))
})

test("keeps a forced transient tool and honours the off switch", () => {
  const forced = {
    ...payload(["Bash", "WaitForMcpServers"]),
    tool_choice: { type: "tool" as const, name: "WaitForMcpServers" },
  }
  expect(stabilizeBridgeTools(forced).tools).toHaveLength(2)

  process.env.COPILOT_BRIDGE_STABLE_TOOLS = "0"
  expect(
    stabilizeBridgeTools(payload(["Bash", "WaitForMcpServers"])).tools,
  ).toHaveLength(2)
})
