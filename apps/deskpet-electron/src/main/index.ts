import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

import { createAgentRuntime, createSessionManager, createChatHooks } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

let mainWindow: BrowserWindow | null = null

function loadConfig() {
  const cfgPath = join(app.getAppPath(), '..', 'config.json')
  if (existsSync(cfgPath)) {
    try {
      return JSON.parse(readFileSync(cfgPath, 'utf-8'))
    }
    catch {}
  }
  return {}
}

const fileConfig = loadConfig()
const charConfig = fileConfig.character || {}

const systemPrompt = `你是${charConfig.name || 'DeskPet'}。${charConfig.persona || '一个友好的AI助手。'}

规则：
- 说话温柔可爱，像朋友一样自然
- 回复简洁，控制在100字以内
- 用一点颜文字增加可爱感 (｡･ω･｡)
- 不要提自己是AI`

const config = {
  apiKey: process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  baseURL: process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  model: process.env.DESKPET_MODEL || fileConfig.model || 'gpt-4o-mini',
  systemPrompt: process.env.DESKPET_SYSTEM_PROMPT || systemPrompt,
  memoryEnabled: process.env.DESKPET_MEMORY ? process.env.DESKPET_MEMORY !== 'false' : (fileConfig.memoryEnabled !== false),
}

const llm = createOpenAILlm({ apiKey: config.apiKey, baseURL: config.baseURL })
const session = createSessionManager(200)

let memory
if (config.memoryEnabled) {
  const store = createVectorStore({ apiKey: config.apiKey })
  memory = createMemoryWriter({ store })
}

const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])
const hooks = createChatHooks()

hooks.onTokenLiteral(async (literal) => {
  mainWindow?.webContents.send('chat:token', literal)
})

const runtime = createAgentRuntime({
  persona: { systemPrompt: config.systemPrompt, model: config.model },
  llm, session, memory,
  tools: tools.hasTools() ? tools : undefined,
  hooks,
})

function setupIPC() {
  ipcMain.handle('chat:send', async (_event, message: string) => {
    const result = await runtime.send('default', message)
    return { text: result.text, toolCalls: result.toolCalls }
  })

  ipcMain.handle('get:character', () => charConfig)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 600,
    minHeight: 400,
    title: 'DeskPet',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  }
  else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  setupIPC()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin')
    app.quit()
})