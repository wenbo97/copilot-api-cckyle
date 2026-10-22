import { expect, test } from "bun:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { prepareGeneration } from "./local-budget"
import {
  buildClaudeAuthorization,
  claudeOptions,
  readClaudeAuthorization,
} from "./local-claude-authorization"
import {
  cacheMetrics,
  uniqueDiagnostics,
  validateMessagesTerminal,
} from "./local-claude-report"
import { cacheCatalogue, changeCacheQuestion } from "./local-claude-scenarios"
import { openBudget } from "./local-continuation"

function authorization(directory: string) {
  return buildClaudeAuthorization({
    roundId: "claude-test",
    budgetDirectory: directory,
    approvalReference: "Synthetic offline test",
    executionSha256: "a".repeat(64),
    fixtureSalt: randomUUID(),
    models: ["gpt-6.1-sol", "gpt-6-luna"],
    credits: 500,
    attempts: 60,
    minutes: 45,
  })
}

test("Claude profile rejects budget widening, alternate models and ambiguous invocation", () => {
  const base = ["--profile", "claude-proxy"]
  expect(claudeOptions(base).effort).toBe("high")
  for (const extra of [
    ["--max-attempts", "61"],
    ["--models", "gpt-6-astra"],
    ["--effort", "low"],
    ["--live"],
    ["--models", "gpt-6-luna,gpt-6-luna"],
    ["--dry-run", "--live"],
  ])
    expect(() => claudeOptions([...base, ...extra])).toThrow()
})

test("high request preparation preserves actual payload and rejects output truncation", () => {
  const body = {
    model: "gpt-6.1-sol",
    reasoning: { effort: "high" },
    max_output_tokens: 16384,
    input: "hello",
  }
  const limits = {
    inputTokens: 65536,
    outputTokens: 16384,
    profile: "claude-proxy" as const,
  }
  expect(prepareGeneration("/responses", body, limits).serialized).toBe(
    JSON.stringify(body),
  )
  expect(() => prepareGeneration("/responses", body)).toThrow()
  expect(() =>
    prepareGeneration(
      "/responses",
      { ...body, max_output_tokens: 16385 },
      limits,
    ),
  ).toThrow()
  expect(() =>
    prepareGeneration(
      "/responses",
      { ...body, reasoning: { effort: "low" } },
      limits,
    ),
  ).toThrow()
})

test("Claude authorization binds prices, effort and case scope", () => {
  const auth = authorization("fixture")
  expect(readClaudeAuthorization({ ...structuredClone(auth) })).toEqual(auth)
  const edited = { ...structuredClone(auth) } as Record<string, unknown>
  edited.effort = "low"
  expect(() => readClaudeAuthorization(edited)).toThrow()
  expect(Object.values(auth.cases).every((cap) => cap?.effort === "high")).toBe(
    true,
  )
})

test("Claude ledger persists high reservations, case limits and stops", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-budget-"))
  const authorizationFile = path.join(directory, "authorization.json")
  writeFileSync(authorizationFile, JSON.stringify(authorization(directory)))
  const input = {
    directory,
    maxCredits: 500,
    previous: [],
    options: { authorizationFile },
  }
  const request = {
    caseId: "claude-proxy-gpt-6.1-sol-smoke",
    model: "gpt-6.1-sol",
    endpoint: "/responses",
    phase: "clients" as const,
    inputTokens: 10000,
    outputTokens: 16384,
    effort: "high",
    limitApplied: false,
  }
  try {
    const first = openBudget(input)
    first.ledger.reserve(request)
    expect(() => first.ledger.reserve({ ...request, effort: "low" })).toThrow()
    first.clock.checkpoint()
    first.release()
    const second = openBudget(input)
    expect(second.ledger.grants).toHaveLength(1)
    second.ledger.reserve(request)
    expect(() => second.ledger.reserve(request)).toThrow("scenario attempt")
    second.ledger.halt("Account stop")
    second.clock.checkpoint()
    second.release()
    expect(() => openBudget(input)).toThrow("stopped")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("cache measurement keeps unknown counts separate and weights paired inputs", () => {
  const result = cacheMetrics([
    { input_tokens: 100, cached_input_tokens: 90 },
    { input_tokens: 900, cached_input_tokens: 0 },
    { input_tokens: 10000 },
    { input_tokens: 10, cached_input_tokens: 11 },
  ])
  expect(result.tokenHitRatio).toBe(0.09)
  expect(result.coverage).toBe(0.5)
  expect(cacheMetrics([{ input_tokens: 100 }]).tokenHitRatio).toBeNull()
  const rows = [
    { caseId: "first", summary: { request_id: "id", input_tokens: 5 } },
    { caseId: "second", summary: { request_id: "id", input_tokens: 5 } },
  ]
  expect(uniqueDiagnostics(rows)[0].caseId).toBe("first")
  expect(() =>
    uniqueDiagnostics([
      ...rows,
      { summary: { request_id: "id", input_tokens: 6 } },
    ]),
  ).toThrow()
})

test("terminal evidence rejects missing stop, errors and max-token truncation", () => {
  const stop = { type: "message_stop" }
  expect(() => validateMessagesTerminal([stop])).toThrow()
  expect(() =>
    validateMessagesTerminal([
      { type: "message_delta", stopReason: "max_tokens" },
      stop,
    ]),
  ).toThrow()
  expect(() =>
    validateMessagesTerminal([
      { type: "message_delta", stopReason: "end_turn" },
      stop,
      { type: "error" },
    ]),
  ).toThrow()
  validateMessagesTerminal([
    { type: "message_delta", stopReason: "tool_use" },
    stop,
  ])
  for (const invalid of [
    [stop, { type: "message_delta", stopReason: "end_turn" }],
    [
      { type: "message_delta", stopReason: "end_turn" },
      { type: "message_delta", stopReason: "max_tokens" },
      stop,
    ],
    [
      { type: "message_delta", stopReason: "end_turn" },
      stop,
      { type: "content_block_delta" },
    ],
  ])
    expect(() => validateMessagesTerminal(invalid)).toThrow()
})

test("cache suffix replay changes only the final user question", () => {
  const body = {
    system: "CACHE_A static",
    tools: [{ name: "CACHE_A" }],
    messages: [
      { role: "user", content: "CACHE_A previous" },
      { role: "user", content: [{ type: "text", text: "Reply CACHE_A" }] },
    ],
  }
  changeCacheQuestion(body)
  expect(body.system).toBe("CACHE_A static")
  expect(body.tools[0].name).toBe("CACHE_A")
  expect(body.messages[0].content).toBe("CACHE_A previous")
  expect(body.messages[1].content).toEqual([
    { type: "text", text: "Reply CACHE_B" },
  ])
})

test("cache replay preserves Claude's trailing system environment message", () => {
  const body = {
    messages: [
      { role: "user", content: "Reply CACHE_A" },
      { role: "system", content: "Environment: retain CACHE_A here" },
    ],
  }
  changeCacheQuestion(body)
  expect(body.messages).toEqual([
    { role: "user", content: "Reply CACHE_B" },
    { role: "system", content: "Environment: retain CACHE_A here" },
  ])
})

test("cache catalogue is long enough to measure reuse and fits Windows argv", () => {
  const corpus = cacheCatalogue(randomUUID())
  expect(encode(corpus).length).toBeGreaterThanOrEqual(8192)
  expect(corpus.length).toBeLessThan(24500)
})
