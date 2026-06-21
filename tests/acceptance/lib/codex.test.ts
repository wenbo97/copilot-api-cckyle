import { describe, test, expect } from "bun:test"

import {
  buildCodexArgs,
  providerConfigArgs,
  resolveCodexBin,
} from "../lib/codex"

const BASE = "http://localhost:4143"

describe("providerConfigArgs", () => {
  test("emits the four verified -c overrides incl. required name", () => {
    const args = providerConfigArgs(BASE)
    expect(args).toEqual([
      "-c",
      "model_providers.copilot.name=copilot",
      "-c",
      "model_providers.copilot.base_url=http://localhost:4143/v1",
      "-c",
      "model_providers.copilot.wire_api=responses",
      "-c",
      "model_provider=copilot",
    ])
  })

  test("appends /v1 without doubling a trailing slash", () => {
    expect(providerConfigArgs("http://localhost:4143/")).toContain(
      "model_providers.copilot.base_url=http://localhost:4143/v1",
    )
  })
})

describe("buildCodexArgs — exec mode", () => {
  const args = buildCodexArgs(
    { model: "gpt-5.3-codex", prompt: "say OK" },
    "/tmp/last.txt",
    BASE,
  )

  test("starts with exec and carries model/json/-o/skip-git", () => {
    expect(args[0]).toBe("exec")
    expect(args).toContain("-m")
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.3-codex")
    expect(args).toContain("--json")
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/last.txt")
    expect(args).toContain("--skip-git-repo-check")
  })

  test("uses --sandbox workspace-write by default", () => {
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write")
  })

  test("includes the provider config overrides", () => {
    expect(args).toContain("model_providers.copilot.name=copilot")
    expect(args).toContain("model_provider=copilot")
  })

  test("prompt is the final positional argument", () => {
    expect(args.at(-1)).toBe("say OK")
  })
})

describe("buildCodexArgs — review mode", () => {
  test("review subcommand with --uncommitted and NO --sandbox, NO positional prompt", () => {
    const args = buildCodexArgs(
      { model: "gpt-5.3-codex", mode: "review" },
      "/tmp/r.txt",
      BASE,
    )
    expect(args[0]).toBe("exec")
    expect(args[1]).toBe("review")
    expect(args).toContain("--uncommitted")
    expect(args).not.toContain("--sandbox")
    // No positional prompt trailing (last arg is part of provider config).
    expect(args.at(-1)).toBe("model_provider=copilot")
  })

  test("review --base overrides --uncommitted", () => {
    const args = buildCodexArgs(
      { model: "gpt-5.5", mode: "review", reviewScope: { base: "main" } },
      "/tmp/r.txt",
      BASE,
    )
    expect(args).toContain("--base")
    expect(args[args.indexOf("--base") + 1]).toBe("main")
    expect(args).not.toContain("--uncommitted")
  })

  test("review --commit scope", () => {
    const args = buildCodexArgs(
      { model: "gpt-5.5", mode: "review", reviewScope: { commit: "abc123" } },
      "/tmp/r.txt",
      BASE,
    )
    expect(args[args.indexOf("--commit") + 1]).toBe("abc123")
  })
})

describe("buildCodexArgs — sandbox + extraArgs", () => {
  test("custom sandbox honored", () => {
    const args = buildCodexArgs(
      { model: "m", prompt: "p", sandbox: "read-only" },
      "/tmp/l.txt",
      BASE,
    )
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only")
  })

  test("extraArgs are appended", () => {
    const args = buildCodexArgs(
      { model: "m", prompt: "p", extraArgs: ["--ephemeral"] },
      "/tmp/l.txt",
      BASE,
    )
    expect(args).toContain("--ephemeral")
  })
})

describe("resolveCodexBin", () => {
  test("honors an explicit override", () => {
    expect(resolveCodexBin("X:/codex.exe")).toBe("X:/codex.exe")
  })
})
