import { expect, test } from "bun:test"

import { validateArguments } from "./local-options"

test("ambiguous flags cannot accidentally enable a live full matrix", () => {
  expect(() => validateArguments(["--live", "false"])).toThrow()
  expect(() => validateArguments(["--live", "--only"])).toThrow()
  expect(() => validateArguments(["--live", "--only", ""])).toThrow()
  expect(() => validateArguments(["--live", "--only", ","])).toThrow()
  expect(() =>
    validateArguments(["--live", "--only", "responses-json,,soak"]),
  ).toThrow()
  expect(() =>
    validateArguments(["--live", "--only", "soak,soak-recheck"]),
  ).toThrow()
  expect(() => validateArguments(["--live", "--dry-run"])).toThrow()
  expect(() => validateArguments(["--max-credits", "1001"])).toThrow()
  expect(() =>
    validateArguments([
      "--live",
      "--only",
      "responses-json",
      "--max-credits",
      "10",
    ]),
  ).not.toThrow()
  expect(() => validateArguments([])).not.toThrow()
})

test("cross-version budgets require explicit bounded additional limits and selection", () => {
  const valid = [
    "--budget-dir",
    "old",
    "--output-dir",
    "new",
    "--only",
    "claude-smoke",
    "--max-additional-credits",
    "30",
    "--max-additional-attempts",
    "20",
    "--max-additional-minutes",
    "15",
  ]
  expect(() => validateArguments(valid)).not.toThrow()
  expect(() => validateArguments(valid.slice(0, -2))).toThrow()
  expect(() => validateArguments(valid.slice(2))).toThrow()
  expect(() => validateArguments([...valid.slice(0, -1), "16"])).toThrow()
  expect(() => validateArguments(["--budget-dir", "old"])).toThrow()
})

test("matrix bounds require explicit matrix authorization and do not expand legacy CLI limits", () => {
  const args = [
    "--matrix",
    "--budget-dir",
    "old",
    "--output-dir",
    "new",
    "--authorization-file",
    "draft.json",
    "--max-additional-credits",
    "825",
    "--max-additional-attempts",
    "42",
    "--max-additional-minutes",
    "30",
  ]
  expect(() => validateArguments(args)).not.toThrow()
  expect(() => validateArguments(args.slice(1))).toThrow()
  expect(() => validateArguments([...args, "--only", "claude-tool"])).toThrow()
  expect(() => validateArguments(["--matrix"])).toThrow()
  expect(() => validateArguments([...args.slice(0, -1), "31"])).toThrow()
})

test("E2E live flags require the historical budget, fixed stage limits, and an output directory", () => {
  const matrix = [
    "--e2e",
    "--stage",
    "matrix",
    "--live",
    "--budget-dir",
    "old",
    "--output-dir",
    "new",
    "--max-additional-credits",
    "1000",
    "--max-additional-attempts",
    "176",
    "--max-additional-minutes",
    "90",
  ]
  expect(() => validateArguments(matrix)).not.toThrow()
  expect(() =>
    validateArguments(
      matrix.filter((value) => value !== "--budget-dir" && value !== "old"),
    ),
  ).toThrow()
  expect(() => validateArguments([...matrix.slice(0, -1), "91"])).toThrow()
  expect(() =>
    validateArguments([...matrix, "--matrix-output-dir", "other"]),
  ).toThrow()
  const legacy = [...matrix]
  legacy[legacy.indexOf("matrix")] = "legacy"
  legacy[legacy.indexOf("1000")] = "8000"
  legacy[legacy.indexOf("176")] = "2"
  legacy[legacy.indexOf("90")] = "10"
  expect(() =>
    validateArguments([...legacy, "--matrix-output-dir", "prior"]),
  ).not.toThrow()
  expect(() =>
    validateArguments([...legacy, "--only", "responses-json"]),
  ).toThrow()
})
