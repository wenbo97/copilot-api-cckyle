import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { stringValue } from "./local-budget"
import {
  BudgetLedger,
  record,
  type Json,
  type Observation,
  type Phase,
  type Reservation,
} from "./local-budget"
import { openBudget, type ContinuationOptions } from "./local-continuation"
import { executionManifest, identitySha256 } from "./local-identity"
import { LiveTime } from "./local-live-time"
import { parseEvents, validateResponseEvents } from "./local-wire"

export const ROOT = path.resolve(import.meta.dir, "../../..")
export const BASE_URL = "http://127.0.0.1:4143"
export const MODEL = "gpt-5.6-luna"
export interface CaseResult {
  id: string
  phase: string
  status: "pass" | "fail" | "blocked" | "skipped"
  detail: string
  durationMs: number
  attempts: number
}

export class AcceptanceBlockedError extends Error {
  override name = "AcceptanceBlockedError"
}

export class AcceptanceTimeoutError extends Error {
  override name = "AcceptanceTimeoutError"
}

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function sourceManifest() {
  const files: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(filename)
      else
        files[path.relative(ROOT, filename)] = createHash("sha256")
          .update(readFileSync(filename))
          .digest("hex")
    }
  }
  visit(path.join(ROOT, "src"))
  return files
}

export function childEnvironment(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:COPILOT_|GH_TOKEN$|GITHUB_TOKEN$|MODEL_MAPPINGS$|ANTHROPIC_|OPENAI_|CODEX_|TRACE_)/u.test(
          key,
        ),
    ),
  )
  return { ...env, ...extra }
}

export class AcceptanceRuntime {
  readonly budgetSession: ReturnType<typeof openBudget>
  readonly directory: string
  readonly ledger: BudgetLedger
  readonly secret = randomUUID()
  readonly results: Array<CaseResult> = []
  readonly blocked: Array<Json> = []
  readonly clock: LiveTime
  readonly manifest = sourceManifest()
  readonly execution = executionManifest()
  readonly activeCases = new Set<string>()
  readonly resources: Array<Json> = []
  readonly startupDiagnostics: Array<string> = []
  readonly controller: ReturnType<typeof Bun.serve>
  catalog: Array<Json> = []
  auth: Json = {}
  halted = false
  child?: Bun.Subprocess<"ignore", "pipe", "pipe">
  private drains: Array<Promise<void>> = []
  private bridgeConfirmed = false
  private deadlineShutdown?: Promise<void>
  private deadlineFailure?: unknown
  private readonly timeCheckpoint: ReturnType<typeof setInterval>

  constructor(
    directory: string,
    maxCredits: number,
    options: ContinuationOptions = {},
  ) {
    this.directory = directory
    mkdirSync(directory, { recursive: true })
    const previousManifest = path.join(directory, "source-manifest.json")
    const previousExecution = path.join(directory, "execution-manifest.json")
    if (
      existsSync(previousExecution)
      && identitySha256(
        JSON.parse(readFileSync(previousExecution, "utf8")) as Record<
          string,
          string
        >,
      ) !== identitySha256(this.execution)
    )
      throw new Error("Cannot continue against changed acceptance source")
    if (
      existsSync(previousManifest)
      && JSON.stringify(JSON.parse(readFileSync(previousManifest, "utf8")))
        !== JSON.stringify(this.manifest)
    )
      throw new Error(
        "Cannot continue a ledger against changed production source",
      )
    const priorResults = path.join(directory, "result.json")
    if (existsSync(priorResults)) {
      const previous = record(JSON.parse(readFileSync(priorResults, "utf8")))
      this.auth = record(previous.auth)
      if (Array.isArray(previous.results))
        this.results.push(...(previous.results as Array<CaseResult>))
      if (Array.isArray(previous.resources))
        this.resources.push(...(previous.resources as Array<Json>))
    }
    this.budgetSession = openBudget({
      directory,
      maxCredits,
      previous: this.results,
      options,
    })
    this.ledger = this.budgetSession.ledger
    this.clock = this.budgetSession.clock
    if (this.budgetSession.expired() || this.ledger.stopReason)
      this.halted = true
    for (const [id, observation] of this.ledger.observations)
      this.applyStopCondition(id, observation)
    let controller: ReturnType<typeof Bun.serve> | undefined
    try {
      writeFileSync(
        path.join(directory, "source-manifest.json"),
        JSON.stringify(this.manifest, null, 2),
        "utf8",
      )
      writeFileSync(
        path.join(directory, "execution-manifest.json"),
        JSON.stringify(this.execution, null, 2),
        "utf8",
      )
      this.controller = controller = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => this.handleControl(request),
      })
      this.timeCheckpoint = setInterval(() => {
        try {
          this.clock.checkpoint()
          if (this.budgetSession.expired()) this.stopAtDeadline()
        } catch {
          this.stopAtDeadline()
          console.error(
            "Live-time checkpoint failed; further generation blocked",
          )
        }
      }, 1000)
      this.timeCheckpoint.unref()
    } catch (error) {
      this.halted = true
      if (controller) {
        void Promise.resolve(controller.stop(true))
          .then(this.budgetSession.release)
          .catch(() =>
            console.error("Controller cleanup failed; budget lock retained"),
          )
      } else this.budgetSession.release()
      throw error
    }
  }

  private stopAtDeadline() {
    this.halted = true
    this.deadlineShutdown ??= this.stopProxy().catch((error: unknown) => {
      this.deadlineFailure = error
    })
  }

  private async handleControl(request: Request) {
    if (request.headers.get("x-acceptance-secret") !== this.secret)
      return new Response("Forbidden", { status: 403 })
    try {
      const body = record(await request.json())
      const pathname = new URL(request.url).pathname
      if (pathname === "/heartbeat") return Response.json({ ok: true })
      if (pathname === "/blocked") {
        this.blocked.push(body)
        appendFileSync(
          path.join(this.directory, "blocked.jsonl"),
          `${JSON.stringify(body)}\n`,
          "utf8",
        )
        return Response.json({ ok: true })
      }
      if (pathname === "/observe") {
        this.recordObservation(String(body.id), body.observation as Observation)
        return Response.json({ ok: true })
      }
      if (pathname !== "/reserve")
        return new Response("Not found", { status: 404 })
      if (this.halted || this.budgetSession.expired())
        throw new Error("Acceptance live deadline reached")
      assert(
        this.activeCases.has(String(body.caseId)),
        "Request has no active acceptance case",
      )
      assert(
        JSON.stringify(sourceManifest()) === JSON.stringify(this.manifest),
        "Production source changed during acceptance",
      )
      assert(
        identitySha256(executionManifest()) === identitySha256(this.execution),
        "Acceptance source changed during acceptance",
      )
      return Response.json(this.ledger.reserve(body as unknown as Reservation))
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Controller failure"
      if (
        /limit (?:exceeded|reached)|deadline|source changed|checkpoint/iu.test(
          message,
        )
      ) {
        this.halted = true
        this.ledger.halt(message)
      }
      return Response.json({ error: message }, { status: 429 })
    }
  }

  recordObservation(id: string, observation: Observation) {
    this.ledger.observe(id, observation)
    this.applyStopCondition(id, observation)
  }

  private applyStopCondition(id: string, observation: Observation) {
    if ([402, 403, 429].includes(observation.status ?? 0)) this.halted = true
    const grant = this.ledger.grants.find((entry) => entry.id === id)
    const usage = record(observation.usage)
    if (
      grant
      && (Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
        > grant.inputTokens
        || Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
          > grant.outputTokens)
    )
      this.halted = true
  }

  async authenticate() {
    const ping = await fetch("http://127.0.0.1:18774/ping", {
      signal: AbortSignal.timeout(5000),
    })
    assert(
      ping.ok && record(await ping.json()).service === "copilot-token-bridge",
      "Bridge is not ready",
    )
    const response = await fetch("http://127.0.0.1:18774/token?force=true", {
      signal: AbortSignal.timeout(25_000),
    })
    assert(
      response.ok,
      `Bridge exchange failed: HTTP ${response.status}; response omitted`,
    )
    const token = record(await response.json())
    assert(
      typeof token.token === "string" && token.token.length > 0,
      "Bridge returned no credential",
    )
    assert(
      Number(token.expires_at) > Date.now() / 1000 + 60,
      "Bridge credential is expiring",
    )
    const endpoint = stringValue(record(token.endpoints).api)
    let accountType = "individual"
    if (endpoint.includes("enterprise")) accountType = "enterprise"
    else if (endpoint.includes("business")) accountType = "business"
    this.auth = {
      account: "wenbo97",
      identityEvidence:
        "user-confirmed VS Code login; bridge does not expose username",
      sku: token.sku,
      endpoint,
      accountType,
      expiresAt: token.expires_at,
    }
  }

  async startProxy() {
    // Bind first: never mistake an existing service for the new child.
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 4143,
      fetch: () => new Response("reserved"),
    })
    await probe.stop(true)
    this.bridgeConfirmed = false
    this.child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "local-proxy.ts"),
      ],
      {
        cwd: ROOT,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnvironment({
          ACCEPTANCE_CONTROL_URL: `http://127.0.0.1:${this.controller.port}`,
          ACCEPTANCE_SECRET: this.secret,
          ACCEPTANCE_DIRECTORY: this.directory,
          ACCEPTANCE_ACCOUNT_TYPE: String(this.auth.accountType),
          VSCODE_PROXY_PORT: "18774",
          COPILOT_CACHE_POLICY: "off",
          COPILOT_CACHE_DIAGNOSTICS: "1",
          COPILOT_CACHE_NAMESPACE: "local-acceptance",
          COPILOT_HEADER_TIMEOUT_MS:
            this.budgetSession.shared ? "60000" : "30000",
          COPILOT_FIRST_EVENT_TIMEOUT_MS: "30000",
          COPILOT_STREAM_IDLE_TIMEOUT_MS: "20000",
          COPILOT_TOTAL_TIMEOUT_MS: "120000",
        }),
      },
    )
    this.drains = [this.drain(this.child.stdout), this.drain(this.child.stderr)]
    const deadline = Date.now() + 60_000
    let lastStartupError = "No response from child"
    let ownedServerReady = false
    while (Date.now() < deadline && this.child.exitCode === null) {
      try {
        const health = await this.management("health")
        if (
          health.pid === this.child.pid
          && health.bridgeOnly === true
          && this.isBridgeConfirmed()
        ) {
          ownedServerReady = true
          this.recordLoadedIdentity(health)
          const response = await fetch(`${BASE_URL}/v1/models`, {
            signal: AbortSignal.timeout(3000),
          })
          const data = record(await response.json()).data
          assert(Array.isArray(data), "Missing model catalog")
          this.catalog = data.map((value) => record(value))
          const primary = this.catalog.find((model) => model.id === MODEL)
          assert(
            primary
              && Array.isArray(primary.supported_endpoints)
              && primary.supported_endpoints.includes("/responses"),
            "Luna native Responses unavailable",
          )
          const efforts = record(
            record(primary.capabilities).supports,
          ).reasoning_effort
          assert(
            Array.isArray(efforts) && efforts.includes("low"),
            "Catalog does not advertise Luna low effort",
          )
          return
        }
      } catch (error) {
        lastStartupError =
          error instanceof Error ? error.message : "Unknown startup error"
        if (ownedServerReady) {
          await this.stopProxy()
          throw new Error(lastStartupError)
        }
      }
      await Bun.sleep(250)
    }
    await this.stopProxy()
    throw new Error(
      `Isolated proxy readiness failed: ${lastStartupError}; ${this.startupDiagnostics.join("; ")}`,
    )
  }

  private isBridgeConfirmed() {
    return this.bridgeConfirmed
  }

  private recordLoadedIdentity(health: Json) {
    assert(
      health.loadedIdentitySha256 === identitySha256(this.execution),
      "Isolated child source identity mismatch",
    )
    writeFileSync(
      path.join(this.directory, "loaded-identity.json"),
      JSON.stringify(
        {
          pid: this.child?.pid,
          entrypoint: "tests/acceptance/lib/local-proxy.ts",
          runtime: process.version,
          bun: Bun.version,
          executionSha256: health.loadedIdentitySha256,
          observedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    )
  }

  private async drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      const lines = pending.split(/\r?\n/u)
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (/error:|failed|unavailable/iu.test(line)) {
          const safe = sanitizeStartupDiagnostic(line)
          this.startupDiagnostics.push(safe)
          if (this.startupDiagnostics.length > 20)
            this.startupDiagnostics.shift()
        }
        if (
          line.includes(
            "Copilot token obtained from VS Code proxy (skipping GitHub auth)",
          )
        )
          this.bridgeConfirmed = true
        const index = line.indexOf("[cache-diagnostics]")
        if (index !== -1)
          appendFileSync(
            path.join(this.directory, "diagnostics.log"),
            `${line.slice(index)}\n`,
            "utf8",
          )
        const usageIndex = line.indexOf("[messages-usage]")
        if (usageIndex !== -1)
          appendFileSync(
            path.join(this.directory, "messages-usage.log"),
            `${line.slice(usageIndex)}\n`,
            "utf8",
          )
      }
    }
  }

  async management(action: string, body?: Json): Promise<Json> {
    const response = await fetch(`${BASE_URL}/__acceptance/${action}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-acceptance-secret": this.secret,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    assert(response.ok, `Management ${action} failed: ${response.status}`)
    return record(await response.json())
  }

  async stopProxy() {
    if (this.child?.exitCode === null) this.child.kill()
    if (this.child) await this.child.exited
    await Promise.allSettled(this.drains)
    this.child = undefined
  }

  async runCase(id: string, phase: Phase, work: () => Promise<string>) {
    const started = Date.now()
    if (!this.child || this.child.exitCode !== null) this.halted = true
    if (this.halted) {
      this.results.push({
        id,
        phase,
        status: "blocked",
        detail: "Run admission limit reached",
        durationMs: 0,
        attempts: 0,
      })
      return
    }
    this.activeCases.add(id)
    const blockedBefore = this.blocked.length
    const grantsBefore = this.ledger.grants.length
    let status: CaseResult["status"] = "pass"
    let detail: string
    try {
      detail = await work()
      assert(
        !this.blocked.slice(blockedBefore).some((row) => row.caseId === id),
        "Upstream guard blocked one or more requests",
      )
    } catch (error) {
      detail = error instanceof Error ? error.message : "Unknown failure"
      if (
        error instanceof AcceptanceTimeoutError
        || (error instanceof Error && error.name === "TimeoutError")
      ) {
        this.halted = true
        this.ledger.halt("Acceptance scenario timeout")
      }
      status =
        (
          error instanceof AcceptanceBlockedError
          || this.blocked.slice(blockedBefore).some((row) => row.caseId === id)
        ) ?
          "blocked"
        : "fail"
      if (status === "blocked") {
        this.halted = true
        this.ledger.halt(
          error instanceof AcceptanceBlockedError ?
            "Local model-tool policy rejection"
          : "Upstream admission guard blocked the scenario",
        )
      }
    } finally {
      this.activeCases.delete(id)
    }
    const attempts = this.ledger.grants
      .slice(grantsBefore)
      .filter((grant) => grant.caseId === id).length
    this.results.push({
      id,
      phase,
      status,
      detail: detail.slice(0, 1000),
      durationMs: Date.now() - started,
      attempts,
    })
    console.log(
      `${status.toUpperCase()} ${id}: ${detail} (${attempts} upstream attempts; ${this.ledger.summary().reservedCredits.toFixed(3)} reserved credits)`,
    )
    this.save()
  }

  async post(
    id: string,
    body: Json,
    options: { phase: Phase; route: string; signal?: AbortSignal },
  ) {
    const { phase, route, signal } = options
    return fetch(`${BASE_URL}/v1/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acceptance-case": id,
        "x-acceptance-phase": phase,
      },
      body: JSON.stringify(body),
      signal:
        signal ?
          AbortSignal.any([signal, AbortSignal.timeout(125_000)])
        : AbortSignal.timeout(125_000),
    })
  }

  async responses(id: string, body: Json, phase: Phase = "functional") {
    const response = await this.post(
      id,
      {
        model: MODEL,
        reasoning: { effort: "low" },
        max_output_tokens: 1024,
        ...body,
      },
      { phase: phase, route: "responses" },
    )
    const raw = await response.text()
    assert(response.ok, `Responses HTTP ${response.status}: ${safeError(raw)}`)
    if (body.stream) {
      const events = parseEvents(raw)
      return validateResponseEvents(events)
    }
    const result = record(JSON.parse(raw))
    assert(
      result.status === "completed",
      `Unexpected response status: ${String(result.status)}`,
    )
    return result
  }

  save() {
    writeFileSync(
      path.join(this.directory, "result.json"),
      JSON.stringify(
        {
          auth: this.auth,
          budget: this.ledger.summary(),
          followup: this.budgetSession.summary(),
          results: this.results,
          blocked: this.blocked,
          startupDiagnostics: this.startupDiagnostics,
          resources: this.resources,
          catalog: this.catalog,
          sourceUnchanged:
            JSON.stringify(sourceManifest()) === JSON.stringify(this.manifest),
          knownDefects: [],
        },
        null,
        2,
      ),
      "utf8",
    )
  }

  async close() {
    this.halted = true
    clearInterval(this.timeCheckpoint)
    const failures: Array<unknown> = []
    await this.deadlineShutdown
    if (this.deadlineFailure) failures.push(this.deadlineFailure)
    try {
      this.clock.checkpoint()
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.stopProxy()
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.controller.stop(true)
    } catch (error) {
      failures.push(error)
    }
    try {
      this.save()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Acceptance cleanup failed; budget lock retained",
      )
    this.budgetSession.release()
  }
}

function safeError(raw: string): string {
  try {
    const error = record(record(JSON.parse(raw)).error)
    return JSON.stringify({
      type: error.type,
      code: error.code,
      message: stringValue(error.message).slice(0, 250),
    })
  } catch {
    return "Non-JSON error body omitted"
  }
}

export function sanitizeStartupDiagnostic(line: string): string {
  return line
    .replaceAll(
      /Bearer\s+\S+|gh[pousr]_\S+|token[:=]\s*\S+/giu,
      "[credential redacted]",
    )
    .slice(0, 300)
}
