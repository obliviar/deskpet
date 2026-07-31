/**
 * Provider configuration mapping for OpenAI-compatible APIs.
 */

export interface ProviderConfig {
  /** OpenAI API key, or a key for a compatible provider. */
  apiKey: string
  /** Base URL override (e.g. for Ollama, vLLM, OpenRouter, ...). */
  baseURL?: string
  /** Named provider preset. */
  provider?: ProviderPreset
}

/** Well-known provider presets. */
export type ProviderPreset =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'ollama'
  | 'zhipu'
  | 'moonshot'

/** Resolved connection config. */
export interface ResolvedProvider {
  apiKey: string
  baseURL: string
}

const PRESET_BASE_URLS: Record<ProviderPreset, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
}

/**
 * Resolves provider config into a concrete apiKey + baseURL pair.
 *
 * If a `provider` preset is given and `baseURL` is not explicitly set,
 * the preset's default base URL is used.
 */
export { PRESET_BASE_URLS }

export function resolveProvider(config: ProviderConfig): ResolvedProvider {
  const baseURL = config.baseURL
    ?? (config.provider ? PRESET_BASE_URLS[config.provider] : PRESET_BASE_URLS.openai)

  return { apiKey: config.apiKey, baseURL }
}