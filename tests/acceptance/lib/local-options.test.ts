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
