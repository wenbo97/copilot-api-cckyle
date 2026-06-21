import { createHash } from "node:crypto"

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
