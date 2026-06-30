import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  // The Copilot upstream can intermittently reset fresh TLS handshakes, which
  // makes a single boot-time GET /models flap and crash the process before it
  // can serve. Retry with linear backoff so a fresh proxy survives a transient
  // reset window instead of dying at startup.
  const MAX_ATTEMPTS = 5
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      state.models = await getModels()
      return
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = attempt * 1000
        consola.warn(
          `cacheModels: attempt ${attempt}/${MAX_ATTEMPTS} failed (${String(error)}); retrying in ${backoffMs}ms`,
        )
        await sleep(backoffMs)
      }
    }
  }
  throw lastError
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
