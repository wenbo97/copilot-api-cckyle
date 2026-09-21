import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  // Internal overrides used by isolated acceptance processes. Normal startup
  // uses the application data directory and the actual Copilot endpoint.
  responsesHistoryDirectory?: string
  responsesHistoryScope?: string
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiresAt?: number // Unix timestamp (seconds) when copilot token expires

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean
  verbose: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Trace configuration
  traceEnabled: boolean
  traceFolder?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  traceEnabled: false,
}
