import { copilotFetch } from "./copilot-fetch"

export const getModels = async () => {
  const response = await copilotFetch("/models")
  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  dimensions?: boolean
  // Per-model reasoning levels (e.g. ["none","low","medium","high","xhigh","max"]).
  // Differs per model; used to clamp thinking/effort to what the model accepts.
  reasoning_effort?: Array<string>
  // Whether the model accepts `thinking: {type:"adaptive"}` — the ONLY thinking
  // shape the Copilot backend takes (it rejects Anthropic's `type:"enabled"`).
  // False/absent for e.g. claude-haiku-4.5, which advertises no effort set either.
  adaptive_thinking?: boolean
  min_thinking_budget?: number
  max_thinking_budget?: number
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  // Egress endpoints the model accepts, e.g. ["/responses", "ws:/responses"] or
  // ["/v1/messages", "/chat/completions"]. Some models (gpt-5.3-codex, gpt-5.5) are
  // /responses-only and 400 on /chat/completions; the endpoint router reads this.
  supported_endpoints?: Array<string>
}
