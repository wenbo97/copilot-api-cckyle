import { writeFileSync } from "node:fs"
import path from "node:path"

import { ROOT } from "./local-runtime"

export async function runCommand(
  directory: string,
  name: string,
  command: Array<string>,
) {
  console.log(`OFFLINE ${name}`)
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => child.kill(), 180000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    writeFileSync(path.join(directory, `${name}.log`), stdout + stderr, "utf8")
    return { name, exitCode, pass: exitCode === 0 }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
  }
}

export async function offline(directory: string) {
  const guard = path.join(import.meta.dir, "local-network-deny.ts")
  const commands: Array<[string, Array<string>]> = [
    [
      "tests",
      [process.execPath, "test", "--timeout", "30000", "--preload", guard],
    ],
    ["typecheck", [process.execPath, "run", "typecheck"]],
    ["build", [process.execPath, "run", "build"]],
    [
      "offline-operations",
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "local-offline.ts"),
        path.join(directory, "offline-operations.json"),
      ],
    ],
    [
      "start-help",
      [
        process.execPath,
        "--preload",
        guard,
        "./src/main.ts",
        "start",
        "--help",
      ],
    ],
    ["summary-help", [process.execPath, "run", "usage:summary", "--help"]],
  ]
  const outcomes = []
  for (const [name, command] of commands)
    outcomes.push(await runCommand(directory, name, command))
  writeFileSync(
    path.join(directory, "offline.json"),
    JSON.stringify(outcomes, null, 2),
    "utf8",
  )
  return outcomes
}
