import { describe, test, expect } from "bun:test"

import { StreamItemIdNormalizer } from "../src/routes/_shared/stream-item-id"

describe("StreamItemIdNormalizer (litellm port)", () => {
  test("rewrites per-event item_id to the anchor id from output_item.added", () => {
    const n = new StreamItemIdNormalizer()
    n.normalize({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "anchor", type: "message" },
    })
    const ev = n.normalize({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "drifting",
      delta: "x",
    })
    expect((ev as { item_id?: string }).item_id).toBe("anchor")
  })

  test("output_item.done item.id rewritten to anchor", () => {
    const n = new StreamItemIdNormalizer()
    n.normalize({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "A", type: "reasoning" },
    })
    const ev = n.normalize({
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "B" },
    })
    expect((ev as { item?: { id?: string } }).item?.id).toBe("A")
  })

  test("output_item.added passes through unchanged (its id IS the anchor)", () => {
    const n = new StreamItemIdNormalizer()
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "anchor", type: "message" },
    }
    expect(n.normalize(added)).toBe(added)
  })

  test("event with no output_index passes through untouched", () => {
    const n = new StreamItemIdNormalizer()
    const ev = { type: "response.created", response: { id: "r" } }
    expect(n.normalize(ev)).toBe(ev)
  })

  test("no anchor seen for this index yet -> untouched", () => {
    const n = new StreamItemIdNormalizer()
    const ev = {
      type: "response.output_text.delta",
      output_index: 3,
      item_id: "drifting",
      delta: "y",
    }
    const out = n.normalize(ev)
    expect((out as { item_id?: string }).item_id).toBe("drifting")
  })

  test("distinct output_index values are anchored independently", () => {
    const n = new StreamItemIdNormalizer()
    n.normalize({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "anchor0", type: "message" },
    })
    n.normalize({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "anchor1", type: "reasoning" },
    })
    const ev0 = n.normalize({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "drift0",
      delta: "a",
    })
    const ev1 = n.normalize({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "drift1",
      delta: "b",
    })
    expect((ev0 as { item_id?: string }).item_id).toBe("anchor0")
    expect((ev1 as { item_id?: string }).item_id).toBe("anchor1")
  })

  test("does not mutate the original event when rewriting item_id", () => {
    const n = new StreamItemIdNormalizer()
    n.normalize({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "anchor", type: "message" },
    })
    const original = {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "drifting",
      delta: "x",
    }
    const out = n.normalize(original)
    expect(original.item_id).toBe("drifting") // original untouched
    expect((out as { item_id?: string }).item_id).toBe("anchor")
  })
})
