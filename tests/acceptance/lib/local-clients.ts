import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import type { Scenario } from "./local-scenarios"

import { stringValue } from "./local-budget"
import { record, type Json, type Phase } from "./local-budget"
import {
  claudeIsolationArgs,
  codexSandboxArgs,
  createClientDirectory,
} from "./local-client-config"
import { clientVerdict, projectClientEvents } from "./local-client-evidence"
import { startFixtureMcp } from "./local-mcp"
import {
  AcceptanceRuntime,
  AcceptanceTimeoutError,
  AcceptanceBlockedError,
  assert,
  BASE_URL,
  childEnvironment,
  MODEL,
} from "./local-runtime"

export interface Session {
  directory: string
  codexHome: string
  claudeHome: string
  thread?: string
  marker?: string
}
const sessions = new WeakMap<AcceptanceRuntime, Map<string, Session>>()

function session(runtime: AcceptanceRuntime, model = MODEL): Session {
  const models = sessions.get(runtime) ?? new Map<string, Session>()
  const existing = models.get(model)
  if (existing) return existing
  const created = prepareClientFixtures(model)
  if (runtime.e2e?.stage === "latest" && runtime.e2e.codexFixtureDirectory) {
    created.directory = runtime.e2e.codexFixtureDirectory
    created.codexHome = path.join(created.directory, "codex")
  }
  models.set(model, created)
  sessions.set(runtime, models)
  return created
}

export function prepareClientFixtures(model = MODEL): Session {
  const directory = createClientDirectory("copilot-local-client-")
  const codexHome = path.join(directory, "codex")
  const claudeHome = path.join(directory, "claude")
  mkdirSync(codexHome)
  mkdirSync(claudeHome)
  writeFileSync(path.join(directory, "marker.txt"), "LOCAL_TOOL_42\n", "utf8")
  const created = { directory, codexHome, claudeHome }
  writeFileSync(
    path.join(claudeHome, "acceptance-settings.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "acceptance-dummy",
          ANTHROPIC_MODEL: model,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
          MAX_THINKING_TOKENS: "1024",
          DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
      null,
      2,
    ),
    "utf8",
  )
  return created
}

export async function capture(
  bin: string,
  args: Array<string>,
  options: {
    cwd: string
    env: Record<string, string | undefined>
    guardReason?: () => string | undefined
    evidence?: (events: Array<Json>, exitCode: number | null) => void
    timeoutMs?: number
    rawFile?: string
  },
) {
  const { cwd, env } = options
  const child = Bun.spawn([bin, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let guardFailure: string | undefined
  let stopping = false
  const stop = () => {
    if (stopping || child.exitCode !== null) return
    stopping = true
    if (process.platform === "win32") {
      const killer = Bun.spawn(
        ["taskkill", "/PID", String(child.pid), "/T", "/F"],
        { stdout: "ignore", stderr: "ignore" },
      )
      void killer.exited
    } else child.kill()
  }
  const timeout = setTimeout(() => {
    timedOut = true
    stop()
  }, options.timeoutMs ?? 125000)
  const guardPoll = setInterval(() => {
    guardFailure = options.guardReason?.()
    if (guardFailure) stop()
  }, 250)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (options.rawFile) {
      writeFileSync(`${options.rawFile}.stdout.jsonl`, stdout, "utf8")
      writeFileSync(`${options.rawFile}.stderr.log`, stderr, "utf8")
    }
    const events: Array<Json> = []
    for (const line of stdout.split(/\r?\n/u)) {
      try {
        events.push(record(JSON.parse(line)))
      } catch {
        /* Non-JSON startup output. */
      }
    }
    options.evidence?.(events, exitCode)
    assert(!guardFailure, `Budget guard: ${guardFailure ?? "unknown"}`)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the deadline callback mutates this while child output is awaited
    if (timedOut)
      throw new AcceptanceTimeoutError(
        `Client exceeded ${(options.timeoutMs ?? 125000) / 1000} seconds`,
      )
    const error = events.find((event) => event.type === "error")
    assert(
      exitCode === 0,
      `Client exit ${exitCode}: ${(stringValue(error?.message) || stderr.slice(-500)).slice(0, 500)}`,
    )
    return events
  } finally {
    clearTimeout(timeout)
    clearInterval(guardPoll)
    if (child.exitCode === null) child.kill()
  }
}

export async function codex(
  runtime: AcceptanceRuntime,
  id: string,
  options: {
    prompt: string
    mode?: "fork" | "resume"
    thread?: string
    mcpUrl?: string
    model?: string
    fixture?: Session
    phase?: Phase
    timeoutMs?: number
    noTools?: boolean
  },
) {
  const { prompt, mode, thread } = options
  const startedAt = Date.now()
  const model = options.model ?? MODEL
  const data = options.fixture ?? session(runtime, model)
  const evidenceId =
    runtime.e2e?.stage === "latest" ? `${id}-${randomUUID()}` : id
  await runtime.management("configure", {
    caseId: id,
    phase: options.phase ?? "clients",
  })
  const args = [
    "-a",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    ...codexSandboxArgs,
    "--disable",
    "hooks",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'model_provider="acceptance"',
    "-c",
    'model_providers.acceptance.name="Local acceptance"',
    "-c",
    `model_providers.acceptance.base_url="${BASE_URL}/v1"`,
    "-c",
    'model_providers.acceptance.wire_api="responses"',
    "-c",
    'model_providers.acceptance.env_key="OPENAI_API_KEY"',
    "-c",
    "model_providers.acceptance.request_max_retries=0",
    "-c",
    "model_providers.acceptance.stream_max_retries=0",
  ]
  if (options.noTools)
    args.push("--disable", "shell_tool", "--disable", "unified_exec")
  if (options.mcpUrl)
    args.push(
      "-c",
      `mcp_servers.fixture.url="${options.mcpUrl}"`,
      "-c",
      'mcp_servers.fixture.enabled_tools=["read_marker"]',
      "-c",
      'mcp_servers.fixture.tools.read_marker.approval_mode="approve"',
    )
  if (mode) {
    assert(thread, "No isolated source thread")
    args.push(mode, thread)
  }
  args.push(prompt)
  const events = await capture(Bun.which("codex") ?? "codex", args, {
    cwd: data.directory,
    rawFile:
      runtime.e2e?.stage === "latest" ?
        path.join(runtime.directory, evidenceId)
      : undefined,
    timeoutMs: options.timeoutMs,
    guardReason: () => {
      if (runtime.halted) return "Acceptance halted"
      const blocked = runtime.blocked.findLast((row) => row.caseId === id)
      return blocked ? stringValue(blocked.reason) : undefined
    },
    evidence: (events, exitCode) =>
      saveClientEvidence(runtime, evidenceId, {
        client: "codex",
        marker: data.marker,
        events: [...events, ...rolloutToolEvents(data.codexHome, startedAt)],
        exitCode,
      }),
    env: childEnvironment({
      CODEX_HOME: data.codexHome,
      OPENAI_API_KEY: "acceptance-dummy",
    }),
  })
  events.push(...rolloutToolEvents(data.codexHome, startedAt))
  return parseCodexTurn(events)
}

export function parseCodexTurn(events: Array<Json>) {
  assert(
    events.some((event) => event.type === "turn.completed"),
    "Codex did not complete the turn",
  )
  const items = events
    .filter((event) => event.type === "item.completed")
    .map((event) => record(event.item))
  const text = stringValue(
    items.findLast((item) => item.type === "agent_message")?.text,
  ).trim()
  return {
    text,
    thread: events.find((event) => event.type === "thread.started")?.thread_id,
    items,
    events,
  }
}

export async function runClaudeCase(
  runtime: AcceptanceRuntime,
  id: string,
  options: { model: string; withTool: boolean },
) {
  const { model, withTool } = options
  const data = session(runtime, model)
  if (withTool && runtime.e2e?.stage === "latest") randomizeMarker(data)
  await runtime.management("configure", { caseId: id, phase: "clients" })
  const settings = path.join(data.claudeHome, "acceptance-settings.json")
  const prompt =
    withTool ?
      "Read marker.txt using the Read tool. Reply only with its exact content."
    : "Do not use tools. Reply with exactly READY."
  const events = await capture(
    Bun.which("claude") ?? "claude",
    [
      ...claudeIsolationArgs,
      "-p",
      prompt,
      "--model",
      model,
      "--effort",
      "low",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      settings,
      "--tools",
      withTool ? "Read" : "",
      "--permission-mode",
      "dontAsk",
      ...(withTool ? ["--allowedTools", "Read"] : []),
    ],
    {
      cwd: data.directory,
      rawFile:
        runtime.e2e?.stage === "latest" ?
          path.join(runtime.directory, id)
        : undefined,
      evidence: (events, exitCode) =>
        saveClientEvidence(runtime, id, {
          client: "claude",
          events,
          exitCode,
          marker: data.marker,
        }),
      guardReason: () => {
        if (runtime.halted) return "Acceptance halted"
        const blocked = runtime.blocked.findLast((row) => row.caseId === id)
        return blocked ? stringValue(blocked.reason) : undefined
      },
      env: childEnvironment({
        CLAUDE_CONFIG_DIR: data.claudeHome,
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_AUTH_TOKEN: "acceptance-dummy",
        ANTHROPIC_API_KEY: "acceptance-dummy",
        ANTHROPIC_MODEL: model,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
        MAX_THINKING_TOKENS: "1024",
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_SIMPLE: "0",
      }),
    },
  )
  const result = events.find((event) => event.type === "result")
  assert(result && !result.is_error, "Claude Code returned an error")
  if (withTool) assertToolEvidence("claude", events, data.marker)
  assert(
    String(result.result).trim()
      === (withTool ? (data.marker ?? "LOCAL_TOOL_42") : "READY"),
    "Claude Code final text mismatch",
  )
  return withTool ?
      "Real Claude Code read a synthetic file through the OpenAI Messages bridge"
    : "Real Claude Code completed a tool-free OpenAI request"
}

function saveClientEvidence(
  runtime: AcceptanceRuntime,
  id: string,
  result: {
    client: "claude" | "codex"
    events: Array<Json>
    exitCode: number | null
    marker?: string
  },
) {
  const { client, events, exitCode } = result
  const evidence = projectClientEvents(events, result.marker)
  const verdict = clientVerdict(client, evidence)
  writeFileSync(
    path.join(runtime.directory, `${id}-client-evidence.json`),
    JSON.stringify({ client, exitCode, evidence, verdict }, null, 2),
    "utf8",
  )
  if (verdict.blocked)
    throw new AcceptanceBlockedError(`${client} shell/tool admission blocked`)
}

function rolloutToolEvents(home: string, startedAt: number): Array<Json> {
  const root = path.join(home, "sessions")
  if (!existsSync(root)) return []
  const events: Array<Json> = []
  for (const relative of readdirSync(root, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!relative.endsWith(".jsonl")) continue
    const filename = path.join(root, relative)
    if (statSync(filename).size > 2_000_000) continue
    for (const line of readFileSync(filename, "utf8").split(/\r?\n/u)) {
      try {
        const event = record(JSON.parse(line))
        if (
          Date.parse(stringValue(event.timestamp)) >= startedAt
          && event.type === "response_item"
          && ["custom_tool_call", "custom_tool_call_output"].includes(
            stringValue(record(event.payload).type),
          )
        )
          events.push(event)
      } catch {
        /* Incomplete final line is not acceptance evidence. */
      }
    }
  }
  return events.slice(-100)
}

function assertToolEvidence(
  client: "claude" | "codex",
  events: Array<Json>,
  marker?: string,
) {
  const verdict = clientVerdict(client, projectClientEvents(events, marker))
  if (verdict.blocked)
    throw new AcceptanceBlockedError(`${client} shell/tool admission blocked`)
  assert(
    verdict.validArguments,
    `${client} tool arguments invalid or unverified`,
  )
  assert(verdict.toolExecution, `${client} tool execution failed or unverified`)
  assert(verdict.exactFinal, `${client} final text mismatch`)
}

export async function runCodexToolCase(
  runtime: AcceptanceRuntime,
  id: string,
  model: string,
) {
  const data = session(runtime, model)
  if (runtime.e2e?.stage === "latest") randomizeMarker(data)
  const result = await codex(runtime, id, {
    model,
    prompt: String.raw`Read marker.txt in the current directory using exactly one exec_command with cmd Get-Content -Raw .\marker.txt and login false. If using the exec JavaScript tool, start the cell with // @exec: {"yield_time_ms": 60000} and print the complete exec_command result object including exit_code. Wait for any running tool to finish before answering. Reply only with the file content. Do not inspect other files or retry a denied command.`,
  })
  const verdict = clientVerdict(
    "codex",
    projectClientEvents(result.events, data.marker),
  )
  if (verdict.blocked)
    throw new AcceptanceBlockedError("Codex shell admission blocked")
  assert(verdict.toolExecution, "Codex shell execution failed or unverified")
  assert(
    result.text === (data.marker ?? "LOCAL_TOOL_42"),
    "Codex tool round-trip lost marker",
  )
  return "Read-only synthetic file tool step and exact result"
}

function randomizeMarker(data: Session) {
  data.marker = `LATEST_TOOL_${randomUUID().replaceAll("-", "").toUpperCase()}`
  writeFileSync(
    path.join(data.directory, "marker.txt"),
    `${data.marker}\n`,
    "utf8",
  )
}

export const CLIENTS: Array<Scenario> = [
  {
    id: "codex-mcp-tool",
    phase: "clients",
    run: async (runtime) => {
      const fixture = startFixtureMcp()
      try {
        const result = await codex(runtime, "codex-mcp-tool", {
          prompt:
            "Call the fixture MCP read_marker tool exactly once. Do not use shell, file, or other tools. Reply only with the returned marker.",
          mcpUrl: fixture.url,
        })
        assert(
          fixture.calls() === 1,
          "Expected exactly one actual fixture MCP tool call",
        )
        assert(
          result.text === fixture.marker,
          "MCP result was not preserved in the final answer",
        )
        return "Actual read-only MCP call and exact synthetic result; shell policy remains unchanged"
      } finally {
        await fixture.stop()
      }
    },
  },

  {
    id: "codex-seed",
    phase: "clients",
    run: async (runtime) => {
      const result = await codex(runtime, "codex-seed", {
        prompt:
          "Do not use tools. Remember this marker: ACCEPTANCE_42. Reply with exactly READY.",
      })
      assert(
        result.text === "READY" && typeof result.thread === "string",
        "Codex seed failed",
      )
      session(runtime).thread = result.thread
      return "New isolated Codex session retained the diagnostic marker"
    },
  },
  {
    id: "codex-tool",
    phase: "clients",
    run: (runtime) => runCodexToolCase(runtime, "codex-tool", MODEL),
  },
  {
    id: "codex-fork-resume",
    phase: "clients",
    run: async (runtime) => {
      const data = session(runtime)
      const prompt =
        "Do not use tools. What marker did I ask you to remember? Reply only with the marker."
      const fork = await codex(runtime, "codex-fork-resume", {
        prompt: prompt,
        mode: "fork",
        thread: data.thread,
      })
      assert(
        fork.text === "ACCEPTANCE_42" && typeof fork.thread === "string",
        "Fork lost the marker",
      )
      for (let index = 0; index < 2; index++) {
        const resumed = await codex(runtime, "codex-fork-resume", {
          prompt: prompt,
          mode: "resume",
          thread: fork.thread,
        })
        assert(
          resumed.text === "ACCEPTANCE_42",
          "Independent resume lost the marker",
        )
      }
      await runtime.stopProxy()
      await runtime.startProxy()
      const restarted = await codex(runtime, "codex-fork-resume", {
        prompt: prompt,
        mode: "resume",
        thread: fork.thread,
      })
      assert(
        restarted.text === "ACCEPTANCE_42",
        "Resume after proxy restart lost the marker",
      )
      return "Fork, two independent resumes, and post-restart resume passed with isolated receipts"
    },
  },
  {
    id: "claude-smoke",
    phase: "clients",
    run: (runtime) =>
      runClaudeCase(runtime, "claude-smoke", { model: MODEL, withTool: false }),
  },
  {
    id: "claude-tool",
    phase: "clients",
    run: (runtime) =>
      runClaudeCase(runtime, "claude-tool", { model: MODEL, withTool: true }),
  },
]
