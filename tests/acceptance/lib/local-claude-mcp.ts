import { randomUUID, randomInt } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"

import { record, type Json } from "./local-budget"
import { assert } from "./local-runtime"

export const MCP_LONG_TOOL = `read_private_marker_${"long_tool_name_roundtrip_".repeat(3)}`
export const MCP_IMAGE_TOOL = "inspect_color_strip"
export const MCP_PREFIX = "mcp__acceptance__"

const colors = {
  RED: [230, 25, 25],
  BLUE: [20, 50, 230],
  GREEN: [20, 180, 40],
  YELLOW: [250, 220, 20],
} as const

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer) {
  const kind = Buffer.from(type)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])))
  return Buffer.concat([size, kind, data, checksum])
}

/** Synthetic pixels, not an answer encoded in metadata or tool descriptions. */
export function colorStrip(order: Array<keyof typeof colors>): Buffer {
  const width = 640
  const height = 160
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      if (x % 160 < 10 || x % 160 >= 150 || y < 10 || y >= 150) continue
      const color = colors[order[Math.floor(x / 160)]]
      for (let channel = 0; channel < 3; channel++)
        pixels[y * (width * 3 + 1) + 1 + x * 3 + channel] = color[channel]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function createMcpFixture(directory: string) {
  const marker = `MCP_${randomUUID()}`
  const order = Object.keys(colors) as Array<keyof typeof colors>
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const image = path.join(directory, "mcp-colors.png")
  const dispatch = path.join(directory, "mcp-dispatch.jsonl")
  const fixtureFile = path.join(directory, "mcp-server-fixture.json")
  writeFileSync(image, colorStrip(order))
  writeFileSync(fixtureFile, JSON.stringify({ marker, image, dispatch }))
  const config = path.join(directory, "mcp-config.json")
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        acceptance: {
          type: "stdio",
          command: process.execPath,
          args: [
            "--no-env-file",
            path.join(import.meta.dir, "local-claude-mcp-server.ts"),
            fixtureFile,
          ],
        },
      },
    }),
  )
  const expected = { marker, colors: order.join(",") }
  writeFileSync(
    path.join(directory, "mcp-expected.json"),
    JSON.stringify(expected),
  )
  return { config, dispatch, expected }
}

export function verifyMcpEvidence(
  fixture: ReturnType<typeof createMcpFixture>,
  events: Array<Json>,
  final: string,
) {
  const calls = readFileSync(fixture.dispatch, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => record(JSON.parse(line)))
  for (const name of [MCP_LONG_TOOL, MCP_IMAGE_TOOL]) {
    assert(
      calls.some((call) => call.name === name),
      `MCP never dispatched ${name}`,
    )
    const toolIds = new Set<string>()
    const completed = new Set<string>()
    for (const event of events) {
      const content = record(event.message).content
      if (!Array.isArray(content)) continue
      for (const item of content) {
        const block = record(item)
        if (block.type === "tool_use" && block.name === MCP_PREFIX + name)
          toolIds.add(String(block.id))
        if (block.type === "tool_result" && !block.is_error)
          completed.add(String(block.tool_use_id))
      }
    }
    assert(
      [...toolIds].some((id) => completed.has(id)),
      `No successful CLI result for ${name}`,
    )
  }
  assert(
    final.trim() === `${fixture.expected.marker}|${fixture.expected.colors}`,
    "Independent MCP marker/image answer mismatch",
  )
  return "Real CLI dispatched original long MCP name and image tool; private marker and randomized pixel colors verified"
}
