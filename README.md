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

## Token sources

The proxy resolves a Copilot token in this order:

1. **GitHub token** (`GH_TOKEN` / `--github-token`, or the interactive device-code flow) → exchanged for a Copilot token, then auto-refreshed.
2. **VS Code token bridge** (fallback, or **proxy-only mode** when no GitHub token is present) — the proxy fetches a token from a small VS Code extension at `http://127.0.0.1:<VSCODE_PROXY_PORT>/token`.

### Setting up the VS Code token bridge

> Source: [**wenbo97/copilot-token-bridge**](https://github.com/wenbo97/copilot-token-bridge) — the extension is open source; the bundled `.vsix` below is a prebuilt copy.

1. Install the bundled extension: `copilot-token-bridge-0.3.0.vsix`
   ```sh
   code --install-extension copilot-token-bridge-0.3.0.vsix
   ```
2. Make sure VS Code is signed in to GitHub Copilot and left running.
3. (Optional) If the extension uses a non-default port, set `VSCODE_PROXY_PORT` in `.env` (default `18774`).

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
| `COPILOT_CACHE_DIAGNOSTICS` | Set to `1` or `true` for native Responses cache/usage summaries in the proxy log. | disabled |
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
helps cache routing; it is not an access-control or session identifier.

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
`[cache-diagnostics]` JSON summary per native `/responses` request. This makes
no additional model requests and does not require `--trace`. The summary
contains upstream attempts, input/output tokens, cache reads/writes when
reported, Copilot-reported nano-AIU, request body size, and latency. Missing
usage is `null`, including on failed requests; it is never reported as a cache
miss merely because it is absent.

For a token-weighted cache hit rate, divide the sum of `cached_input_tokens`
by the sum of `input_tokens` over the same `usage_complete=true` samples.
Also report the fraction of requests with complete usage. Keep results grouped
by model; cache hit rate alone does not establish a reduction in task cost.
Copilot-reported nano-AIU is not an independently verified account deduction.

Ingress and final egress fingerprints preserve array order and use a random
process-local HMAC key. They do not contain prompt text, raw cache keys, or
credentials, and cannot be compared across process restarts. Fingerprint
changes are not token-level cache measurements. Requests remain explicitly
`uncorrelated` with an `unknown` task role until a reliable thread identifier
is available: sharing a cache key does not establish a shared thread.

`ttft_ms` measures the first nonempty streamed text, function-argument, or
custom-tool-input delta;
reasoning-only frames do not count. It is `null` for non-streaming requests.
Timing starts after request compatibility transforms, before the upstream call;
it excludes earlier inbound handling, rate-limit waits, and manual approval.
This initial observer covers native Responses only, including Messages requests
that use that egress. It does not yet provide cross-turn history comparisons or
a complete per-task cost report.

### Responses history rejected by Copilot

Copilot can return HTTP 401 with the exact message
`input item does not belong to this connection`. The proxy reports this known
history rejection as HTTP 400 with code `copilot_input_connection_mismatch`
and `param: "input"`, without refreshing authentication or automatically
replaying the rejected request. Ordinary authentication 401s still receive at
most one refresh and retry.

This classification prevents an unhelpful auth retry; it does not repair the
rejected history or establish why Copilot rejected it. Check that the history
belongs to the current account and endpoint, or start a new conversation. The
proxy preserves history items, reasoning ciphertext, and cache parameters.

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
the tracked `.env` and standard launcher leave the policy and diagnostics off.

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
