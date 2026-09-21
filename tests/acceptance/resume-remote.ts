/** Real Codex fork/resume acceptance against an HTTPS or loopback provider. */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_URL = "https://g5x5mg68-8314.usw3.devtunnels.ms/v1"
const DEFAULT_SESSION = "01a0c20f-c841-7871-a351-3b3fce86bcc5"

interface TurnResult {
  label: string
  exitCode: number | null
  threadId?: string
  completed: boolean
  toolsUsed: boolean
  timedOut: boolean
  answer: string
  errors: Array<string>
}

interface TurnInput {
  baseUrl: string
  mode: "fork" | "resume"
  id: string
  prompt: string
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function cliArgs({ baseUrl, mode, id, prompt }: TurnInput): Array<string> {
  return [
    "-a",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--disable",
    "hooks",
    "-m",
    "gpt-6-astra",
    "-c",
    'model_provider="copilotproxyry"',
    "-c",
    `model_providers.copilotproxyry.base_url="${baseUrl}"`,
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'model_reasoning_summary="concise"',
    "-c",
    "model_providers.copilotproxyry.stream_max_retries=0",
    "-c",
    "model_providers.copilotproxyry.request_max_retries=0",
    mode,
    id,
    prompt,
  ]
}

function runTurn(label: string, input: TurnInput): Promise<TurnResult> {
  return new Promise((resolve) => {
    const result: TurnResult = {
      label,
      exitCode: null,
      completed: false,
      toolsUsed: false,
      timedOut: false,
      answer: "",
      errors: [],
    }
    const child = spawn(Bun.which("codex") ?? "codex", cliArgs(input), {
      cwd: String.raw`C:\Users\v-wangjunf`,
      windowsHide: true,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "dummy",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let pending = ""
    let stderr = ""
    const timer = setTimeout(() => {
      result.timedOut = true
      child.kill()
    }, 180_000)
    child.stdout.on("data", (buffer: Buffer) => {
      pending += buffer.toString()
      const lines = pending.split(/\r?\n/u)
      pending = lines.pop() ?? ""
      for (const line of lines) consumeEvent(line, result, () => child.kill())
    })
    child.stderr.on("data", (buffer: Buffer) => {
      stderr = (stderr + buffer.toString()).slice(-8000)
    })
    child.on("error", (error) => result.errors.push(error.message))
    child.on("close", (code) => {
      clearTimeout(timer)
      if (pending) consumeEvent(pending, result, () => undefined)
      result.exitCode = code
      // Do not save raw transcript, tool output, credentials, or request bodies.
      if (code !== 0 && result.errors.length === 0)
        result.errors.push(stderr.slice(-600))
      console.log(JSON.stringify(result))
      resolve(result)
    })
  })
}

function consumeEvent(
  line: string,
  result: TurnResult,
  stop: () => void,
): void {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (event.type === "thread.started" && typeof event.thread_id === "string")
    result.threadId = event.thread_id
  if (event.type === "turn.completed") result.completed = true
  if (event.type === "error" && typeof event.message === "string")
    result.errors.push(event.message)
  const item = event.item as { type?: string; text?: string } | undefined
  if (event.type === "item.completed" && item?.type === "agent_message")
    result.answer = (item.text ?? "").trim()
  if (item?.type && !["agent_message", "reasoning"].includes(item.type)) {
    result.toolsUsed = true
    result.errors.push("Diagnostic turn attempted a tool; stopped.")
    stop()
  }
}

async function main(): Promise<void> {
  const baseUrl = arg("--base-url", DEFAULT_URL).replace(/\/$/u, "")
  const url = new URL(baseUrl)
  const localHttp =
    url.protocol === "http:"
    && ["127.0.0.1", "localhost"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      "Acceptance requires HTTPS, or HTTP on loopback, without embedded credentials or query parameters.",
    )
  }
  const sourceSession = arg("--source-session", DEFAULT_SESSION)
  const runDirectory = path.resolve(
    arg(
      "--output-dir",
      path.join("tests", "_runlog", `resume-remote-${randomUUID()}`),
    ),
  )
  await mkdir(runDirectory, { recursive: true })
  const nonce = `RESUME-${randomUUID()}`
  const guard =
    "This is a diagnostic connectivity test only. Do not use any tools, inspect or change files, or continue previous tasks. "
  const turns: Array<TurnResult> = []
  turns.push(
    await runTurn("fork-seed", {
      baseUrl,
      mode: "fork",
      id: sourceSession,
      prompt: `${guard}Remember this diagnostic token: ${nonce}. Reply with exactly READY.`,
    }),
  )
  let passed = valid(turns[0], "READY")
  const testSession = turns[0].threadId
  if (passed && testSession) {
    for (let index = 1; index <= 3; index++) {
      const turn = await runTurn(`resume-${index}`, {
        baseUrl,
        mode: "resume",
        id: testSession,
        prompt: `${guard}What diagnostic token did I ask you to remember? Reply only with that token.`,
      })
      turns.push(turn)
      if (!valid(turn, nonce)) {
        passed = false
        break
      }
    }
  } else passed = false
  const report = {
    timestamp: new Date().toISOString(),
    baseUrl,
    sourceSession,
    testSession,
    model: "gpt-6-astra",
    effort: "high",
    summary: "concise",
    passed,
    turns,
    boundary:
      "Direct remote-service evidence only; does not prove the local source patch is deployed.",
  }
  const reportPath = path.join(runDirectory, "result.json")
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed, testSession, reportPath }))
  process.exitCode = passed ? 0 : 1
}

function valid(turn: TurnResult, answer: string): boolean {
  return (
    turn.exitCode === 0
    && turn.completed
    && !turn.toolsUsed
    && !turn.timedOut
    && turn.answer === answer
  )
}

await main()
