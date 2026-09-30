import { AcceptanceRuntime, assert, MODEL } from "./local-runtime"
import { boundedContextPayload, type Scenario } from "./local-scenarios"
import { responseText } from "./local-wire"

const observationStarts = new WeakMap<AcceptanceRuntime, number>()

export const FOLLOWUPS: Array<Scenario> = [
  {
    id: "rate-limit-followup",
    phase: "operations",
    optional: true,
    run: async (runtime) => {
      const id = "rate-limit-followup"
      const before = runtime.ledger.grants.length
      await runtime.management("configure", {
        caseId: id,
        phase: "operations",
        rateLimitSeconds: 1,
        resetRateLimit: true,
      })
      const controller = new AbortController()
      const cancelled = runtime
        .post(
          id,
          {
            model: MODEL,
            input: "Reply READY.",
            reasoning: { effort: "low" },
            max_output_tokens: 1024,
          },
          {
            phase: "operations",
            route: "responses",
            signal: controller.signal,
          },
        )
        .then(
          async (response) => {
            await response.text()
            return "response"
          },
          () => "cancelled",
        )
      const timer = setTimeout(() => controller.abort(), 100)
      try {
        const survivors = Array.from({ length: 3 }, () =>
          runtime.responses(
            id,
            { input: "Reply with exactly READY." },
            "operations",
          ),
        )
        assert(
          (await cancelled) === "cancelled",
          "Queued client did not cancel",
        )
        for (const result of await Promise.all(survivors))
          assert(
            responseText(result).trim() === "READY",
            "Queued response mismatch",
          )
        const grants = runtime.ledger.grants.slice(before)
        assert(grants.length === 3, "Cancelled request reached upstream")
        const health = await runtime.management("health")
        const admissions = health.rateAdmissions
        assert(
          Array.isArray(admissions)
            && admissions.length === 3
            && admissions.every((value) => typeof value === "number"),
          "Missing admission timestamps",
        )
        const times = admissions
        const intervals = times
          .slice(1)
          .map((value, index) => value - times[index])
        assert(
          intervals.every((value) => value >= 1000),
          `Rate-limit admissions clustered: ${intervals.join(",")}`,
        )
        const result = await runtime.responses(
          id,
          { input: "Reply with exactly READY." },
          "operations",
        )
        assert(
          responseText(result).trim() === "READY",
          "Recovery request failed",
        )
        return `Three separated queue admissions (${intervals.join(",")} ms), zero cancelled admission, recovery passed`
      } finally {
        clearTimeout(timer)
        controller.abort()
        await runtime.management("configure", {
          caseId: id,
          phase: "operations",
          rateLimitSeconds: 0,
        })
      }
    },
  },
  ...[false, true, true, false].map((array, index): Scenario => {
    const id = `context-followup-${index + 1}-${array ? "array" : "scalar"}`
    return {
      id,
      phase: "comparison",
      optional: true,
      run: async (runtime) => {
        const payload = boundedContextPayload()
        const result = await runtime.responses(
          id,
          {
            ...payload,
            input:
              array ?
                [{ role: "user", content: payload.input }]
              : payload.input,
          },
          "comparison",
        )
        assert(
          responseText(result).trim() === "ALPHA17 BETA25",
          "Long input lost markers",
        )
        return `Exact markers preserved; input representation=${array ? "message array" : "scalar"}`
      },
    }
  }),
  ...Array.from({ length: 5 }, (_, index): Scenario => {
    const id = `stability-followup-${index + 1}`
    return {
      id,
      phase: "operations",
      optional: true,
      run: async (runtime) => {
        let start = observationStarts.get(runtime)
        if (start === undefined) {
          start = Date.now()
          observationStarts.set(runtime, start)
        }
        await waitUntil(runtime, start + index * 60000)
        const marker = `FOLLOWUP_${index}`
        const result = await runtime.responses(
          id,
          { input: `Reply with exactly ${marker}.`, stream: true },
          "operations",
        )
        assert(
          responseText(result).trim() === marker,
          "Observation marker mismatch",
        )
        const health = await runtime.management("health")
        assert(health.active === 0, "Upstream body remained active")
        runtime.resources.push({
          at: new Date().toISOString(),
          window: "stability-followup",
          sample: index + 1,
          ...health,
        })
        if (index === 4) await waitUntil(runtime, start + 300000)
        return "Exact marker, completed stream, zero active bodies; 60-second header deadline"
      },
    }
  }),
]

async function waitUntil(runtime: AcceptanceRuntime, target: number) {
  while (Date.now() < target) {
    assert(!runtime.halted, "Acceptance stopped during observation")
    await Bun.sleep(Math.min(1000, target - Date.now()))
  }
}
