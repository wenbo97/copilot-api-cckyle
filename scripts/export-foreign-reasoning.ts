import { createReadStream } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"

import {
  foreignReasoningManifestSchema,
  reasoningDigest,
} from "~/services/copilot/foreign-reasoning"

function openaiSessionId(payload: Record<string, unknown> | undefined): string {
  if (payload?.model_provider !== "openai" || typeof payload.id !== "string")
    throw new Error("Expected one explicitly OpenAI-origin source session.")
  return payload.id
}

// Run only for an operator-confirmed OpenAI-origin rollout. The output is a
// reviewable hash allowlist; generating it does not activate server policy.
export async function exportForeignReasoning(
  source: string,
  destination: string,
) {
  let sourceSessionId: string | undefined
  const hashes = new Set<string>()
  const input = createReadStream(source)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as {
        type?: string
        payload?: Record<string, unknown>
      }
      const payload = row.payload
      if (row.type === "session_meta") {
        if (sourceSessionId)
          throw new Error(
            "Expected one explicitly OpenAI-origin source session.",
          )
        sourceSessionId = openaiSessionId(payload)
      }
      if (
        row.type === "turn_context"
        && payload?.model_provider !== undefined
        && payload.model_provider !== "openai"
      )
        throw new Error(
          "Mixed-provider rollout requires manual per-item provenance review.",
        )
      if (
        row.type === "response_item"
        && payload?.type === "reasoning"
        && typeof payload.encrypted_content === "string"
      )
        hashes.add(reasoningDigest(payload.encrypted_content))
    }
  } finally {
    lines.close()
    input.destroy()
  }
  const manifest = foreignReasoningManifestSchema.parse({
    version: 1,
    sourceProvider: "openai",
    sourceSessionId,
    ciphertextSha256: [...hashes].sort(),
  })
  if (hashes.size === 0)
    throw new Error("No reasoning ciphertext found; no manifest written.")
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  })
  return { sourceSessionId, ciphertextCount: hashes.size }
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2)
  if (!source || !destination)
    throw new Error(
      "Usage: bun scripts/export-foreign-reasoning.ts <OpenAI rollout.jsonl> <new manifest.json>",
    )
  console.log(JSON.stringify(await exportForeignReasoning(source, destination)))
}
