import { expect, test } from "bun:test"

import { clientVerdict, projectClientEvents } from "./local-client-evidence"

test("random marker evidence requires the matching real Read result and final answer", () => {
  const marker = "LATEST_TOOL_UNPREDICTABLE"
  const events = [
    {
      message: {
        content: [
          {
            type: "tool_use",
            id: "read",
            name: "Read",
            input: { file_path: "marker.txt" },
          },
        ],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read",
            is_error: false,
            content: marker,
          },
        ],
      },
    },
    { type: "result", result: marker },
  ]
  expect(
    clientVerdict("claude", projectClientEvents(events, marker)).exactFinal,
  ).toBe(true)
  expect(
    clientVerdict("claude", projectClientEvents(events, "OTHER")).toolExecution,
  ).toBe(false)
  expect(
    clientVerdict("claude", projectClientEvents(events.slice(0, 2), marker))
      .exactFinal,
  ).toBe(false)
})
