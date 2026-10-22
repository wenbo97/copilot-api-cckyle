# Claude Code / OpenAI proxy acceptance

The `claude-proxy` profile uses the installed Claude Code executable with isolated
settings and persistent synthetic sessions. It targets `gpt-6.1-sol` and
`gpt-6-luna` at high effort, with a client-side 16,384 output-token cap.
The upstream guard verifies the model, effort and cap without rewriting them.

```powershell
bun --no-env-file run acceptance:local --profile claude-proxy --dry-run
bun --no-env-file run acceptance:local --profile claude-proxy --live --models gpt-6.1-sol,gpt-6-luna --effort high --max-credits 500 --max-attempts 60 --max-minutes 45 --output-dir tests/_runlog/claude-reviewed-round --approval-reference "Current account / models / budget approval reference"
```

An invocation is an independently approved round, never standing permission for
paid calls. Defaults are 500 conservatively reserved credits, 60 total upstream
attempts and 45 active live minutes, with a 450-credit admission ceiling. All
internal retries count. Existing authorized evidence directories are immutable;
the command does not silently reset or replay an interrupted paid round.

The source, scenario scopes, prices and approval reference are bound by version-6
authorization. Earlier profiles retain their low-effort and output restrictions.
Pricing was checked against the [official Copilot table](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
on 2026-10-22. Per million tokens, Sol input/write/output are $2/$2.50/$10
(long: $4/$5/$15); Luna $0.10/$0.125/$0.50 (long: $0.20/$0.25/$0.75).
Both default tiers end at 272K input tokens. These match the existing tariff
snapshot; reservations assume full input plus write price, without cache savings.
Recheck this source before a future live round. Reservations are not account debits.

Offline tests, typecheck, build, route simulation, lint and a real Claude
Read/Edit/Bash/resume exercise against a loopback mock precede paid admission.
Live cases alternate models: smoke, coding with independent tests, three resumed
turns, isolated MCP long-name/image tools, cancellation and recovery, then
controlled cache reuse. The MCP fixture records actual original-name dispatch and supplies
a randomized four-color PNG with surrounding text; the final colors and private
marker are checked independently. Only `bun test` is an
allowed shell command in the synthetic project. User homes and port 4141 are
preserved; the owned proxy uses 4142 and the current Bridge at 18774.

Cache policy remains off: prefix-v1 currently excludes both models. A real CLI
seed supplies a fixed >=8K-token numeric catalogue that fits Windows command-line
limits, followed by two identical Messages
replays and one final-user-question change. A trailing Claude system Environment
message is preserved. These transport replays are distinguished
from actual CLI workflows. Prefix fingerprints are compared within the same
proxy process. Session IDs come from the harness, not inferred prompt similarity.

Offline CLI preflight traverses the production Messages route into a simulated
Responses upstream, including real tools, resume, cache and MCP tool dispatch.
Capability admission requires high effort, streaming, tools, vision and the
16,384 output cap. The sum of per-case caps is subordinate to the one shared
60-attempt limit; adding scenarios never increases that limit.

The fast suite includes real loopback socket lifecycle checks. Run the separate
long-stream simulation with an outer deadline of at least 420 seconds:

```powershell
bun --no-env-file tests/fixtures/streaming-socket.ts --slow
```

It exercises about 330 seconds of upstream reasoning with a silent downstream
Messages bridge and the production 255-second listener setting. It verifies
completion and release; it does not establish the old default's precise failure
time. The slow simulation is deliberately outside ordinary `bun test` discovery.

Evidence includes private synthetic ingress payloads, CLI events, upstream and
downstream terminals, per-attempt reservations, diagnostics, file changes and
test results under ignored `tests/_runlog/`. Reports use paired valid input/read
counters, retain unknowns, separate final/attempt usage and deduplicate identical
diagnostic replays. Truncated responses, missing terminals, rereads during recall
and cancellation after completed generation cannot pass. A bounded run does not
certify production availability, very long thinking periods or account charges.
