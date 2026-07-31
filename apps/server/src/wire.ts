import { createAgentRuntime } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createSessionManager } from '@deskpet/core'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

/**
 * Wire function: assembles the full agent runtime with implementations injected.
 *
 * This is the composition root — the only place where concrete implementations
 * are coupled to the runtime.
 */
export interface WireOptions {
  apiKey: string
  model?: string
  systemPrompt?: string
  memoryEnabled?: boolean
}

export function wireAgent(options: WireOptions) {
  const { apiKey, model = 'gpt-4o-mini', systemPrompt, memoryEnabled = true } = options

  const llm = createOpenAILlm({ apiKey })
  const session = createSessionManager(200)

  let memory
  if (memoryEnabled) {
    const store = createVectorStore({ apiKey })
    memory = createMemoryWriter({ store })
  }

  const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

  return createAgentRuntime({
    persona: {
      systemPrompt: systemPrompt ?? 'You are a helpful AI assistant named DeskPet.',
      model,
    },
    llm,
    session,
    memory,
    tools: tools.hasTools() ? tools : undefined,
  })
}