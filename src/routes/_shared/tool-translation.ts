import type {
  AnthropicMessagesPayload,
  AnthropicTool,
} from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponseTool,
} from "~/routes/responses/responses-types"

import { truncateToolName } from "./tool-name"

// =============================================================================
// Shared Anthropic -> OpenAI Responses tool translation.
//
// Single source of truth lifted from messages/responses-translation.ts so the
// non-stream and stream Anthropic->Responses bridges can't drift apart. The
// Responses-direction translateTools in responses/non-stream-translation.ts
// handles a DIFFERENT (Chat-format) input shape and is intentionally NOT merged
// here.
// =============================================================================

/** Anthropic `tools` -> OpenAI Responses function tools. Empty/undefined -> undefined. */
export function anthropicToolsToResponses(
  tools?: Array<AnthropicTool>,
): Array<ResponseTool> | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function",
    // OpenAI rejects tool names >64 chars; Anthropic does not cap them.
    name: truncateToolName(tool.name),
    description: tool.description,
    parameters: tool.input_schema,
  }))
}

/** Anthropic `tool_choice` -> OpenAI Responses `tool_choice`. */
export function anthropicToolChoiceToResponses(
  tc: AnthropicMessagesPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!tc) return undefined
  switch (tc.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      // Truncate symmetrically with the tool DEFINITION name above, else a forced
      // choice on a >64-char name would reference a tool absent from the list.
      return tc.name ?
          { type: "function", name: truncateToolName(tc.name) }
        : "auto"
    }
    default: {
      return undefined
    }
  }
}
