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
| `bun run dev` | Watch-mode server |
| `bun run lint` | ESLint (`@echristian/eslint-config`) — `bun run lint --fix` to autofix |
| `bun test` | Run the test suite (`tests/*.test.ts`) |
| `bun run typecheck` | `tsc` |

See [`AGENTS.md`](/AGENTS.md) for code-style conventions.

---

Credit: original work by [Erick Christian](https://github.com/ericc-ch) ([ko-fi](https://ko-fi.com/E1E519XS7W)). This fork only layers on the Windows/Claude-Code/token-bridge changes described above.
