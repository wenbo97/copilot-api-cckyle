import { stringValue, list } from "./local-budget"
import { record, type Phase } from "./local-budget"
import { AcceptanceRuntime, assert, MODEL } from "./local-runtime"
import { parseEvents, responseText, isNamespaceStatusCall } from "./local-wire"

export interface Scenario {
  id: string
  phase: Phase
  optional?: boolean
  run: (runtime: AcceptanceRuntime) => Promise<string>
}

export function boundedContextPayload(model = MODEL) {
  return {
    model,
    input: `The first marker is ALPHA17.\n${"irrelevant fixed filler line\n".repeat(1500)}\nThe final marker is BETA25. Reply with the two markers separated by one space.`,
  }
}

const tool = (name: string) => ({
  type: "function",
  name,
  description: `Return ${name}`,
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  strict: true,
})
const messageBody = (stream: boolean) => ({
  model: MODEL,
  max_tokens: 2048,
  thinking: { type: "enabled", budget_tokens: 1024 },
  stream,
  messages: [{ role: "user", content: "Reply with exactly READY." }],
})

export const FUNCTIONAL: Array<Scenario> = [
  {
    id: "bounded-context-array",
    phase: "comparison",
    optional: true,
    run: async (runtime) => {
      const payload = boundedContextPayload()
      const result = await runtime.responses(
        "bounded-context-array",
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: payload.input }],
            },
          ],
        },
        "comparison",
      )
      assert(
        responseText(result).trim() === "ALPHA17 BETA25",
        "Array context boundary markers lost",
      )
      return "Identical text represented as a standard user message array"
    },
  },
  {
    id: "bounded-context-terra",
    phase: "comparison",
    optional: true,
    run: async (runtime) => {
      const model = runtime.catalog.find(
        (candidate) => candidate.id === "gpt-5.6-terra",
      )
      assert(
        model
          && Array.isArray(model.supported_endpoints)
          && model.supported_endpoints.includes("/responses"),
        "Terra native Responses unavailable",
      )
      const result = await runtime.responses(
        "bounded-context-terra",
        boundedContextPayload("gpt-5.6-terra"),
        "comparison",
      )
      assert(
        responseText(result).trim() === "ALPHA17 BETA25",
        "Terra context boundary markers lost",
      )
      return "Same synthetic context on Terra/low; diagnostic comparison only"
    },
  },
  {
    id: "auth-catalog",
    phase: "functional",
    run: async (runtime) => {
      const health = await runtime.management("health")
      assert(
        health.bridgeOnly === true,
        "Proxy did not use bridge-only authentication",
      )
      return `${runtime.catalog.length} catalog models; bridge-only authentication; account identity user-confirmed`
    },
  },
  {
    id: "responses-json",
    phase: "functional",
    run: async (runtime) => {
      const response = await runtime.responses("responses-json", {
        input: "Return status=ok and count=7.",
        text: {
          format: {
            type: "json_schema",
            name: "status",
            strict: true,
            schema: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["ok"] },
                count: { type: "integer", enum: [7] },
              },
              required: ["status", "count"],
              additionalProperties: false,
            },
          },
        },
      })
      const parsed = record(JSON.parse(responseText(response)))
      assert(
        parsed.status === "ok"
          && parsed.count === 7
          && Object.keys(parsed).length === 2,
        "Structured output violated the schema",
      )
      return "Strict JSON schema, exact values, completed non-stream response"
    },
  },
  {
    id: "responses-stream",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses("responses-stream", {
        input: "Reply with exactly READY.",
        stream: true,
      })
      assert(
        responseText(result).trim() === "READY",
        "Unexpected streamed text",
      )
      return "Exact text, monotonic SSE sequence, one completed terminal"
    },
  },
  {
    id: "parallel-tools-replay",
    phase: "functional",
    run: async (runtime) => {
      const user = {
        role: "user",
        content:
          "Call alpha and beta exactly once each in the same turn. Do not answer directly.",
      }
      const tools = [tool("alpha"), tool("beta")]
      const first = await runtime.responses("parallel-tools-replay", {
        input: [user],
        tools,
        tool_choice: "required",
        parallel_tool_calls: true,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 2048,
      })
      const output = list(first.output)
      const calls = output
        .map((value) => record(value))
        .filter((item) => item.type === "function_call")
      assert(
        calls.length === 2
          && new Set(calls.map((call) => call.name)).size === 2
          && calls.every((call) =>
            ["alpha", "beta"].includes(String(call.name)),
          ),
        "Model did not emit both parallel calls; no automatic repeat",
      )
      assert(
        calls.every((call) => typeof call.call_id === "string"),
        "Missing call IDs",
      )
      const second = await runtime.responses("parallel-tools-replay", {
        input: [
          user,
          ...output,
          ...calls.map((call) => ({
            type: "function_call_output",
            call_id: call.call_id,
            output: [
              {
                type: "input_text",
                text: call.name === "alpha" ? "A=17" : "B=25",
              },
            ],
          })),
          {
            role: "user",
            content:
              "Add the returned A and B values. Reply only with their sum as decimal digits.",
          },
        ],
        tools,
        tool_choice: "none",
        stream: true,
        max_output_tokens: 2048,
      })
      assert(
        responseText(second).trim() === "42",
        "Tool result replay lost values",
      )
      return "Two distinct calls and text-array results replayed with reasoning/history intact"
    },
  },
  {
    id: "namespace-tool",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses("namespace-tool", {
        input: "Call ops.status now.",
        tool_choice: "required",
        tools: [
          {
            type: "namespace",
            name: "ops",
            description: "Status operations",
            tools: [tool("status")],
          },
        ],
      })
      const calls = (Array.isArray(result.output) ? result.output : []).map(
        (value) => record(value),
      )
      assert(
        calls.some((call) => isNamespaceStatusCall(call)),
        "Missing namespace call",
      )
      return "Namespace function call preserved"
    },
  },
  {
    id: "custom-tool",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses("custom-tool", {
        input: "Call emit_status with the exact text READY.",
        tool_choice: "required",
        tools: [
          {
            type: "custom",
            name: "emit_status",
            description: "Emit a status string",
            format: { type: "text" },
          },
        ],
      })
      const calls = (Array.isArray(result.output) ? result.output : []).map(
        (value) => record(value),
      )
      assert(
        calls.some(
          (item) =>
            item.type === "custom_tool_call"
            && item.name === "emit_status"
            && String(item.input).trim() === "READY",
        ),
        "Missing exact custom tool input",
      )
      return "Custom tool name and input preserved"
    },
  },
  ...[false, true].map<Scenario>((stream) => ({
    id: stream ? "messages-stream" : "messages-json",
    phase: "functional",
    run: async (runtime) => {
      const id = stream ? "messages-stream" : "messages-json"
      const response = await runtime.post(id, messageBody(stream), {
        phase: "functional",
        route: "messages",
      })
      const raw = await response.text()
      assert(response.ok, `Messages HTTP ${response.status}`)
      if (stream) {
        const events = parseEvents(raw)
        assert(
          events.filter((event) => event.type === "message_stop").length === 1,
          "Expected one message_stop",
        )
        assert(
          !events.some((event) => event.type === "error"),
          "Messages emitted an error",
        )
        const text = events
          .map((event) => stringValue(record(event.delta).text))
          .join("")
          .trim()
        assert(text === "READY", "Unexpected Messages stream text")
      } else {
        const result = record(JSON.parse(raw))
        const text = (Array.isArray(result.content) ? result.content : [])
          .map((item) => stringValue(record(item).text))
          .join("")
          .trim()
        assert(
          text === "READY" && result.stop_reason === "end_turn",
          "Incorrect Messages response or stop reason",
        )
      }
      return "Messages-to-Responses low-effort bridge and terminal contract passed"
    },
  })),
  {
    id: "vision",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses("vision", {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "What is the dominant color? Reply with the lowercase color only.",
              },
              {
                type: "input_image",
                detail: "low",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
              },
            ],
          },
        ],
        stream: true,
      })
      assert(
        responseText(result).trim().toLowerCase() === "red",
        "Image interpretation did not return red",
      )
      return "Small synthetic image accepted through native Responses"
    },
  },
  {
    id: "pdf",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses("pdf", {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                filename: "acceptance.pdf",
                file_data: makePdf(),
              },
              {
                type: "input_text",
                text: "Reply with only the status word printed in the PDF.",
              },
            ],
          },
        ],
      })
      assert(responseText(result).trim() === "READY", "PDF marker not returned")
      return "Small synthetic PDF marker preserved"
    },
  },
  {
    id: "bounded-context",
    phase: "functional",
    run: async (runtime) => {
      const result = await runtime.responses(
        "bounded-context",
        boundedContextPayload(),
      )
      assert(
        responseText(result).trim() === "ALPHA17 BETA25",
        "Context boundary markers lost",
      )
      return "Both markers retrieved from bounded synthetic context; not a maximum-context benchmark"
    },
  },
  {
    id: "cache-policy",
    phase: "functional",
    run: async (runtime) => {
      const input = [
        {
          role: "developer",
          content: "For this synthetic test, reply with exactly READY.",
        },
        { role: "user", content: "Report status." },
      ]
      try {
        for (const policy of ["off", "prefix-v1"]) {
          await runtime.management("configure", {
            caseId: "cache-policy",
            phase: "functional",
            cachePolicy: policy,
          })
          const result = await runtime.responses("cache-policy", {
            input,
            stream: true,
          })
          assert(
            responseText(result).trim() === "READY",
            `Cache policy ${policy} changed the answer`,
          )
        }
      } finally {
        await runtime.management("configure", {
          caseId: "unassigned",
          phase: "functional",
          cachePolicy: "off",
        })
      }
      return "off and prefix-v1 accepted with identical synthetic task; no savings claim"
    },
  },
  {
    id: "openai-chat",
    phase: "comparison",
    run: async (runtime) => {
      const model = runtime.catalog.find(
        (candidate) => candidate.id === "gpt-5-mini",
      )
      assert(
        Array.isArray(model?.supported_endpoints)
          && model.supported_endpoints.includes("/chat/completions"),
        "GPT-5 mini Chat unavailable",
      )
      const response = await runtime.post(
        "openai-chat",
        {
          model: "gpt-5-mini",
          reasoning_effort: "low",
          max_completion_tokens: 1024,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Reply with exactly READY." }],
        },
        { phase: "comparison", route: "chat/completions" },
      )
      const raw = await response.text()
      assert(response.ok, `Chat HTTP ${response.status}`)
      const events = parseEvents(raw)
      const choices = events.flatMap((event) =>
        Array.isArray(event.choices) ?
          event.choices.map((value) => record(value))
        : [],
      )
      assert(
        choices
          .map((choice) => stringValue(record(choice.delta).content))
          .join("")
          .trim() === "READY",
        "Chat text mismatch",
      )
      assert(
        choices.some((choice) => choice.finish_reason === "stop"),
        "Chat finish_reason missing",
      )
      return "GPT-5 mini direct Chat stream, low effort, terminal and usage observation"
    },
  },
]

function makePdf(): string {
  const content = "BT /F1 18 Tf 40 80 Td (READY) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`
}
