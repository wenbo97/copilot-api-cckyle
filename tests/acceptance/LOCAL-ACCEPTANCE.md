# Budgeted local acceptance

## Latest-commit six-model acceptance

Fresh native Windows sandbox homes require administrator-approved initialization;
see [OpenAI's Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).
When a synthetic admission home has already completed that initialization, pass
`--codex-fixture-dir <absolute-or-relative-fixture-path>` to reuse it. Only
`tests/_runlog/client-fixtures/copilot-codex-admission-XXXXXX` directories are
accepted, and the path is bound to the round authorization. Codex then uses that
owned home with independent threads across models; Claude configuration homes
remain separate. Personal client homes and configuration are never imported.
The preflight requires the native setup marker and still verifies an actual
read-only shell read with approval never; reuse does not bypass the sandbox.

`--verify-evidence --output-dir <completed-round>` validates saved authorization,
source manifests, ledger checkpoint, cases and diagnostics without authentication
or generation. It writes separate `REPORT-verified.md` and `summary-verified.json`
artifacts, preserving the live report. Identical logger replays are deduplicated
by request ID with the first correlation retained; conflicting payloads fail.
The live execution identity and verifier identity are recorded separately.

The `latest` profile runs a reusable, independently budgeted acceptance round.
It defaults to gpt-6-luna, gpt-5.6-luna,
gpt-6-sol, gpt-6.1-sol, gpt-5.6-terra and gpt-6-astra, all with explicit low
reasoning. Its ceilings are 500 conservative reserved credits, 60 upstream
attempts and 45 active live minutes; admission stops before 450 credits.
These are tool ceilings, not standing authorization to consume account credits.
Every live invocation requires `--approval-reference` recording reviewed approval
for the current account, exact models and budget. The reference is bound to the
local authorization and cannot change on continuation. Historical version-5
references remain readable; no previous incident approval is inferred for a new run.

```powershell
bun run acceptance:local --profile latest --dry-run
bun --no-env-file run acceptance:local --profile latest
bun --no-env-file run acceptance:local --profile latest --live `
  --output-dir tests/_runlog/my-reviewed-round `
  --approval-reference "Reference to reviewed current-account/model/budget approval"
```

Optional `--models`, `--max-credits`, `--max-attempts` and `--max-minutes` can
narrow the approved scope. Other models and wider limits are rejected before
side effects. Keep the same output directory and authorization for continuation;
changing limits or source, missing checkpoints, and a persisted stop fail closed.
An interruption during the six-request cache experiment also prevents live
continuation: its fingerprints use a process-local HMAC key. The original round
remains incomplete; its requests are never replayed to reset the comparison.
The existing 4141 service is preserved. The runner owns 4142 and authenticates
only through the current VS Code Bridge on 18774, using isolated application
state, client homes and history receipts. Existing user configuration is not edited.

All six models run Responses JSON, Messages JSON, actual Codex shell reads and
Claude Code Read turns. Tool fixtures contain unpredictable markers absent from
the prompt; tool execution and the last completed answer are verified separately.
The CLI paths also exercise both streaming protocols. Luna additionally covers
parallel tools, six off/prefix-v1 catalogue requests, cancellation/recovery,
Bridge refresh, and seed/fork/resume across an owned proxy restart. The nominal
plan needs 52 attempts, leaving eight slots for internal retries. It does not
retry failed cases until they pass. Detailed fault, fallback and native Messages
contracts remain offline-only for this selected Responses-only model catalogue.

The offline suite, typecheck, build, 300 simulated route requests and both real
CLI loopback tool-admission preflights precede paid admission. Source-bound
version-5 authorization, a durable locked ledger and active-time checkpoints
protect the whole round. A case failure continues with independent cases;
account, global budget, source and service failures stop admission.

The conservative tariff snapshot was verified on 2026-10-02 against GitHub's
Copilot price table. Review that snapshot before a new paid experiment; it is not
an assertion that current prices have been fetched automatically. Default output
directory names use the current date. Every run writes its authorization and
evidence under git-ignored `tests/_runlog/`; they are never bundled as approval
for another checkout. See [the sanitized 2026-10-02 result](LATEST-ACCEPTANCE-2026-10-02.md)
for historical six-model coverage.

Reports contain exact-model coverage and explicit unknown usage. Provider usage
and conservative reservations are different observations; neither independently
audits account debits. Cache hits or equal answers do not establish incremental
prefix-v1 savings. Raw CLI logs and isolated session files are local diagnostic
artifacts, not publication-ready reports. Existing historical reports are retained.

Observed results: [2026-09-29 consolidated acceptance report](../../LOCAL-ACCEPTANCE-REPORT-2026-09-29.md).

Subsequent repairs and qualified rechecks:
[remaining issue repair report](../../REMAINING-ISSUES-FIXES-2026-09-29.md).

This suite evaluates the current dirty working tree without changing production
implementation. It uses the user's confirmed `wenbo97` VS Code GitHub account
through the bridge on 18774. The bridge response has no username: identity is
user-confirmed, not independently established by the token endpoint.

## Commands

```powershell
bun run acceptance:local --list
bun run acceptance:local --dry-run
bun run acceptance:local
bun run acceptance:local --live --max-credits 1000
bun run acceptance:local --live --only auth-catalog,responses-json,responses-stream --output-dir tests/_runlog/my-acceptance
```

The default runs the full offline suite, typecheck, build, 300 simulated route
requests, and CLI help checks. `--list` and `--dry-run` do not authenticate, start
services, or send generation requests. `--live` runs the offline gate first and
owns a fresh proxy on 4143. Ports 4141/4142 and the user's Bridge are untouched.
The full live run includes a 20-minute observation window with 20 short requests.
Use `--only` to select cases; fork/resume also selects its seed case.

## Eight-model E2E round

These dated live commands are incident-specific continuations, not a general
authorization to generate requests. They require the original private ledger,
the account confirmation recorded for that incident, and, for `legacy`, its
private historical fixtures. The source snapshot contains the prior approval
reference; another account or incident needs its own reviewed authorization.
Those private artifacts are intentionally excluded from source control. A clean
checkout can run the offline suite and `--dry-run` without them.

The `--e2e` path uses a separate, cumulative version-4 authorization. It runs the
current dirty source through an owned proxy on port 4142, with isolated Claude
Code and Codex homes. It preserves the historical budget directory and its
prior 129 upstream reservations. `--dry-run` lists the exact planned cases and
prices without starting the proxy or sending generation requests.

```powershell
bun run acceptance:local --e2e --stage matrix --dry-run
bun run acceptance:local --e2e --stage matrix --live `
  --budget-dir tests/_runlog/local-acceptance-20260929 `
  --output-dir tests/_runlog/e2e-matrix-20260930 `
  --max-additional-credits 1000 --max-additional-attempts 176 --max-additional-minutes 90

bun run acceptance:local --e2e --stage legacy --dry-run
bun run acceptance:local --e2e --stage legacy --live `
  --budget-dir tests/_runlog/local-acceptance-20260929 `
  --output-dir tests/_runlog/e2e-legacy-20260930 `
  --max-additional-credits 8000 --max-additional-attempts 2 --max-additional-minutes 10
```

The offline gate runs before a new authorization is written. Keep the original
output directory and authorization file for a continuation; changing directory
or source cannot reset attempts. A case failure continues to the next independent
case. Budget, account, source, checkpoint, and service failures stop the round.

The matrix covers the eight exact model IDs advertised by the 4141 catalog on
2026-09-30. Every model gets native Responses and Messages bridge JSON/SSE,
parallel tool replay, two independent Claude Read turns, Codex's actual read-only
shell turn, seed/fork/resume across an owned proxy restart, cancellation with a
next-request check, and a credential refresh check. Each model has 22 reserved
attempt slots. `gpt-5.6-sol-fast` remains `BLOCKED` until a model-specific
Copilot price is verified. The existing `gpt-5.6-sol` price is not substituted.

The legacy stage requires Astra's matrix JSON, SSE, and history cases
to pass under the same source fingerprint. It clones the original incident's
source-session lineage into an isolated Codex home and checks the full captured
historical prefix, 137 foreign reasoning ciphertexts, and 149 tool-call/result
pairs through an offline capture before paid admission. The two calls then
validate fork and independent resume after restarting only the test proxy. The
capture of 563 items included four extra diagnostic items beyond the original
559-item history; a new fork may regenerate its first two tool-metadata items.
The preflight records the exact current item count and rejects changed inherited
content, tool pairs, or foreign-ciphertext coverage. It never writes the private
history to a report.

`summary.json` and `REPORT.md` include per-model pass counts, attempts, usage
coverage, known input/output/cache tokens, and source fingerprint. Historical
reports retain the defects observed for their original source snapshot; current
reports do not advertise the repaired HTTP error-forwarding defect as active.
Unknown usage is not zero. Credit
reservations are conservative estimates rather than account deductions. The
round is incomplete if any required model or case is failed, blocked, or skipped.

`codex-tool` records whether the machine permits a read-only shell command.
`codex-mcp-tool` separately verifies a pure local MCP tool that returns synthetic
data without executing commands or accessing files. A successful MCP case does
not override or erase a shell-policy denial.

After a primary-model failure warrants a comparison, explicitly select
`--only bounded-context-terra` with the same output directory. This optional
Terra/low case uses the identical bounded-context input and is excluded from
default live runs. Its estimated reservation is approximately 10 credits.
`--only bounded-context-array` is the corresponding Luna/low input-shape
comparison: identical text in a user-message array, approximately one credit.
`--only soak-recheck` starts a fresh 20-minute window using the reserved recheck
phase and separate case IDs, preserving any interrupted window's outcomes.

## Original assessment contract

The following contract describes the original assessment. The approved repair
followup below permits production fixes before freezing a new source snapshot.

- Preserve production implementation, existing dirty changes, original sessions,
  normal services, and global client settings. Deliver evidence and isolated
  reproductions for defects, not production fixes. No commits or deployments.
- Record source fingerprints and stop admission when production source changes.
  Use separate application state, history receipts, and client configuration.
- Primary model is `gpt-5.6-luna`, explicit low reasoning. Real calls are
  OpenAI-only. `gpt-5-mini/low` tests direct Chat; Terra is restricted to diagnosed
  comparisons and four attempts. No automatic expensive-model fallback.
- Cover non-stream and streamed Responses, strict JSON, parallel tools and result
  replay, namespace/custom tools, Messages bridging, small synthetic media,
  bounded context, and off/prefix-v1 compatibility.
- Exercise actual Codex seed/tool/fork/resume/restart and Claude Code smoke/tool
  workflows using synthetic files and isolated configuration.
- Exercise bridge refresh, cancellation, next-request recovery, concurrency 2/4,
  in-flight process termination, restart, and the observation window.
- Use offline tests for all six ingress/egress pairs, authentication failures,
  401/429/5xx, malformed/truncated streams, all terminal states, history ownership,
  and usage unknown/zero behavior. B7 was a known expected failure in that run;
  the repair followup runs it as an ordinary regression.
- Native Anthropic and untested model/protocol combinations must remain labeled
  offline-only or unverified. A short observation window is not a statistical
  reliability guarantee or a cache-savings experiment.

## Budget enforcement

The test child wraps the final upstream fetch. Every model attempt, including
internal refresh/history retries and client side calls, must acquire a durable
reservation from the parent controller before network transmission. The parent
remains alive across proxy restarts. A ledger reload retains all reservations.
The controller admits only active case IDs; requests must have low reasoning,
an allowed OpenAI model, an allowed endpoint, and a bounded output limit.

The default ceiling is 1000 credits, with admission stopping at 900 and 100 held
for uncertainty. All phases together allow at most 120 upstream attempts and
60 minutes of live execution. Ordinary fixtures request 1024 output tokens,
tools/clients use 2048, and the guard caps any request at 4096. Missing client
output limits receive a recorded test-only cap. Input is conservatively
estimated from twice the serialized token count plus framing allowance; small
media fixtures reserve the full 64K input ceiling.

Reservations use the GitHub Copilot 2026-09-29 price table, not OpenAI direct API
pricing. Luna reserves ordinary input plus cache-write pricing, without cache
discount assumptions. Failed, cancelled, and unknown-usage attempts never refund
reservations. These are conservative estimates, not an authoritative account
ledger. Actual usage, reservation totals, and missing coverage are separate.

| Phase | Credits | Attempts |
| --- | ---: | ---: |
| Functional | 200 | 24 |
| Clients | 250 | 24 |
| Operations | 150 | 32 |
| Other OpenAI comparisons | 100 | 16 |
| Targeted rechecks | 200 | 24 |

Reuse an output directory for a targeted continuation so its ledger is retained.
The budget does not authorize additional cases merely to consume the allowance.
Earlier case outcomes remain in JSON evidence; the latest outcome for each case
determines the current verdict. Service disappearance stops the observation run.
Active live time is checkpointed atomically once per second and retained across
continuations; time while an interrupted runner is absent is excluded. Older
evidence is conservatively initialized from case durations, full-minute soak
slots, and a four-minute startup allowance. The cumulative active limit remains
60 minutes. A completed fresh recheck window does not erase an earlier timeout
or an interrupted window.

## Isolated production-contract reproduction

```powershell
bun --no-env-file tests/acceptance/repros/messages-low-effort.ts
```

This command denies real network access and tests actual Messages handlers with
a synthetic upstream. Before the repair, adaptive and absent thinking lost
`output_config.effort=low`, and the command exited 1. The repaired implementation
must pass all three variants and exit 0. Ordinary handler regressions now also
cover native Messages and Chat egress, precedence, invalid values, and streaming.

## Repair followup across source versions

Use a separate evidence directory for the repaired source and retain the original
budget directory. The shared ledger, active clock, phase caps, account stops, and
unknown usage are never reset. A single-runner lock protects accounting. An
existing lock must be investigated for a live owner; never delete it based only
on a historical PID. Missing or corrupt budget evidence prevents continuation.

```powershell
bun run acceptance:local --live `
  --output-dir tests/_runlog/remaining-fixes-20260929 `
  --budget-dir tests/_runlog/local-acceptance-20260929 `
  --max-additional-credits 30 --max-additional-attempts 20 --max-additional-minutes 15 `
  --only claude-smoke,claude-tool,rate-limit-followup,context-followup-1-scalar,context-followup-2-array,context-followup-3-array,context-followup-4-scalar,stability-followup-1,stability-followup-2,stability-followup-3,stability-followup-4,stability-followup-5
```

After a successful local policy/sandbox preflight, `codex-tool` may be selected
within the same followup budget. The per-group attempt caps are Claude 5,
rate-limit/recovery 4, scalar/array comparisons 4, observation 5, and Codex shell 2.
Followup requests permit only Luna with explicit low reasoning. Additional caps
are persisted in the budget directory and cannot be increased on continuation or
reset by choosing another source evidence directory. Retain `--budget-dir` on
every continuation. The original cumulative limits also apply.

The five observation samples use a five-minute window and a 60-second response
header deadline, matching the production default. Historical failures and the
original 30-second timeout remain evidence. A failed diagnostic case can still
make the command exit 1 after the repaired features pass. New reports distinguish
the current source snapshot and additional consumption from historical totals.

## Evidence and interpretation

The 2026-09-30 client follow-up keeps Claude's full built-in tool descriptions
using isolated standard mode instead of `--bare`. User settings, MCP, skills and
session persistence remain isolated. This restores the Read line-number display
contract; it does not certify any model's exact final answer. Messages-to-Responses
now explicitly defaults tools to `strict: false`, preserving optional parameters
and any caller's explicit strict value. Empty model-generated `pages` values are
not rewritten and final answers are not stripped.

Before a live selection containing `codex-tool` (including the matrix), the
runner executes `repros/codex-tool-admission.ts` against a loopback-only synthetic
upstream. Failure stops before authentication, proxy startup or any paid request.
The preflight requires a real tool output with the marker and exit code zero;
client exit zero alone is insufficient. It uses the same read-only/never and
isolated-home configuration as the live case, with an explicit elevated Windows
sandbox because `--ignore-user-config` omits the user's backend setting. Client
homes live under git-ignored `tests/_runlog/client-fixtures` to allow Codex helper
creation outside TEMP. Windows may initialize its sandbox for a fresh home; the
synthetic cell waits up to 60 seconds before returning. CLI help or a direct
sandbox test cannot substitute for this gate. Historical stops and ledger
entries remain. `--legacy-no-sandbox` on the standalone repro retains the old
configuration as a diagnostic control; it is never passed by live acceptance.

Each output directory contains the machine-readable result, durable per-attempt
ledger, production-source manifest, offline check logs, resource observations,
native diagnostics and usage summary, and a Markdown report. No raw credential,
prompt, response ciphertext, or existing user transcript is part of the report.

Model choice, low effort, output caps, endpoint, case ID, and attempts are observed
at egress. The observer forwards response bytes and propagates cancellation.
Its own offline tests verify budget concurrency/reload and stream transparency.

New findings should first be classified as fixture, client, model behavior,
upstream capability, or proxy contract failures. Add an isolated offline
reproduction when possible. Never convert missing usage into zero, count B7's
historical expected failure as a fixed feature, or claim a real fallback/Anthropic test from
a synthetic catalog.

Sources: [Copilot pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing),
[reasoning output limits](https://developers.openai.com/api/docs/guides/reasoning#controlling-costs),
[VS Code account preferences](https://code.visualstudio.com/docs/setup/copilot#_use-a-different-github-account-per-workspace-or-profile).
