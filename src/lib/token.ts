import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"
import { sleep } from "./utils"

const DEFAULT_VSCODE_PROXY_PORT = 18774

function readVscodeProxyPort(): number {
  const raw = process.env.VSCODE_PROXY_PORT
  if (raw === undefined || raw === "") return DEFAULT_VSCODE_PROXY_PORT
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  consola.warn(
    `Invalid VSCODE_PROXY_PORT="${raw}", using default ${DEFAULT_VSCODE_PROXY_PORT}`,
  )
  return DEFAULT_VSCODE_PROXY_PORT
}

const VSCODE_PROXY_PORT = readVscodeProxyPort()
const VSCODE_PROXY_TOKEN_URL = `http://127.0.0.1:${VSCODE_PROXY_PORT}/token`

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

let refreshTimer: ReturnType<typeof setTimeout> | null = null

// If a refresh is already in progress, subsequent callers share the same promise
let refreshPromise: Promise<void> | null = null

// Track consecutive failures for exponential backoff
let consecutiveFailures = 0
const MAX_RETRY_DELAY_S = 600 // 10 minutes max backoff
const MIN_RETRY_DELAY_S = 15

function applyCopilotToken(token: string, expires_at: number) {
  state.copilotToken = token
  state.copilotTokenExpiresAt = expires_at
  consecutiveFailures = 0
}

function getRetryDelay(): number {
  // Exponential backoff: 15s, 30s, 60s, 120s, 240s, 600s (capped)
  const delay = Math.min(
    MIN_RETRY_DELAY_S * Math.pow(2, consecutiveFailures),
    MAX_RETRY_DELAY_S,
  )
  return delay
}

function scheduleRefresh(refresh_in: number) {
  if (refreshTimer) clearTimeout(refreshTimer)

  // Use the EARLIER of: (refresh_in - 60s) or (expires_at - now - 60s)
  // This ensures we refresh before the token actually expires
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = state.copilotTokenExpiresAt ?? 0
  const timeUntilExpiry = expiresAt - now

  const delayFromRefreshIn = Math.max((refresh_in - 60) * 1000, 30_000)
  const delayFromExpiry = Math.max((timeUntilExpiry - 60) * 1000, 30_000)
  const delayMs = Math.min(delayFromRefreshIn, delayFromExpiry)

  consola.debug(`Next copilot token refresh in ${Math.round(delayMs / 1000)}s`)

  refreshTimer = setTimeout(() => {
    if (!refreshPromise) {
      refreshPromise = refreshCopilotToken().finally(() => {
        refreshPromise = null
      })
    }
    refreshPromise.catch((err: unknown) => {
      consola.error("Unhandled error in background token refresh:", err)
    })
  }, delayMs)
}

async function fetchCopilotTokenWithRetry(): Promise<{
  token: string
  refresh_in: number
  expires_at: number
}> {
  // Try up to 3 times with short delays for transient failures
  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getCopilotToken()
    } catch (error) {
      lastError = error
      const is401 = error instanceof HTTPError && error.response.status === 401

      if (attempt < maxAttempts) {
        // Short delay between retries (1s, 2s) for transient issues
        const retryMs = attempt * 1000
        consola.warn(
          `Copilot token fetch attempt ${attempt}/${maxAttempts} failed`
            + `${is401 ? " (401)" : ""}, retrying in ${retryMs}ms...`,
        )
        await sleep(retryMs)
      }
    }
  }

  throw lastError
}

async function fetchTokenFromVscodeProxy(): Promise<{
  token: string
  refresh_in: number
  expires_at: number
  sku?: string
} | null> {
  try {
    const response = await fetch(VSCODE_PROXY_TOKEN_URL, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as {
      token: string
      refresh_in: number
      expires_at: number
      sku?: string
    }
    if (data.token && data.expires_at) {
      return data
    }
    return null
  } catch {
    return null
  }
}

async function refreshCopilotToken(): Promise<void> {
  consola.debug("Refreshing Copilot token")

  // If no GitHub token (proxy-only mode), skip straight to VS Code proxy
  if (!state.githubToken) {
    consola.debug("No GitHub token, trying VS Code proxy directly")
    const proxyResult = await fetchTokenFromVscodeProxy()
    if (proxyResult) {
      applyCopilotToken(proxyResult.token, proxyResult.expires_at)
      if (proxyResult.sku?.includes("enterprise")) {
        // eslint-disable-next-line require-atomic-updates -- intentional update of account type
        state.accountType = "enterprise"
      }
      consola.success("Copilot token refreshed from VS Code proxy")
      scheduleRefresh(proxyResult.refresh_in)
      return
    }
    consecutiveFailures++
    const retryDelay = getRetryDelay()
    consola.error(`VS Code proxy unavailable, will retry in ${retryDelay}s`)
    scheduleRefresh(retryDelay)
    return
  }

  // Attempt 1: fetch with built-in retries using current GitHub token
  try {
    const { token, refresh_in, expires_at } = await fetchCopilotTokenWithRetry()
    applyCopilotToken(token, expires_at)
    consola.debug("Copilot token refreshed")
    if (state.showToken) {
      consola.info("Refreshed Copilot token:", token)
    }
    scheduleRefresh(refresh_in)
    return
  } catch (error) {
    consola.error("Failed to refresh Copilot token:", error)

    if (!(error instanceof HTTPError) || error.response.status !== 401) {
      consecutiveFailures++
      const retryDelay = getRetryDelay()
      consola.warn(
        `Transient error, will retry in ${retryDelay}s `
          + `(failure #${consecutiveFailures})`,
      )
      scheduleRefresh(retryDelay)
      return
    }
  }

  // Attempt 2: re-read GitHub token from disk (may have been refreshed externally)
  consola.warn("All retries returned 401, re-reading GitHub token from disk...")
  try {
    const diskToken = await readGithubToken()
    if (diskToken && diskToken !== state.githubToken) {
      state.githubToken = diskToken
      consola.debug("Found different GitHub token on disk, retrying")
      const { token, refresh_in, expires_at } =
        await fetchCopilotTokenWithRetry()
      applyCopilotToken(token, expires_at)
      consola.success("Copilot token refreshed with disk GitHub token")
      scheduleRefresh(refresh_in)
      return
    } else {
      consola.debug("Disk token is same as current token")
    }
  } catch (retryError) {
    consola.error("Retry with disk token also failed:", retryError)
  }

  // Attempt 3: try VS Code proxy (if VS Code extension is running)
  consola.warn("Trying VS Code proxy for token...")
  const proxyResult = await fetchTokenFromVscodeProxy()
  if (proxyResult) {
    applyCopilotToken(proxyResult.token, proxyResult.expires_at)
    if (proxyResult.sku?.includes("enterprise")) {
      // eslint-disable-next-line require-atomic-updates -- intentional update of account type
      state.accountType = "enterprise"
    }
    consola.success("Copilot token obtained from VS Code proxy")
    scheduleRefresh(proxyResult.refresh_in)
    return
  }
  consola.debug("VS Code proxy not available or returned no token")

  // Attempt 4: validate whether the GitHub token itself is still good
  consola.warn("Validating GitHub token against /user endpoint...")
  try {
    const user = await getGitHubUser()
    consola.info(
      `GitHub token is still valid (user: ${user.login}). `
        + `Copilot endpoint may be temporarily unavailable.`,
    )
    consecutiveFailures++
    const retryDelay = getRetryDelay()
    consola.warn(
      `Will retry in ${retryDelay}s (failure #${consecutiveFailures})`,
    )
    scheduleRefresh(retryDelay)
  } catch {
    consecutiveFailures++
    const retryDelay = getRetryDelay()
    consola.error(
      "GitHub token is invalid. Please re-authenticate.\n"
        + `  Run: re-auth.cmd\n`
        + `  Will keep retrying every ${retryDelay}s in case token is refreshed externally.`,
    )
    // eslint-disable-next-line require-atomic-updates -- intentional clear of stale token
    state.copilotToken = undefined
    // eslint-disable-next-line require-atomic-updates -- intentional clear of stale expiry
    state.copilotTokenExpiresAt = undefined
    scheduleRefresh(retryDelay)
  }
}

/**
 * Called before each request to ensure the copilot token is still valid.
 * If the token is expired or about to expire (within 60s), refresh it on-demand.
 * If no token exists at all (after a failure), force a refresh attempt.
 * Multiple concurrent callers share a single refresh attempt.
 */
export async function ensureCopilotToken(force = false): Promise<void> {
  if (!force && state.copilotToken) {
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = state.copilotTokenExpiresAt ?? 0

    // Token still valid for at least 60s
    if (expiresAt - now > 60) {
      return
    }
  }

  consola.warn(
    state.copilotToken ?
      "Copilot token expired or expiring soon, refreshing on-demand"
    : "No valid Copilot token, attempting refresh",
  )

  // Coalesce concurrent refresh attempts into one
  if (!refreshPromise) {
    refreshPromise = refreshCopilotToken().finally(() => {
      refreshPromise = null
    })
  }

  await refreshPromise

  // After the refresh attempt, verify we actually have a valid token.
  // If refreshCopilotToken failed and cleared the token, throw so the
  // caller can return an error to the client instead of silently proceeding.
  if (!state.copilotToken) {
    throw new Error(
      "Copilot token refresh failed. GitHub token may be invalid — re-authenticate.",
    )
  }
}

export async function tryVscodeProxyToken(): Promise<boolean> {
  consola.debug("Trying VS Code proxy for initial token...")
  const result = await fetchTokenFromVscodeProxy()
  if (result) {
    applyCopilotToken(result.token, result.expires_at)
    if (result.sku?.includes("enterprise")) {
      state.accountType = "enterprise"
      consola.info("Detected enterprise account from VS Code proxy")
    }
    consola.success(
      "Copilot token obtained from VS Code proxy (skipping GitHub auth)",
    )
    scheduleRefresh(result.refresh_in)
    return true
  }
  consola.debug("VS Code proxy not available, falling back to normal auth")
  return false
}

export const setupCopilotToken = async () => {
  try {
    const { token, refresh_in, expires_at } = await getCopilotToken()
    applyCopilotToken(token, expires_at)

    consola.debug("GitHub Copilot Token fetched successfully!")
    if (state.showToken) {
      consola.info("Copilot token:", token)
    }

    scheduleRefresh(refresh_in)
  } catch (error) {
    consola.warn(
      "Failed to fetch Copilot token normally, trying VS Code proxy...",
    )
    const proxyResult = await fetchTokenFromVscodeProxy()
    if (proxyResult) {
      applyCopilotToken(proxyResult.token, proxyResult.expires_at)
      if (proxyResult.sku?.includes("enterprise")) {
        // eslint-disable-next-line require-atomic-updates -- intentional update of account type
        state.accountType = "enterprise"
      }
      consola.success("Copilot token obtained from VS Code proxy")
      scheduleRefresh(proxyResult.refresh_in)
      return
    }
    throw error
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }

      // Always validate the token on startup
      try {
        await logUser()
      } catch {
        consola.warn(
          "Stored GitHub token failed validation, requesting new one",
        )
        // Fall through to device code flow
        await runDeviceCodeFlow()
        return
      }

      return
    }

    // When force=true, validate the existing token before starting device code flow.
    if (githubToken && options?.force) {
      state.githubToken = githubToken
      try {
        await logUser()
        consola.info("Existing GitHub token is still valid, reusing it")
        if (state.showToken) {
          consola.info("GitHub token:", githubToken)
        }
        return
      } catch {
        consola.warn(
          "Existing GitHub token failed validation, requesting new one",
        )
        // Fall through to device code flow below
      }
    }

    await runDeviceCodeFlow()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function runDeviceCodeFlow(): Promise<void> {
  consola.info("Not logged in, getting new access token")
  const response = await getDeviceCode()
  consola.debug("Device code response:", response)

  consola.info(
    `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
  )

  const token = await pollAccessToken(response)
  await writeGithubToken(token)
  state.githubToken = token

  if (state.showToken) {
    consola.info("GitHub token:", token)
  }
  await logUser()
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
