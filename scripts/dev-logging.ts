import consola, { LogLevels } from "consola"
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { formatWithOptions, stripVTControlCharacters } from "node:util"

/** Keep development diagnostics in a file without flooding the console. */
export function configureDevLogging(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true })
  const file = openSync(logPath, "a+")
  process.once("exit", () => closeSync(file))

  // Windows PowerShell's Tee-Object created UTF-16LE logs. Keep appending in
  // their original encoding; new logs use UTF-8.
  const header = Buffer.alloc(2)
  readSync(file, header, 0, header.length, 0)
  const encoding = header[0] === 0xff && header[1] === 0xfe ? "utf16le" : "utf8"

  const consoleReporters = [...consola.options.reporters]
  consola.setReporters([
    {
      log(log, context) {
        const args: Array<unknown> = log.args
        const message = stripVTControlCharacters(
          formatWithOptions({ colors: false }, ...args),
        )
        const tag = log.tag ? ` [${log.tag}]` : ""
        // Synchronous writes also preserve the final error on process.exit().
        writeSync(
          file,
          Buffer.from(
            `${log.date.toISOString()} [${log.type}]${tag} ${message}\n`,
            encoding,
          ),
        )

        if (log.level <= LogLevels.info)
          for (const reporter of consoleReporters) reporter.log(log, context)
      },
    },
  ])
  consola.level = LogLevels.debug
  // Includes Hono's access log and existing console.error calls.
  consola.wrapConsole()
}
