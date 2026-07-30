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

See the [upstream README](https://github.com/ericc-ch/copilot-api#readme) for npx, Docker, and the full CLI option tables — they apply unchanged.

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
| `TRACE_OUTPUT_FOLDER` | Where request/response traces go when `--trace` is set. | `./traces` |

`MODEL_MAPPINGS` example (maps the IDs Claude Code sends to internal Copilot model names):

```env
MODEL_MAPPINGS="claude-opus-4-8:claude-opus-4.8,claude-opus-4-7:claude-opus-4.7-1m-internal,claude-sonnet-4-6:claude-sonnet-4.6,claude-haiku-4-5:claude-haiku-4.5"
```

## Using with the VS Code Claude extension

1. Copy [`settings.json`](/settings.json) to `C:/Users/<user-name>/.claude/settings.json` (create the file if needed).
2. Restart the Claude chat (close and reopen it).

`settings.json` points `ANTHROPIC_BASE_URL` at `http://localhost:4141` and sets the model IDs — adjust to taste.

## Development

| Command | |
| ------- | --- |
| `bun run dev` | Watch-mode server (`--account-type enterprise`, port 4141) |
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
