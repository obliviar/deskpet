import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { join } from 'node:path'
import type { AgentRuntime } from '@deskpet/core'
import { createAgentRuntime, createSessionManager } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

import { chatRoutes } from './routes/chat'
import { voiceRoutes } from './routes/voice'

export type AppEnv = { Variables: { runtime: AgentRuntime } }

const config = {
  port: Number(process.env.PORT) || 3000,
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  model: process.env.DESKPET_MODEL || 'gpt-4o-mini',
  systemPrompt: process.env.DESKPET_SYSTEM_PROMPT || 'You are a helpful AI assistant named DeskPet.',
  embeddingApiKey: process.env.DESKPET_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
  embeddingBaseURL: process.env.DESKPET_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
  embeddingModel: process.env.DESKPET_EMBEDDING_MODEL || 'local-hash-v3',
  memoryPath: process.env.DESKPET_MEMORY_PATH || join(process.cwd(), 'data', 'memories.json'),
}

if (!config.apiKey) {
  console.error('[deskpet-server] Set OPENAI_API_KEY environment variable')
  process.exit(1)
}

const llm = createOpenAILlm({ apiKey: config.apiKey, baseURL: config.baseURL })
const session = createSessionManager(200)

let memory: ReturnType<typeof createMemoryWriter> | undefined
if (process.env.DESKPET_MEMORY !== 'false') {
  const store = createVectorStore({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseURL,
    embeddingModel: config.embeddingModel,
    storagePath: config.memoryPath,
  })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

const runtime = createAgentRuntime({
  persona: { systemPrompt: config.systemPrompt, model: config.model },
  llm, session, memory, tools,
  // Without authentication, use the session id as the owner boundary to avoid cross-session leaks.
  resolveMemoryScope: sessionId => ({ ownerId: sessionId, agentId: 'deskpet' }),
})

const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ status: 'ok' }))

app.use('*', async (c, next) => {
  c.set('runtime', runtime)
  await next()
})

app.route('/chat', chatRoutes)
app.route('/voice', voiceRoutes)

console.log(`[deskpet-server] starting on http://localhost:${config.port}`)
console.log(`[deskpet-server] model: ${config.model}, tools: ${tools.definitions().map(d => d.function.name).join(', ')}`)

serve({ fetch: app.fetch, port: config.port })
