import { afterEach, beforeEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponsesPayload } from "~/routes/responses/responses-types"

import {
  claudeCodeSessionId,
  withBridgeCacheKey,
} from "~/routes/messages/bridge-cache-key"

const SESSION = "0f1e2d3c-4b5a-4978-8877-665544332211"
const keys = ["COPILOT_BRIDGE_CACHE_KEY", "COPILOT_CACHE_NAMESPACE"] as const
let previous: Array<string | undefined>

beforeEach(() => {
  previous = keys.map((key) => process.env[key])
  for (const key of keys) Reflect.deleteProperty(process.env, key)
})

afterEach(() => {
  for (const [index, key] of keys.entries()) {
    const value = previous[index]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function anthropic(userId?: string): AnthropicMessagesPayload {
  return {
    model: "gpt-fixture",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
    ...(userId === undefined ? {} : { metadata: { user_id: userId } }),
  }
}

const responses = (model = "gpt-fixture"): ResponsesPayload => ({
  model,
  input: [],
})

const jsonUserId = JSON.stringify({
  device_id: "device",
  account_uuid: "",
  session_id: SESSION,
})

test("reads both Claude Code user_id session formats", () => {
  expect(claudeCodeSessionId(jsonUserId)).toBe(SESSION)
  expect(claudeCodeSessionId(`user_abc_account__session_${SESSION}`)).toBe(
    SESSION,
  )
  expect(claudeCodeSessionId("{not json")).toBeUndefined()
  expect(claudeCodeSessionId('{"session_id":"x"}')).toBeUndefined()
  expect(claudeCodeSessionId("plain-user")).toBeUndefined()
  expect(claudeCodeSessionId(undefined)).toBeUndefined()
})

test("is on by default and disabled by 0/false/off", () => {
  expect(
    withBridgeCacheKey(responses(), anthropic(jsonUserId)).prompt_cache_key,
  ).toMatch(/^cc-v1:/)
  for (const off of ["0", "false", "OFF"]) {
    process.env.COPILOT_BRIDGE_CACHE_KEY = off
    expect(withBridgeCacheKey(responses(), anthropic(jsonUserId))).toEqual(
      responses(),
    )
  }
})

test("derives a stable per-session, per-model digest without raw ids", () => {
  process.env.COPILOT_BRIDGE_CACHE_KEY = "1"
  const first = withBridgeCacheKey(responses(), anthropic(jsonUserId))
  const again = withBridgeCacheKey(
    responses(),
    anthropic(`user_x_account__session_${SESSION}`),
  )
  const otherModel = withBridgeCacheKey(
    responses("gpt-other"),
    anthropic(jsonUserId),
  )
  expect(first.prompt_cache_key).toMatch(/^cc-v1:[\da-f]{48}$/)
  expect(again.prompt_cache_key).toBe(first.prompt_cache_key)
  expect(otherModel.prompt_cache_key).not.toBe(first.prompt_cache_key)
  expect(first.prompt_cache_key).not.toContain(SESSION.slice(0, 8))

  process.env.COPILOT_CACHE_NAMESPACE = "team-a"
  expect(
    withBridgeCacheKey(responses(), anthropic(jsonUserId)).prompt_cache_key,
  ).not.toBe(first.prompt_cache_key)
})

test("sends no key without a session and keeps a client key", () => {
  process.env.COPILOT_BRIDGE_CACHE_KEY = "true"
  expect(withBridgeCacheKey(responses(), anthropic())).toEqual(responses())
  const client = { ...responses(), prompt_cache_key: "client-key" }
  expect(
    withBridgeCacheKey(client, anthropic(jsonUserId)).prompt_cache_key,
  ).toBe("client-key")
})
