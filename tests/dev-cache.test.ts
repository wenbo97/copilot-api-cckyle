import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const projectRoot = join(import.meta.dir, "..")
const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function createWorkspace() {
  const scratch = join(projectRoot, "tmps")
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "dev-cache-test-"))
  directories.push(directory)
  return directory
}

async function runFixture(directory: string, exitCode = 0) {
  const loggingModule = pathToFileURL(
    join(projectRoot, "scripts/dev-logging.ts"),
  ).href
  const serverModule = pathToFileURL(join(projectRoot, "src/server.ts")).href
  const fixture = join(directory, "fixture.ts")
  writeFileSync(
    fixture,
    `import consola from "consola"
import { configureDevLogging } from ${JSON.stringify(loggingModule)}
configureDevLogging("tmps/cache-session.log")
consola.info("info 中文")
consola.debug("debug 中文")
consola.warn("warning marker")
consola.error(new Error("error marker"))
console.log("http access marker")
console.debug("console debug marker")
consola.info("\\u001b[31mcolor marker\\u001b[0m")
consola.info('[cache-diagnostics] {"cached_input_tokens":42}')
const { server } = await import(${JSON.stringify(serverModule)})
await server.request("http://localhost/")
process.exit(${exitCode})
`,
  )
  const child = Bun.spawn([process.execPath, fixture], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { output: stdout + stderr, code }
}

test("keeps normal logs on console and appends debug only to the file", async () => {
  const directory = createWorkspace()
  for (let run = 0; run < 2; run++) {
    const result = await runFixture(directory)
    expect(result.code).toBe(0)
    for (const marker of [
      "info 中文",
      "warning marker",
      "error marker",
      "http access marker",
      "[cache-diagnostics]",
      "<-- GET /",
    ])
      expect(result.output).toContain(marker)
    expect(result.output).not.toContain("debug 中文")
    expect(result.output).not.toContain("console debug marker")
  }
  const log = readFileSync(join(directory, "tmps/cache-session.log"), "utf8")
  expect(log.match(/info 中文/g)).toHaveLength(2)
  expect(log.match(/debug 中文/g)).toHaveLength(2)
  expect(log).toContain("console debug marker")
  expect(log).toContain("http access marker")
  expect(log).toContain("error marker")
  expect(log).toContain("color marker")
  expect(log).not.toContain("\u001b")
  expect(log).toContain("<-- GET /")
  expect(log).toContain("--> GET / 200")
  expect(log).toContain('[cache-diagnostics] {"cached_input_tokens":42}')
})

test("preserves old UTF-16LE logs and flushes a nonzero exit", async () => {
  const directory = createWorkspace()
  mkdirSync(join(directory, "tmps"))
  const logPath = join(directory, "tmps/cache-session.log")
  writeFileSync(logPath, "\uFEFF已有日志\n", "utf16le")
  const result = await runFixture(directory, 7)
  expect(result.code).toBe(7)
  const log = readFileSync(logPath, "utf16le")
  expect(log).toStartWith("\uFEFF已有日志\n")
  expect(log).toContain("info 中文")
  expect(log).toContain("debug 中文")
  expect(log).toContain('[cache-diagnostics] {"cached_input_tokens":42}')
})

test("forwards help arguments to the existing start command", async () => {
  const child = Bun.spawn(
    [process.execPath, join(projectRoot, "scripts/dev-cache.ts"), "--help"],
    { cwd: createWorkspace(), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(0)
  expect(stdout + stderr).toContain("--port")
  expect(stdout + stderr).toContain("--account-type")
})
