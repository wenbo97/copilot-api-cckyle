import { cacheFingerprint } from "~/lib/cache-fingerprint"
import {
  type CacheIngressProtocol,
  inspectCacheIntent,
} from "~/lib/cache-intent"

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function atPath(body: unknown, path: string): unknown {
  let value = body
  for (const component of path.replaceAll(/\[(\d+)\]/gu, ".$1").split("."))
    value =
      Array.isArray(value) ? value[Number(component)] : record(value)[component]
  return value
}

/** Values are restricted enums or keyed digests, including malformed hints. */
export function cacheHintObservation(
  payload: unknown,
  protocol: CacheIngressProtocol,
) {
  const intent = inspectCacheIntent(payload, protocol)
  return {
    intent,
    fields: intent.paths.map((path) => {
      const value = atPath(payload, path)
      const item = record(value)
      const control = path.endsWith("cache_control")
      const options = path === "prompt_cache_options"
      const mode = item[control ? "type" : "mode"]
      const modes = control ? ["ephemeral"] : ["explicit"]
      if (options) modes.push("implicit")
      const ttls = control ? ["1h", "5m"] : []
      if (options) ttls.push("30m")
      return {
        path,
        fingerprint: cacheFingerprint(value),
        mode: recognized(mode, modes),
        ttl: recognized(item.ttl, ttls),
        retention:
          (
            path === "prompt_cache_retention"
            && typeof value === "string"
            && ["24h", "in_memory"].includes(value)
          ) ?
            value
          : null,
      }
    }),
  }
}

function recognized(value: unknown, allowed: Array<string>) {
  return typeof value === "string" && allowed.includes(value) ? value : null
}

export type CacheHintObservation = ReturnType<typeof cacheHintObservation>

export function compareCacheHints(
  ingress: CacheHintObservation,
  egress: CacheHintObservation,
) {
  const paths = new Set(
    [...ingress.fields, ...egress.fields].map((field) => field.path),
  )
  return {
    ingress,
    egress,
    changes: [...paths].map((path) => {
      const before = ingress.fields.find((field) => field.path === path)
      const after = egress.fields.find((field) => field.path === path)
      let action = "changed"
      if (!before) action = "added"
      else if (!after) action = "removed"
      else if (before.fingerprint === after.fingerprint) action = "preserved"
      return {
        path,
        action,
      }
    }),
    incomplete: ingress.intent.truncated || egress.intent.truncated,
  }
}
