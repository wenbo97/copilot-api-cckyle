import type { Phase, Reservation } from "./local-budget"

// Copilot USD per million input/cache-write and output tokens, verified 2026-09-29.
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
export const MATRIX_RATES = {
  "gpt-5.6-luna": { input: 0.45, output: 1.2 },
  "gpt-5.6-terra": { input: 4.5, output: 12 },
  "gpt-5.6-sol": { input: 9, output: 20 },
  "gpt-6-luna": { input: 0.225, output: 0.5 },
  "gpt-6-sol": { input: 4.5, output: 10 },
  "gpt-6-astra": { input: 22.5, output: 50 },
}
export const MATRIX_MODELS = Object.keys(MATRIX_RATES)
export interface MatrixCase {
  model: string
  phase: Phase
  endpoint: "/responses"
  effort: "low"
  attempts: number
  inputTokens: number
  outputTokens: number
}
export interface MatrixAuthorization {
  cases: Partial<Record<string, MatrixCase>>
  cumulative: {
    maxCredits: number
    admissionCredits: number
    attempts: number
    activeMs: number
    phases: Record<Phase, { credits: number; attempts: number }>
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}
function bounded(value: unknown, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  )
    throw new Error("Invalid explicit matrix authorization limit")
  return value
}
function matrixCase(id: string, value: unknown): MatrixCase {
  const cap = object(value)
  const model = String(cap.model)
  const scenario = id.slice(`matrix-${model}-`.length)
  if (
    !Object.hasOwn(MATRIX_RATES, model)
    || id !== `matrix-${model}-${scenario}`
    || !["basic-json", "basic-stream", "claude-tool", "codex-tool"].includes(
      scenario,
    )
    || cap.endpoint !== "/responses"
    || cap.effort !== "low"
  )
    throw new Error("Invalid matrix model or scenario scope")
  const basic = scenario.startsWith("basic-")
  const phase = basic ? "functional" : "clients"
  const clientAttempts = scenario === "claude-tool" ? 3 : 2
  if (cap.phase !== phase) throw new Error("Invalid matrix scenario phase")
  return {
    model,
    phase,
    endpoint: "/responses",
    effort: "low",
    attempts: bounded(cap.attempts, basic ? 1 : clientAttempts),
    inputTokens: bounded(cap.inputTokens, basic ? 4096 : 32768),
    outputTokens: bounded(cap.outputTokens, basic ? 512 : 2048),
  }
}
export function readMatrixAuthorization(
  saved: Record<string, unknown>,
): MatrixAuthorization {
  if (saved.version !== 2 || saved.approved !== true || saved.effort !== "low")
    throw new Error("Explicit approved matrix authorization required")
  bounded(saved.additionalCredits, 825)
  bounded(saved.additionalAttempts, 42)
  bounded(saved.additionalMinutes, 30)
  const cumulative = object(saved.cumulative)
  if (cumulative.maxCredits !== 1000 || cumulative.admissionCredits !== 900)
    throw new Error("Matrix cannot change global credit ceilings")
  const phaseCaps = {
    functional: { credits: 200, attempts: 27 },
    clients: { credits: 850, attempts: 46 },
    operations: { credits: 150, attempts: 32 },
    comparison: { credits: 100, attempts: 16 },
    recheck: { credits: 200, attempts: 24 },
  }
  const phases = {} as MatrixAuthorization["cumulative"]["phases"]
  for (const phase of Object.keys(phaseCaps) as Array<Phase>) {
    const cap = object(object(cumulative.phases)[phase])
    phases[phase] = {
      credits: bounded(cap.credits, phaseCaps[phase].credits),
      attempts: bounded(cap.attempts, phaseCaps[phase].attempts),
    }
  }
  const cases: MatrixAuthorization["cases"] = {}
  for (const [id, value] of Object.entries(object(saved.cases)))
    cases[id] = matrixCase(id, value)
  if (Object.keys(cases).length === 0)
    throw new Error("Matrix requires exact cases")
  return {
    cases,
    cumulative: {
      maxCredits: 1000,
      admissionCredits: 900,
      attempts: bounded(cumulative.attempts, 129),
      activeMs: bounded(cumulative.activeMs, 4733444),
      phases,
    },
  }
}
export function assertMatrixScope(
  matrix: MatrixAuthorization,
  request: Reservation,
) {
  const cap = matrix.cases[request.caseId]
  if (
    !cap
    || request.model !== cap.model
    || request.phase !== cap.phase
    || request.endpoint !== cap.endpoint
    || request.effort !== cap.effort
    || request.inputTokens > cap.inputTokens
    || request.outputTokens > cap.outputTokens
  )
    throw new Error("Request exceeds authorized matrix scope")
  return cap
}
