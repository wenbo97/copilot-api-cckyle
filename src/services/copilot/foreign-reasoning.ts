import consola from "consola"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"

import type { ResponsesPayload } from "~/routes/responses/responses-types"

import { ResponsesHistoryRegistry } from "./responses-history-registry"

// This is operator-supplied provenance, never an inference from a receipt miss.
export const foreignReasoningManifestSchema = z
  .object({
    version: z.literal(1),
    sourceProvider: z.literal("openai"),
    sourceSessionId: z.string().min(1),
    ciphertextSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(10000),
  })
  .strict()

export function reasoningDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Remove only explicitly identified foreign ciphertext from the outgoing copy. */
export async function applyForeignReasoningPolicy(
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<ResponsesPayload> {
  const filename = process.env.COPILOT_FOREIGN_REASONING_MANIFEST
  if (!filename || typeof payload.input === "string") return payload
  signal?.throwIfAborted()
  let hashes: Set<string>
  try {
    const manifest = foreignReasoningManifestSchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    )
    hashes = new Set(manifest.ciphertextSha256)
  } catch {
    // Never include file contents (or ciphertext) in configuration errors.
    throw new Error(
      "Invalid COPILOT_FOREIGN_REASONING_MANIFEST; request not sent.",
    )
  }
  const registry = new ResponsesHistoryRegistry()
  const input = []
  let removed = 0
  for (const item of payload.input) {
    signal?.throwIfAborted()
    const value = item as unknown as Record<string, unknown>
    if (
      value.type !== "reasoning"
      || typeof value.encrypted_content !== "string"
      || !hashes.has(reasoningDigest(value.encrypted_content))
      || (await registry.isIssued(value.encrypted_content))
    ) {
      input.push(item)
      continue
    }
    const clean = { ...value }
    delete clean.encrypted_content
    input.push(clean)
    removed++
  }
  signal?.throwIfAborted()
  if (!removed) return payload
  consola.info(
    `[Responses] Explicit foreign reasoning policy removed=${removed}`,
  )
  return { ...payload, input: input as ResponsesPayload["input"] }
}
