import { writeFileSync } from "node:fs"
import path from "node:path"

import type { Scenario } from "./local-scenarios"

import { record } from "./local-budget"
import { runClaudeCase, runCodexToolCase } from "./local-clients"
import { MATRIX_MODELS } from "./local-matrix-authorization"
import { AcceptanceRuntime, assert } from "./local-runtime"
import { responseText } from "./local-wire"

export function assertMatrixCatalog(runtime: AcceptanceRuntime) {
  for (const model of MATRIX_MODELS) {
    const entry = runtime.catalog.find((item) => item.id === model)
    const endpoints = entry?.supported_endpoints
    const supports = record(record(entry?.capabilities).supports)
    assert(
      Array.isArray(endpoints) && endpoints.includes("/responses"),
      `Matrix model unavailable: ${model}`,
    )
    assert(
      Array.isArray(supports.reasoning_effort)
        && supports.reasoning_effort.includes("low"),
      `Matrix model does not advertise low effort: ${model}`,
    )
  }
}

async function basic(
  runtime: AcceptanceRuntime,
  id: string,
  options: { model: string; stream: boolean },
) {
  const { model, stream } = options
  const result = await runtime.responses(id, {
    model,
    input: [
      { role: "user", content: "Reply with exactly READY. Do not use tools." },
    ],
    reasoning: { effort: "low" },
    max_output_tokens: 512,
    stream,
  })
  const text = responseText(result).trim()
  const usage = record(result.usage)
  writeFileSync(
    path.join(runtime.directory, `${id}-basic.json`),
    JSON.stringify(
      {
        model,
        stream,
        status: result.status,
        exactFinal: text === "READY",
        usage: result.usage ?? null,
      },
      null,
      2,
    ),
    "utf8",
  )
  assert(text === "READY", "Basic response final text mismatch")
  assert(
    typeof usage.input_tokens === "number"
      && Number.isSafeInteger(usage.input_tokens)
      && usage.input_tokens >= 0,
    "Insufficient evidence: basic input usage missing or invalid",
  )
  assert(
    typeof usage.output_tokens === "number"
      && Number.isSafeInteger(usage.output_tokens)
      && usage.output_tokens >= 0,
    "Insufficient evidence: basic output usage missing or invalid",
  )
  return "Exact READY; completed response; observed input/output usage (cache coverage reported separately)"
}

// Complete all basic checks and Claude cases before shell admission can stop the round.
export const MATRIX: Array<Scenario> = [
  "basic-json",
  "basic-stream",
  "claude-tool",
  "codex-tool",
].flatMap((kind) =>
  MATRIX_MODELS.map((model): Scenario => {
    const id = `matrix-${model}-${kind}`
    return {
      id,
      phase: kind.startsWith("basic-") ? "functional" : "clients",
      optional: true,
      run: (runtime) => {
        if (kind === "claude-tool")
          return runClaudeCase(runtime, id, { model, withTool: true })
        if (kind === "codex-tool") return runCodexToolCase(runtime, id, model)
        return basic(runtime, id, { model, stream: kind === "basic-stream" })
      },
    }
  }),
)
