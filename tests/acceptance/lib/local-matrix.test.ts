import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { MATRIX } from "./local-matrix"
import { MATRIX_MODELS } from "./local-matrix-authorization"
import { AcceptanceRuntime } from "./local-runtime"

test("matrix completes both basic modes for all six exact models before client workflows", () => {
  expect(MATRIX).toHaveLength(24)
  expect(MATRIX.slice(0, 12).every((item) => item.phase === "functional")).toBe(
    true,
  )
  expect(
    MATRIX.slice(12, 18).every((item) => item.id.endsWith("-claude-tool")),
  ).toBe(true)
  expect(
    MATRIX.slice(18).every((item) => item.id.endsWith("-codex-tool")),
  ).toBe(true)
  expect(new Set(MATRIX.map((item) => item.id)).size).toBe(24)
  expect(MATRIX_MODELS).not.toContain("gpt-5.6-astra")
  expect(MATRIX_MODELS).not.toContain("gpt-6-terra")
})

test("basic matrix fixture uses bounded array input and distinguishes zero from missing usage", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "copilot-matrix-basic-"))
  const runtime = new AcceptanceRuntime(directory, 1000)
  const responses = spyOn(runtime, "responses")
  const result = {
    status: "completed",
    output: [{ content: [{ text: "READY" }] }],
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  responses.mockResolvedValue(result)
  const scenario = MATRIX[0]
  try {
    await scenario.run(runtime)
    expect(responses.mock.calls[0]?.[1]).toMatchObject({
      model: MATRIX_MODELS[0],
      input: [{ role: "user" }],
      max_output_tokens: 512,
      reasoning: { effort: "low" },
      stream: false,
    })
    responses.mockResolvedValue({ ...result, usage: {} })
    const rejection = await scenario
      .run(runtime)
      .catch((error: unknown) => error)
    expect(String(rejection)).toContain("Insufficient evidence")
    const evidence = JSON.parse(
      readFileSync(path.join(directory, `${scenario.id}-basic.json`), "utf8"),
    ) as { usage: Record<string, unknown> }
    expect(evidence.usage).toEqual({})
    expect(runtime.ledger.grants).toHaveLength(0)
  } finally {
    responses.mockRestore()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
