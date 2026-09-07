import { InvalidRequestError } from "~/lib/error"

const OWNERSHIP_MESSAGE = "input item does not belong to this connection"
const MAX_ERROR_BYTES = 16 * 1024
const ERROR_BODY_TIMEOUT_MS = 1000

/** A Responses history rejection is not an expired bearer token. */
export async function rejectInputConnectionMismatch(
  path: string,
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (path !== "/responses" || response.status !== 401) return

  const message = await readErrorMessage(response, signal)
  signal?.throwIfAborted()
  if (message?.trim().toLowerCase() !== OWNERSHIP_MESSAGE) return

  await response.body?.cancel()
  throw new InvalidRequestError(
    `Copilot rejected the conversation history: ${OWNERSHIP_MESSAGE}. `
      + "Check that this history belongs to the current account and endpoint, "
      + "or start a new conversation. No history was removed by the proxy.",
    "copilot_input_connection_mismatch",
    "input",
  )
}

async function readErrorMessage(
  response: Response,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Inspect only a bounded error body. Cancel the cloned reader without
  // awaiting its tee cancellation: the original body is still owned by the
  // caller and must remain readable for ordinary authentication errors.
  const body = response.clone().body as ReadableStream<Uint8Array> | null
  const reader = body?.getReader()
  if (!reader) return
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  const timeout = setTimeout(cancel, ERROR_BODY_TIMEOUT_MS)
  signal?.addEventListener("abort", cancel, { once: true })

  try {
    if (signal?.aborted) return
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_ERROR_BYTES) return
      text += decoder.decode(value, { stream: true })
    }
    return errorMessage(text + decoder.decode())
  } catch {
    // An unreadable or non-JSON 401 still follows the existing auth retry path.
    return
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    cancel()
  }
}

function errorMessage(text: string): string | undefined {
  const body: unknown = JSON.parse(text)
  if (typeof body !== "object" || body === null || !("error" in body)) return
  const error = body.error
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
  )
    return error.message
}
