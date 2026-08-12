import type { ProviderPreset } from '@deskpet/llm-openai'

export interface DeskPetConfig {
  openaiApiKey: string
  baseURL?: string
  provider?: ProviderPreset
  model: string
  systemPrompt?: string
  maxHistory?: number
  defaultSession?: string
  memoryEnabled?: boolean
  memoryPath?: string
  memoryOwnerId?: string
  embeddingApiKey?: string
  embeddingBaseURL?: string
  embeddingModel?: string
  tools?: string[]
}

export function loadConfig(): DeskPetConfig {
  const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY || ''
  if (!apiKey) {
    console.error('[deskpet] Set OPENAI_API_KEY environment variable')
    process.exit(1)
  }

  return {
    openaiApiKey: apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    provider: (process.env.DESKPET_PROVIDER as ProviderPreset) || undefined,
    model: process.env.DESKPET_MODEL || 'gpt-4o-mini',
    systemPrompt: process.env.DESKPET_SYSTEM_PROMPT,
    maxHistory: process.env.DESKPET_MAX_HISTORY ? Number(process.env.DESKPET_MAX_HISTORY) : 100,
    defaultSession: process.env.DESKPET_SESSION || 'default',
    memoryEnabled: process.env.DESKPET_MEMORY !== 'false',
    memoryPath: process.env.DESKPET_MEMORY_PATH,
    memoryOwnerId: process.env.DESKPET_MEMORY_OWNER || 'local-user',
    embeddingApiKey: process.env.DESKPET_EMBEDDING_API_KEY || apiKey,
    embeddingBaseURL: process.env.DESKPET_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    embeddingModel: process.env.DESKPET_EMBEDDING_MODEL || 'local-hash-v2',
    tools: process.env.DESKPET_TOOLS ? process.env.DESKPET_TOOLS.split(',').map(t => t.trim()) : undefined,
  }
}
