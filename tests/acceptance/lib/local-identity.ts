import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

export function executionManifest(directory = root): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (relative: string) => {
    const filename = path.join(directory, relative)
    files[relative.replaceAll("\\", "/")] = createHash("sha256")
      .update(readFileSync(filename))
      .digest("hex")
  }
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "_runlog") continue
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) walk(child)
      else visit(child)
    }
  }
  walk("src")
  walk("tests")
  for (const relative of [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "tsdown.config.ts",
    "scripts/usage-summary.ts",
  ]) {
    if (existsSync(path.join(directory, relative))) visit(relative)
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function identitySha256(manifest: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}
