import { describe, test, expect } from "bun:test"

import { StreamItemIdNormalizer } from "../src/routes/_shared/stream-item-id"

describe("StreamItemIdNormalizer (litellm port)", () => {
  test.each(["completed", "incomplete", "failed"])(
    "immutably normalizes %s snapshots with first anchors",
    (status) => {
      const n = new StreamItemIdNormalizer()
      n.normalize({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "first" },
      })
      const repeated = n.normalize({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "second" },
      })
      expect(repeated.item.id).toBe("first")
      const event = {
        type: `response.${status}`,
        response: {
          id: "response_untouched",
          output: [
            {
              id: "drift",
              call_id: "call_untouched",
              encrypted_content: "opaque",
              arguments: '{"id":"untouched"}',
            },
            { id: "unanchored" },
          ],
        },
      }
      const fixed = n.normalize(event)
      expect(fixed.response.output).toEqual([
        { ...event.response.output[0], id: "first" },
        event.response.output[1],
      ])
      expect(event.response.output[0].id).toBe("drift")
      expect(fixed.response).not.toBe(event.response)
      expect(fixed.response.output[1]).toBe(event.response.output[1])
      expect(fixed.response.id).toBe("response_untouched")
    },
  )

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid index %s",
    (index) => {
      const n = new StreamItemIdNormalizer()
      n.normalize({
        type: "response.output_item.added",
        output_index: index,
        item: { id: "anchor" },
      })
      const event = {
        type: "response.output_item.done",
        output_index: index,
        item: { id: "untouched" },
      }
      expect(n.normalize(event)).toBe(event)
    },
  )

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
