import consola from "consola"
import fs from "node:fs/promises"
import path from "node:path"

import { requestLogContext } from "./request-log-context"
import { state } from "./state"

/**
 * Generates a timestamp string for trace file naming.
 * Format: YYYYMMDD_HHmmss_SSS (e.g., 20251204_143052_123)
 */
function getTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const hours = String(now.getHours()).padStart(2, "0")
  const minutes = String(now.getMinutes()).padStart(2, "0")
  const seconds = String(now.getSeconds()).padStart(2, "0")
  const millis = String(now.getMilliseconds()).padStart(3, "0")
  return `${year}${month}${day}_${hours}${minutes}${seconds}_${millis}`
}

/**
 * Ensures the trace folder exists.
 */
export async function ensureTraceFolder(): Promise<void> {
  if (!state.traceEnabled || !state.traceFolder) return

  try {
    await fs.mkdir(state.traceFolder, { recursive: true })
    consola.debug(`Trace folder ensured: ${state.traceFolder}`)
  } catch (error) {
    consola.error("Failed to create trace folder:", error)
  }
}

/**
 * Logs a request to the trace folder.
 * @param request The request payload to log
 * @returns The timestamp used for the request file (to use for matching response)
 */
export async function traceRequest(request: unknown): Promise<string | null> {
  if (!state.traceEnabled || !state.traceFolder) return null

  const timestamp = getTimestamp()
  const filename = `${timestamp}.req`
  const filepath = path.join(state.traceFolder, filename)

  try {
    const content = JSON.stringify(withLogContext(request), null, 2)
    await fs.writeFile(filepath, content, "utf8")
    consola.debug(`Trace request written: ${filepath}`)
    return timestamp
  } catch (error) {
    consola.error("Failed to write trace request:", error)
    return null
  }
}

/**
 * Logs a response to the trace folder.
 * @param response The response payload to log
 * @param timestamp The timestamp from the corresponding request
 */
export async function traceResponse(
  response: unknown,
  timestamp: string | null,
): Promise<void> {
  if (!state.traceEnabled || !state.traceFolder || !timestamp) return

  const filename = `${timestamp}.resp`
  const filepath = path.join(state.traceFolder, filename)

  try {
    const content = JSON.stringify(withLogContext(response), null, 2)
    await fs.writeFile(filepath, content, "utf8")
    consola.debug(`Trace response written: ${filepath}`)
  } catch (error) {
    consola.error("Failed to write trace response:", error)
  }
}

/**
 * Logs a streaming response to the trace folder.
 * For streaming responses, we collect all chunks and write them at the end.
 */
export class StreamTracer {
  private readonly logContext = requestLogContext()
  private chunks: Array<unknown> = []
  private timestamp: string | null

  constructor(timestamp: string | null) {
    this.timestamp = timestamp
  }

  addChunk(chunk: unknown): void {
    if (!state.traceEnabled) return
    this.chunks.push(chunk)
  }

  async finish(): Promise<void> {
    if (!state.traceEnabled || !state.traceFolder || !this.timestamp) return

    const filename = `${this.timestamp}.resp`
    const filepath = path.join(state.traceFolder, filename)

    try {
      const content = JSON.stringify(
        {
          streaming: true,
          ...(this.logContext ? { log_context: this.logContext } : {}),
          chunks: this.chunks,
        },
        null,
        2,
      )
      await fs.writeFile(filepath, content, "utf8")
      consola.debug(`Trace streaming response written: ${filepath}`)
    } catch (error) {
      consola.error("Failed to write trace streaming response:", error)
    }
  }
}

function withLogContext(value: unknown): unknown {
  const context = requestLogContext()
  if (
    !context
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
  )
    return value
  return { ...value, log_context: context }
}
