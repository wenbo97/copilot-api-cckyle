import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

import { MCP_IMAGE_TOOL, MCP_LONG_TOOL } from "./local-claude-mcp"

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  marker: string
  image: string
  dispatch: string
}
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line) as {
    id?: string | number
    method: string
    params?: { name?: string; protocolVersion?: string }
  }
  if (message.id === undefined) continue
  let result: unknown
  switch (message.method) {
    case "initialize": {
      result = {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "isolated-acceptance", version: "1.0.0" },
      }
      break
    }
    case "ping": {
      result = {}
      break
    }
    case "tools/list": {
      result = {
        tools: [
          {
            name: MCP_LONG_TOOL,
            description:
              "Return the private acceptance marker. Call exactly once.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: MCP_IMAGE_TOOL,
            description:
              "Return an image of four colored squares. Inspect the actual image left to right. Call exactly once.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      }
      break
    }
    case "tools/call": {
      const name = message.params?.name
      if (name !== MCP_LONG_TOOL && name !== MCP_IMAGE_TOOL) {
        result = {
          isError: true,
          content: [{ type: "text", text: "Unknown tool" }],
        }
        break
      }
      appendFileSync(
        fixture.dispatch,
        JSON.stringify({ name, time: Date.now() }) + "\n",
      )
      result = {
        content:
          name === MCP_LONG_TOOL ?
            [{ type: "text", text: fixture.marker }]
          : [
              {
                type: "text",
                text: "Inspect these four squares from left to right:",
              },
              {
                type: "image",
                mimeType: "image/png",
                data: readFileSync(fixture.image).toString("base64"),
              },
              {
                type: "text",
                text: "Return uppercase color names separated by commas.",
              },
            ],
      }
      break
    }
    default: {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      )
      continue
    }
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
  )
}
