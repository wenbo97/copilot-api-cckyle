import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { LiveTime } from "./local-live-time"

test("active time persists while an interrupted inactive gap is excluded", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "acceptance-clock-"))
  let now = 0
  try {
    const initial = new LiveTime(directory, [], () => now)
    now = 10000
    initial.checkpoint()
    now = 900000
    const resumed = new LiveTime(directory, [], () => now)
    expect(resumed.elapsedMs()).toBe(10000)
    now += 1000
    expect(resumed.elapsedMs()).toBe(11000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
