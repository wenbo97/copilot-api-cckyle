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
   * one is known, including terminal snapshots. The first added event wins;
   * unknown or invalid indices pass through untouched. Never mutates the input.
   */
  normalize<T extends StreamEvent>(event: T): T {
    if (
      event.type === "response.completed"
      || event.type === "response.incomplete"
      || event.type === "response.failed"
    )
      return this.normalizeSnapshot(event)
    const outputIndex = event.output_index
    if (!validOutputIndex(outputIndex)) return event

    if (event.type === "response.output_item.added") {
      const id = isRecord(event.item) ? event.item.id : undefined
      if (!this.anchors.has(outputIndex) && typeof id === "string")
        this.anchors.set(outputIndex, id)
    }

    const stable = this.anchors.get(outputIndex)
    if (stable === undefined) return event

    // Most events carry a top-level `item_id`.
    if (typeof event.item_id === "string") {
      return { ...event, item_id: stable }
    }

    // `output_item.done` instead nests the id under `item.id`.
    if (
      (event.type === "response.output_item.done"
        || event.type === "response.output_item.added")
      && isRecord(event.item)
      && event.item.id !== stable
    ) {
      return { ...event, item: { ...event.item, id: stable } }
    }

    return event
  }

  private normalizeSnapshot<T extends StreamEvent>(event: T): T {
    const response = event.response
    if (!isRecord(response) || !Array.isArray(response.output)) return event
    return {
      ...event,
      response: {
        ...response,
        output: response.output.map((item: unknown, index: number) => {
          const stable = this.anchors.get(index)
          return stable !== undefined && isRecord(item) ?
              { ...item, id: stable }
            : item
        }),
      },
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validOutputIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
