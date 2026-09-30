import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { exportForeignReasoning } from "../scripts/export-foreign-reasoning"

test("foreign manifest export preserves the rollout and persists only reasoning hashes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foreign-export-"))
  try {
    const source = path.join(directory, "source.jsonl")
    const destination = path.join(directory, "manifest.json")
    const rows = [
      {
        type: "session_meta",
        payload: { id: "source", model_provider: "openai" },
      },
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          encrypted_content: "secret-ciphertext",
          summary: [{ text: "private-context" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "message", encrypted_content: "not-reasoning" },
      },
    ]
    const original = rows.map((row) => JSON.stringify(row)).join("\n")
    await writeFile(source, original)
    expect(await exportForeignReasoning(source, destination)).toEqual({
      sourceSessionId: "source",
      ciphertextCount: 1,
    })
    expect(await readFile(source, "utf8")).toBe(original)
    const output = await readFile(destination, "utf8")
    expect(output).not.toContain("secret-ciphertext")
    expect(output).not.toContain("private-context")
    expect(output).not.toContain("not-reasoning")
    expect(
      await exportForeignReasoning(source, destination).catch(
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error)
    await writeFile(source, original.replace('"openai"', '"copilotproxy"'))
    expect(
      await exportForeignReasoning(
        source,
        path.join(directory, "other.json"),
      ).catch((error: unknown) => error),
    ).toHaveProperty("message", expect.stringContaining("OpenAI-origin"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
