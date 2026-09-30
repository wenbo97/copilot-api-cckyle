# Responses resume compatibility implementation

Date: 2026-09-21. Feature commit: `dd349783b6a259d71fad21970dd8a3cb207436ef`.
Integrated with `origin/master` at `9f205372e22a3fabbf6c5a128096fcd533ead1eb`.

2026-09-29 local follow-up: ownership failures now preserve HTTP 401, upstream
error codes, and accurate retry-copy cleanup descriptions. Registry failures
retain the original upstream cause. SSE failures preserve the same classification,
including a different final failure (such as HTTP 503) after recovery. These
changes are covered by offline regressions; the historical live results below
do not establish deployment of this follow-up.

The second 2026-09-29 local follow-up adds cancellation propagation across all
six generation routes, including downstream SSE-reader cancellation, and explicit
Messages bridge terminal handling. Responses-to-Chat fallback now preserves
parallel tool replay and observable usage, and rejects unsupported tool outputs
before fetching. Registry subprocess checks have 10-second child deadlines and
30-second test budgets, with cleanup before temporary directories are removed.
These are offline source changes; no service restart, deployment, live model
request, or quota experiment has been performed for this follow-up.

## Behavior

2026-09-30 adds an explicit, opt-in foreign-reasoning manifest for the generic
400 `invalid_request_body` case. `COPILOT_FOREIGN_REASONING_MANIFEST` points to
a version-1 JSON file with `sourceProvider: "openai"`, `sourceSessionId`, and
`ciphertextSha256`. Export it from an operator-confirmed OpenAI rollout using
`scripts/export-foreign-reasoning.ts`. Only listed reasoning ciphertext without
a current-upstream receipt is omitted, before the first request. Unknown
ciphertext remains unchanged. Invalid configuration or corrupt matching receipts
fails before I/O; no generic-400 recovery is added. The policy runs before cache
policy and diagnostics, so both see the actual sanitized egress. It is disabled
by default and never edits a rollout. Mixed-origin exports require per-item
review; session metadata is evidence, not cryptographic provenance.

Regression coverage includes JSON/SSE, preserved summaries/IDs/tool pairs,
current-issued and unknown ciphertext, no generic-400 retry, corrupt receipts,
invalid manifests, and privacy-preserving export. The 563-item diagnostic fork
also passed offline replay: 137 target fields omitted, all other egress fields
unchanged. The earlier live differential proves the original field-level trigger;
it does not certify live deployment of this new implementation.

Native Responses requests normally preserve encrypted reasoning. On the precise
upstream 401 `input item does not belong to this connection`, the request may
retry once, before any Responses event has been delivered. Only reasoning
`encrypted_content` fields not recorded as issued by this installation/upstream
are removed from the retry copy. Visible messages, reasoning summaries, tool
calls, and tool results remain. Normal auth errors, network failures, rate limits,
and failures after the first event cannot trigger history cleanup.

Both actual HTTP 401 and HTTP-200 SSE `{status:401, body:...}` envelopes are
recognized. Failed recovery retains the upstream status/cause. HTTP failures are
returned as HTTP errors before streaming starts; streaming failures are rendered
as the existing official error/failure events.

New reasoning is registered before being delivered to clients. Only SHA-256
receipts are persisted, under the application's `responses-history` directory,
scoped by upstream URL. Immutable files and atomic rename avoid lost updates
between concurrent processes. State survives restarts. Registry corruption or
write failure disables automatic cleanup; otherwise healthy responses still work.
The receipt directory is specific to one proxy installation/account and must not
be shared between different accounts. Ciphertext is redacted from trace/debug
copies without changing the wire payload.

## Local verification

- Before changes: `bun test` — 325 passed, 0 failed.
- Regression demonstrated before implementation: the ownership envelope produced
  an `invalid_upstream_response` error instead of recovering.
- Regression demonstrated before provenance protection: a recovery also removed
  newly issued reasoning. Receipt registration fixed that failure.
- After integration with current master: `bun test` — 398 passed, 0 failed.
- `bun run build` — passed.
- Scoped ESLint over all changed/new TypeScript files — passed.
- `git diff --check` — passed.
- New regression coverage includes HTTP/SSE rejection, non-stream responses,
  one-retry limit, no replay after output, preserved messages/tool pairs,
  retained new reasoning, corrupt/unwritable receipts, distinct upstreams,
  cancellation, first-event timeout, fresh-process resume, concurrent-process
  registration, and ciphertext log redaction.
- `bun run typecheck` — passed when run after the build step.

## Direct remote CLI evidence

The user removed the local proxy/4142 requirement. All live requests went directly
to `https://g5x5mg68-8314.usw3.devtunnels.ms/v1`. No local proxy was started and no
remote server was restarted or deployed.

Model: `gpt-6-astra`; reasoning: `high`; summaries: `concise`; cwd:
`C:\Users\v-wangjunf`. Diagnostic children use read-only permissions and no tools.
Original source sessions and global Codex configuration were not edited.

| Scenario | Result |
| --- | --- |
| Source `01a0c20f-c841-7871-a351-3b3fce86bcc5` → test fork `01a0c241-de72-7703-bde4-baaf29ec2fd3` | Seed succeeded; three independent CLI `resume` processes returned the exact remembered marker, `turn.completed`, exit 0 |
| Previously failing cross-provider source `01a0c1e4-94b7-7382-8ac5-dfd04eeb3c89` → diagnostic fork `01a0c243-22b2-7412-862d-b3334df125ed` | Still fails against the current remote service: `stream closed before response.completed`, exit 1 |

Machine-readable reports (local, git-ignored):

- `tests/_runlog/resume-remote-primary-20260921/result.json`
- `tests/_runlog/resume-remote-regression-20260921/result.json`

These results do not prove that the local patch is deployed. The failing remote
regression remains the deployment acceptance gate. The repository has no identified
deployment mapping for this Dev Tunnel. The remote host/source checkout and its
update procedure are required before the fixed code can be validated there.

## Local 4141 CLI evidence

The existing local service at `http://127.0.0.1:4141/v1` was tested without
stopping it. Its process was Bun PID `37356`, launched as
`bun run ./src/main.ts start --account-type enterprise`; `/v1/models` returned
HTTP 200 with 36 models including `gpt-6-astra`.

Source `01a0c1e4-94b7-7382-8ac5-dfd04eeb3c89` was forked through that endpoint.
Test thread `01a0c283-0057-7af0-9a3e-2d5ac57ed8bc` returned `READY`, then three
independent `resume` processes returned the exact remembered marker. Every turn
emitted `turn.completed`, exited 0, and used no tools. Report:
`tests/_runlog/resume-local-4141-before-restart-20260921/result.json`.

The service process predates the source edits, so this result proves that local
4141 and its current upstream identity can already resume the source history. It
does not exercise the newly implemented ownership-error recovery path. The failed
remote regression above remains the evidence for the incompatible-identity case.

## Commands

Run from this repository. Each invocation creates a separate test fork and writes
a report to a new directory; it never resumes or changes the source thread itself.

```powershell
bun run tests/acceptance/resume-remote.ts `
  --source-session 01a0c20f-c841-7871-a351-3b3fce86bcc5

bun run tests/acceptance/resume-remote.ts `
  --source-session 01a0c1e4-94b7-7382-8ac5-dfd04eeb3c89
```

Resume the successful diagnostic copy interactively using the same remote URL:

```powershell
$env:OPENAI_API_KEY = 'dummy'
codex resume 01a0c241-de72-7703-bde4-baaf29ec2fd3 `
  -C C:\Users\v-wangjunf `
  -m gpt-6-astra `
  -c 'model_provider="copilotproxyry"' `
  -c 'model_providers.copilotproxyry.base_url="https://g5x5mg68-8314.usw3.devtunnels.ms/v1"' `
  -c 'model_reasoning_effort="high"' `
  -c 'model_reasoning_summary="concise"'
```

Use the successful local 4141 copy interactively:

```powershell
$env:OPENAI_API_KEY = 'dummy'
codex resume 01a0c283-0057-7af0-9a3e-2d5ac57ed8bc `
  -C C:\Users\v-wangjunf `
  -m gpt-6-astra `
  -c 'model_provider="copilotproxyry"' `
  -c 'model_providers.copilotproxyry.base_url="http://127.0.0.1:4141/v1"' `
  -c 'model_reasoning_effort="high"' `
  -c 'model_reasoning_summary="concise"'
```

After deployment, rerun both live scenarios and repeat resume after the remote
service restarts while preserving its receipt directory. Until then, the source
patch and local restart tests are verified, but the original remote issue is not
resolved.
