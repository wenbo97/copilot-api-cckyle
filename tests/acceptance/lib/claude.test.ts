import { describe, test, expect } from "bun:test"

import { buildClaudeArgs, extractLastText } from "../lib/claude"

describe("buildClaudeArgs", () => {
  test("baseline: -p, model, output-format, skip-permissions", () => {
    const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4.8" })
    expect(args).toEqual([
      "-p",
      "hi",
      "--model",
      "claude-opus-4.8",
      "--output-format",
      "text",
      "--allow-dangerously-skip-permissions",
    ])
  })

  test("includes --agents and --output-format stream-json", () => {
    const args = buildClaudeArgs({
      prompt: "task",
      model: "gpt-5.5",
      outputFormat: "stream-json",
      agentsJson: '{"explorer":{}}',
    })
    expect(args).toContain("--agents")
    expect(args[args.indexOf("--agents") + 1]).toBe('{"explorer":{}}')
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json")
  })

  test("supports multiple --mcp-config arguments", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      model: "m",
      mcpConfig: ["a.json", "b.json"],
    })
    const idxs = args.reduce<Array<number>>((acc, a, i) => {
      if (a === "--mcp-config") acc.push(i)
      return acc
    }, [])
    expect(idxs.length).toBe(2)
    expect(args[idxs[0] + 1]).toBe("a.json")
    expect(args[idxs[1] + 1]).toBe("b.json")
  })

  test("appends extraArgs verbatim", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      model: "m",
      extraArgs: ["--verbose"],
    })
    expect(args).toContain("--verbose")
  })
})

describe("extractLastText", () => {
  test("text format returns trimmed stdout", () => {
    expect(extractLastText("  OK\n", "text")).toBe("OK")
  })

  test("json format pulls .result", () => {
    expect(
      extractLastText(JSON.stringify({ result: "the answer" }), "json"),
    ).toBe("the answer")
  })

  test("json format falls back to raw stdout when unparseable", () => {
    expect(extractLastText("not json", "json")).toBe("not json")
  })

  test("stream-json prefers terminal result event", () => {
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial " }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "FINAL" }),
    ].join("\n")
    expect(extractLastText(ndjson, "stream-json")).toBe("FINAL")
  })

  test("stream-json concatenates assistant text when no result event", () => {
    const ndjson = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello " }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "world" }] },
      }),
    ].join("\n")
    expect(extractLastText(ndjson, "stream-json")).toBe("Hello world")
  })

  test("stream-json tolerates blank / non-JSON lines", () => {
    const ndjson = [
      "",
      "garbage-line",
      JSON.stringify({ type: "result", result: "ok" }),
      "",
    ].join("\n")
    expect(extractLastText(ndjson, "stream-json")).toBe("ok")
  })
})
