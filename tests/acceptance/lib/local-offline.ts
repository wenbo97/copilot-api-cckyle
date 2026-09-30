import { writeFileSync } from "node:fs"

import type { Model } from "~/services/copilot/get-models"

import { record, list, stringValue } from "./local-budget"

const destination = process.argv[2]
if (!destination) throw new Error("Provide the isolated result path")
const originalFetch = globalThis.fetch
let calls = 0
let embeddingCalls = 0
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    await Promise.resolve()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "aur.archlinux.org")
      return new Response("pkgver=1.139.1")
    if (
      url.hostname !== "api.githubcopilot.com"
      || typeof init?.body !== "string"
    )
      throw new Error("Unexpected network request in offline acceptance")
    const payload = record(JSON.parse(init.body))
    if (url.pathname === "/embeddings") {
      embeddingCalls++
      if (JSON.stringify(payload.input) !== '["first","second"]')
        throw new Error("Embedding input order changed")
      return Response.json({
        object: "list",
        model: payload.model,
        data: [
          { object: "embedding", index: 0, embedding: [0.25, -0.5] },
          { object: "embedding", index: 1, embedding: [-0.75, 0.5] },
        ],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      })
    }
    calls++
    const marker = init.body.match(/MARKER_\d+_\d+/u)?.[0]
    if (!marker) throw new Error("Missing synthetic marker")
    if (url.pathname === "/responses")
      return Response.json({
        id: `resp_${calls}`,
        object: "response",
        status: "completed",
        model: payload.model,
        output: [
          {
            type: "message",
            id: `msg_${calls}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: marker, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      })
    if (url.pathname === "/chat/completions")
      return Response.json({
        id: `chat_${calls}`,
        object: "chat.completion",
        model: payload.model,
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: marker },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
    if (url.pathname === "/v1/messages")
      return Response.json({
        id: `msg_${calls}`,
        type: "message",
        role: "assistant",
        model: payload.model,
        content: [{ type: "text", text: marker }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      })
    throw new Error("Unexpected offline upstream endpoint")
  },
  { preconnect: originalFetch.preconnect },
)

const { state } = await import("~/lib/state")
const { server } = await import("~/server")
const routes = [
  ["responses", "/responses"],
  ["responses", "/chat/completions"],
  ["chat/completions", "/chat/completions"],
  ["messages", "/v1/messages"],
  ["messages", "/chat/completions"],
  ["messages", "/responses"],
]
state.copilotToken = "offline-not-a-credential"
state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
state.models = {
  object: "list",
  data: routes.map<Model>(([, egress], index) => ({
    id: `fixture-${index}`,
    name: `Fixture ${index}`,
    model_picker_enabled: false,
    preview: false,
    object: "model",
    vendor: "synthetic",
    version: "1",
    supported_endpoints: [egress],
    capabilities: {
      family: "fixture",
      type: "chat",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      limits: { max_output_tokens: 4096 },
      supports: {
        streaming: true,
        tool_calls: true,
        reasoning_effort: ["low"],
      },
    },
  })),
}

const results: Array<{ ingress: string; egress: string; requests: number }> = []
const started = Date.now()
const initialRss = process.memoryUsage().rss
try {
  for (const [routeIndex, [ingress, egress]] of routes.entries()) {
    let complete = 0
    while (complete < 50) {
      const concurrency = [1, 2, 4, 8][Math.floor(complete / 8) % 4]
      const count = Math.min(concurrency, 50 - complete)
      await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const marker = `MARKER_${routeIndex}_${complete + index}`
          const payload = {
            model: `fixture-${routeIndex}`,
            stream: false,
            ...(ingress === "responses" ?
              { max_output_tokens: 64 }
            : { max_tokens: 64 }),
            ...(ingress === "responses" ?
              { input: marker }
            : { messages: [{ role: "user", content: marker }] }),
          }
          const response = await server.request(
            `http://localhost/v1/${ingress}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(5000),
            },
          )
          const text = await response.text()
          const result = record(JSON.parse(text))
          let answer: string
          if (ingress === "responses")
            answer = list(result.output)
              .flatMap((item) => list(record(item).content))
              .map((part) => stringValue(record(part).text))
              .join("")
          else if (ingress === "messages")
            answer = list(result.content)
              .map((part) => stringValue(record(part).text))
              .join("")
          else
            answer = stringValue(
              record(record(list(result.choices)[0]).message).content,
            )
          if (!response.ok || answer !== marker)
            throw new Error(`Offline route failed: ${ingress} -> ${egress}`)
        }),
      )
      complete += count
    }
    results.push({ ingress, egress, requests: complete })
  }
  if (calls !== 300)
    throw new Error(`Expected 300 upstream calls, observed ${calls}`)
  for (const endpoint of ["/embeddings", "/v1/embeddings"]) {
    const response = await server.request(`http://localhost${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-embedding",
        input: ["first", "second"],
      }),
    })
    const body = record(await response.json())
    const vectors = list(body.data).map((entry) => record(entry).embedding)
    if (
      !response.ok
      || JSON.stringify(vectors) !== "[[0.25,-0.5],[-0.75,0.5]]"
      || record(body.usage).prompt_tokens !== 3
    )
      throw new Error(`Embedding contract failed at ${endpoint}`)
  }
  if (embeddingCalls !== 2)
    throw new Error("Embedding aliases were not exercised")
  writeFileSync(
    destination,
    JSON.stringify(
      {
        status: "pass",
        calls,
        embeddingCalls,
        results,
        durationMs: Date.now() - started,
        initialRss,
        finalRss: process.memoryUsage().rss,
        transport:
          "Simulated non-streaming upstream; actual handlers; concurrency 1/2/4/8; external network denied",
      },
      null,
      2,
    ),
    "utf8",
  )
} finally {
  globalThis.fetch = originalFetch
}
