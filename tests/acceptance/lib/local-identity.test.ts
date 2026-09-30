import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { executionManifest, identitySha256 } from "./local-identity"

test("execution identity covers the handler, guard, and build configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "copilot-identity-"))
  try {
    mkdirSync(path.join(directory, "src"))
    mkdirSync(path.join(directory, "tests/acceptance"), { recursive: true })
    writeFileSync(path.join(directory, "src/server.ts"), "original")
    writeFileSync(path.join(directory, "tests/acceptance/guard.ts"), "original")
    writeFileSync(path.join(directory, "package.json"), "original")
    const initial = identitySha256(executionManifest(directory))
    for (const relative of [
      "src/server.ts",
      "tests/acceptance/guard.ts",
      "package.json",
    ]) {
      writeFileSync(path.join(directory, relative), "changed")
      expect(identitySha256(executionManifest(directory))).not.toBe(initial)
      writeFileSync(path.join(directory, relative), "original")
      expect(identitySha256(executionManifest(directory))).toBe(initial)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
