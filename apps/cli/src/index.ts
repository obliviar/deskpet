import { createAgentRuntime, createSessionManager, createChatHooks } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from './config'
import { startChatRepl } from './commands/chat'

const config = loadConfig()

const llm = createOpenAILlm({ apiKey: config.openaiApiKey, baseURL: config.baseURL, provider: config.provider })
const session = createSessionManager(config.maxHistory ?? 100)

const hooks = createChatHooks()
hooks.onTokenLiteral(async (literal) => {
  process.stdout.write(literal)
})
hooks.onStreamEnd(async () => {
  process.stdout.write('\n')
})

let memory: ReturnType<typeof createMemoryWriter> | undefined
if (config.memoryEnabled) {
  const store = createVectorStore({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseURL,
    embeddingModel: config.embeddingModel,
    storagePath: config.memoryPath ?? join(homedir(), '.deskpet', 'memories.json'),
  })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

const runtime = createAgentRuntime({
  persona: {
    systemPrompt: config.systemPrompt ?? 'You are a helpful AI assistant named DeskPet.',
    model: config.model,
  },
  llm,
  session,
  memory,
  resolveMemoryScope: () => ({ ownerId: config.memoryOwnerId ?? 'local-user', agentId: 'deskpet' }),
  tools,
  hooks,
})

console.log(`[deskpet] Ready. Model: ${config.model}, Provider: ${config.provider ?? 'openai'}`)
console.log(`[deskpet] Tools: ${tools.definitions().map(d => d.function.name).join(', ')}`)
console.log('[deskpet] Type /help for commands, Ctrl+C to exit.\n')

startChatRepl(runtime, config.defaultSession ?? 'default')
