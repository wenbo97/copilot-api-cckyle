#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import path from "node:path"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import {
  validateModelMappings,
  validateRequiredResponsesModels,
} from "./lib/model-identity"
import { getModelMappings } from "./lib/model-mapping"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import {
  setupCopilotToken,
  setupGitHubToken,
  tryVscodeProxyToken,
} from "./lib/token"
import { ensureTraceFolder } from "./lib/trace"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  trace: boolean
  traceFolder?: string
}

export function createListenOptions(
  port: number,
  idleTimeout: number,
): Parameters<typeof serve>[0] {
  return {
    fetch: server.fetch as ServerHandler,
    hostname: "127.0.0.1",
    port,
    bun: {
      idleTimeout,
    },
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    state.verbose = true
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  // Configure tracing
  if (options.trace) {
    state.traceEnabled = true
    // Use provided folder, env variable, or default to ./traces
    state.traceFolder =
      options.traceFolder
      || process.env.TRACE_OUTPUT_FOLDER
      || path.join(process.cwd(), "traces")
    consola.info(`Tracing enabled. Logs will be saved to: ${state.traceFolder}`)
    await ensureTraceFolder()
  }

  await ensurePaths()
  await cacheVSCodeVersion()

  // Try VS Code proxy first — skip GitHub auth entirely if it works
  const proxyOk = await tryVscodeProxyToken()
  if (!proxyOk) {
    if (options.githubToken) {
      // eslint-disable-next-line require-atomic-updates -- intentional assignment of provided token
      state.githubToken = options.githubToken
      consola.info("Using provided GitHub token")
    } else {
      await setupGitHubToken()
    }

    await setupCopilotToken()
  }
  await cacheModels()

  // Warn early if any MODEL_MAPPINGS target is absent from the loaded catalog.
  validateModelMappings()
  validateRequiredResponsesModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const mappings = getModelMappings()
  if (mappings.size > 0) {
    const mappingLines = Array.from(mappings.entries())
      .map(([source, target]) => `  ${source} -> ${target}`)
      .join("\n")
    consola.info(`Model mappings:\n${mappingLines}`)
  }

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  const idleTimeout =
    process.env.IDLE_TIMEOUT ?
      Number.parseInt(process.env.IDLE_TIMEOUT, 10)
    : 255

  serve(createListenOptions(options.port, idleTimeout))
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    trace: {
      alias: "t",
      type: "boolean",
      default: false,
      description:
        "Enable tracing to log all LLM requests and responses to files",
    },
    "trace-folder": {
      type: "string",
      description:
        "Folder to save trace files (defaults to TRACE_OUTPUT_FOLDER env var or ./traces)",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      trace: args.trace,
      traceFolder: args["trace-folder"],
    })
  },
})
