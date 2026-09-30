/** Standalone red-capable production-contract reproduction. No network or fix. */
import type { Model } from "~/services/copilot/get-models"

import { record } from "../lib/local-budget"

const originalFetch = globalThis.fetch
let egress: Record<string, unknown> = {}
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    await Promise.resolve()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "aur.archlinux.org")
      return new Response("pkgver=1.139.1")
    if (url.pathname !== "/responses" || typeof init?.body !== "string")
      throw new Error("Unexpected network attempt")
    egress = record(JSON.parse(init.body))
    return Response.json({
      id: "resp_fixture",
      object: "response",
      status: "completed",
      model: "gpt-5.6-luna",
      output: [
        {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "READY", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  },
  { preconnect: originalFetch.preconnect },
)

const { state } = await import("~/lib/state")
const { server } = await import("~/server")
const model: Model = {
  id: "gpt-5.6-luna",
  name: "Fixture",
  object: "model",
  model_picker_enabled: false,
  preview: false,
  vendor: "synthetic",
  version: "1",
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt-5.6-luna",
    type: "chat",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    limits: { max_output_tokens: 4096 },
    supports: { reasoning_effort: ["low", "medium", "high"] },
  },
}
state.models = { object: "list", data: [model] }
state.copilotToken = "offline-not-a-credential"
state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
let failures = 0
try {
  for (const variant of [
    {
      name: "enabled-budget-control",
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "low" },
    },
    {
      name: "adaptive-output-config",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    },
    { name: "output-config-only", output_config: { effort: "low" } },
  ]) {
    const { name, ...settings } = variant
    const response = await server.request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 2048,
        stream: false,
        messages: [{ role: "user", content: "Reply READY" }],
        ...settings,
      }),
    })
    await response.text()
    const observed = record(egress.reasoning).effort ?? null
    const pass = response.ok && observed === "low"
    console.log(
      JSON.stringify({
        scenario: name,
        http: response.status,
        expectedEffort: "low",
        actualEffort: observed,
        pass,
      }),
    )
    if (!pass) failures++
  }
} finally {
  globalThis.fetch = originalFetch
}
if (failures) process.exitCode = 1
