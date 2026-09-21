// A fresh process exercising the public HTTP route without a listening socket.
// Only the external network is substituted; no recovery or registry internals
// are mocked. Used for restart and concurrent-writer regression coverage.
import { state } from "../../src/lib/state"
import { server } from "../../src/server"

const [directory, mode, ciphertext = "issued-before-restart"] =
  process.argv.slice(2)
Object.assign(state, {
  copilotToken: "fixture-token",
  copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  responsesHistoryDirectory: directory,
  responsesHistoryScope: "https://upstream.example/v1",
  models: {
    object: "list",
    data: [{ id: "gpt-6-astra", supported_endpoints: ["/responses"] }],
  },
})
const outcome = { requests: 0, retained: false }
const reasoning = {
  type: "reasoning",
  encrypted_content: ciphertext,
  summary: [],
}
const fetchFixture = (_url: unknown, init?: RequestInit): Response => {
  outcome.requests++
  const body = typeof init?.body === "string" ? init.body : ""
  if (mode === "resume" && body.includes("foreign-cipher")) {
    return Response.json(
      { error: { message: "input item does not belong to this connection" } },
      { status: 401 },
    )
  }
  outcome.retained = mode !== "resume" || body.includes(ciphertext)
  return Response.json({
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    model: "gpt-6-astra",
    status: "completed",
    output: mode === "issue" ? [reasoning] : [],
  })
}
globalThis.fetch = Object.assign(
  (url: unknown, init?: RequestInit) =>
    Promise.resolve(fetchFixture(url, init)),
  { preconnect: globalThis.fetch.preconnect },
) as typeof fetch
const response = await server.request("http://localhost/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gpt-6-astra",
    stream: false,
    input:
      mode === "issue" ?
        []
      : [reasoning, { type: "reasoning", encrypted_content: "foreign-cipher" }],
  }),
})
await response.text()
console.log(JSON.stringify({ status: response.status, ...outcome }))
process.exitCode = response.status === 200 && outcome.retained ? 0 : 1
