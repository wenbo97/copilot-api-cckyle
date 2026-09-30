import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
const ownershipMessage = "input item does not belong to this connection"
let directory: string
const originalForeignManifest = process.env.COPILOT_FOREIGN_REASONING_MANIFEST
const children = new Set<Bun.Subprocess>()

beforeEach(async () => {
  delete process.env.COPILOT_FOREIGN_REASONING_MANIFEST
  directory = await mkdtemp(path.join(os.tmpdir(), "responses-history-test-"))
  Object.assign(state, {
    copilotToken: "test-token",
    copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    accountType: "individual",
    vsCodeVersion: "1.0.0",
    manualApprove: false,
    traceEnabled: false,
    responsesHistoryDirectory: directory,
    responsesHistoryScope: "https://upstream.example/v1",
    models: {
      object: "list",
      data: [{ id: "gpt-6-astra", supported_endpoints: ["/responses"] }],
    },
  })
})

afterEach(async () => {
  if (originalForeignManifest === undefined)
    delete process.env.COPILOT_FOREIGN_REASONING_MANIFEST
  else process.env.COPILOT_FOREIGN_REASONING_MANIFEST = originalForeignManifest
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null) child.kill()
      await child.exited
    }),
  )
  globalThis.fetch = originalFetch
  Object.assign(state, {
    responsesHistoryDirectory: undefined,
    responsesHistoryScope: undefined,
  })
  await rm(directory, { recursive: true, force: true })
})

test("resume recovers an ownership error wrapped in SSE without losing visible history", async () => {
  const input = [
    { type: "reasoning", encrypted_content: "old-cipher", summary: [] },
    { role: "user", content: "Remember bluebird" },
    { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "bluebird" },
  ]
  const bodies: Array<Record<string, unknown>> = []
  installFetch((_url, init) => {
    const body = JSON.parse(requestBody(init)) as Record<string, unknown>
    bodies.push(body)
    if (JSON.stringify(body).includes("old-cipher")) return ownershipSse()
    return completedSse()
  })
  const response = await request(input)
  expect(await response.text()).toContain('"type":"response.completed"')
  expect(bodies).toHaveLength(2)
  expect(bodies[1].input).toEqual([
    { type: "reasoning", summary: [] },
    ...input.slice(1),
  ])
  expect(input[0]).toHaveProperty("encrypted_content", "old-cipher")
})

test("a later resume preserves encryption previously issued by this upstream", async () => {
  const current = {
    type: "reasoning",
    encrypted_content: "current-cipher",
    summary: [],
  }
  installFetch(() => completedSse([current]))
  await (await request([{ role: "user", content: "first turn" }])).text()

  const sent: Array<Record<string, unknown>> = []
  installFetch((_url, init) => {
    const body = JSON.parse(requestBody(init)) as Record<string, unknown>
    sent.push(body)
    return JSON.stringify(body).includes("old-cipher") ?
        ownershipSse()
      : completedSse()
  })
  const response = await request([
    { type: "reasoning", encrypted_content: "old-cipher", summary: [] },
    current,
    { role: "user", content: "continue" },
  ])
  expect(await response.text()).toContain('"type":"response.completed"')
  expect(sent[1].input).toContainEqual(current)
})

test("HTTP ownership rejection is recovered without refreshing credentials", async () => {
  let calls = 0
  installFetch((url, init) => {
    expect(url).toEndWith("/responses")
    calls++
    if (requestBody(init).includes("old-cipher")) {
      return Response.json(
        { error: { message: ownershipMessage } },
        { status: 401 },
      )
    }
    return completedSse()
  })
  expect(await (await request([oldReasoning()])).text()).toContain(
    '"type":"response.completed"',
  )
  expect(calls).toBe(2)
})

test("non-streaming recovery preserves a valid Responses response", async () => {
  let calls = 0
  installFetch((_url, init) => {
    calls++
    return requestBody(init).includes("old-cipher") ?
        Response.json({ error: { message: ownershipMessage } }, { status: 401 })
      : Response.json(completedObject())
  })
  const response = await request([oldReasoning()], false)
  expect(await response.json()).toEqual(completedObject())
  expect(calls).toBe(2)
})

test("ownership failure after the first event is not replayed and retains its status", async () => {
  let calls = 0
  installFetch(() => {
    calls++
    return sse([
      {
        type: "response.created",
        response: { ...completedObject(), status: "in_progress" },
      },
      {
        status: 401,
        body: JSON.stringify({ error: { message: ownershipMessage } }),
      },
    ])
  })
  const output = await (await request([oldReasoning()])).text()
  expect(calls).toBe(1)
  expect(output).toContain('"type":"response.failed"')
  expect(output).toContain(ownershipMessage)
  expect(output).toContain("401")
  expect(output).toContain('"code":"copilot_input_connection_mismatch"')
  expect(output).toContain("not attempted")
})

test("repeated ownership failure stops after one recovery attempt", async () => {
  let calls = 0
  installFetch(() => {
    calls++
    return ownershipSse()
  })
  const output = await (await request([oldReasoning()])).text()
  expect(calls).toBe(2)
  expect(output).toContain(ownershipMessage)
  expect(output).toContain("removed=1")
  expect(output).not.toContain('"type":"response.completed"')
})

test("already registered reasoning is never cleared even when the upstream rejects it", async () => {
  const current = {
    type: "reasoning",
    encrypted_content: "current-cipher",
    summary: [],
  }
  installFetch(() => completedSse([current]))
  await (await request([])).text()
  let calls = 0
  installFetch(() => {
    calls++
    return ownershipSse()
  })
  const output = await (await request([current])).text()
  expect(calls).toBe(1)
  expect(output).toContain(ownershipMessage)
})

test("receipt write failure disables cleanup while keeping healthy responses usable", async () => {
  const blockedPath = path.join(directory, "not-a-directory")
  await writeFile(blockedPath, "fixture")
  state.responsesHistoryDirectory = blockedPath
  installFetch(() =>
    completedSse([{ type: "reasoning", encrypted_content: "current-cipher" }]),
  )
  expect(await (await request([])).text()).toContain(
    '"type":"response.completed"',
  )
  let calls = 0
  installFetch(() => {
    calls++
    return ownershipSse()
  })
  const output = await (await request([oldReasoning()])).text()
  expect(calls).toBe(1)
  expect(output).toContain("automatic recovery disabled")
  expect(output).toContain(ownershipMessage)
  expect(output).toContain("401")
})

test("client cancellation prevents an ownership-recovery request", async () => {
  const caller = new AbortController()
  let calls = 0
  installFetch(() => {
    calls++
    caller.abort(new Error("client cancelled"))
    return ownershipSse()
  })
  const response = await server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: caller.signal,
    body: JSON.stringify({
      model: "gpt-6-astra",
      stream: true,
      input: [oldReasoning()],
    }),
  })
  await response.text()
  expect(calls).toBe(1)
})

test("a first-event timeout does not consume a history-recovery attempt", async () => {
  const previous = process.env.COPILOT_FIRST_EVENT_TIMEOUT_MS
  process.env.COPILOT_FIRST_EVENT_TIMEOUT_MS = "10"
  let calls = 0
  const signals: Array<AbortSignal> = []
  installFetch((_url, init) => {
    calls++
    const signal = init?.signal
    if (!signal) throw new Error("Expected upstream cancellation signal")
    signals.push(signal)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  try {
    const output = await (await request([oldReasoning()])).text()
    expect(calls).toBe(1)
    expect(output).toContain("timeout")
    expect(signals[0].aborted).toBe(true)
  } finally {
    if (previous === undefined)
      delete process.env.COPILOT_FIRST_EVENT_TIMEOUT_MS
    // eslint-disable-next-line require-atomic-updates -- serial test restores its own timeout fixture
    else process.env.COPILOT_FIRST_EVENT_TIMEOUT_MS = previous
  }
})

test("normal authorization errors in SSE do not discard historical state", async () => {
  let calls = 0
  installFetch(() => {
    calls++
    return sse([
      {
        status: 401,
        body: JSON.stringify({ error: { message: "token expired" } }),
      },
    ])
  })
  const output = await (await request([oldReasoning()])).text()
  expect(calls).toBe(1)
  expect(output).toContain("token expired")
})

test.each([false, true])(
  "recovery preserves a different final upstream failure (sse=%s)",
  async (firstSse) => {
    let calls = 0
    installFetch(() => {
      calls++
      if (calls === 1)
        return firstSse ? ownershipSse() : (
            Response.json(
              { error: { message: ownershipMessage } },
              { status: 401 },
            )
          )
      return Response.json(
        {
          error: { message: "capacity unavailable", code: "capacity_exceeded" },
        },
        { status: 503 },
      )
    })
    const response = await request([oldReasoning()])
    const output = await response.text()
    expect(calls).toBe(2)
    expect(response.status).toBe(firstSse ? 200 : 503)
    expect(output).toContain("capacity unavailable")
    expect(output).toContain("capacity_exceeded")
    expect(output).toContain("removed=1")
    if (firstSse) expect(output).toContain("503")
  },
)

test("a rate limit and a network failure never trigger historical cleanup", async () => {
  for (const failure of ["rate-limit", "network"]) {
    let calls = 0
    installFetch(() => {
      calls++
      if (failure === "network") throw new Error("network unavailable")
      return Response.json(
        { error: { message: "rate limit" } },
        { status: 429 },
      )
    })
    const response = await request([oldReasoning()])
    expect(response.status).toBe(failure === "network" ? 500 : 429)
    expect(calls).toBe(1)
  }
})

test("upstream receipts contain hashes only and are isolated by destination", async () => {
  const current = {
    type: "reasoning",
    encrypted_content: "current-cipher",
    summary: [],
  }
  installFetch(() => completedSse([current]))
  await (await request([])).text()
  const scopes = await readdir(directory)
  expect(scopes).toHaveLength(1)
  const scopeDir = path.join(directory, scopes[0])
  const receipts = await readdir(scopeDir)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatch(/^[a-f0-9]{64}$/u)
  expect(
    await readFile(path.join(scopeDir, receipts[0]), "utf8"),
  ).not.toContain("current-cipher")

  state.responsesHistoryScope = "https://other-upstream.example/v1"
  let calls = 0
  installFetch((_url, init) => {
    calls++
    return requestBody(init).includes("current-cipher") ?
        ownershipSse()
      : completedSse()
  })
  expect(await (await request([current])).text()).toContain(
    '"type":"response.completed"',
  )
  expect(calls).toBe(2)
})

test("corrupt receipts disable cleanup but do not prevent healthy responses", async () => {
  const current = {
    type: "reasoning",
    encrypted_content: "current-cipher",
    summary: [],
  }
  installFetch(() => completedSse([current]))
  await (await request([])).text()
  const scopeDir = path.join(directory, (await readdir(directory))[0])
  await writeFile(path.join(scopeDir, (await readdir(scopeDir))[0]), "broken")
  let calls = 0
  installFetch(() => {
    calls++
    return ownershipSse()
  })
  const output = await (await request([current, oldReasoning()])).text()
  expect(calls).toBe(1)
  expect(output).toContain("corrupt")
  installFetch(() => completedSse())
  expect(await (await request([])).text()).toContain(
    '"type":"response.completed"',
  )
})

function oldReasoning(): Record<string, unknown> {
  return { type: "reasoning", encrypted_content: "old-cipher", summary: [] }
}

test("a new process resumes without dropping previously registered state", async () => {
  expect((await runRegistryProcess("issue")).exitCode).toBe(0)
  const resumed = await runRegistryProcess("resume")
  expect(resumed.exitCode).toBe(0)
  expect(resumed.output).toContain('"retained":true')
  expect(resumed.output).toContain('"requests":2')
}, 30_000)

test("concurrent processes register independent receipts without overwriting one another", async () => {
  const issued = await Promise.all([
    runRegistryProcess("issue", "issued-a"),
    runRegistryProcess("issue", "issued-b"),
  ])
  expect(issued.map((r) => r.exitCode)).toEqual([0, 0])
  const resumed = await Promise.all([
    runRegistryProcess("resume", "issued-a"),
    runRegistryProcess("resume", "issued-b"),
  ])
  expect(resumed.map((r) => r.exitCode)).toEqual([0, 0])
}, 30_000)

async function runRegistryProcess(
  mode: string,
  ciphertext?: string,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "fixtures", "history-registry-process.ts"),
      directory,
      mode,
      ...(ciphertext ? [ciphertext] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  children.add(child)
  const timeoutState = { expired: false }
  const deadline = setTimeout(() => {
    timeoutState.expired = true
    child.kill()
  }, 10_000)
  try {
    const [exitCode, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timeoutState.expired)
      throw new Error(`Registry subprocess exceeded 10 seconds: ${stderr}`)
    return { exitCode, output: output + stderr }
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    await child.exited
    children.delete(child)
  }
}

function sse(values: Array<unknown>): Response {
  return new Response(
    values.map((v) => `data: ${JSON.stringify(v)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function ownershipSse(): Response {
  return sse([
    {
      status: 401,
      body: JSON.stringify({ error: { message: ownershipMessage } }),
    },
  ])
}

function completedSse(output: Array<unknown> = []): Response {
  return sse([
    {
      type: "response.completed",
      response: completedObject(output),
    },
  ])
}

function completedObject(output: Array<unknown> = []): Record<string, unknown> {
  return {
    id: "response_1",
    object: "response",
    created_at: 1,
    model: "gpt-6-astra",
    status: "completed",
    output,
    error: null,
  }
}

async function request(
  input: Array<unknown>,
  stream = true,
): Promise<Response> {
  return server.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", input, stream }),
  })
}

function installFetch(
  handler: (url: unknown, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = Object.assign(
    (url: unknown, init?: RequestInit) => Promise.resolve(handler(url, init)),
    {
      preconnect: originalFetch.preconnect,
    },
  ) as typeof fetch
}

async function foreignManifest(ciphertexts: Array<string>) {
  const filename = path.join(directory, "foreign.json")
  await writeFile(
    filename,
    JSON.stringify({
      version: 1,
      sourceProvider: "openai",
      sourceSessionId: "synthetic-source",
      ciphertextSha256: ciphertexts.map((value) =>
        createHash("sha256").update(value).digest("hex"),
      ),
    }),
  )
  process.env.COPILOT_FOREIGN_REASONING_MANIFEST = filename
}

for (const stream of [false, true]) {
  test(`explicit foreign reasoning avoids invalid_request_body without losing history stream=${stream}`, async () => {
    const current = {
      type: "reasoning",
      id: "current",
      encrypted_content: "current-cipher",
      summary: [],
    }
    installFetch(() => completedSse([current]))
    await (await request([])).text()
    // Even an operator manifest cannot override a current-upstream receipt.
    await foreignManifest(["foreign-cipher", "current-cipher"])
    const input = [
      {
        type: "reasoning",
        id: "foreign",
        encrypted_content: "foreign-cipher",
        summary: [{ type: "summary_text", text: "Visible summary" }],
      },
      current,
      { type: "reasoning", encrypted_content: "unknown-cipher", summary: [] },
      { role: "user", content: "Remember bluebird" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "bluebird" },
    ]
    const bodies: Array<Record<string, unknown>> = []
    installFetch((_url, init) => {
      const body = JSON.parse(requestBody(init)) as Record<string, unknown>
      bodies.push(body)
      if (requestBody(init).includes("foreign-cipher"))
        return Response.json(
          { error: { code: "invalid_request_body", message: "" } },
          { status: 400 },
        )
      return stream ? completedSse() : Response.json(completedObject())
    })
    const response = await request(input, stream)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      stream ? "response.completed" : "response_1",
    )
    expect(bodies).toHaveLength(1)
    const { encrypted_content: _ciphertext, ...visible } = input[0]
    expect(bodies[0].input).toEqual([visible, ...input.slice(1)])
    expect(input[0].encrypted_content).toBe("foreign-cipher")
  })
}

test("generic 400 never removes unrecognized reasoning or retries", async () => {
  await foreignManifest(["other-cipher"])
  let calls = 0
  installFetch((_url, init) => {
    calls++
    expect(requestBody(init)).toContain("old-cipher")
    return Response.json(
      { error: { code: "invalid_request_body", message: "" } },
      { status: 400 },
    )
  })
  expect((await request([oldReasoning()])).status).toBe(400)
  expect(calls).toBe(1)
})

test("invalid foreign manifests stop before provider I/O", async () => {
  await foreignManifest(["foreign-cipher"])
  await writeFile(path.join(directory, "foreign.json"), "{invalid")
  let calls = 0
  installFetch(() => {
    calls++
    return completedSse()
  })
  expect((await request([oldReasoning()])).status).toBe(500)
  expect(calls).toBe(0)
})

test("foreign policy fails closed when current-origin receipts are corrupt", async () => {
  const current = {
    type: "reasoning",
    encrypted_content: "current-cipher",
    summary: [],
  }
  installFetch(() => completedSse([current]))
  await (await request([])).text()
  const scope = (await readdir(directory))[0]
  await writeFile(
    path.join(
      directory,
      scope,
      createHash("sha256").update("current-cipher").digest("hex"),
    ),
    "corrupt",
  )
  await foreignManifest(["current-cipher"])
  let calls = 0
  installFetch(() => {
    calls++
    return completedSse()
  })
  expect((await request([current])).status).toBe(500)
  expect(calls).toBe(0)
})

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== "string")
    throw new Error("Expected a serialized Responses payload")
  return init.body
}
