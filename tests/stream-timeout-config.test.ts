import { afterEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import {
  readCopilotHeaderTimeoutMs,
  readCopilotStreamTimeouts,
} from "../src/services/copilot/stream-lifecycle"

const names = [
  "COPILOT_HEADER_TIMEOUT_MS",
  "COPILOT_FIRST_EVENT_TIMEOUT_MS",
  "COPILOT_STREAM_IDLE_TIMEOUT_MS",
  "COPILOT_TOTAL_TIMEOUT_MS",
] as const
const original = names.map((name) => process.env[name])

afterEach(() => {
  for (const [index, name] of names.entries()) {
    if (original[index] === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = original[index]
  }
})

test("blank timeout configuration uses bounded phase defaults and unlimited total", () => {
  for (const name of names) process.env[name] = " "
  expect(readCopilotHeaderTimeoutMs()).toBe(60_000)
  expect(readCopilotStreamTimeouts()).toEqual({
    firstEventMs: 300_000,
    idleMs: 300_000,
    totalMs: undefined,
  })
})

test("zero disables each deadline and positive integers override it", () => {
  for (const name of names) process.env[name] = "0"
  expect(readCopilotHeaderTimeoutMs()).toBeUndefined()
  expect(readCopilotStreamTimeouts()).toEqual({
    firstEventMs: undefined,
    idleMs: undefined,
    totalMs: undefined,
  })
  for (const name of names) process.env[name] = " 1250 "
  expect(readCopilotHeaderTimeoutMs()).toBe(1250)
  expect(readCopilotStreamTimeouts()).toEqual({
    firstEventMs: 1250,
    idleMs: 1250,
    totalMs: 1250,
  })
})

test("invalid configuration warns and falls back without accepting numeric prefixes", () => {
  const warn = spyOn(consola, "warn").mockImplementation(
    Object.assign(() => {}, { raw: () => {} }),
  )
  try {
    for (const invalid of [
      "12ms",
      "1.5",
      "-1",
      "Infinity",
      "NaN",
      "1e3",
      "2147483648",
      "9007199254740992",
    ]) {
      for (const name of names) process.env[name] = invalid
      expect(readCopilotHeaderTimeoutMs()).toBe(60_000)
      expect(readCopilotStreamTimeouts()).toEqual({
        firstEventMs: 300_000,
        idleMs: 300_000,
        totalMs: undefined,
      })
    }
    expect(warn).toHaveBeenCalledTimes(32)
  } finally {
    warn.mockRestore()
  }
})
