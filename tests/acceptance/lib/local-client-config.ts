import { mkdirSync, mkdtempSync } from "node:fs"
import path from "node:path"

// Windows refuses helper aliases under TEMP. Use git-ignored isolated homes.
export function createClientDirectory(prefix: string): string {
  const root = path.resolve(import.meta.dir, "../../_runlog/client-fixtures")
  mkdirSync(root, { recursive: true })
  return mkdtempSync(path.join(root, prefix))
}

// --ignore-user-config also removes windows.sandbox. Preserve the actual Windows
// sandbox, in addition to the caller's read-only access and approval=never.
export const codexSandboxArgs =
  process.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : []

// Keep Claude's built-in tool instructions while isolating settings, MCP,
// skills, and persistence. --bare also removes tool semantics (e.g. line numbers).
export const claudeIsolationArgs = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--no-session-persistence",
]
