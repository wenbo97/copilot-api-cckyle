# Passive long-session cache diagnostics

Enable `COPILOT_CACHE_DIAGNOSTICS=1` to observe native Responses and Messages-to-Responses traffic. This adds no inference requests, routing affinity, cache markers, TTL changes, or comparison parameters. Cache policy remains separately controlled. JSON/SSE data and compatibility retries retain their existing behavior.

## What the additive schema-v2 fields mean

- `process_scope` identifies the observer process; `observed_at` is an ISO timestamp usable when a log reporter supplies no timestamp.
- `identity` contains only keyed identity digests and bounded classifications. Codex `thread-id` and `client_metadata["x-codex-turn-metadata"]`/its compatibility header provide declared identity and request-kind information. `session-id`, prompt cache keys and content similarity never supply thread identity. Conflicting declarations disable correlation; malformed/oversized metadata keeps roles unknown. These declarations are observations, not authentication boundaries.
- `correlation_scope` separates account type, configured history endpoint/namespace and ingress protocol. `thread_fingerprint` is meaningful only together with this scope and `process_scope`. Metadata may declare memory, compaction, prewarm, subagent or normal turn; absent evidence remains unknown.
- `history_comparison` compares ordered ingress and actual egress digests against the prior successful request in that declared chain. It reports matching items, the first changed item/block, representation changes and changed settings. A changed history is not automatically compaction, and identical structure does not establish a provider cache hit. Block indices are flattened across an item's content/output arrays.
- Each `attempt_details` entry has its own `history_comparison`, `cache_hint_processing`, observed `service_tier` and allowlisted `prompt_cache_diagnostics`. Hint processing lists ingress/egress locations, restricted mode/TTL enums, keyed digests and preserved/changed/removed/added actions. Cross-protocol locations do not establish equivalent semantics. The existing `cache_policy` records whether the proxy injected a key/breakpoint; `cache_intent` retains its earlier contract.
- `returned_service_tier` and top-level provider diagnostics describe the logical final response. Provider comparisons are included only when naturally returned; unknown diagnostic reasons/counts are omitted or null. Diagnostic estimates are not billing counters.

The observer retains fingerprints, never prompt text, raw cache keys, IDs, tool arguments or reasoning ciphertext. It keeps at most 128 chains and 2048 item/block units per snapshot; idle entries expire after 30 minutes. This is a local memory lifetime, not a provider TTL. `history_state` exposes eviction/expiry totals. Truncation, absent baselines and eviction do not certify full prefix equality. Restart creates a new HMAC key and scope.

Concurrent requests are marked overlapping. Only completed, non-cancelled requests with an observed final attempt advance the baseline; an older request completing later cannot regress it. Retries compare each actual body independently. Fork metadata is recorded, but a new thread starts its own baseline rather than inheriting an assumed parent cache.

## Offline analysis

```powershell
bun run usage:summary tmps/cache-session.log --history
bun run usage:summary tmps/cache-session.log --history --json
bun run usage:summary tmps/cache-session.log --history --since "2026-10-03T00:00:00+08:00" --until "2026-10-04T00:00:00+08:00"
```

The original overall/model/ingress summaries retain their counter semantics. `--history` additionally groups by model, ingress, role and scoped process/thread, reports latency medians and lists up to 20 largest **unread input** contributors with structural evidence. The largest list includes only paired valid input/read observations; missing counters remain unknown.

`unread = input - read` includes legitimate new context. It is not a count of preventable misses. `ordinary = input - read - write` is available only when all counters are known and form a valid partition. Reasoning is a detail of output, and read/write are input categories: never add them again. Final-response and attempt observations remain separate views. Nano-AIU is provider metering, not independently audited account debit.

Identical request-ID payload replays retain their first association, including time-window membership. Conflicting payloads stop analysis without echoing raw contents. UTF-8/UTF-16LE and old logs remain readable; missing historical identities/roles cannot be reconstructed. Raw logs and private analysis output remain ignored.

## Open-source comparison (read on 2026-10-03)

These fixed OSS snapshots describe inspected paths, not all hosted products or account capabilities. Response/semantic caches replay full outputs and are distinct from provider KV prompt caches.

| Project / snapshot | Observed design | Adopted lesson |
| --- | --- | --- |
| [LiteLLM / 5724117](https://github.com/BerriAI/litellm/blob/5724117116102665495b9bad0c998fd210cdee06/litellm/integrations/anthropic_cache_control_hook.py) | Model/host gates, caller markers, attempt-level injection provenance | Observe actual hints and source; do not infer support from model names |
| [Bifrost / 0d25eca](https://github.com/maximhq/bifrost/blob/0d25eca96840aadd2333a6575da95f20cb44758e/core/providers/openai/responses.go) | Injected markers can cause explicit-only mode; caller options win | Observe mode together with boundaries; preserve our existing implicit policy |
| [Portkey OSS / 669825c](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts) | Inspected Chat adapter rewrites markers and has protocol-specific usage accounting | Verify final TTL/payload and counter semantics rather than hosted documentation assumptions |
| [CLIProxyAPI / 2044a01](https://github.com/router-for-me/CLIProxyAPI/blob/2044a01f422998de79a5da8015141b878886534d/sdk/cliproxy/session/lcp.go) | Bounded canonical history/session matching | Use bounded structural comparison for observation, never as thread/auth identity |

The inspected [Portkey Responses whitelist](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/open-ai-base/createModelResponse.ts) does not list retention/options, unlike its generic proxy path. [CLIProxyAPI's compatibility usage helper](https://github.com/router-for-me/CLIProxyAPI/blob/2044a01f422998de79a5da8015141b878886534d/internal/runtime/executor/helps/responses_usage_helpers.go) can fill missing cached counts with zero; this observer deliberately preserves unknown. Hosted response/semantic-cache namespaces, TTLs and licensing should not be attributed to unrelated OSS modules.

Codex transport references are fixed to the tested client version [0.160.0 headers](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/requests/headers.rs) and [turn metadata](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/responses_metadata.rs). Other clients without these declarations retain unknown attribution.

## Verification and follow-up

Offline route fixtures verify byte-equivalent upstream bodies and unchanged JSON/SSE under diagnostics on/off, retries/cancellation, hint losses, thread collisions, first block differences and provider observation privacy. Tracker tests cover bounds, expiry and inverse concurrent completion; CLI tests cover unknown/zero/invalid partitions, replay conflicts, scopes and encodings.

Use the resulting evidence to select a specific boundary defect for a later opt-in experiment. This stage does not expand the model allowlist, enable prewarming/keepalive, change cache keys or retention, introduce response caching, or run paid acceptance. New live experiments follow the separately reviewed authorization in LOCAL-ACCEPTANCE.md.
