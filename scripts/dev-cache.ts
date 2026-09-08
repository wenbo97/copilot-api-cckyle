import { runMain } from "citty"

import { configureDevLogging } from "./dev-logging"

configureDevLogging("tmps/cache-session.log")

// Hono captures console.log when its middleware is created.
const { start } = await import("~/start")

await runMain(start, {
  rawArgs: ["--account-type", "enterprise", ...process.argv.slice(2)],
})
