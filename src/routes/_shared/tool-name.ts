import { createHash } from "node:crypto"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { InvalidRequestError } from "~/lib/error"

// OpenAI caps tool/function names at 64 characters; Anthropic imposes no such
// limit, so a long Anthropic tool name must be shortened before it reaches a
// /responses or /chat/completions egress (which would otherwise 400). Port of
// litellm's truncate_tool_name.
const MAX = 64
const HASH = 8
const PREFIX = MAX - HASH - 1 // 55 (room for the "_" joiner)

/**
 * Shorten a tool name to <=64 chars, keeping a 55-char prefix and appending a
 * deterministic 8-char sha256 suffix. The hash avoids collisions when several
 * long names share the same 55-char prefix. Names already within the limit are
 * returned unchanged. (Port of litellm truncate_tool_name.)
 */
export function truncateToolName(name: string): string {
  if (name.length <= MAX) return name
  const h = createHash("sha256").update(name).digest("hex").slice(0, HASH)
  return `${name.slice(0, PREFIX)}_${h}`
}

/** Request-local identities; never attached to a wire payload or shared state. */
export interface ToolNameMap {
  toUpstream(name: string): string
  toOriginal(name: string): string
}

export function createToolNameMap(
  payload: AnthropicMessagesPayload,
): ToolNameMap {
  const originals = new Map<string, string>()
  const aliases = new Map<string, string>()
  const register = (name: string) => {
    const alias = truncateToolName(name)
    const previous = aliases.get(alias)
    if (previous !== undefined && previous !== name)
      throw new InvalidRequestError(
        `Tool names "${previous}" and "${name}" share the same upstream name.`,
        "tool_name_collision",
        "tools",
      )
    originals.set(name, alias)
    aliases.set(alias, name)
  }
  for (const tool of payload.tools ?? []) register(tool.name)
  if (payload.tool_choice?.type === "tool" && payload.tool_choice.name)
    register(payload.tool_choice.name)
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content)
      if (block.type === "tool_use") register(block.name)
  }
  return {
    toUpstream: (name) => originals.get(name) ?? truncateToolName(name),
    toOriginal: (name) => aliases.get(name) ?? name,
  }
}
