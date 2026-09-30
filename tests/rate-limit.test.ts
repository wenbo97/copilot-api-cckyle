import { expect, test } from "bun:test"

import type { State } from "~/lib/state"

import { createRateLimitChecker, type RateLimitClock } from "~/lib/rate-limit"

class Clock implements RateLimitClock {
  time = 0
  tasks = new Map<number, { at: number; callback: () => void }>()
  next = 0
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const id = this.next++
    this.tasks.set(id, { at: this.time + delay, callback })
    return () => {
      this.tasks.delete(id)
    }
  }
  advance(ms: number) {
    const target = this.time + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .at(0)
      if (!next || next[1].at > target) break
      this.time = next[1].at
      this.tasks.delete(next[0])
      next[1].callback()
    }
    this.time = target
  }
}

function limited(): State {
  return {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: true,
    showToken: false,
    verbose: false,
    traceEnabled: false,
    rateLimitSeconds: 1,
  }
}

test("FIFO admissions use complete intervals, including an initial timestamp of zero", async () => {
  const clock = new Clock()
  const check = createRateLimitChecker(clock)
  const state = limited()
  await check(state)
  const order: Array<number> = []
  const second = check(state).then(() => order.push(2))
  const third = check(state).then(() => order.push(3))
  clock.advance(999)
  expect(order).toEqual([])
  clock.advance(1)
  await second
  expect(order).toEqual([2])
  expect(state.lastRequestTimestamp).toBe(1000)
  clock.advance(1000)
  await third
  expect(order).toEqual([2, 3])
  expect(state.lastRequestTimestamp).toBe(2000)
  expect(clock.tasks.size).toBe(0)
})

for (const cancelledIndex of [0, 1]) {
  test(`cancelled waiter ${cancelledIndex} releases its place without cancelling survivors`, async () => {
    const clock = new Clock()
    const check = createRateLimitChecker(clock)
    const state = limited()
    await check(state)
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ]
    const admitted: Array<number> = []
    const pending = controllers.map((controller, index) =>
      check(state, controller.signal).then(
        () => {
          admitted.push(index)
          return "admitted"
        },
        () => "cancelled",
      ),
    )
    controllers[cancelledIndex].abort()
    expect(await pending[cancelledIndex]).toBe("cancelled")
    clock.advance(1000)
    const first = cancelledIndex === 0 ? 1 : 0
    await pending[first]
    expect(admitted).toEqual([first])
    clock.advance(1000)
    await Promise.all(pending)
    expect(admitted).toEqual([first, 2])
    expect(clock.tasks.size).toBe(0)
  })
}

test("pre-cancelled and sole cancelled requests consume no slots or timers", async () => {
  const clock = new Clock()
  const check = createRateLimitChecker(clock)
  const state = limited()
  expect(
    await check(state, AbortSignal.abort()).catch((error: unknown) => error),
  ).toBeDefined()
  expect(state.lastRequestTimestamp).toBeUndefined()
  await check(state)
  const controller = new AbortController()
  const pending = check(state, controller.signal).catch(() => "cancelled")
  controller.abort()
  expect(await pending).toBe("cancelled")
  expect(clock.tasks.size).toBe(0)
  expect(state.lastRequestTimestamp).toBe(0)
  clock.advance(1000)
  await check(state)
  expect(state.lastRequestTimestamp).toBe(1000)
})

test("states are independent and non-wait mode rejects until the exact boundary", async () => {
  const clock = new Clock()
  const check = createRateLimitChecker(clock)
  const first = limited()
  first.rateLimitWait = false
  const second = limited()
  await check(first)
  await check(second)
  expect(await check(first).catch((error: unknown) => error)).toMatchObject({
    response: { status: 429 },
  })
  clock.advance(1000)
  await check(first)
  expect(clock.tasks.size).toBe(0)
})

test("request preparation can shorten egress gaps without changing admission intervals", async () => {
  const clock = new Clock()
  const check = createRateLimitChecker(clock)
  const state = limited()
  await check(state)
  const admissions = [clock.now()]
  const sends: Array<number> = []
  const first = new Promise<void>((resolve) =>
    clock.schedule(() => {
      sends.push(clock.now())
      resolve()
    }, 200),
  )
  const second = check(state).then(() => {
    admissions.push(clock.now())
    sends.push(clock.now())
  })
  const third = check(state).then(() => {
    admissions.push(clock.now())
    sends.push(clock.now())
  })
  clock.advance(200)
  await first
  clock.advance(800)
  await second
  clock.advance(1000)
  await third
  expect(admissions).toEqual([0, 1000, 2000])
  expect(sends).toEqual([200, 1000, 2000])
})
