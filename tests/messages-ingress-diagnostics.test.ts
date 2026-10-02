import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { state, type State } from "~/lib/state"
import { server } from "~/server"

import { captureInfo, captureLogs, completed } from "./fixtures/responses-cache"

const originalFetch = globalThis.fetch
const environment = [
  "COPILOT_CACHE_DIAGNOSTICS",
  "COPILOT_CACHE_POLICY",
  "COPILOT_CACHE_NAMESPACE",
]
let previousState: State
let previousEnvironment: Array<string | undefined>
let info: ReturnType<typeof captureInfo>
let directory: string
const sent: Array<string> = []

beforeEach(async () => {
  previousState = { ...state }
  previousEnvironment = environment.map((key) => process.env[key])
  process.env.COPILOT_CACHE_POLICY = "off"
  delete process.env.COPILOT_CACHE_NAMESPACE
  directory = await mkdtemp(join(tmpdir(), "messages-ingress-diagnostics-"))
  info = captureInfo()
  sent.length = 0
  Object.assign(state, {
    copilotToken: "synthetic-offline-token",
    copilotTokenExpiresAt: Date.now() / 1000 + 3600,
    responsesHistoryDirectory: directory,
    responsesHistoryScope: "https://synthetic.invalid",
    manualApprove: false,
    rateLimitSeconds: undefined,
    traceEnabled: false,
    models: {
      object: "list",
      data: [{ id: "gpt-5.6-luna", supported_endpoints: ["/responses"] }],
    },
  })
  globalThis.fetch = Object.assign(
    (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body !== "string")
        throw new Error("Unexpected synthetic request")
      sent.push(init.body)
      return Promise.resolve(Response.json(completed()))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(async () => {
  info.mockRestore()
  globalThis.fetch = originalFetch
  for (const key of Object.keys(state)) Reflect.deleteProperty(state, key)
  Object.assign(state, previousState)
  for (const [index, key] of environment.entries()) {
    const value = previousEnvironment[index]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  await rm(directory, { recursive: true, force: true })
})

function request(payload: unknown) {
  return server.request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

test("Messages bridge retains original ingress fingerprint sensitivity without changing wire payloads", async () => {
  const base = {
    model: "gpt-5.6-luna",
    max_tokens: 32,
    system: "synthetic-original-system-a",
    messages: [{ role: "user", content: "synthetic-original-question-a" }],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  }
  for (const payload of [
    base,
    { ...base, system: "synthetic-original-system-b" },
    {
      ...base,
      messages: [{ role: "user", content: "synthetic-original-question-b" }],
    },
    { ...base, output_config: { effort: "high" } },
  ]) {
    process.env.COPILOT_CACHE_DIAGNOSTICS = "1"
    const enabled = await request(payload)
    expect(enabled.status).toBe(200)
    await enabled.text()
    delete process.env.COPILOT_CACHE_DIAGNOSTICS
    const disabled = await request(payload)
    expect(disabled.status).toBe(200)
    await disabled.text()
    expect(sent.at(-1)).toBe(sent.at(-2))
  }
  const records = captureLogs(info.mock.calls, "cache-diagnostics")
  expect(records).toHaveLength(4)
  const [original, changedSystem, changedQuestion, changedEffort] = records
  expect(original.ingress_static_prefix).not.toEqual(
    changedSystem.ingress_static_prefix,
  )
  expect(original.ingress_static_prefix).toEqual(
    changedQuestion.ingress_static_prefix,
  )
  expect(original.ingress_fingerprints).not.toEqual(
    changedQuestion.ingress_fingerprints,
  )
  expect(original.ingress_static_prefix).not.toEqual(
    changedEffort.ingress_static_prefix,
  )
  expect(JSON.stringify(records)).not.toContain("synthetic-original-system")
  expect(JSON.stringify(records)).not.toContain("synthetic-original-question")
  for (const body of sent) {
    expect(body).not.toContain("ingressFingerprints")
    expect(body).not.toContain("ingressStaticPrefix")
  }
})
