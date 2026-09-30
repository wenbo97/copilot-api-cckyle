import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { record } from "./local-budget"

/** Counts active runner time, not time while an interrupted runner is absent. */
export class LiveTime {
  private readonly file: string
  private readonly initial: number
  private readonly base: number
  private readonly now: () => number

  constructor(
    directory: string,
    previous: Array<{ id: string; durationMs: number }>,
    now = () => performance.now(),
  ) {
    this.file = path.join(directory, "live-time.json")
    this.now = now
    this.initial = now()
    if (existsSync(this.file)) {
      const saved = record(JSON.parse(readFileSync(this.file, "utf8")))
      if (
        typeof saved.elapsedMs !== "number"
        || !Number.isSafeInteger(saved.elapsedMs)
        || saved.elapsedMs < 0
      )
        throw new Error("Invalid persisted live-time budget")
      this.base = saved.elapsedMs
    } else {
      // Migration for this suite's initial interrupted run: overcount each soak
      // sample as a full minute and allow four minutes for unrecorded startup.
      for (const item of previous)
        if (
          typeof item.id !== "string"
          || !Number.isFinite(item.durationMs)
          || item.durationMs < 0
        )
          throw new Error("Invalid prior timing evidence")
      this.base = previous.reduce(
        (sum, item) =>
          sum
          + (item.id.includes("soak-") ?
            Math.max(60000, item.durationMs)
          : item.durationMs),
        previous.length > 0 ? 240000 : 0,
      )
    }
    this.checkpoint()
  }

  elapsedMs() {
    return Math.ceil(this.base + this.now() - this.initial)
  }

  checkpoint() {
    const temporary = `${this.file}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({
        elapsedMs: this.elapsedMs(),
        updatedAt: new Date().toISOString(),
        basis:
          "checkpointed active runner time; legacy runs conservatively estimated",
      }),
      "utf8",
    )
    renameSync(temporary, this.file)
  }
}
