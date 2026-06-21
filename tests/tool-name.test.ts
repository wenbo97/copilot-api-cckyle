import { describe, test, expect } from "bun:test"
import { createHash } from "node:crypto"

import { truncateToolName } from "../src/routes/_shared/tool-name"

describe("truncateToolName (litellm port)", () => {
  test("<=64 chars unchanged", () => {
    expect(truncateToolName("short")).toBe("short")
  })

  test("exactly 64 chars unchanged", () => {
    const name = "a".repeat(64)
    expect(truncateToolName(name)).toBe(name)
  })

  test(">64 chars -> 55-prefix + _ + 8-hash, length exactly 64", () => {
    const long = "a".repeat(80)
    const out = truncateToolName(long)
    expect(out.length).toBe(64)
    expect(out.startsWith("a".repeat(55) + "_")).toBe(true)
  })

  test("deterministic for the same input", () => {
    const long = "b".repeat(100)
    expect(truncateToolName(long)).toBe(truncateToolName(long))
  })

  test("hash matches sha256(name)[:8] (matches litellm)", () => {
    const long =
      "compute_the_meaning_of_life_the_universe_and_everything_in_one_call_please"
    const expectedHash = createHash("sha256")
      .update(long)
      .digest("hex")
      .slice(0, 8)
    expect(truncateToolName(long)).toBe(`${long.slice(0, 55)}_${expectedHash}`)
  })

  test("two long names sharing a 55-char prefix do NOT collide", () => {
    const a = "x".repeat(55) + "_alpha_aaaaaaaaaa"
    const b = "x".repeat(55) + "_beta_bbbbbbbbbbb"
    expect(truncateToolName(a)).not.toBe(truncateToolName(b))
  })
})
