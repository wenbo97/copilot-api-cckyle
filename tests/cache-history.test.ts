import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import {
  cacheDiagnosticProcessScope,
  cacheFingerprint,
} from "~/lib/cache-fingerprint"
import { cacheHintObservation } from "~/lib/cache-hint-observation"
import {
  cacheDiagnosticIdentity,
  cacheHistorySnapshot,
  CacheHistoryTracker,
  compareCacheHistory,
} from "~/lib/cache-history"

const payload = {
  model: "model-a",
  input: [{ role: "developer", content: "private-rules" }],
}
function identity(thread = "private-thread") {
  return cacheDiagnosticIdentity({}, new Headers({ "thread-id": thread }))
}
function snapshot(input: unknown = payload.input) {
  return cacheHistorySnapshot({ ...payload, input })
}

test("uses thread-id rather than shared session/cache keys, and hashes identities", () => {
  const headers = new Headers({
    "session-id": "private-session",
    "thread-id": "private-thread",
  })
  const observed = cacheDiagnosticIdentity(
    { prompt_cache_key: "private-session" },
    headers,
  )
  expect(observed.thread).toBe(identity().thread)
  expect(observed.thread).not.toBe("private-thread")
  expect(
    cacheDiagnosticIdentity(
      { prompt_cache_key: "private-session" },
      new Headers({ "session-id": "private-session" }),
    ).thread,
  ).toBeNull()
  expect(JSON.stringify(observed)).not.toContain("private-")
})

test("validates metadata projections and recognizes declared roles and lifecycle", () => {
  for (const [kind, role] of [
    ["turn", "main"],
    ["memory", "memory"],
    ["compaction", "compaction"],
    ["prewarm", "prewarm"],
  ] as const) {
    const metadata = JSON.stringify({
      thread_id: "private-thread",
      request_kind: kind,
    })
    const observed = cacheDiagnosticIdentity({
      client_metadata: { "x-codex-turn-metadata": metadata },
    })
    expect(observed.role).toBe(role)
    expect(observed.thread).toBe(identity().thread)
  }
  const child = cacheDiagnosticIdentity(
    {},
    new Headers({
      "thread-id": "child",
      "x-codex-parent-thread-id": "parent",
      "x-openai-subagent": "review",
    }),
  )
  expect(child.role).toBe("subagent")
  expect(child.parent_thread).not.toBeNull()
  const conflict = cacheDiagnosticIdentity(
    {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "other",
          request_kind: "turn",
        }),
      },
    },
    new Headers({ "thread-id": "private-thread" }),
  )
  expect(conflict).toMatchObject({
    conflict: true,
    thread: null,
    role: "unknown",
  })
  expect(
    cacheDiagnosticIdentity(
      {},
      new Headers({
        "thread-id": "private-thread",
        "x-codex-turn-metadata": "{",
      }),
    ),
  ).toMatchObject({ metadata_incomplete: true, role: "unknown" })
})

test("locates block changes and keeps structural changes separate from cache usage", () => {
  const initial = snapshot([
    {
      role: "developer",
      content: [
        { type: "input_text", text: "private-stable" },
        { type: "input_text", text: "private-a" },
      ],
    },
  ])
  const changed = snapshot([
    {
      role: "developer",
      content: [
        { type: "input_text", text: "private-stable" },
        { type: "input_text", text: "private-b" },
      ],
    },
  ])
  expect(compareCacheHistory(initial, changed)).toMatchObject({
    status: "compared",
    relation: "modified",
    matched_items: 0,
    first_changed_item: 0,
    first_changed_block: 1,
  })
  expect(
    compareCacheHistory(
      snapshot(),
      snapshot([...payload.input, { role: "user", content: "private-next" }]),
    ),
  ).toMatchObject({ relation: "appended", matched_items: 1 })
  expect(
    compareCacheHistory(snapshot([...payload.input, {}]), snapshot()),
  ).toMatchObject({ relation: "shortened" })
  expect(
    compareCacheHistory(
      snapshot(),
      cacheHistorySnapshot({
        ...payload,
        tools: [{}],
        reasoning: { effort: "high" },
        service_tier: "fast",
      }),
    ),
  ).toMatchObject({ changed_settings: ["tools", "reasoning", "service_tier"] })
  expect(JSON.stringify(initial)).not.toContain("private-")
  expect(compareCacheHistory(snapshot(), snapshot("rules"))).toMatchObject({
    relation: "representation_changed",
  })
})

test("bounds both items and blocks without certifying full equality when truncated", () => {
  const long = snapshot([
    { content: Array.from({ length: 3000 }, () => ({ text: "private" })) },
  ])
  expect(long.items[0].blocks).toHaveLength(2047)
  expect(long.truncated).toBe(true)
  expect(compareCacheHistory(long, long)).toMatchObject({
    status: "truncated",
    relation: "unknown",
  })
})

test("malformed declarations and contradictory role projections do not gain confident attribution", () => {
  for (const threadId of [42, "x".repeat(257), "private\nthread"]) {
    const observed = cacheDiagnosticIdentity(
      {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: threadId,
            request_kind: "turn",
          }),
        },
      },
      new Headers({ "thread-id": "private-thread" }),
    )
    expect(observed).toMatchObject({
      metadata_incomplete: true,
      role: "unknown",
    })
  }
  const conflict = cacheDiagnosticIdentity(
    {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "private-thread",
          request_kind: "turn",
        }),
      },
    },
    new Headers({
      "thread-id": "private-thread",
      "x-openai-memgen-request": "true",
    }),
  )
  expect(conflict).toMatchObject({
    conflict: true,
    thread: null,
    role: "unknown",
  })
})

test("hint observation never coerces malformed enum values or crosses protocol TTL contracts", () => {
  const native = cacheHintObservation(
    {
      prompt_cache_retention: ["24h"],
      prompt_cache_options: { mode: ["explicit"], ttl: ["30m"] },
      input: [
        {
          content: [
            { prompt_cache_breakpoint: { mode: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
    },
    "responses",
  )
  for (const field of native.fields)
    expect(field).toMatchObject({ mode: null, ttl: null, retention: null })
  expect(native.intent.malformed_or_unknown).toBe(true)
  const message = cacheHintObservation(
    { system: [{ cache_control: { type: "ephemeral", ttl: "30m" } }] },
    "messages",
  )
  expect(message.fields[0]).toMatchObject({ mode: "ephemeral", ttl: null })
})

test("only successful actual egress advances a baseline and inverse completion cannot regress it", () => {
  const tracker = new CacheHistoryTracker()
  const first = tracker.begin(identity(), "scope")
  first.finish(snapshot(), snapshot(), true)
  const failed = tracker.begin(identity(), "scope")
  failed.finish(snapshot([]), snapshot([]), false)
  const older = tracker.begin(identity(), "scope")
  const newer = tracker.begin(identity(), "scope")
  expect(older.compare(snapshot(), snapshot())).toMatchObject({
    overlapping: true,
  })
  expect(newer.compare(snapshot(), snapshot())).toMatchObject({
    overlapping: true,
  })
  newer.finish(snapshot([]), snapshot([]), true)
  older.finish(snapshot(), snapshot(), true)
  const next = tracker.begin(identity(), "scope")
  expect(next.compare(snapshot([]), snapshot([]))).toMatchObject({
    ingress: { relation: "unchanged" },
    egress: { relation: "unchanged" },
  })
  next.finish(snapshot([]), snapshot([]), false)
  expect(
    tracker.begin(identity(), "other-scope").compare(snapshot()),
  ).toMatchObject({ ingress: { status: "no_baseline" } })
})

test("evicts at the chain limit, expires idle state, and never merges forks or unknown identities", () => {
  const tracker = new CacheHistoryTracker()
  const first = tracker.begin(identity("root"), "scope", 0)
  first.finish(snapshot(), snapshot(), true)
  expect(
    tracker.begin(identity("fork"), "scope", 1).compare(snapshot()),
  ).toMatchObject({ ingress: { status: "no_baseline" } })
  for (let index = 0; index < 130; index++) {
    const ticket = tracker.begin(
      identity(`thread-${index}`),
      "scope",
      index + 2,
    )
    ticket.finish(snapshot(), snapshot(), true)
  }
  expect(tracker.statistics().chains).toBe(128)
  expect(first.compare(snapshot())).toMatchObject({ state_evicted: true })
  const expired = tracker.begin(
    identity("thread-129"),
    "scope",
    30 * 60_000 + 500,
  )
  expect(expired.compare(snapshot())).toMatchObject({
    ingress: { status: "no_baseline" },
  })
  expect(tracker.statistics().expired).toBe(128)
  const unknown = tracker.begin(cacheDiagnosticIdentity({}), "scope")
  unknown.finish(snapshot(), snapshot(), true)
  expect(unknown.compare(snapshot())).toMatchObject({
    ingress: { status: "no_baseline" },
  })
})

test("a process restart cannot reuse diagnostic fingerprints or history state", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'import {cacheDiagnosticProcessScope,cacheFingerprint} from "./src/lib/cache-fingerprint.ts"; console.log(JSON.stringify({scope:cacheDiagnosticProcessScope,digest:cacheFingerprint("synthetic-restart-prefix")}))',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const text = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const observed = JSON.parse(text) as { scope: string; digest: string }
  expect(observed.scope).not.toBe(cacheDiagnosticProcessScope)
  expect(observed.digest).not.toBe(cacheFingerprint("synthetic-restart-prefix"))
  expect(
    new CacheHistoryTracker().begin(identity(), "scope").compare(snapshot()),
  ).toMatchObject({ ingress: { status: "no_baseline" } })
})
