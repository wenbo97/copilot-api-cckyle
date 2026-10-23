import consola, { LogLevels } from "consola"

/**
 * Debug-log a JSON value without serializing it when debug output is off.
 * Request payloads can be megabytes, so eager `JSON.stringify` is not free.
 */
export function debugJson(
  label: string,
  value: () => unknown,
  tailChars?: number,
): void {
  if (consola.level < LogLevels.debug) return
  const json = JSON.stringify(value())
  consola.debug(
    label,
    tailChars === undefined ? json : (
      (json as string | undefined)?.slice(-tailChars)
    ),
  )
}
