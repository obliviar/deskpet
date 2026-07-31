import { createAgentRuntime } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createSessionManager } from '@deskpet/core'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'
import { createChatHooks } from '@deskpet/core'

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

let memory
if (config.memoryEnabled) {
  const store = createVectorStore({ apiKey: config.openaiApiKey })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([
  ...(config.tools?.includes('web_search') ? [webSearchTool] : []),
  ...(config.tools?.includes('file_read') ? [fileReadTool] : []),
  ...(config.tools?.includes('http_fetch') ? [httpFetchTool] : []),
])

const runtime = createAgentRuntime({
  persona: {
    systemPrompt: config.systemPrompt ?? 'You are a helpful AI assistant named DeskPet.',
    model: config.model ?? 'gpt-4o-mini',
  },
  llm,
  session,
  memory,
  tools: tools.hasTools() ? tools : undefined,
  hooks,
})

console.log(`[deskpet] Ready. Model: ${config.model ?? 'gpt-4o-mini'}, Provider: ${config.provider ?? 'openai'}`)
console.log(`[deskpet] Tools: ${tools.hasTools() ? tools.definitions().map(d => d.function.name).join(', ') : 'none'}`)
console.log('[deskpet] Type /help for commands, Ctrl+C to exit.\n')

startChatRepl(runtime, config.defaultSession ?? 'default')