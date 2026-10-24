import { afterEach, expect, test } from "bun:test"

import { pollAccessToken } from "~/services/github/poll-access-token"

const originalFetch = globalThis.fetch
const deviceCode = {
  device_code: "offline-device",
  user_code: "offline-user",
  verification_uri: "https://example.test",
  expires_in: 60,
  interval: -1,
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function respondWith(replies: Array<unknown>) {
  let calls = 0
  globalThis.fetch = Object.assign(
    () => {
      if (calls >= replies.length) throw new Error("Unexpected token poll")
      return Promise.resolve(Response.json(replies[calls++]))
    },
    { preconnect: originalFetch.preconnect },
  )
  return () => calls
}

test("keeps polling pending OAuth responses and returns a string token", async () => {
  const calls = respondWith([
    { error: "authorization_pending" },
    { access_token: "offline-token", token_type: "bearer", scope: "" },
  ])
  expect(await pollAccessToken(deviceCode)).toBe("offline-token")
  expect(calls()).toBe(2)
})

test.each(
  [null, [], "invalid", { access_token: 123 }].map((response) => ({
    response,
  })),
)(
  "rejects malformed token responses without returning an unsafe value ($response)",
  async ({ response }) => {
    const calls = respondWith([response])
    const error: unknown = await pollAccessToken(deviceCode).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected a response error")
    expect(error.message).toContain("Invalid GitHub access token response")
    expect(calls()).toBe(1)
  },
)
