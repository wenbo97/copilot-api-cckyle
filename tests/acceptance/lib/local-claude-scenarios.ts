import { encode } from "gpt-tokenizer/encoding/o200k_base"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record, type Json } from "./local-budget"
import {
  type ClaudeKind,
  type ClaudeProxyAuthorization,
} from "./local-claude-authorization"
import {
  createClaudeFixture,
  invokeClaude,
  verifyCodingEvidence,
  verifyFixture,
} from "./local-claude-client"
import { createMcpFixture, verifyMcpEvidence } from "./local-claude-mcp"
import { validateMessagesTerminal } from "./local-claude-report"
import { AcceptanceRuntime, assert, BASE_URL } from "./local-runtime"
import { parseEvents } from "./local-wire"

type Fixture = ReturnType<typeof createClaudeFixture>
export class ClaudeScenarios {
  private readonly fixtures = new Map<string, Fixture>()

  private readonly runtime: AcceptanceRuntime
  private readonly auth: ClaudeProxyAuthorization

  constructor(runtime: AcceptanceRuntime, auth: ClaudeProxyAuthorization) {
    this.runtime = runtime
    this.auth = auth
  }

  private fixture(model: string) {
    let fixture = this.fixtures.get(model)
    if (!fixture) {
      fixture = createClaudeFixture(this.runtime.directory, model)
      this.fixtures.set(model, fixture)
      writeFileSync(
        path.join(fixture.evidenceDirectory, "session-evidence.json"),
        JSON.stringify(fixture, null, 2),
      )
    }
    return fixture
  }

  private call(
    id: string,
    model: string,
    extra: Pick<Parameters<typeof invokeClaude>[0], "prompt">
      & Partial<Parameters<typeof invokeClaude>[0]>,
  ) {
    return invokeClaude({
      fixture: this.fixture(model),
      model,
      baseUrl: BASE_URL,
      rawFile: path.join(this.runtime.directory, `${id}-${Date.now()}`),
      guardReason: () =>
        this.runtime.halted ?
          "Acceptance stopped"
        : (this.runtime.blocked.findLast((row) => row.caseId === id)?.reason as
            | string
            | undefined),
      ...extra,
    })
  }

  async run(id: string, model: string, kind: ClaudeKind): Promise<string> {
    switch (kind) {
      case "smoke":
      case "recovery": {
        const result = await this.call(id, model, {
          prompt: "Do not use tools. Reply with exactly READY.",
        })
        assert(result.final.trim() === "READY", "Exact smoke answer missing")
        return "Real Claude CLI completed high-effort stream with exact READY"
      }
      case "coding": {
        const result = await this.call(id, model, {
          prompt:
            "In this isolated project, use Read to inspect marker.txt, sum.ts and sum.test.ts. Fix sumPositive using Edit so it sums positive values and ignores zero/negative values. Do not edit tests or package.json. Use Bash with exactly the command bun test to verify. Do not access other directories or use any other shell command. In the final answer include the exact marker and the test result.",
          tools: true,
          session: "start",
        })
        verifyCodingEvidence(result.events)
        const fixture = this.fixture(model)
        assert(
          result.final.includes(fixture.marker),
          "Final answer lacks tool-read marker",
        )
        assert(
          result.sessionId === fixture.sessionId,
          "CLI changed requested session identity",
        )
        await verifyFixture(fixture)
        return "Actual Read/Edit/Bash, marker, unchanged tests and independent passing tests verified"
      }
      case "resume": {
        return this.resume(id, model)
      }
      case "mcp": {
        const fixture = createMcpFixture(this.fixture(model).evidenceDirectory)
        const result = await this.call(id, model, {
          prompt:
            "Use both tools from the acceptance MCP server, once each: obtain the private marker and inspect the color-strip image. Return exactly MARKER|COLOR1,COLOR2,COLOR3,COLOR4 using the returned marker and uppercase colors in left-to-right order. Do not guess or use other tools.",
          mcpConfig: fixture.config,
        })
        return verifyMcpEvidence(fixture, result.events, result.final)
      }
      case "cache": {
        return this.cache(id, model)
      }
      case "cancel": {
        return this.cancel(id, model)
      }
      default: {
        throw new Error("Unknown Claude case")
      }
    }
  }

  private async resume(id: string, model: string) {
    const fixture = this.fixture(model)
    const token = `RESUME_${this.auth.fixtureSalt}`
    const prompts = [
      [
        "Do not use tools. What exact marker did you read in marker.txt earlier? Reply only with that marker.",
        fixture.marker,
      ],
      [
        `Do not use tools. Remember this token for our next turn: ${token}. Reply only SAVED.`,
        "SAVED",
      ],
      [
        "Do not use tools. What exact token did I ask you to remember in the previous turn? Reply only with it.",
        token,
      ],
    ]
    for (const [prompt, expected] of prompts) {
      const result = await this.call(id, model, {
        prompt,
        tools: true,
        session: "resume",
      })
      assert(
        result.sessionId === fixture.sessionId,
        "Resumed CLI has wrong session ID",
      )
      assert(result.final.trim() === expected, "Resume lost historical content")
      assert(
        !result.events.some((event) => {
          const content = record(event.message).content
          return (
            Array.isArray(content)
            && content.some((block) => record(block).type === "tool_use")
          )
        }),
        "Resume recalled data using tools instead of history",
      )
    }
    return "Three separate real CLI processes resumed the same session and recalled tool/history tokens"
  }

  private async cache(id: string, model: string) {
    const corpus = cacheCatalogue(this.auth.fixtureSalt)
    const result = await this.call(id, model, {
      prompt: "Do not use tools. Reply exactly CACHE_A.",
      appendSystem: corpus,
    })
    assert(result.final.trim() === "CACHE_A", "Cache seed answer mismatch")
    const files = readdirSync(this.runtime.directory).filter(
      (file) => file.startsWith(`${id}-`) && file.endsWith("-ingress.json"),
    )
    assert(
      files.length === 1,
      "Cache seed must have exactly one actual CLI request",
    )
    const body = record(
      JSON.parse(
        readFileSync(path.join(this.runtime.directory, files[0]), "utf8"),
      ),
    )
    for (const suffix of [false, false, true]) {
      const replay = structuredClone(body)
      if (suffix) changeCacheQuestion(replay)
      const response = await this.runtime.post(id, replay, {
        phase: "comparison",
        route: "messages",
      })
      const raw = await response.text()
      writeFileSync(
        path.join(this.runtime.directory, `${id}-replay-${Date.now()}.sse`),
        raw,
      )
      assert(response.ok, `Cache replay HTTP ${response.status}`)
      const events = parseEvents(raw)
      validateMessagesTerminal(events)
      assert(
        events.some(
          (event) =>
            event.type === "message_delta"
            && record(event.delta).stop_reason === "end_turn",
        ),
        "Cache replay was truncated",
      )
      const text = events
        .filter((event) => record(event.delta).type === "text_delta")
        .map((event) => record(event.delta).text)
        .join("")
      assert(
        text.trim() === (suffix ? "CACHE_B" : "CACHE_A"),
        "Cache replay answer mismatch",
      )
    }
    return "Actual CLI seed with >=8192-token catalogue; two identical Messages replays and changed-suffix replay completed"
  }

  private async cancel(id: string, model: string) {
    const before = await this.runtime.management("health")
    const cancellation = { requested: false }
    let polling = false
    const timer = setInterval(() => {
      if (polling) return
      polling = true
      void this.runtime
        .management("health")
        .then((health) => {
          if (
            Number(health.active) > 0
            && Number(health.upstreamEvents) > Number(before.upstreamEvents)
          )
            cancellation.requested = true
        })
        .finally(() => {
          polling = false
        })
        .catch(() => undefined)
    }, 100)
    let stopped = false
    try {
      await this.call(id, model, {
        prompt:
          "Write a detailed 5000-word tutorial on sorting algorithms. Do not use tools.",
        guardReason: () => {
          if (cancellation.requested)
            return "Intentional cancellation after upstream SSE"
          if (this.runtime.halted) return "Acceptance stopped"
        },
      })
    } catch (error) {
      assert(
        cancellation.requested
          && String(error).includes("Intentional cancellation"),
        `Unexpected cancellation failure: ${String(error)}`,
      )
      stopped = true
    } finally {
      clearInterval(timer)
    }
    assert(stopped, "Client finished before cancellation could be exercised")
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const health = await this.runtime.management("health")
      const grants = this.runtime.ledger.grants.filter(
        (grant) => grant.caseId === id,
      )
      const aborted = grants.some((grant) => {
        const observation = this.runtime.ledger.observations.get(grant.id)
        return (
          observation?.upstreamSignalAborted
          && observation.protocolOutcome !== "completed"
          && ["cancelled", "transport_error"].includes(
            String(observation.transportOutcome),
          )
        )
      })
      if (health.active === 0 && aborted)
        return "Real CLI cancelled after upstream SSE; upstream abort and zero active requests observed"
      await Bun.sleep(100)
    }
    throw new Error(
      "Cancelled client did not release upstream within 10 seconds",
    )
  }
}

export function changeCacheQuestion(body: Json) {
  assert(Array.isArray(body.messages), "Cache request lacks messages")
  const last = record(
    body.messages.findLast((item) => record(item).role === "user"),
  )
  assert(last.role === "user", "Cache request has no user question")
  const before = JSON.stringify(last)
  if (typeof last.content === "string")
    last.content = last.content.replaceAll("CACHE_A", "CACHE_B")
  else if (Array.isArray(last.content)) {
    for (const item of last.content) {
      const part = record(item)
      if (part.type === "text" && typeof part.text === "string")
        part.text = part.text.replaceAll("CACHE_A", "CACHE_B")
    }
  }
  assert(JSON.stringify(last) !== before, "Cache suffix was not changed")
}

/** Numeric rows keep >8K tokens below Windows' argv character limit. */
export function cacheCatalogue(salt: string) {
  let corpus = `Synthetic numeric catalogue ${salt}\n`
  let row = 0
  while (encode(corpus).length < 8192)
    corpus += Array.from(
      { length: 128 },
      () => `${String(row++).padStart(6, "0")}\n`,
    ).join("")
  assert(
    corpus.length < 24500,
    "Cache catalogue exceeds Windows argument allowance",
  )
  return corpus
}
