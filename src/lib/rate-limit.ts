import type { State } from "./state"

import { HTTPError } from "./error"

export interface RateLimitClock {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => () => void
}

interface Waiter {
  admit: () => void
  reject: (reason: unknown) => void
  cleanup: () => void
}

interface Queue {
  waiters: Array<Waiter>
  cancelTimer?: () => void
}

const systemClock: RateLimitClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** One FIFO admission queue per State; only admitted requests consume an interval. */
export function createRateLimitChecker(clock: RateLimitClock = systemClock) {
  const queues = new WeakMap<State, Queue>()

  function drain(state: State, queue: Queue) {
    queue.cancelTimer?.()
    queue.cancelTimer = undefined
    const waiter = queue.waiters.at(0)
    if (!waiter) return
    const now = clock.now()
    const interval = Math.max(0, (state.rateLimitSeconds ?? 0) * 1000)
    const delay =
      state.lastRequestTimestamp === undefined ?
        0
      : state.lastRequestTimestamp + interval - now
    if (delay > 0) {
      queue.cancelTimer = clock.schedule(() => drain(state, queue), delay)
      return
    }
    queue.waiters.shift()
    waiter.cleanup()
    state.lastRequestTimestamp = now
    waiter.admit()
    if (queue.waiters.length > 0) drain(state, queue)
  }

  return async (state: State, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    if (state.rateLimitSeconds === undefined || state.rateLimitSeconds === 0)
      return
    if (!Number.isFinite(state.rateLimitSeconds) || state.rateLimitSeconds < 0)
      throw new Error("Rate limit must be a finite non-negative number")
    let queue = queues.get(state)
    if (!queue) {
      queue = { waiters: [] }
      queues.set(state, queue)
    }
    if (
      !state.rateLimitWait
      && (queue.waiters.length > 0
        || (state.lastRequestTimestamp !== undefined
          && clock.now()
            < state.lastRequestTimestamp + state.rateLimitSeconds * 1000))
    ) {
      throw new HTTPError(
        "Rate limit exceeded",
        Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
      )
    }
    const activeQueue = queue
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        admit: resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      }
      const abort = () => {
        const index = activeQueue.waiters.indexOf(waiter)
        if (index === -1) return
        activeQueue.waiters.splice(index, 1)
        waiter.cleanup()
        waiter.reject(
          signal?.reason ?? new DOMException("Request cancelled", "AbortError"),
        )
        drain(state, activeQueue)
      }
      activeQueue.waiters.push(waiter)
      signal?.addEventListener("abort", abort, { once: true })
      drain(state, activeQueue)
    })
  }
}

export const checkRateLimit = createRateLimitChecker()
