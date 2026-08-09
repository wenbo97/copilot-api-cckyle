/**
 * Live capability matrix for the Responses-native models guaranteed by this
 * proxy. The proxy must already be running; use :4142 so the user's :4141
 * session is never disturbed.
 *
 * Usage:
 *   bun run tests/acceptance/responses-capabilities.ts
 *   bun run tests/acceptance/responses-capabilities.ts --base-url http://127.0.0.1:4142
 */
import consola from "consola"

const REQUIRED_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const

const REQUIRED_FEATURES = [
  "tool_calls",
  "parallel_tool_calls",
  "streaming",
  "structured_outputs",
  "vision",
] as const

const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAASSURBVBhXY/jPwPAfhKEMhv8AR8oH+ax4QrwAAAAASUVORK5CYII="
const REQUEST_TIMEOUT_MS = 180_000

interface CatalogModel {
  id: string
  supported_endpoints?: Array<string>
  capabilities?: {
    supports?: Record<string, unknown> & { reasoning_effort?: Array<string> }
    limits?: Record<string, unknown>
  }
}

interface CatalogResponse {
  data: Array<CatalogModel>
}

interface ResponsesObject {
  status?: string
  output?: Array<Record<string, unknown>>
  error?: unknown
}

interface Outcome {
  ok: boolean
  status: number
  raw: string
  json?: ResponsesObject
}

interface Check {
  model: string
  name: string
  effort?: string
  pass: boolean
  detail: string
}

interface MatrixContext {
  baseUrl: string
  catalog: CatalogResponse
  checks: Array<Check>
}

interface ScenarioCheck {
  model: string
  effort: string
  name: string
  run: Scenario
}

type Scenario = (
  baseUrl: string,
  model: string,
  effort: string,
) => Promise<string>

function parseBaseUrl(argv: Array<string>): string {
  const index = argv.indexOf("--base-url")
  return (
    index === -1 ?
      "http://127.0.0.1:4142"
    : (argv[index + 1] ?? "")).replace(/\/$/u, "")
}

async function postResponses(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Outcome> {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  let json: ResponsesObject | undefined
  try {
    json = JSON.parse(raw) as ResponsesObject
  } catch {
    // Streaming responses are SSE and intentionally do not parse as one object.
  }
  return { ok: response.ok, status: response.status, raw, json }
}

function assertOk(outcome: Outcome, context: string): ResponsesObject {
  if (!outcome.ok) {
    throw new Error(
      `${context}: HTTP ${outcome.status} ${outcome.raw.slice(0, 500)}`,
    )
  }
  if (!outcome.json) throw new Error(`${context}: expected a JSON response`)
  if (outcome.json.status === "failed" || outcome.json.error) {
    throw new Error(`${context}: response failed ${outcome.raw.slice(0, 500)}`)
  }
  return outcome.json
}

function functionCalls(
  response: ResponsesObject,
): Array<Record<string, unknown>> {
  return (response.output ?? []).filter((item) => item.type === "function_call")
}

function outputText(response: ResponsesObject): string {
  for (const item of response.output ?? []) {
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = part as { type?: string; text?: string }
      if (record.type === "output_text" && record.text) return record.text
    }
  }
  return ""
}

function functionTool(name: string, description = "Returns a short value.") {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  }
}

const structuredOutput: Scenario = async (baseUrl, model, effort) => {
  const outcome = await postResponses(baseUrl, {
    model,
    input: 'Return JSON whose status field is exactly "ok".',
    reasoning: { effort },
    max_output_tokens: 256,
    text: {
      format: {
        type: "json_schema",
        name: "status_response",
        strict: true,
        schema: {
          type: "object",
          properties: { status: { type: "string", const: "ok" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
  })
  const response = assertOk(outcome, "structured output")
  const parsed = JSON.parse(outputText(response)) as { status?: string }
  if (parsed.status !== "ok")
    throw new Error("structured output violated schema")
  return "strict JSON schema returned status=ok"
}

const streamingVision: Scenario = async (baseUrl, model, effort) => {
  const outcome = await postResponses(baseUrl, {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image and reply with OK." },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${RED_PIXEL_PNG}`,
          },
        ],
      },
    ],
    reasoning: { effort },
    max_output_tokens: 256,
    stream: true,
  })
  if (!outcome.ok) {
    throw new Error(
      `streaming vision: HTTP ${outcome.status} ${outcome.raw.slice(0, 500)}`,
    )
  }
  if (!outcome.raw.includes("response.completed")) {
    throw new Error("streaming vision: response.completed event missing")
  }
  return "vision request completed over SSE"
}

const parallelTools: Scenario = async (baseUrl, model, effort) => {
  let received = ""
  for (const attempt of [1, 2, 3]) {
    const outcome = await postResponses(baseUrl, {
      model,
      input:
        "Call both get_alpha and get_beta exactly once. Do not answer directly.",
      reasoning: { effort },
      max_output_tokens: 512,
      parallel_tool_calls: true,
      tool_choice: "required",
      tools: [
        functionTool("get_alpha", "Returns alpha."),
        functionTool("get_beta", "Returns beta."),
      ],
    })
    const response = assertOk(outcome, `parallel tools attempt ${attempt}`)
    const names = new Set(functionCalls(response).map((call) => call.name))
    received = [...names].join(",")
    if (names.has("get_alpha") && names.has("get_beta")) {
      return `both required function calls emitted on attempt ${attempt}`
    }
  }
  throw new Error(`parallel tools: expected two calls, received ${received}`)
}

const namespaceTools: Scenario = async (baseUrl, model, effort) => {
  for (const attempt of [1, 2, 3]) {
    const outcome = await postResponses(baseUrl, {
      model,
      input:
        "Call the status tool in the ops namespace. Do not answer directly.",
      reasoning: { effort },
      max_output_tokens: 512,
      tool_choice: "required",
      tools: [
        {
          type: "namespace",
          name: "ops",
          description: "",
          tools: [functionTool("status", "")],
        },
      ],
    })
    const response = assertOk(outcome, `namespace tools attempt ${attempt}`)
    if (functionCalls(response).length > 0) {
      return `namespace tool called on attempt ${attempt}`
    }
  }
  throw new Error(
    "namespace tools: model emitted no function call after 3 attempts",
  )
}

const multiTurn: Scenario = async (baseUrl, model, effort) => {
  const user = {
    role: "user",
    content: "Call lookup_status, then report the returned status.",
  }
  const tools = [functionTool("lookup_status", "")]
  const firstOutcome = await postResponses(baseUrl, {
    model,
    input: [user],
    reasoning: { effort },
    max_output_tokens: 512,
    tools,
    tool_choice: { type: "function", name: "lookup_status" },
  })
  const first = assertOk(firstOutcome, "multi-turn first response")
  const callId = functionCalls(first)[0]?.call_id
  if (typeof callId !== "string") {
    throw new TypeError(
      "multi-turn: first response emitted no callable tool item",
    )
  }

  const secondOutcome = await postResponses(baseUrl, {
    model,
    input: [
      user,
      ...(first.output ?? []),
      {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ status: "ok" }),
      },
    ],
    reasoning: { effort },
    max_output_tokens: 512,
    tools,
    tool_choice: "none",
  })
  const second = assertOk(secondOutcome, "multi-turn replay")
  if (!outputText(second)) throw new Error("multi-turn replay returned no text")
  return "tool call, output, and reasoning replay completed"
}

const basicCompletion: Scenario = async (baseUrl, model, effort) => {
  const outcome = await postResponses(baseUrl, {
    model,
    input: "Reply with the single word OK.",
    reasoning: { effort },
    max_output_tokens: 256,
  })
  const response = assertOk(outcome, "basic completion")
  if (!outputText(response))
    throw new Error("basic completion returned no text")
  return "non-streaming response returned text"
}

function createPdfDataUrl(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 33 >>\nstream\nBT /F1 18 Tf 40 100 Td (OK) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`
}

async function pdfCanary(baseUrl: string, model: string, effort: string) {
  const outcome = await postResponses(baseUrl, {
    model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "status.pdf",
            file_data: createPdfDataUrl(),
          },
          { type: "input_text", text: "Read the PDF and reply with OK." },
        ],
      },
    ],
    reasoning: { effort },
    max_output_tokens: 256,
  })
  const response = assertOk(outcome, "PDF canary")
  if (!outputText(response)) throw new Error("PDF canary returned no text")
  return "PDF input returned text"
}

const BASIC_SCENARIO = { name: "basic-completion", run: basicCompletion }

const SCENARIOS: Array<{ name: string; run: Scenario }> = [
  { name: "structured-output", run: structuredOutput },
  { name: "streaming-vision", run: streamingVision },
  { name: "parallel-tools", run: parallelTools },
  { name: "namespace-tools", run: namespaceTools },
  { name: "multi-turn-replay", run: multiTurn },
  BASIC_SCENARIO,
]

async function fetchCatalog(baseUrl: string): Promise<CatalogResponse> {
  const catalogResponse = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!catalogResponse.ok) {
    throw new Error(`GET /v1/models failed: ${catalogResponse.status}`)
  }
  return (await catalogResponse.json()) as CatalogResponse
}

async function recordScenario(
  context: MatrixContext,
  check: ScenarioCheck,
): Promise<void> {
  const { effort, model, name, run } = check
  consola.info(`  ${effort}: ${name}`)
  try {
    context.checks.push({
      model,
      name,
      effort,
      pass: true,
      detail: await run(context.baseUrl, model, effort),
    })
  } catch (error) {
    context.checks.push({
      model,
      name,
      effort,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runModel(
  context: MatrixContext,
  modelId: string,
): Promise<void> {
  const model = context.catalog.data.find(
    (candidate) => candidate.id === modelId,
  )
  if (!model) {
    context.checks.push({
      model: modelId,
      name: "catalog",
      pass: false,
      detail: "missing",
    })
    return
  }

  const supports = model.capabilities?.supports
  const missingFeatures = REQUIRED_FEATURES.filter(
    (feature) => supports?.[feature] !== true,
  )
  const efforts = supports?.reasoning_effort ?? []
  const catalogPass =
    model.supported_endpoints?.includes("/responses") === true
    && missingFeatures.length === 0
    && efforts.length > 0
  context.checks.push({
    model: modelId,
    name: "catalog",
    pass: catalogPass,
    detail: `efforts=[${efforts.join(",")}], missingFeatures=[${missingFeatures.join(",")}]`,
  })
  consola.info(`${modelId}: ${efforts.length} advertised effort tier(s)`)
  if (!catalogPass) return

  for (const [index, effort] of efforts.entries()) {
    const scenario = SCENARIOS[index] ?? BASIC_SCENARIO
    await recordScenario(context, {
      model: modelId,
      effort,
      name: scenario.name,
      run: scenario.run,
    })
  }

  const coverageEffort = efforts.at(-1)
  if (coverageEffort) {
    for (const scenario of SCENARIOS.slice(efforts.length)) {
      await recordScenario(context, {
        model: modelId,
        effort: coverageEffort,
        name: scenario.name,
        run: scenario.run,
      })
    }
  }

  if (efforts.includes("max")) {
    await recordScenario(context, {
      model: modelId,
      effort: "ultra",
      name: "ultra-aliases-max",
      run: basicCompletion,
    })
  }
}

async function runPdfCanary(context: MatrixContext): Promise<void> {
  const pdfModel = context.catalog.data.find(
    (model) => model.id === "gpt-5.6-sol",
  )
  const pdfEffort = pdfModel?.capabilities?.supports?.reasoning_effort?.at(-1)
  if (!pdfEffort) return
  await recordScenario(context, {
    model: "gpt-5.6-sol",
    effort: pdfEffort,
    name: "pdf-vision-canary",
    run: pdfCanary,
  })
}

function renderChecks(checks: Array<Check>): void {
  consola.log("")
  for (const check of checks) {
    consola.log(
      `${check.pass ? "PASS" : "FAIL"}  ${check.model}  ${check.effort ?? "-"}  ${check.name}  ${check.detail}`,
    )
  }
  const failed = checks.filter((check) => !check.pass)
  consola.box(`${checks.length - failed.length}/${checks.length} checks PASS`)
  if (failed.length > 0) process.exit(1)
}

async function main(): Promise<void> {
  const baseUrl = parseBaseUrl(process.argv.slice(2))
  if (!baseUrl) throw new Error("--base-url requires a value")
  const catalog = await fetchCatalog(baseUrl)
  const checks: Array<Check> = []
  const context = { baseUrl, catalog, checks }
  for (const modelId of REQUIRED_MODELS) {
    await runModel(context, modelId)
  }
  await runPdfCanary(context)
  renderChecks(checks)
}

await main()
