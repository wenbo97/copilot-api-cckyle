import { randomUUID } from "node:crypto"

import { record } from "./local-budget"

/** Pure test data, not a shell/file access workaround. No external side effects. */
export function startFixtureMcp() {
  const marker = `MCP_${randomUUID().slice(0, 8)}`
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = record(await request.json())
      if (body.id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      switch (body.method) {
        case "initialize": {
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "acceptance-fixture", version: "1.0.0" },
          }
          break
        }
        case "tools/list": {
          result = {
            tools: [
              {
                name: "read_marker",
                description:
                  "Return the fixed synthetic acceptance marker. No files, commands, or external services are accessed.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
            ],
          }
          break
        }
        case "tools/call": {
          if (record(body.params).name !== "read_marker")
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32602, message: "Unknown fixture tool" },
            })
          calls++
          result = { content: [{ type: "text", text: marker }], isError: false }
          break
        }
        case "ping": {
          result = {}
          break
        }
        default: {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          })
        }
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result })
    },
  })
  return {
    marker,
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls: () => calls,
    stop: () => server.stop(true),
  }
}
