/**
 * Codex ships inter-agent message payloads as a content part of type
 * `encrypted_content` — a Fernet token (version byte 0x80) that Codex mints with
 * its own key, distinct from the opaque `encrypted_content` FIELD the Copilot
 * backend puts on `reasoning` items (different format entirely, not Fernet).
 *
 * No provider we egress to can read the Fernet blob, and forwarding it makes the
 * Copilot backend abort the whole response. Since the bytes are unreadable
 * either way, we swap the part for a short marker: the model then knows a
 * message existed but its body is not available, rather than seeing a
 * `Payload:` header followed by nothing and concluding the sub-agent said
 * nothing at all.
 */
export const ENCRYPTED_PART_TYPE = "encrypted_content"

export const UNREADABLE_PAYLOAD_MARKER =
  "[inter-agent payload omitted: encrypted by the client, unreadable by this provider]"

export function isEncryptedPart(part: unknown): boolean {
  return (part as { type?: string } | null)?.type === ENCRYPTED_PART_TYPE
}

export function hasEncryptedContentPart(item: unknown): boolean {
  const content = (item as { content?: unknown }).content
  return Array.isArray(content) && content.some((part) => isEncryptedPart(part))
}
