import { state } from "./state"

/**
 * Decide which Copilot egress endpoint a model accepts, from the live catalog.
 *
 * The Copilot `/models` catalog carries a `supported_endpoints` array per model.
 * Some models (e.g. `gpt-5.3-codex`, `gpt-5.5`) are `/responses`-ONLY and 400 with
 * `unsupported_api_for_model` on `/chat/completions`. Inbound handlers call this to
 * pick the egress verb (native `/responses` passthrough vs translate-down to
 * `/chat/completions`) instead of unconditionally translating everything down.
 *
 * This is a pure capability check against `state.models` — each handler applies its
 * own preference. Endpoints are matched exactly, with the leading slash as the
 * catalog stores them (e.g. `"/responses"`, NOT `"responses"`).
 */
export function modelSupportsEndpoint(
  modelId: string,
  endpoint: string,
): boolean {
  return (
    state.models?.data
      .find((model) => model.id === modelId)
      ?.supported_endpoints?.includes(endpoint) ?? false
  )
}
