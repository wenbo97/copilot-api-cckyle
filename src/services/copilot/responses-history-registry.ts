import consola from "consola"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

import { copilotBaseUrl } from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

const MARKER = "responses-history-issued-v1\n"
const disabled = new Set<string>()

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
}

/**
 * Immutable, hash-addressed receipts for upstream-issued reasoning. One atomic
 * rename per digest makes concurrent processes additive, without a shared
 * read/modify/write database or a stale lock after a crash. No ciphertext or
 * credentials are stored. A receipt is scoped to this installation + upstream.
 */
export class ResponsesHistoryRegistry {
  private readonly directory: string

  constructor() {
    const scope = new URL(state.responsesHistoryScope ?? copilotBaseUrl(state))
    scope.search = ""
    scope.hash = ""
    const normalized = scope.toString().replace(/\/$/u, "")
    this.directory = path.join(
      state.responsesHistoryDirectory
        ?? path.join(PATHS.APP_DIR, "responses-history"),
      digest(normalized),
    )
  }

  async ensureHealthy(): Promise<void> {
    if (disabled.has(this.directory))
      throw new Error(
        "History compatibility state is unavailable; automatic recovery disabled.",
      )
    try {
      await readFile(path.join(this.directory, "disabled"), "utf8")
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    throw new Error(
      "History compatibility state is unavailable; automatic recovery disabled.",
    )
  }

  async isIssued(ciphertext: string): Promise<boolean> {
    await this.ensureHealthy()
    try {
      const marker = await readFile(
        path.join(this.directory, digest(ciphertext)),
        "utf8",
      )
      if (marker !== MARKER)
        throw new Error(
          "History compatibility receipt is corrupt; automatic recovery disabled.",
        )
      return true
    } catch (error) {
      if (isMissing(error)) return false
      await this.disable()
      throw error
    }
  }

  async remember(value: unknown): Promise<void> {
    const outer = record(value)
    if (!outer) return
    const response = record(outer.response) ?? outer
    const output: Array<unknown> =
      Array.isArray(response.output) ? response.output : []
    const items = [...output, outer.item]
    for (const item of items) {
      const candidate = record(item)
      if (
        candidate?.type !== "reasoning"
        || typeof candidate.encrypted_content !== "string"
        || !candidate.encrypted_content
      )
        continue
      try {
        if (!(await this.isIssued(candidate.encrypted_content)))
          await this.issue(candidate.encrypted_content)
      } catch {
        await this.disable()
        // Healthy requests must remain usable even when the optional receipts
        // cannot be written. Recovery then fails closed instead of guessing.
        consola.warn(
          "[Responses] History receipt unavailable; automatic recovery disabled for this upstream.",
        )
        return
      }
    }
  }

  private async issue(ciphertext: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const destination = path.join(this.directory, digest(ciphertext))
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, MARKER, { flag: "wx", mode: 0o600 })
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error
      })
    }
  }

  private async disable(): Promise<void> {
    disabled.add(this.directory)
    // Persist the fail-closed state if possible, so a restart does not silently
    // reinterpret already-delivered reasoning as unrecognized history.
    await mkdir(this.directory, { recursive: true })
      .then(() =>
        writeFile(
          path.join(this.directory, "disabled"),
          "automatic-recovery-disabled\n",
          { mode: 0o600 },
        ),
      )
      .catch(() => undefined)
  }
}
