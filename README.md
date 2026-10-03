# Copilot API (fork)

> Fork of [**ericc-ch/copilot-api**](https://github.com/ericc-ch/copilot-api) — a reverse-engineered proxy that exposes GitHub Copilot as an OpenAI- and Anthropic-compatible API, usable as a backend for [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

> [!WARNING]
> Reverse-engineered and unsupported by GitHub. Excessive automated/bulk requests may trigger GitHub's abuse detection and get your Copilot access suspended. Use responsibly. See [GitHub Acceptable Use](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies) and the [Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot).

## What this fork adds

- **VS Code token bridge / proxy-only auth** — obtain the Copilot token from a running VS Code instead of the GitHub device-code flow. Lets the proxy run with no `GH_TOKEN` (see [Token sources](#token-sources)).
- **Model mappings** — `MODEL_MAPPINGS` env var rewrites incoming model IDs (e.g. the `claude-*` IDs Claude Code sends) to the internal Copilot model names. This is what makes Claude Code work against Copilot.
- **`/v1/responses` endpoint** — OpenAI Responses API support, in addition to the upstream chat/messages/embeddings routes.
- **Hardened token refresh** — centralized 401 handling, retry with backoff, and survives long-running sessions.
- **Enterprise account type by default** — `bun run dev` / `bun run auth` pass `--account-type enterprise`.
- **Windows `.cmd` helpers + Claude Code `settings.json`** for a one-double-click workflow (see below).

## Prerequisites

- [Bun](https://bun.com/docs/installation#windows) (>= 1.2.x)
- A GitHub account with a Copilot subscription, **or** a running VS Code signed in to Copilot (for the token bridge)

```sh
bun install
```

## Quick start (Windows)

The repo ships `.cmd` launchers. Set them up once as Windows Terminal profiles (Settings → Add a new profile → New empty profile → paste the script path into *Command line*), or just double-click them.

| Script | What it does |
| ------ | ------------ |
| `start-copilot-api.cmd` | Starts the proxy server (`npm run dev`) on `http://localhost:4141`. |
| `start-claude.cmd` | Launches Claude Code pointed at the proxy (working dir `c:\src\controlplane`). |
| `start-cc-copilot-api.cmd` | Launches Claude Code in *this* repo's dir (handy for working on the proxy itself). |
| `re-auth.cmd` | Re-runs the GitHub auth flow (`npm run auth`) when the token expires. |

Typical flow: run `start-copilot-api.cmd`, then `start-claude.cmd`.

The model IDs and effort level Claude Code uses are set as `set ANTHROPIC_*` lines at the top of `start-claude.cmd` / `start-cc-copilot-api.cmd` — edit those to change models.

## Running without the scripts

```sh
bun run dev     # watch mode (account-type enterprise)
bun run start   # production
bun run auth    # GitHub auth only
```

See the [upstream README](https://github.com/ericc-ch/copilot-api#readme) for npx and the full CLI option tables. Docker/network publishing instructions do **not** apply to this fork's default server boundary.

### Local-only server boundary

The server binds explicitly to `127.0.0.1`. It is intentionally unavailable to other machines, Docker port publishing, and reverse proxies. The `/token` management endpoint additionally rejects browser requests carrying an `Origin` header, accepts only a loopback `Host`, disables caching with `Cache-Control: no-store`, and does not opt into CORS.

If remote or container access is required later, add a separate authenticated management boundary instead of exposing `/token` through the public API listener.

## Responses history compatibility

Native Responses requests retain encrypted reasoning by default. If an upstream
explicitly rejects history with `input item does not belong to this connection`,
the proxy can retry once before forwarding any Responses event. That retry removes
only reasoning ciphertext that this proxy has not recorded as issued by that
upstream. Messages, summaries, and tool call/result pairs remain intact. Ordinary
authentication errors, rate limits, network failures, and failures after streaming
has started do not trigger history cleanup.

The proxy records SHA-256 receipts, not ciphertext, under
`~/.local/share/copilot-api/responses-history/<upstream-hash>/`. Atomic immutable
receipts survive restarts and allow concurrent writers. Keep this directory with
the proxy's state and do not share it between different accounts. A corrupt or
unwritable registry disables automatic cleanup while allowing otherwise healthy
requests. The first recovery may discard previously valid but unregistered opaque
reasoning; visible conversation history is preserved. Upstream 401 envelopes in
SSE are decoded so failures retain their real cause instead of appearing only as a
closed stream.

Codex fork/resume acceptance against the configured HTTPS or loopback provider:

```powershell
bun run tests/acceptance/resume-remote.ts `
  --base-url https://g5x5mg68-8314.usw3.devtunnels.ms/v1 `
  --source-session 01a0c20f-c841-7871-a351-3b3fce86bcc5
```

This does not start or stop the provider. It creates a test fork and performs three independent `resume` turns with
`gpt-6-astra`, reasoning `high`, and summaries `concise`. Only diagnostic messages
are sent. The original session and user configuration are not edited. A successful
remote run does not prove a local source change is deployed. See
[the implementation and acceptance record](tests/acceptance/RESUME-COMPATIBILITY.md)
for the observed source/deployment boundary.

From Windows Command Prompt, fork the known session through the local `4141`
service with this single command:

```cmd
set "OPENAI_API_KEY=dummy" && codex -c model_provider="copilotproxyry" -c model_providers.copilotproxyry.base_url="http://127.0.0.1:4141/v1" -c model_reasoning_effort="high" -c model_reasoning_summary="concise" -m gpt-6-astra fork 01a0c1e4-94b7-7382-8ac5-dfd04eeb3c89
```

Resume the resulting fork with the same provider and base URL. Replace
`<FORK_SESSION_ID>` with the session ID printed by the fork command:

```cmd
set "OPENAI_API_KEY=dummy" && codex -c model_provider="copilotproxyry" -c model_providers.copilotproxyry.base_url="http://127.0.0.1:4141/v1" -c model_reasoning_effort="high" -c model_reasoning_summary="concise" -m gpt-6-astra resume <FORK_SESSION_ID>
```

## Token sources

The proxy resolves a Copilot token in this order:

1. **VS Code token bridge** — startup first tries the extension at `http://127.0.0.1:<VSCODE_PROXY_PORT>/token`. A successful exchange skips GitHub authentication, including when a GitHub token was supplied.
2. **GitHub token** (`GH_TOKEN` / `--github-token`, stored credentials, or the interactive device-code flow) — used if the bridge is unavailable, then exchanged for an automatically refreshed Copilot token. A failed GitHub exchange can also fall back to the bridge.

### Setting up the VS Code token bridge

> Source: [**wenbo97/copilot-token-bridge**](https://github.com/wenbo97/copilot-token-bridge) — the extension is open source; the bundled `.vsix` below is a prebuilt copy.

1. Install the bundled extension: `copilot-token-bridge-0.3.1.vsix`
   ```sh
   code --install-extension copilot-token-bridge-0.3.1.vsix
   ```
2. Reload VS Code and make sure it is signed in to GitHub Copilot.
3. Click the `Copilot Token :18774` status bar item and select **Start server**, or run **Copilot Token Bridge: Start Server** from the command palette. Version 0.3.1 keeps the HTTP server stopped until you start it manually. Leave VS Code running while using the bridge.
4. (Optional) If the extension uses a non-default port, set `VSCODE_PROXY_PORT` in `.env` (default `18774`).

With the bridge available the proxy can run with **no GitHub token at all** — useful when the device-code flow is blocked.

## Configuration (`.env`)

Copy `.env.example` to `.env`. Fork-relevant keys:

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `MODEL_MAPPINGS` | Rewrite model IDs, `source:target` comma-separated (e.g. `claude-opus-4-8:claude-opus-4.8`). | none |
| `VSCODE_PROXY_PORT` | Port of the Copilot Token Bridge VS Code extension. | `18774` |
| `IDLE_TIMEOUT` | Bun server idle timeout (seconds). | `255` |
| `COPILOT_HEADER_TIMEOUT_MS` | Responses request deadline for receiving upstream headers; `0` disables it. | `60000` |
| `COPILOT_FIRST_EVENT_TIMEOUT_MS` | Optional Responses first upstream SSE event deadline; `0` disables it. | disabled |
| `COPILOT_STREAM_IDLE_TIMEOUT_MS` | Optional Responses upstream SSE inactivity deadline; all SSE activity resets it. | disabled |
| `COPILOT_TOTAL_TIMEOUT_MS` | Optional total Responses upstream stream deadline. | disabled |
| `TRACE_OUTPUT_FOLDER` | Where request/response traces go when `--trace` is set. | `./traces` |
| `COPILOT_CACHE_DIAGNOSTICS` | Set to `1` or `true` for Responses cache summaries and separate Messages bridge usage diagnostics. | disabled |
| `COPILOT_CACHE_POLICY` | `prefix-v1` enables the experimental native Responses prefix policy; `off` disables it. | `off` |
| `COPILOT_CACHE_NAMESPACE` | Stable per-account/workspace scope used only to generate a missing cache key. | none |

`MODEL_MAPPINGS` example (maps the IDs Claude Code sends to internal Copilot model names):

```env
MODEL_MAPPINGS="claude-opus-4-8:claude-opus-4.8,claude-opus-4-7:claude-opus-4.7-1m-internal,claude-sonnet-4-6:claude-sonnet-4.6,claude-haiku-4-5:claude-haiku-4.5"
```

## Using with the VS Code Claude extension

1. Copy [`settings.json`](/settings.json) to `C:/Users/<user-name>/.claude/settings.json` (create the file if needed).
2. Restart the Claude chat (close and reopen it).

`settings.json` points `ANTHROPIC_BASE_URL` at `http://localhost:4141` and sets the model IDs — adjust to taste.

## Development

### Opt-in prefix cache policy

`prefix-v1` changes the outgoing caching configuration. It adds one explicit
`prompt_cache_breakpoint` to the final text block of the first eligible leading
developer message, and retains implicit caching for the growing history.
This allows a reusable instruction prefix to have its own cache boundary when
later user inputs differ. Top-level `instructions`, message roles, tool order,
and reasoning ciphertext are preserved. String developer content is represented
as one equivalent `input_text` block so it can carry the marker.
The cache policy does not disable reasoning or override `reasoning.effort`.
Existing model-capability normalization still applies independently of caching.

Enable it when starting the proxy, for example in PowerShell:

```powershell
$env:COPILOT_CACHE_POLICY = "prefix-v1"
$env:COPILOT_CACHE_NAMESPACE = "my-account:my-workspace:v1"
$env:COPILOT_CACHE_DIAGNOSTICS = "1"
bun run dev
```

The namespace is required only for generating an absent `prompt_cache_key`.
Choose a stable account/workspace scope and keep it unchanged between turns and
restarts. The generated key hashes this scope, endpoint/account type, model,
instructions, tools, and fixed generation configuration. It never hashes the
growing history, includes credentials, or changes randomly per request.
Existing client keys, including explicit null values, are preserved. The key
is a model-dependent routing/accounting hint; it does not force a hit and is
not an access-control or session identifier.

The policy is limited to native `/responses` requests for `gpt-6-astra`,
`gpt-5.6-sol`, `gpt-5.6-sol-fast`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
Other models/endpoints and server-side continuation requests are left alone.
Existing explicit breakpoints, explicit-only/null cache options, or a supplied
legacy retention option are treated as client-managed. An existing implicit
options object is preserved verbatim; otherwise a successful prefix adaptation
adds `{ "mode": "implicit", "ttl": "30m" }`.

The prefix search stops at user/assistant/history content. It does not move
top-level instructions into a new message or insert an empty prompt. Without an
eligible leading developer message, the policy can only supply a missing key.
The diagnostics summary's `cache_policy` records `applied`, `key_only`,
`no_prefix`, or the reason it skipped the request. It also records key ownership
and whether a breakpoint was added.

This implementation follows [OpenAI's prompt caching contract](https://developers.openai.com/api/docs/guides/prompt-caching).
The listed models' OpenAI capabilities do not prove Copilot endpoint acceptance
or account-level benefits. The policy is therefore off by default. Cache writes
may carry an additional cost; compare reported reads, writes, actual task cost,
and latency on normal work before concluding that it saves quota. It does not
pad prompts to reach a caching threshold. The cache policy introduces no retries
and never replays a request with cache parameters removed after a rejection.
Set `COPILOT_CACHE_POLICY=off` to roll back.

### Passive cache measurements

Set `COPILOT_CACHE_DIAGNOSTICS=1` when starting the proxy to emit one
`[cache-diagnostics]` JSON summary per logical `/responses` egress request,
including Messages-to-Responses bridges. This makes
no additional model requests and does not require `--trace`. The summary
contains upstream attempts, input/output tokens, cache reads/writes when
reported, Copilot-reported nano-AIU, request body size, and latency. Missing
usage is `null`, including on failed requests; it is never reported as a cache
miss merely because it is absent.

For a token-weighted cache hit rate, divide the sum of `cached_input_tokens`
by the sum of `input_tokens` over the same `usage_complete=true` samples.
Here `usage_complete` means input and cache-read counts are both known; it
does not guarantee output usage or all retry attempts were observed.
Also report the fraction of records with known values for each metric. Keep results grouped
by model; cache hit rate alone does not establish a reduction in task cost.
Copilot-reported nano-AIU is not an independently verified account deduction.

Ingress and prepared egress fingerprints preserve array order and use a random
process-local HMAC key. They do not contain prompt text, raw cache keys, or
credentials, and cannot be compared across process restarts. Fingerprint
changes are not token-level cache measurements. Requests remain explicitly
`uncorrelated` with an `unknown` task role until a reliable thread identifier
is available: sharing a cache key does not establish a shared thread.

Version 2 summaries distinguish `source: native_responses` from
`messages_to_responses`, and include `ingress_protocol` and `egress_endpoint`.
The internal `request_id` groups attempts of one logical call, not a session.
Messages bridge `[messages-usage]` records carry the same ID; they describe
translated counters and must not be added to upstream billing.

`cache_intent` records original caller hint presence, marker count, up to 32
protocol field paths, explicit TTL presence, and malformed/unknown options.
It does not log hint values or walk tool schemas and arguments. Messages hints
lost in conversion are labelled `cache_hint_not_portable`. This observation
does not translate TTLs, reject requests, or change `off`/`prefix-v1` behavior.
Native `observed` intent does not establish upstream acceptance or a cache hit.

Top-level egress fingerprints describe `egress_snapshot: prepared_request`,
before history recovery. `attempt_details` instead fingerprint each body
actually sent and record its byte size, cause (`initial`, `auth_refresh`, or
`history_recovery`), HTTP status, outcome and observed usage. `http_status` is
the transport status; `upstream_error_status` separately records an error
embedded in an otherwise successful HTTP response. Details are capped at 16;
`attempt_details_truncated` flags omitted details while `upstream_attempts`
retains the full count. `diagnostics_incomplete` indicates an observation failure.
Missing usage remains unknown. Cumulative events update one attempt rather
than adding repeated counters, and a retry starts with fresh unknown usage.

`ingress_static_prefix` and `egress_static_prefix` separately fingerprint the
instructions, tools, fixed model/reasoning settings, and leading
system/developer/additional-tools items. Scanning stops at the first dynamic
user, assistant, or tool-history item. The summary includes the leading item
count, input representation and boundary; it does not estimate prefix tokens
or certify a cache hit. Within one process, an unchanged prefix fingerprint
with a changed whole-input fingerprint shows that the selected leading context
stayed structurally equal while other input changed. It does not establish
that earlier user or tool history was preserved.
Messages ingress uses its original `system`, `messages`, `thinking`, and
`output_config` fields for these diagnostic fingerprints. This normalization
is internal to observation and does not change the forwarded request.

For reusable requests, keep instructions, reference material, tool order and
definitions stable; put the changing question after them and preserve earlier
history when appending turns. Avoid injecting timestamps or per-request IDs
before that prefix. Keep model, reasoning level and output schema fixed within
an experiment. Identical outputs do not establish input-cache reuse. Measure
cache reads, cache writes and output together, including the initial write;
account-credit changes are a separate observation.

`ttft_ms` measures the first nonempty streamed text, function-argument, or
custom-tool-input delta;
reasoning-only frames do not count. It is `null` for non-streaming requests.
Timing starts after request compatibility transforms, before the upstream call;
it excludes earlier inbound handling, rate-limit waits, and manual approval.
This observer covers Responses egress only, including Messages requests
that use that egress. It does not provide production cross-turn history state or
a complete per-task cost report.

#### Messages bridge usage

Messages clients using Chat or Responses upstream receive reported cache reads
in both JSON and SSE responses. The bridge subtracts a valid cached-read count
from a known input total; final streamed usage replaces provisional counters
with cumulative values. Native Messages responses remain unchanged.

Missing or invalid usage remains unknown internally. Required Anthropic numeric
fields use compatibility placeholders when no measurement exists, while unknown
optional cache fields are omitted. A known input total without a valid cached
count is a compatibility fallback, not a measured uncached-input breakdown.
Copilot cache-write counters are not mapped to Anthropic cache creation because
their accounting contract has not been established for this bridge.

With `COPILOT_CACHE_DIAGNOSTICS=1`, at most one separate `[messages-usage]`
summary records the upstream protocol, known counters, completeness, and fallback
reasons for each translated request. It contains no prompt or tool arguments.
These summaries are not consumed by `usage:summary`; adding them to native
Responses records would double-count Messages requests using that egress.
Compatibility placeholders must not be interpreted as zero usage or billing.

Chat-backed Messages streams request usage and wait after the finish reason for
a valid usage trailer, `[DONE]`, or normal EOF. A normal close with missing usage
retains the answer. A stalled trailer has a five-second deadline; protocol errors,
network failures, or timeout produce an error rather than a successful stop.
Client cancellation aborts the upstream without synthesizing a terminal result.

#### Summarize saved diagnostics

From the repository directory, run:

```powershell
bun run usage:summary
bun run usage:summary tmps/cache-session.log --since "2026-09-29T00:00:00+08:00" --until "2026-09-30T00:00:00+08:00"
bun run usage:summary tmps/cache-session.log --json
```

The default input is `tmps/cache-session.log`. The command reads UTF-8 and
BOM-marked UTF-16LE logs without making network requests. It reports observed
usage, per-metric coverage, outcome counts, attempts, retries, and token-weighted
cache hit rates, overall, by model, and by ingress source. These are Responses egress records
(including Messages using that egress), not all incoming requests or complete
task costs. Earlier attempts may have unreported usage; nano-AIU is not proof
of an account deduction. Reasoning and cached tokens are details, not additional
tokens to add to their respective output/input totals.

The JSON report uses `schema_version: 2` and `scope: responses_egress`, while
still reading old logs. Old records without explicit version-2 provenance are
grouped as `unknown_ingress`; `/responses` alone does not identify their client.
Existing `metrics` describe final responses. Separate `attempt_usage` totals
describe observed individual attempts, with coverage against reported attempt
counts (unknown if those counts are incomplete). Never add costs across these
two views. Missing or truncated details lower coverage; they do not imply zero
cost. Duplicate attempt indices contribute once, and Messages usage logs are
not parsed as upstream billing records.

Time filters require ISO8601 timestamps with a timezone; the interval includes
`--since` and excludes `--until`. Without filters the whole file is analyzed.
Records without a timestamp are counted, and excluded when a filter is active.
Within the selected range, duplicate request IDs keep their last valid record.
Malformed summaries are skipped and counted; unrelated debug payloads are not
included in the output. Empty results return success with unknown metrics;
unreadable files and invalid arguments exit nonzero.

JSON output has `schema_version: 1`, `scope`, `period`, `overall`, `by_model`,
`parsing`, and `limitations`. Each metric includes `observed_sum`, `known_records`,
and `coverage`; absent values remain `null` and actual zero remains zero.
Integer sums larger than JavaScript's safe integer range are decimal strings.

### Responses history rejected by Copilot

Copilot can return HTTP 401 with the exact message
`input item does not belong to this connection`. The proxy reports this known
history rejection as an upstream error, preserving HTTP 401 and the upstream
error code (or `copilot_input_connection_mismatch` when absent), with
`param: "input"`. It does not refresh authentication for this rejection.
Before any Responses event is forwarded, the proxy may retry once after removing
only unregistered reasoning ciphertext from a retry copy. Visible history and
registered ciphertext remain intact. Ordinary authentication 401s still receive
at most one authentication refresh and retry.

Failed recovery retains the final upstream status and cause, and states whether
recovery was attempted and how many ciphertext fields were removed from the
retry copy. Registry problems disable recovery without replacing the upstream
cause. Once SSE starts, failures use the existing error/failure events; the
already-sent HTTP status cannot change. No history replay occurs after an event
has been forwarded.

For **operator-confirmed OpenAI-origin reasoning**, an optional
`COPILOT_FOREIGN_REASONING_MANIFEST` file identifies exact ciphertext SHA-256
digests to omit from the outgoing copy before the first attempt. Generate a
reviewable manifest with
`bun scripts/export-foreign-reasoning.ts <OpenAI-rollout.jsonl> <new-manifest.json>`,
then set that environment variable only on the intended proxy process. Source
rollouts are never edited. A receipt miss alone is insufficient: unlisted
ciphertext and current-upstream receipts remain intact. Summaries, item IDs,
visible messages and tool pairs are preserved. Invalid manifests or unhealthy
receipts stop matching requests before provider I/O. Ordinary HTTP 400 errors
do not trigger cleanup or an extra retry. This policy is off when unset;
generation of a manifest does not activate it. Verify the source provider and
any mixed-provider history before enabling the manifest.

Canceling a request also cancels its wait for authentication, while other callers
can continue sharing the refresh. Each GitHub token exchange and refresh-time
GitHub user validation has a separate 10-second deadline, including body reads;
the VS Code Bridge retains its 3-second deadline. Authentication retry counts
are unchanged, so a full refresh can take longer than one exchange deadline.

### Fallback compatibility and request termination

Responses-to-Chat fallback groups consecutive function calls into one assistant
tool-call turn, retaining call IDs and result order. Text-only tool-result arrays
are translated to Chat text parts. Image/file or mixed tool results return HTTP
400 with `unsupported_feature` and the failing input path before an upstream
request is sent. Native Responses bypasses this fallback restriction.

Streaming fallback requests Chat usage explicitly and waits after `finish_reason`
for a usage frame, `[DONE]`, or normal EOF before emitting the final Responses
event. Content is streamed as it arrives. A missing `finish_reason`, malformed
tail, network error, or configured timeout still fails the stream. Missing usage
fields are omitted, not zero-filled; observed zero remains zero. Streaming and
non-streaming fallback map cached input and reasoning output details without
adding them again to token totals. `usage:summary` still covers only native
Responses egress diagnostics, not fallback requests.

All Responses, Chat, and Messages generation routes propagate caller cancellation
to the upstream request; closing a downstream SSE reader also aborts upstream
work. They share `COPILOT_HEADER_TIMEOUT_MS` (60 seconds by default; `0` disables)
and optional `COPILOT_FIRST_EVENT_TIMEOUT_MS`, `COPILOT_STREAM_IDLE_TIMEOUT_MS`,
and `COPILOT_TOTAL_TIMEOUT_MS` (unset or `0` disables). The stream timers apply
to streaming requests. Authentication refresh remains shared between callers.

The Messages-to-Responses bridge closes open content blocks before termination.
Output-limit truncation maps to `max_tokens`, content filtering to `refusal`, and
successful tool calls to `tool_use`. Truncation takes precedence over tool calls.
Failed responses, unknown truncation reasons, and missing or malformed terminal
events produce an error instead of a successful `message_stop`. Non-streaming
failures retain a known upstream HTTP status, otherwise 502.

Type checking includes source, tests, scripts, and root configuration files; local
`dist`, `tmps`, and test run logs are outside the project input set.

For development, `bun run dev:cache` uses `scripts/dev-cache.ts` to start the
same enterprise server as `dev`. Normal application logs and enabled cache
summaries appear both on the console and in `tmps/cache-session.log`; debug
messages go only to the file. Debug messages can include request/response
payloads. File output is appended, with timestamps and no terminal colors.
New logs use UTF-8; existing PowerShell UTF-16LE logs keep their encoding.
Arguments are forwarded, for example `bun run dev:cache --port 4142`.
Full `--trace` captures remain opt-in. The Windows launcher
`start-copilot-api.cmd` uses this command.
Set local cache options in the ignored `.env.local` file;
the tracked `.env` leaves the prefix policy off and enables passive diagnostics.
The Windows launcher also explicitly enables `COPILOT_CACHE_DIAGNOSTICS=1`;
it does not enable a cache policy.

Use `bun run dev:trace` explicitly when you need full request/response captures
in `traces/` (or `TRACE_OUTPUT_FOLDER`). Those files contain prompt, history,
and tool content; full tracing is not needed for cache summaries.

### Commands

| Command | |
| ------- | --- |
| `bun run dev` | Development server (`--account-type enterprise`, port 4141), without full tracing |
| `bun run dev:cache` | Console logs plus file-only debug logs; cache summaries require `COPILOT_CACHE_DIAGNOSTICS=1` |
| `bun run dev:trace` | Development server with full request/response tracing |
| `bun run lint` | ESLint (`@echristian/eslint-config`) |
| `bun test` | Unit test suite |
| `bun run typecheck` | `tsc` |

See [`AGENTS.md`](/AGENTS.md) for code-style conventions.

## Testing

Three layers, cheapest first. Run 1 and 2 on every change; run 3 before
declaring a routing or translation change complete.

### 1. Unit tests — fast, offline

No network, no proxy, no CLI. `fetch` is mocked.

```sh
bun test                                      # whole suite
bun test tests/create-responses.test.ts       # one file
bun test --test-name-pattern "encrypted"      # by test name
```

### 2. Static checks

```sh
bun run typecheck                                    # tsc, no emit
bun run lint -- --fix src/foo.ts tests/foo.test.ts   # autofix specific files
bun run lint:all                                     # whole repo — see caveat below
```

Note the `--` before flags you want to reach ESLint: `bun run lint` already
expands to `eslint --cache`, so `bun run lint -- --fix <paths>` is the correct
form. A `simple-git-hooks` pre-commit hook runs `lint-staged` on staged files
automatically, so a commit will reformat what you are committing.

> [!NOTE]
> **`lint:all` does not pass on a fresh Windows checkout**, and that is expected —
> nothing is actually broken. This repo has `core.autocrlf=true` and no
> `.gitattributes`, so Git stores LF but checks files out as CRLF, while the
> Prettier config expects LF: one `prettier/prettier` "Delete `␍`" error per
> line, ~10k repo-wide. Committed content and diffs are unaffected, and the
> pre-commit hook only lints *staged* files, so day-to-day work is unaffected
> too. Lint the files you changed rather than the whole repo.
>
> If you do want `lint:all` to pass, the zero-churn fix is one line in
> `eslint.config.js`. It keeps the CRLF working tree and just tells Prettier to
> accept each file's existing endings (verified: takes an untouched file from
> 434 errors to 0):
>
> ```js
> export default config({
>   prettier: { plugins: ["prettier-plugin-packagejson"], endOfLine: "auto" },
> })
> ```
>
> The heavier alternative — a `.gitattributes` with `* text=auto eol=lf` plus a
> re-checkout — converts the entire working tree to LF instead.

### Budgeted local acceptance

Run `bun run acceptance:local --dry-run` to inspect the OpenAI-only evaluation
plan, or `bun run acceptance:local` for offline checks. Add `--live` to use the
VS Code Bridge and an isolated server on port 4143, with per-attempt credit
reservations and Luna/low as the primary model. Reports distinguish confirmed
behavior, known defects, environment restrictions, and unverified paths.
See [the budget, scenarios, continuation rules, and evidence format](tests/acceptance/LOCAL-ACCEPTANCE.md).

Messages requests preserve explicit `output_config.effort` across Responses,
Chat, and native Messages egress. Explicit effort takes precedence over legacy
thinking budgets; unsupported values can be reduced to a supported level but
are never silently increased. Invalid values return a field-specific 400.
Without explicit effort, the existing budget mapping and upstream defaults apply.

Rate-limit wait mode admits requests in FIFO order at the configured interval.
Cancelled waiters leave the queue without consuming a future slot. The interval
controls request admission rather than waiting for the previous response to end.

### 3. Acceptance matrix — live, drives the real CLIs

This is the only thing that may declare a routing change complete. It starts a
**fresh proxy on `:4143` from the current worktree** (so it tests your edits,
not the running server), drives the **real** `claude -p` and `codex exec`
binaries against it, and judges each cell by a trace-tag oracle rather than by
eyeballing replies.

**Prerequisites**

- `claude` and `codex` on `PATH` and already authenticated
- A working Copilot token source (GitHub token or the VS Code bridge)
- Port `4143` free
- Network access to the Copilot backend

```sh
bun run tests/acceptance/run.ts                 # full matrix (24 cells, ~10 min)
bun run tests/acceptance/run.ts --list          # print the cells, run nothing
bun run tests/acceptance/run.ts --only 1a,1f    # subset by cell id
bun run tests/acceptance/run.ts --mandate 1     # one mandate group
```

A cell passes only when **all** of these hold:

1. the egress **trace tag** matches the expected one,
2. the client process exits `0`,
3. the final assistant text is non-empty,
4. no `unsupported_api_for_model` or raw `400` appears in client output,
5. any cell-specific extra assertions hold.

Results are written to `tests/acceptance/RESULTS-<date>.md` (one row per cell:
expected vs actual tag, exit code, PASS/FAIL, trace path). The runner exits
non-zero if any cell fails.

**Trace tags** — the `.type` field of each `<traceDir>/<ts>.req`, i.e. which
egress leg the request actually took:

| Tag | Inbound → egress |
| --- | --- |
| `anthropic-passthrough` | Claude Code → Copilot `/v1/messages`, no translation |
| `anthropic-via-responses` | Claude Code → Copilot `/responses` |
| `responses-passthrough` | Codex → Copilot `/responses`, no translation |
| `responses` | Codex → Copilot `/chat/completions` (translate-down) |
| `anthropic` / `chat` | Anthropic / OpenAI chat-completions legs |

### 4. Soak — high-volume repeat of the matrix

For each (model × client) combo, runs N live iterations cycling through client
features, so the runs exercise different code paths instead of the same call N
times. Writes `SOAK-RESULTS-<date>.md`.

```sh
bun run tests/acceptance/soak.ts                    # all combos, 50 runs each
bun run tests/acceptance/soak.ts --runs 10          # smoke
bun run tests/acceptance/soak.ts --only claude:gpt-5.5
```

### 5. Direct-connect probe — is this proxy still needed?

Answers one question: can Claude Code point `ANTHROPIC_BASE_URL` straight at the
Copilot backend and drop this proxy? It sends **Claude Code's own wire format**
(its minimal headers, its `thinking` schema, its model ids, a raw `gh auth token`
as the bearer) to the real backend and reports what the backend accepts. Every
gating check that FAILs is a job this proxy is currently doing for you.

```sh
bun run probe:direct                                    # default: opus-5, sonnet-5, haiku-4.5
bun run probe:direct -- --models claude-opus-5          # subset
bun run probe:direct -- --account-type individual       # non-enterprise base url
bun run probe:direct -- --catalog-only                  # GET checks only, spends nothing
bun run probe:direct -- --json                          # machine-readable
```

Exit `0` = direct connect viable · `1` = proxy still required · `2` = probe
could not run (no token / network). It costs a handful of tiny live completions;
`--catalog-only` costs nothing but cannot clear the thinking gate, so it reports
INCONCLUSIVE rather than a pass.

**Result as of 2026-07-31 (enterprise)** — `bun run probe:direct` exits 1:

| Check | Result |
| ----- | ------ |
| `auth` | PASS — the backend accepts a raw GitHub token directly; no Copilot-token exchange needed |
| `catalog` / `native-messages` | PASS for `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4.5` (opus/sonnet already 1M ctx natively) |
| `plain-completion` | PASS |
| **`thinking-standard`** | **FAIL 400** — `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"` |
| `thinking-adaptive` | PASS — the shape [`adaptThinkingForCopilot`](/src/services/copilot/create-messages.ts) rewrites to |
| `model-suffix-1m` | FAIL — `claude-opus-5[1m]` is rejected; direct configs must keep `ANTHROPIC_DEFAULT_*_MODEL` suffix-free |

So direct connect is **not** viable today: Claude Code always sends
`thinking:{type:"enabled",budget_tokens:N}` (confirmed in `traces/`), which the
backend rejects. That one rewrite is the proxy's load-bearing job for Claude
models; model aliasing, `/responses` routing, Codex support, and tracing are the
rest. Re-run the probe after any backend change — when it exits 0, direct
connect has become an option for Claude Code + Claude models.

### Port conventions

The harness deliberately never touches a port you may be using interactively:

| Port | Use |
| ---- | --- |
| `4141` | Your live proxy (`start-copilot-api.cmd` / `bun run dev`) |
| `4142` | Scratch instance for manual probing |
| `4143` | Reserved for the acceptance harness — started and stopped by it |

### Manual probing with traces

To inspect exactly what goes on the wire, run a second instance with tracing and
verbose logging, and leave `:4141` alone:

```sh
bun run ./src/main.ts start --account-type enterprise \
  --port 4142 --trace --trace-folder ./traces-dbg --verbose
```

Each request writes `<ts>.req` and `<ts>.resp` into the trace folder. `--verbose`
additionally logs every raw upstream stream event, which is how you tell a
proxy-side fault from an upstream rejection.

### Reproducing a client-side bug

When a real Codex session misbehaves, replay its history instead of guessing.
Codex stores every session as JSONL under
`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`; the `response_item`
records are exactly the Responses API `input` array. Collect them, POST them to
`:4142/v1/responses`, and bisect by removing item kinds until the failure
disappears. That turns "the client is broken" into a red/green loop in seconds.


---

Credit: original work by [Erick Christian](https://github.com/ericc-ch) ([ko-fi](https://ko-fi.com/E1E519XS7W)). This fork only layers on the Windows/Claude-Code/token-bridge changes described above.
