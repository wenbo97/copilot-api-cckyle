import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { truncateToolName } from "~/routes/_shared/tool-name"
import { server as productionProxy } from "~/server"

import { record, type Json } from "../lib/local-budget"
import {
  createClaudeFixture,
  invokeClaude,
  verifyCodingEvidence,
  verifyFixture,
} from "../lib/local-claude-client"
import {
  createMcpFixture,
  verifyMcpEvidence,
  MCP_PREFIX,
  MCP_LONG_TOOL,
  MCP_IMAGE_TOOL,
} from "../lib/local-claude-mcp"
import { cacheCatalogue } from "../lib/local-claude-scenarios"
import { assert, ROOT } from "../lib/local-runtime"

const directory = path.join(
  ROOT,
  "tests/_runlog",
  `claude-preflight-${randomUUID()}`,
)
mkdirSync(directory, { recursive: true })
const fixture = createClaudeFixture(directory, "gpt-6-luna")
const mcpFixture = createMcpFixture(fixture.evidenceDirectory)
let requests = 0
const bodies: Array<Json> = []
const steps = [
  {
    name: "Read",
    input: { file_path: path.join(fixture.directory, "marker.txt") },
  },
  {
    name: "Read",
    input: { file_path: path.join(fixture.directory, "sum.ts") },
  },
  {
    name: "Edit",
    input: {
      file_path: path.join(fixture.directory, "sum.ts"),
      old_string: "return values.filter(value => value > 0).length",
      new_string:
        "return values.filter(value => value > 0).reduce((sum, value) => sum + value, 0)",
    },
  },
  {
    name: "Bash",
    input: { command: "bun test", description: "Run fixture tests" },
  },
]
const upstreamBodies: Array<Json> = []
const originalFetch = globalThis.fetch
const previousState = { ...state }
Object.assign(state, {
  copilotToken: "offline-preflight-token",
  copilotTokenExpiresAt: Date.now() / 1000 + 3600,
  accountType: "individual",
  manualApprove: false,
  traceEnabled: false,
  rateLimitSeconds: undefined,
  models: {
    object: "list",
    data: [
      {
        id: "gpt-6-luna",
        supported_endpoints: ["/responses"],
        capabilities: { supports: { reasoning_effort: ["high"] } },
      },
    ],
  } as unknown as ModelsResponse,
})
// Every outbound production request is handled here. No real upstream is used.
globalThis.fetch = Object.assign(
  (url: string | URL | Request, init?: RequestInit) => {
    assert(
      new URL(url instanceof Request ? url.url : String(url)).pathname
        === "/responses",
      "Unexpected upstream endpoint",
    )
    assert(typeof init?.body === "string", "Missing translated upstream body")
    const body = record(JSON.parse(init.body))
    upstreamBodies.push(body)
    requests++
    assert(requests <= 10, "Synthetic upstream request cap exceeded")
    const tool =
      requests === 8 || requests === 9 ?
        {
          name: truncateToolName(
            MCP_PREFIX + (requests === 8 ? MCP_LONG_TOOL : MCP_IMAGE_TOOL),
          ),
          input: {},
        }
      : steps.at(requests - 1)
    let answer = fixture.marker
    if (requests === 7) answer = "CACHE_A"
    if (requests === 10)
      answer = `${mcpFixture.expected.marker}|${mcpFixture.expected.colors}`
    const item =
      tool ?
        {
          type: "function_call",
          id: `fc_${requests}`,
          call_id: `tool_${requests}`,
          name: tool.name,
          arguments: JSON.stringify(tool.input),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${requests}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: answer,
              annotations: [],
            },
          ],
        }
    const snapshot = {
      id: `resp_${requests}`,
      object: "response",
      created_at: 1,
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    }
    const events = [
      {
        type: "response.created",
        response: { ...snapshot, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
      },
      tool ?
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: JSON.stringify(tool.input),
        }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          delta: answer,
        },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: snapshot },
    ]
    return Promise.resolve(
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
    )
  },
  { preconnect: originalFetch.preconnect },
)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (
      request.method === "POST"
      && new URL(request.url).pathname === "/v1/messages"
    )
      bodies.push(record(await request.clone().json()))
    return productionProxy.fetch(request)
  },
})
try {
  const options = {
    fixture,
    model: "gpt-6-luna",
    baseUrl: `http://127.0.0.1:${server.port}`,
    tools: true,
  }
  const result = await invokeClaude({
    ...options,
    prompt:
      "Read marker.txt, fix sumPositive using Edit and run bun test. Return the marker.",
    session: "start",
    rawFile: path.join(directory, "coding"),
  })
  verifyCodingEvidence(result.events)
  await verifyFixture(fixture)
  assert(
    requests === 5 && result.final === fixture.marker,
    "Offline tool execution contract failed",
  )
  const resumed = await invokeClaude({
    ...options,
    prompt: "Recall marker without tools",
    session: "resume",
    rawFile: path.join(directory, "resume"),
  })
  assert(
    resumed.final === fixture.marker
      && resumed.sessionId === fixture.sessionId
      && bodies.length === 6,
    "Offline resume failed",
  )
  assert(upstreamBodies.length === 6, "Production bridge was bypassed")
  assert(
    upstreamBodies.every(
      (body) =>
        record(body.reasoning).effort === "high"
        && body.max_output_tokens === 16384
        && body.stream === true,
    ),
    "Translated upstream limits/effort differ from real CLI ingress",
  )
  assert(
    upstreamBodies
      .slice(1)
      .every((body) =>
        JSON.stringify(body.input).includes("function_call_output"),
      ),
    "Production bridge lost tool results",
  )
  const evidence = bodies.map((body) => ({
    model: body.model,
    effort: record(body.output_config).effort,
    thinking: body.thinking,
    max_tokens: body.max_tokens,
  }))
  assert(
    evidence.every(
      (item) => item.effort === "high" && item.max_tokens === 16384,
    ),
    "CLI did not transmit high / 16384 unchanged",
  )
  assert(
    JSON.stringify(bodies[5].messages).includes(fixture.marker),
    "Resumed wire history lacks previous tool result",
  )
  const corpus = cacheCatalogue(randomUUID())
  const cache = await invokeClaude({
    ...options,
    tools: false,
    prompt: "Do not use tools. Reply exactly CACHE_A.",
    appendSystem: corpus,
    rawFile: path.join(directory, "cache"),
  })
  const cacheBody = record(bodies.at(-1))
  const system = cacheBody.system
  assert(
    cache.final === "CACHE_A"
      && Array.isArray(system)
      && system.some((block) => String(record(block).text).includes(corpus)),
    "Real CLI long cache catalogue was not transmitted intact",
  )
  const mcp = await invokeClaude({
    ...options,
    tools: false,
    mcpConfig: mcpFixture.config,
    prompt:
      "Call both acceptance MCP tools once and return the marker, a pipe, and the image colors.",
    rawFile: path.join(directory, "mcp"),
  })
  verifyMcpEvidence(mcpFixture, mcp.events, mcp.final)
  assert(
    (() => requests)() === 10,
    "MCP CLI did not complete its exact bounded tool loop",
  )
  const mcpIngress = bodies.slice(7)
  assert(
    mcpIngress.some((body) =>
      JSON.stringify(body.tools).includes(MCP_PREFIX + MCP_LONG_TOOL),
    ),
    "CLI never advertised original long MCP name",
  )
  const mcpUpstream = upstreamBodies.slice(7)
  assert(
    mcpUpstream.every((body) =>
      JSON.stringify(body.tools).includes(
        truncateToolName(MCP_PREFIX + MCP_LONG_TOOL),
      ),
    ),
    "Upstream did not shorten long MCP definition",
  )
  const translatedHistory = JSON.stringify(mcpUpstream[2].input)
  const beforeImage = translatedHistory.indexOf("Inspect these four squares")
  const image = translatedHistory.indexOf("data:image/png;base64,")
  const afterImage = translatedHistory.indexOf("Return uppercase color names")
  assert(
    beforeImage !== -1 && image > beforeImage && afterImage > image,
    "Translated MCP image/text order was lost",
  )
  console.log(
    JSON.stringify({
      pass: true,
      requests,
      evidence,
      sessionId: fixture.sessionId,
      testLog: readFileSync(
        path.join(fixture.home, "fixture-tests.log"),
        "utf8",
      ),
    }),
  )
} finally {
  await server.stop(true)
  globalThis.fetch = originalFetch
  Object.assign(state, previousState)
}
