import { expect, test } from "bun:test"
import path from "node:path"

import { resolveCodexFixtureDirectory } from "./local-client-config"
import { latestOptions } from "./local-latest-options"

test("latest defaults are the approved six-model round and allow narrower limits", () => {
  const options = latestOptions(["--profile", "latest", "--dry-run"])
  expect(options.models).toHaveLength(6)
  expect(options.credits).toBe(500)
  expect(options.attempts).toBe(60)
  expect(options.minutes).toBe(45)
  expect(
    latestOptions(["--profile", "latest", "--max-credits", "10"]).credits,
  ).toBe(10)
})
test("latest rejects ambiguous modes, unknown models and expanded limits before side effects", () => {
  for (const args of [
    ["--live", "--dry-run"],
    ["--models", "gpt-5.6-sol"],
    ["--max-credits", "501"],
    ["--max-attempts", "61"],
    ["--max-attempts", "1.5"],
    ["--max-minutes", "46"],
    ["--only", "codex-tool"],
    ["--live", "--live"],
    ["--models", "gpt-6-sol,gpt-6-sol"],
  ])
    expect(() => latestOptions(["--profile", "latest", ...args])).toThrow()
})

test("Codex fixture reuse is confined to synthetic admission homes", () => {
  const fixture = path.resolve(
    import.meta.dir,
    "../../_runlog/client-fixtures/copilot-codex-admission-ABC123",
  )
  expect(resolveCodexFixtureDirectory(fixture)).toBe(fixture)
  expect(() =>
    resolveCodexFixtureDirectory(
      path.resolve(import.meta.dir, "../../_runlog/private-history"),
    ),
  ).toThrow()
  expect(() =>
    resolveCodexFixtureDirectory(
      path.resolve(fixture, "../..", "copilot-codex-admission-ABC123"),
    ),
  ).toThrow()
  expect(
    latestOptions(["--profile", "latest", "--codex-fixture-dir", fixture])
      .codexFixtureDirectory,
  ).toBe(fixture)
})

test("live runs require a new explicit approval reference; offline modes do not", () => {
  expect(() => latestOptions(["--profile", "latest", "--live"])).toThrow(
    "approval-reference",
  )
  expect(() =>
    latestOptions([
      "--profile",
      "latest",
      "--live",
      "--approval-reference",
      " ",
    ]),
  ).toThrow()
  expect(
    latestOptions([
      "--profile",
      "latest",
      "--live",
      "--approval-reference",
      "Current account; reviewed six-model budget",
    ]).approvalReference,
  ).toBe("Current account; reviewed six-model budget")
  expect(latestOptions(["--profile", "latest", "--verify-evidence"]).live).toBe(
    false,
  )
})
