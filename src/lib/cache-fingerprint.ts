import { createHmac, randomBytes, randomUUID } from "node:crypto"

const key = randomBytes(32)
export const cacheDiagnosticProcessScope = randomUUID()

/** Process-local equality only; never a persistent prompt or identity hash. */
export function cacheFingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex")
}
