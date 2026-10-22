import { expect, test } from "bun:test"

import { preserveStreamingRequest } from "../src/routes/_shared/streaming-request"

test("only boolean stream:true disables Bun timeout on the original request", () => {
  const calls: Array<[Request, number]> = []
  const request = Object.assign(new Request("http://localhost/v1/messages"), {
    runtime: {
      bun: {
        server: {
          timeout: (raw: Request, seconds: number) =>
            calls.push([raw, seconds]),
        },
      },
    },
  })
  for (const stream of [undefined, false, null, "true", 1])
    preserveStreamingRequest(request, { stream })
  expect(calls).toEqual([])
  preserveStreamingRequest(request, { stream: true })
  expect(calls).toEqual([[request, 0]])
})

test("streaming protection tolerates requests without a Bun runtime", () => {
  expect(() =>
    preserveStreamingRequest(new Request("http://localhost"), { stream: true }),
  ).not.toThrow()
})
