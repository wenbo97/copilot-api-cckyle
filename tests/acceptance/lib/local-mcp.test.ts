import { expect, test } from "bun:test"
import { request } from "node:http"

import { record, list } from "./local-budget"
import { startFixtureMcp } from "./local-mcp"

test("fixture MCP returns only synthetic data and counts actual calls", async () => {
  const fixture = startFixtureMcp()
  const call = async (method: string, params: unknown) => {
    // Other repository tests replace global fetch; use an independent loopback client.
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = request(
        fixture.url,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => {
            try {
              resolve(
                record(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
              )
            } catch (error) {
              reject(
                error instanceof Error ? error : (
                  new Error("Invalid fixture MCP response")
                ),
              )
            }
          })
          response.on("error", reject)
        },
      )
      req.on("error", reject)
      req.setTimeout(5000, () => req.destroy(new Error("Fixture MCP timeout")))
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))
    })
  }
  try {
    const initialized = await call("initialize", {})
    expect(record(initialized.result).protocolVersion).toBe("2025-03-26")
    const returned = await call("tools/call", {
      name: "read_marker",
      arguments: {},
    })
    expect(record(list(record(returned.result).content)[0]).text).toBe(
      fixture.marker,
    )
    expect(fixture.calls()).toBe(1)
    const refused = await call("tools/call", {
      name: "shell",
      arguments: { command: "ignored" },
    })
    expect(record(refused.error).code).toBe(-32602)
    expect(fixture.calls()).toBe(1)
  } finally {
    await fixture.stop()
  }
})
