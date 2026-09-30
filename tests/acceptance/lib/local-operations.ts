import type { Scenario } from "./local-scenarios"

import { record } from "./local-budget"
import { assert, MODEL } from "./local-runtime"
import { responseText } from "./local-wire"

export const OPERATIONS: Array<Scenario> = [
  {
    id: "refresh-recovery",
    phase: "operations",
    run: async (runtime) => {
      await runtime.management("configure", {
        caseId: "refresh-recovery",
        phase: "operations",
        refresh: true,
      })
      const result = await runtime.responses(
        "refresh-recovery",
        { input: "Reply with exactly READY." },
        "operations",
      )
      assert(
        responseText(result).trim() === "READY",
        "Request after shared refresh failed",
      )
      return "Forced bridge refresh followed by a successful request"
    },
  },
  {
    id: "cancel-stream",
    phase: "operations",
    run: async (runtime) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        const response = await runtime.post(
          "cancel-stream",
          {
            model: MODEL,
            reasoning: { effort: "low" },
            max_output_tokens: 2048,
            stream: true,
            input:
              "Write the integers from 1 through 500, one per line. Do not summarize.",
          },
          {
            phase: "operations",
            route: "responses",
            signal: controller.signal,
          },
        )
        assert(response.ok && response.body, "Cannot open cancellation stream")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ""
        while (!pending.includes("response.output_text.delta")) {
          const next = await reader.read()
          assert(
            !next.done,
            "Stream completed before cancellation could be exercised",
          )
          pending += decoder.decode(next.value, { stream: true })
        }
        controller.abort()
        await reader.cancel().catch(() => {})
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const health = await runtime.management("health")
          const grant = runtime.ledger.grants.findLast(
            (entry) => entry.caseId === "cancel-stream",
          )
          const observation =
            grant ? runtime.ledger.observations.get(grant.id) : undefined
          if (
            health.active === 0
            && observation?.upstreamSignalAborted === true
          )
            return "Cancelled after first text delta; upstream signal aborted and no active bodies remain"
          await Bun.sleep(100)
        }
        throw new Error(
          "Active upstream body remained after downstream cancellation",
        )
      } finally {
        clearTimeout(timeout)
        controller.abort()
      }
    },
  },
  {
    id: "after-cancel",
    phase: "operations",
    run: async (runtime) => {
      const result = await runtime.responses(
        "after-cancel",
        { input: "Reply with exactly READY.", stream: true },
        "operations",
      )
      assert(
        responseText(result).trim() === "READY",
        "Service did not recover after cancellation",
      )
      return "Next independent stream completed normally"
    },
  },
  ...[2, 4].map<Scenario>((concurrency) => ({
    id: `concurrency-${concurrency}`,
    phase: "operations",
    run: async (runtime) => {
      const id = `concurrency-${concurrency}`
      const responses = await Promise.allSettled(
        Array.from({ length: concurrency }, async (_, index) => {
          const marker = `ACCEPT_${concurrency}_${index}`
          const result = await runtime.responses(
            id,
            { input: `Reply with exactly ${marker}.`, stream: true },
            "operations",
          )
          assert(
            responseText(result).trim() === marker,
            `Response crossed request boundary for ${marker}`,
          )
        }),
      )
      const failed = responses.filter((result) => result.status === "rejected")
      assert(
        failed.length === 0,
        `${failed.length} concurrent streams failed; all attempts settled`,
      )
      return `${responses.length} concurrent streams retained their individual markers`
    },
  })),
  {
    id: "restart-inflight",
    phase: "operations",
    run: async (runtime) => {
      const response = await runtime.post(
        "restart-inflight",
        {
          model: MODEL,
          reasoning: { effort: "low" },
          max_output_tokens: 2048,
          stream: true,
          input:
            "Write integers 1 through 500, one per line, without abbreviating.",
        },
        { phase: "operations", route: "responses" },
      )
      assert(response.ok && response.body, "No stream before restart")
      const reader = response.body.getReader()
      const first = await reader.read()
      assert(!first.done, "Stream already ended before restart")
      assert(
        Number((await runtime.management("health")).active) > 0,
        "No active upstream request before restart",
      )
      const oldPid = runtime.child?.pid
      await runtime.stopProxy()
      await reader.cancel().catch(() => {})
      await runtime.startProxy()
      assert(
        runtime.child?.pid !== oldPid,
        "Restart did not create a new process",
      )
      const result = await runtime.responses(
        "restart-inflight",
        { input: "Reply with exactly READY." },
        "operations",
      )
      assert(
        responseText(result).trim() === "READY",
        "Post-restart response failed",
      )
      return "Only the owned proxy was stopped during an active stream; new process served successfully"
    },
  },
]

export async function soak(
  runtime: Parameters<Scenario["run"]>[0],
  recheck = false,
) {
  const start = Date.now()
  const phase = recheck ? "recheck" : "operations"
  const prefix = recheck ? "recheck-soak" : "soak"
  for (let index = 0; index < 20; index++) {
    if (runtime.halted) break
    const target = start + index * 60_000
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- controller callbacks can halt admission during the wait
    while (!runtime.halted && Date.now() < target)
      await Bun.sleep(Math.min(target - Date.now(), 1000))
    const id = `${prefix}-${String(index + 1).padStart(2, "0")}`
    await runtime.runCase(id, phase, async () => {
      const marker = `SOAK_${index}`
      const result = await runtime.responses(
        id,
        { input: `Reply with exactly ${marker}.`, stream: true },
        phase,
      )
      assert(
        responseText(result).trim() === marker,
        "Soak response marker mismatch",
      )
      runtime.resources.push({
        at: new Date().toISOString(),
        sample: index + 1,
        window: prefix,
        ...(await runtime.management("health")),
      })
      return "Exact marker, complete stream, resource snapshot recorded"
    })
  }
  while (!runtime.halted && Date.now() < start + 20 * 60_000)
    await Bun.sleep(Math.min(start + 20 * 60_000 - Date.now(), 1000))
}

export function checkUsageReconciliation(
  runtime: Parameters<Scenario["run"]>[0],
) {
  const matched = runtime.ledger.grants.filter((grant) =>
    runtime.ledger.observations.has(grant.id),
  )
  const known = matched.filter(
    (grant) => runtime.ledger.observations.get(grant.id)?.usage,
  )
  let input = 0
  let output = 0
  let inputCoverage = 0
  let outputCoverage = 0
  for (const grant of known) {
    const usage = record(runtime.ledger.observations.get(grant.id)?.usage)
    const observedInput = usage.input_tokens ?? usage.prompt_tokens
    const observedOutput = usage.output_tokens ?? usage.completion_tokens
    if (
      typeof observedInput === "number"
      && Number.isSafeInteger(observedInput)
      && observedInput >= 0
    ) {
      input += observedInput
      inputCoverage++
    }
    if (
      typeof observedOutput === "number"
      && Number.isSafeInteger(observedOutput)
      && observedOutput >= 0
    ) {
      output += observedOutput
      outputCoverage++
    }
  }
  return {
    attempts: runtime.ledger.grants.length,
    observedAttempts: matched.length,
    attemptsWithUsage: known.length,
    unknownUsageAttempts: runtime.ledger.grants.length - known.length,
    observedInputTokens: inputCoverage ? input : null,
    inputTokensCoverage: inputCoverage,
    observedOutputTokens: outputCoverage ? output : null,
    outputTokensCoverage: outputCoverage,
    accounting:
      "Observed token counts only; missing attempts are not zero and reservations are never refunded",
  }
}
