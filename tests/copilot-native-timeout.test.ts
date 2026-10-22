import { expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { createMessages } from "../src/services/copilot/create-messages"
import { createResponses } from "../src/services/copilot/create-responses"

test("all streaming services disable Bun native fetch timeout while non-streaming keeps it", async () => {
  state.copilotToken = "local-timeout-test"
  state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
  state.accountType = "individual"
  const originalFetch = globalThis.fetch
  const calls: Array<RequestInit & { timeout?: false }> = []
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {})
      if (typeof init?.body !== "string") throw new Error("Expected JSON body")
      const payload = JSON.parse(init.body) as { stream?: boolean }
      return Promise.resolve(
        payload.stream ?
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({
            id: "test",
            object: "response",
            type: "message",
            choices: [],
            output: [],
          }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const services = [
      (stream: boolean) =>
        createMessages({
          model: "claude-test",
          messages: [],
          max_tokens: 10,
          stream,
        }),
      (stream: boolean) =>
        createChatCompletions({ model: "gpt-test", messages: [], stream }),
      (stream: boolean) =>
        createResponses({ model: "gpt-test", input: "hello", stream }),
    ]
    for (const service of services) {
      for (const streaming of [true, false]) {
        const response = await service(streaming)
        expect(calls.at(-1)?.timeout).toBe(streaming ? false : undefined)
        await consumeStream(response)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

async function consumeStream(response: object): Promise<void> {
  if (Symbol.asyncIterator in response) {
    for await (const event of response as AsyncIterable<{ data?: string }>)
      expect(event.data).toBe("[DONE]")
  }
}
