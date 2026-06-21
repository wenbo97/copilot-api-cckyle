// =============================================================================
// Responses stream item-id stabilizer (port of litellm _normalize_stream_item_id).
//
// GitHub Copilot's /responses backend tags each SSE event of ONE logical output
// item with a DIFFERENT `item_id` (and a different `item.id` on the closing
// `output_item.done`). Strict clients — notably the Vercel AI SDK — index parts
// by id and throw "reasoning/text part <id> not found" when a later delta or the
// terminal done event arrives under an unrecognised id, aborting the stream.
//
// Fix: anchor ONE stable id per `output_index`, taken from the
// `response.output_item.added` event (always emitted first for an item), and
// rewrite the id carried by every subsequent event for that index to the anchor.
//
// One instance is stream-scoped (its anchor map lives for the life of a single
// stream); construct a fresh normalizer per stream.
// =============================================================================

// Events are unvalidated wire JSON, so we treat them as loose records and probe
// the few fields we touch.
type StreamEvent = Record<string, unknown> & {
  type?: string
  output_index?: number
  item_id?: unknown
  item?: unknown
}

export class StreamItemIdNormalizer {
  // output_index -> the stable anchor id seeded from output_item.added.
  private readonly anchors = new Map<number, string>()

  /**
   * Returns the event with its item id rewritten to the per-index anchor when
   * one is known. The `output_item.added` event seeds the anchor and is returned
   * unchanged. Events without an integer `output_index`, or for an index whose
   * anchor hasn't been seen yet, pass through untouched. Never mutates the input.
   */
  normalize<T extends StreamEvent>(event: T): T {
    const outputIndex = event.output_index
    if (typeof outputIndex !== "number") return event

    // The added event carries the canonical id — record it, forward as-is.
    if (event.type === "response.output_item.added") {
      const id = (event.item as { id?: unknown } | undefined)?.id
      if (typeof id === "string") this.anchors.set(outputIndex, id)
      return event
    }

    const stable = this.anchors.get(outputIndex)
    if (stable === undefined) return event

    // Most events carry a top-level `item_id`.
    if (typeof event.item_id === "string") {
      return { ...event, item_id: stable }
    }

    // `output_item.done` instead nests the id under `item.id`.
    if (
      event.type === "response.output_item.done"
      && event.item
      && typeof event.item === "object"
    ) {
      return { ...event, item: { ...event.item, id: stable } }
    }

    return event
  }
}
