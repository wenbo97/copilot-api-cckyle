import { cacheFingerprint } from "~/lib/cache-fingerprint"

type JsonRecord = Record<string, unknown>
export type CacheRequestRole =
  | "main"
  | "subagent"
  | "memory"
  | "compaction"
  | "prewarm"
  | "unknown"

export interface CacheDiagnosticIdentity {
  thread: string | null
  role: CacheRequestRole
  conflict: boolean
  metadata_incomplete: boolean
  parent_thread: string | null
  forked_from_thread: string | null
  compaction: boolean
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as JsonRecord)
    : {}
}

function identifier(value: unknown): string | undefined {
  return (
      typeof value === "string"
        && value.length > 0
        && value.length <= 256
        && !Array.from(value).some(
          (character) =>
            (character.codePointAt(0) ?? 0) < 32
            || character.codePointAt(0) === 127,
        )
    ) ?
      value
    : undefined
}

/** Read only documented transport projections; session-id/key are not threads. */
function readMetadata(values: Array<unknown>) {
  const metadata: Array<JsonRecord> = []
  let incomplete = false
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value !== "string" || Buffer.byteLength(value) > 32_768) {
      incomplete = true
      continue
    }
    try {
      const parsed: unknown = JSON.parse(value)
      const item = record(parsed)
      if (Object.keys(item).length === 0 || invalidMetadata(item))
        incomplete = true
      metadata.push(item)
    } catch {
      incomplete = true
    }
  }
  return { metadata, incomplete }
}

function invalidMetadata(item: JsonRecord) {
  const fields = [
    "thread_id",
    "parent_thread_id",
    "forked_from_thread_id",
    "subagent_kind",
  ]
  return (
    fields.some(
      (field) =>
        item[field] !== undefined
        && item[field] !== null
        && identifier(item[field]) === undefined,
    )
    || (item.request_kind !== undefined
      && (typeof item.request_kind !== "string"
        || !["compaction", "memory", "prewarm", "turn"].includes(
          item.request_kind,
        )))
  )
}

function identifiers(values: Array<unknown>) {
  return new Set(
    values
      .map((value) => identifier(value))
      .filter((value) => value !== undefined),
  )
}

function declaredRole(
  kinds: Set<string>,
  subagent: boolean,
  memory: boolean,
): CacheRequestRole {
  if (memory || kinds.has("memory")) return "memory"
  if (kinds.has("compaction")) return "compaction"
  if (kinds.has("prewarm")) return "prewarm"
  if (subagent) return "subagent"
  if (kinds.has("turn")) return "main"
  return "unknown"
}

export function cacheDiagnosticIdentity(
  payload: unknown,
  headers?: Headers,
): CacheDiagnosticIdentity {
  const { metadata, incomplete } = readMetadata([
    record(record(payload).client_metadata)["x-codex-turn-metadata"],
    headers?.get("x-codex-turn-metadata"),
  ])
  const threads = identifiers([
    headers?.get("thread-id"),
    ...metadata.map((value) => value.thread_id),
  ])
  const parents = identifiers([
    headers?.get("x-codex-parent-thread-id"),
    ...metadata.map((value) => value.parent_thread_id),
  ])
  const forks = identifiers(
    metadata.map((value) => value.forked_from_thread_id),
  )
  const kinds = new Set(
    metadata
      .map((value) => value.request_kind)
      .filter((value): value is string => typeof value === "string"),
  )
  const memory = headers?.get("x-openai-memgen-request") === "true"
  const conflict =
    threads.size > 1
    || parents.size > 1
    || forks.size > 1
    || kinds.size > 1
    || (memory && kinds.size > 0 && !kinds.has("memory"))
  const subagent =
    Boolean(headers?.get("x-openai-subagent"))
    || parents.size > 0
    || metadata.some((value) => identifier(value.subagent_kind))
  const unavailable = conflict || incomplete
  const role = unavailable ? "unknown" : declaredRole(kinds, subagent, memory)
  return {
    ...identityFingerprints(
      {
        thread: [...threads][0],
        parent_thread: [...parents][0],
        forked_from_thread: [...forks][0],
      },
      unavailable,
    ),
    role,
    conflict,
    metadata_incomplete: incomplete,
    compaction: role === "compaction",
  }
}

function identityFingerprints(
  fields: Record<
    "thread" | "parent_thread" | "forked_from_thread",
    string | undefined
  >,
  unavailable: boolean,
) {
  return {
    thread: unavailable ? null : cacheFingerprint(fields.thread),
    parent_thread: unavailable ? null : cacheFingerprint(fields.parent_thread),
    forked_from_thread:
      unavailable ? null : cacheFingerprint(fields.forked_from_thread),
  }
}

interface HistoryItem {
  digest: string | null
  blocks: Array<string | null>
}
export interface CacheHistorySnapshot {
  form: "array" | "string" | "other"
  items: Array<HistoryItem>
  truncated: boolean
  settings: Record<string, string | null>
}

/** Retain digests only, bounded across items AND blocks, preserving wire order. */
export function cacheHistorySnapshot(payload: unknown): CacheHistorySnapshot {
  const body = record(payload)
  const input: unknown = body.input
  const source: Array<unknown> = historyInput(input)
  let budget = 2048
  const items: Array<HistoryItem> = []
  let truncated = false
  for (const item of source) {
    if (budget-- <= 0) {
      truncated = true
      break
    }
    const blocks: Array<string | null> = []
    for (const field of ["content", "output"]) {
      const parts: unknown = record(item)[field]
      if (!Array.isArray(parts)) continue
      const typedParts: Array<unknown> = parts
      for (const part of typedParts) {
        if (budget-- <= 0) {
          truncated = true
          break
        }
        blocks.push(cacheFingerprint({ field, part }))
      }
    }
    items.push({ digest: cacheFingerprint(item), blocks })
    if (truncated) break
  }
  return {
    form: historyForm(input),
    items,
    truncated,
    settings: Object.fromEntries(
      [
        "model",
        "instructions",
        "tools",
        "reasoning",
        "text",
        "parallel_tool_calls",
        "tool_choice",
        "service_tier",
        "prompt_cache_options",
        "prompt_cache_retention",
        "prompt_cache_key",
      ].map((field) => [field, cacheFingerprint(body[field])]),
    ),
  }
}

function historyInput(value: unknown): Array<unknown> {
  if (Array.isArray(value)) return value
  return typeof value === "string" ? [value] : []
}

function historyForm(value: unknown): CacheHistorySnapshot["form"] {
  if (Array.isArray(value)) return "array"
  return typeof value === "string" ? "string" : "other"
}

function changedBlock(
  first: HistoryItem | undefined,
  old: HistoryItem | undefined,
) {
  if (!first || !old || first.blocks.length === 0 || old.blocks.length === 0)
    return null
  let index = 0
  while (
    index < first.blocks.length
    && index < old.blocks.length
    && first.blocks[index] === old.blocks[index]
  )
    index++
  return index < Math.max(first.blocks.length, old.blocks.length) ? index : null
}

export function compareCacheHistory(
  previous: CacheHistorySnapshot | undefined,
  current: CacheHistorySnapshot,
) {
  if (!previous) return { status: "no_baseline", relation: "unknown" }
  let matched = 0
  while (
    matched < previous.items.length
    && matched < current.items.length
    && previous.items[matched].digest === current.items[matched].digest
  )
    matched++
  const block = changedBlock(
    current.items.at(matched),
    previous.items.at(matched),
  )
  let relation = "modified"
  if (previous.form !== current.form) relation = "representation_changed"
  else if (matched === previous.items.length)
    relation = current.items.length === matched ? "unchanged" : "appended"
  else if (matched === current.items.length) relation = "shortened"
  const truncated = previous.truncated || current.truncated
  return {
    status: truncated ? "truncated" : "compared",
    relation: truncated ? "unknown" : relation,
    matched_items: matched,
    first_changed_item: relation === "unchanged" ? null : matched,
    first_changed_block: block,
    changed_settings: Object.keys(current.settings).filter(
      (field) => previous.settings[field] !== current.settings[field],
    ),
  }
}

interface Baseline {
  sequence: number
  ingress: CacheHistorySnapshot
  egress: CacheHistorySnapshot
}
interface Chain {
  sequence: number
  active: number
  overlap: number
  touched: number
  baseline?: Baseline
}

/** Small process-local observer; it never routes or mutates inference requests. */
export class CacheHistoryTracker {
  private readonly chains = new Map<string, Chain>()
  private evicted = 0
  private expired = 0

  begin(identity: CacheDiagnosticIdentity, scope: string, now = Date.now()) {
    this.expire(now)
    const key = identity.thread ? `${scope}:${identity.thread}` : undefined
    const chain = key ? this.acquire(key, now) : undefined
    const captured = chain
    const sequence = captured?.sequence ?? 0
    const overlap = captured?.overlap ?? 0
    const overlapping = (captured?.active ?? 0) > 1
    const baseline = captured?.baseline
    let finished = false
    return {
      compare: (
        ingress: CacheHistorySnapshot,
        egress?: CacheHistorySnapshot,
      ) => ({
        ingress: compareCacheHistory(baseline?.ingress, ingress),
        egress:
          egress ?
            compareCacheHistory(baseline?.egress, egress)
          : { status: "unavailable", relation: "unknown" },
        overlapping: overlapping || (captured?.overlap ?? 0) > overlap,
        state_evicted: Boolean(key && this.chains.get(key) !== captured),
      }),
      finish: (
        ingress: CacheHistorySnapshot,
        egress: CacheHistorySnapshot | undefined,
        completed: boolean,
      ) => {
        if (finished) return
        finished = true
        if (!captured) return
        captured.active--
        if (
          key
          && this.chains.get(key) === captured
          && completed
          && egress
          && sequence > (captured.baseline?.sequence ?? 0)
        )
          captured.baseline = { sequence, ingress, egress }
      },
    }
  }

  private expire(now: number) {
    for (const [key, chain] of this.chains)
      if (now - chain.touched >= 30 * 60_000) {
        this.chains.delete(key)
        this.expired++
      }
  }

  private acquire(key: string, now: number) {
    let chain = this.chains.get(key)
    if (!chain) chain = { sequence: 0, active: 0, overlap: 0, touched: now }
    this.chains.delete(key)
    this.chains.set(key, chain)
    if (this.chains.size > 128) {
      const oldest = this.chains.keys().next().value
      if (oldest !== undefined) this.chains.delete(oldest)
      this.evicted++
    }
    chain.touched = now
    chain.sequence++
    if (chain.active > 0) chain.overlap++
    chain.active++
    return chain
  }

  statistics() {
    return {
      chains: this.chains.size,
      evicted: this.evicted,
      expired: this.expired,
    }
  }
}
