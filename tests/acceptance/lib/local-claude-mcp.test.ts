import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { inflateSync } from "node:zlib"

import { record } from "./local-budget"
import {
  createMcpFixture,
  MCP_IMAGE_TOOL,
  MCP_LONG_TOOL,
} from "./local-claude-mcp"

test("isolated MCP serves real ordered image content and records exact long tool dispatch", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-mcp-test-"))
  try {
    const fixture = createMcpFixture(directory)
    const requests = [
      {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      {
        id: 3,
        method: "tools/call",
        params: { name: MCP_LONG_TOOL, arguments: {} },
      },
      {
        id: 4,
        method: "tools/call",
        params: { name: MCP_IMAGE_TOOL, arguments: {} },
      },
    ]
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "local-claude-mcp-server.ts"),
        path.join(directory, "mcp-server-fixture.json"),
      ],
      {
        stdin: new Blob([
          requests
            .map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }))
            .join("\n") + "\n",
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const responses = stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => record(JSON.parse(line)))
    expect(responses).toHaveLength(4)
    expect(MCP_LONG_TOOL.length).toBeGreaterThan(64)
    const content = record(responses[3].result).content as Array<
      Record<string, unknown>
    >
    expect(content.map((block) => block.type)).toEqual([
      "text",
      "image",
      "text",
    ])
    expect(record(responses[2].result).content).toEqual([
      { type: "text", text: fixture.expected.marker },
    ])
    const png = Buffer.from(String(content[1].data), "base64")
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(png.readUInt32BE(16)).toBe(640)
    const compressed: Array<Buffer> = []
    for (let offset = 8; offset < png.length; ) {
      const size = png.readUInt32BE(offset)
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
        compressed.push(png.subarray(offset + 8, offset + 8 + size))
      offset += 12 + size
    }
    const pixels = inflateSync(Buffer.concat(compressed))
    const names: Record<string, string> = {
      "230,25,25": "RED",
      "20,50,230": "BLUE",
      "20,180,40": "GREEN",
      "250,220,20": "YELLOW",
    }
    const observed = [80, 240, 400, 560].map((x) => {
      const offset = 80 * 1921 + 1 + x * 3
      return names[[...pixels.subarray(offset, offset + 3)].join(",")]
    })
    expect(observed.join(",")).toBe(fixture.expected.colors)
    expect(
      readFileSync(fixture.dispatch, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => record(JSON.parse(line)).name),
    ).toEqual([MCP_LONG_TOOL, MCP_IMAGE_TOOL])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
