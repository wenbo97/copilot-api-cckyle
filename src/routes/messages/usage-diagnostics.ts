import consola from "consola"

import { observeRequest } from "~/services/copilot/request-observer"

import { readMessagesUsage, type MessagesUsage } from "./usage-translation"

/** `messages` is the native /v1/messages passthrough; the others are bridges. */
export type MessagesUsageSource = "chat" | "responses" | "messages"

/** Bounded observations, independent of native Responses and billing reports. */
export class MessagesUsageDiagnostics {
  private finished = false
  private requestId?: string
  private readonly enabled = ["1", "true"].includes(
    process.env.COPILOT_CACHE_DIAGNOSTICS ?? "",
  )

  private readonly source: MessagesUsageSource

  constructor(source: MessagesUsageSource) {
    this.source = source
  }

  setRequestId(requestId: string | undefined): void {
    this.requestId = requestId
  }

  finish(
    usage = readMessagesUsage(
      undefined,
      this.source === "messages" ? "responses" : this.source,
    ),
    extra?: () => Record<string, unknown>,
  ): void {
    if (this.finished) return
    this.finished = true
    if (!this.enabled) return
    const fallbackReasons = reasons(usage)
    observeRequest(() =>
      consola.debug(
        `[messages-usage] ${JSON.stringify({
          source: this.source,
          ...(this.requestId ? { request_id: this.requestId } : {}),
          total_input_tokens: usage.totalInput ?? null,
          cached_input_tokens: usage.cachedInput ?? null,
          output_tokens: usage.output ?? null,
          read_usage_complete:
            usage.totalInput !== undefined
            && usage.cachedInput !== undefined
            && usage.output !== undefined,
          // These are translated counters, not verified provider/account deductions.
          billing_complete: false,
          fallback_reasons: fallbackReasons,
          ...extra?.(),
        })}`,
      ),
    )
  }
}

function reasons(usage: MessagesUsage): Array<string> {
  const result: Array<string> = []
  if (usage.totalInput === undefined) result.push("input_unknown")
  if (usage.cachedInput === undefined) result.push("cache_read_unknown")
  if (usage.output === undefined) result.push("output_unknown")
  if (usage.unverifiedWrite) result.push("unverified_cache_write")
  return result
}

export async function withMessagesUsage<T>(
  source: MessagesUsageSource,
  run: (diagnostics: MessagesUsageDiagnostics) => Promise<T>,
): Promise<T> {
  const diagnostics = new MessagesUsageDiagnostics(source)
  try {
    return await run(diagnostics)
  } catch (error) {
    diagnostics.finish()
    throw error
  }
}
