import { beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"
import { createListenOptions } from "../src/start"

describe("local management boundary", () => {
  beforeEach(() => {
    state.copilotToken = "local-test-token"
  })

  test("rejects browser-origin requests to /token without CORS access", async () => {
    const response = await server.request("http://localhost/token", {
      headers: { host: "localhost", origin: "https://evil.example" },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("does not grant a CORS preflight for /token", async () => {
    const response = await server.request("http://localhost/token", {
      method: "OPTIONS",
      headers: {
        host: "localhost",
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("rejects /token requests whose Host is not loopback", async () => {
    const response = await server.request("http://proxy.example/token", {
      headers: { host: "proxy.example" },
    })

    expect(response.status).toBe(403)
  })

  test("allows a local non-browser client without exposing a CORS response", async () => {
    const response = await server.request("http://127.0.0.1/token", {
      headers: { host: "127.0.0.1" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: "local-test-token" })
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("configures the production listener on IPv4 loopback", () => {
    const options = createListenOptions(4142, 255)

    expect(options.hostname).toBe("127.0.0.1")
    expect(options.port).toBe(4142)
  })
})
