# Six-model acceptance — 2026-10-02

The six-model run completed 34/34 scenarios using 52 upstream attempts and 2.68
minutes of active live time. Conservative credit reservations were 342.495428,
within the reviewed ceiling of 500 credits, 60 attempts and 45 minutes. The
admission guard enforced a 450-credit limit. Reservations are bounds, not account debits.

| Model | Scenarios passed | Attempts | Input/output usage coverage |
| --- | ---: | ---: | ---: |
| gpt-6-luna | 4/4 | 6 | 6/6 |
| gpt-5.6-luna | 14/14 | 22 | 21/22 |
| gpt-6-sol | 4/4 | 6 | 6/6 |
| gpt-6.1-sol | 4/4 | 6 | 6/6 |
| gpt-5.6-terra | 4/4 | 6 | 6/6 |
| gpt-6-astra | 4/4 | 6 | 6/6 |

All models used low reasoning and passed native Responses JSON, Messages bridge
JSON, an actual Codex read-only shell turn and an actual Claude Code Read turn.
The client workflows also exercised both streaming protocols. Luna additionally
passed parallel tool replay, six cache requests, cancellation followed by recovery,
Bridge refresh, and seed/fork/two independent resumes/restart/resume. Fault,
fallback and native Messages contracts were exercised offline, not certified live.

The cancelled stream had unknown usage; that is not a zero-cost observation.
The off and prefix-v1 cache arms each reported 66,277,000 nano-AIU for three calls.
Both reused 2182/2185 input tokens on exact repeats and 2169/2185 after changing
the final question. This small experiment establishes no incremental prefix-v1
savings; retain the default policy off. Upstream metering is not an audited
account deduction.

Fresh Codex homes initially waited for Windows administrator-approved sandbox
provisioning. The run reused a synthetic home initialized during its offline
preflight, retaining the read-only/elevated sandbox and approval never. Threads
were independent; Claude configuration homes remained separate.

One byte-equivalent diagnostic summary was replayed by the logger under the next
case context. Evidence-only verification deduplicated it by request ID, preserving
the first association and rejecting conflicting payloads. All 52 unique request
observations, both ingress sources and six cache-policy/prefix observations were
verified without replaying paid calls. The original live report was retained.

Live execution source SHA-256:
`9e3c5a0aae08aecc8a704c4a8817c011d80311a31f3f7cf92e83c531222b5b85`.
The final 2026-10-02 code checks passed 676 tests, typecheck, build and related lint.
This is historical evidence for that snapshot, not certification of later source
changes or the subsequently bundled Bridge 0.3.1 extension.

Only this sanitized summary is versioned. Raw logs, authorization, budget ledger,
client homes, session history and sandbox state stay in git-ignored local output.
