import { expect, test } from "bun:test"

import type { Json } from "./local-budget"

import { validateLatestDiagnostics } from "./local-latest-diagnostics"

function fixture(): Array<Json> {
  const rows: Array<Json> = [
    {
      caseId: "bridge",
      summary: {
        schema_version: 2,
        model: "gpt-5.6-luna",
        source: "messages_to_responses",
        attempt_details: [],
        request_id: "bridge",
      },
    },
  ]
  for (const group of ["control", "prefix"])
    for (const kind of ["initial", "repeat", "suffix"])
      rows.push({
        caseId: `latest-gpt-5.6-luna-cache-${group}-${kind}`,
        summary: {
          schema_version: 2,
          model: "gpt-5.6-luna",
          source: "native_responses",
          attempt_details: [],
          request_id: `${group}-${kind}`,
          cache_policy: {
            status: group === "control" ? "disabled" : "applied",
            breakpoint_added: group === "prefix",
            key_source: "generated",
          },
          egress_static_prefix: { fingerprint: "static" },
          egress_fingerprints: {
            input: kind === "suffix" ? "changed" : "original",
          },
        },
      })
  return rows
}
test("latest diagnostics require both ingress sources and actual correlated cache policy", () => {
  expect(
    validateLatestDiagnostics(fixture(), ["gpt-5.6-luna"], "secret")
      .cachePoliciesVerified,
  ).toBe(true)
  expect(() =>
    validateLatestDiagnostics(fixture().slice(1), ["gpt-5.6-luna"], "secret"),
  ).toThrow("native/bridge")
  expect(() =>
    validateLatestDiagnostics(
      fixture().slice(0, -1),
      ["gpt-5.6-luna"],
      "secret",
    ),
  ).toThrow("correlation")
  const rows = fixture()
  const summary = rows.at(-1)?.summary as Json
  summary.cache_policy = { status: "disabled" }
  expect(() =>
    validateLatestDiagnostics(rows, ["gpt-5.6-luna"], "secret"),
  ).toThrow("policy")
})

test("identical logger replays retain first correlation while conflicting duplicates fail", () => {
  const rows = fixture()
  const original = rows[4]
  const replay: Json = {
    ...structuredClone(original),
    caseId: "latest-gpt-5.6-luna-cache-prefix-repeat",
  }
  rows.splice(5, 0, replay)
  expect(
    validateLatestDiagnostics(rows, ["gpt-5.6-luna"], "secret")
      .identicalReplays,
  ).toBe(1)
  ;(replay.summary as Json).output_tokens = 999
  expect(() =>
    validateLatestDiagnostics(rows, ["gpt-5.6-luna"], "secret"),
  ).toThrow("Conflicting duplicate")
})
