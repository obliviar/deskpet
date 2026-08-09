import { app, BrowserWindow, ipcMain, desktopCapturer, safeStorage } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

import { createAgentRuntime, createSessionManager, createChatHooks } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

import { createPersistence } from './persist'
import { createSettingsManager } from './settings'
import { setupVoiceIPC } from './voice'

// Some Windows systems cannot initialize Electron's GPU subprocess. Disable
// hardware acceleration before app readiness so the packaged app still starts.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null

const bootLogPath = process.env.DESKPET_BOOT_LOG?.trim()
function writeBootLog(message: string) {
  if (bootLogPath)
    appendFileSync(bootLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
}
process.on('uncaughtException', error => writeBootLog(`uncaughtException: ${error.stack || error.message}`))
process.on('unhandledRejection', error => writeBootLog(`unhandledRejection: ${String(error)}`))
writeBootLog('main module loaded')
const moduleDir = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────
function loadFileConfig() {
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR && join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json'),
    join(dirname(process.execPath), 'config.json'),
    join(app.getAppPath(), '..', 'config.json'),
    join(app.getAppPath(), 'config.json'),
  ].filter((candidate): candidate is string => !!candidate)
  for (const cfgPath of candidates) {
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')) }
      catch { /* try the next candidate */ }
    }
  }
  return {}
}
const fileConfig = loadFileConfig()

const config = {
  apiKey: process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  baseURL: process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  model: process.env.DESKPET_MODEL || fileConfig.model || 'gpt-4o-mini',
  memoryEnabled: process.env.DESKPET_MEMORY ? process.env.DESKPET_MEMORY !== 'false' : (fileConfig.memoryEnabled !== false),
  embeddingApiKey: process.env.DESKPET_EMBEDDING_API_KEY || fileConfig.embeddingApiKey || process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  embeddingBaseURL: process.env.DESKPET_EMBEDDING_BASE_URL || fileConfig.embeddingBaseURL || process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  embeddingModel: process.env.DESKPET_EMBEDDING_MODEL || fileConfig.embeddingModel || 'local-hash-v1',
}

// ── Persistence ─────────────────────────────────────────
const requestedUserDataDir = process.env.DESKPET_USER_DATA_DIR?.trim()
if (requestedUserDataDir) {
  mkdirSync(requestedUserDataDir, { recursive: true })
  app.setPath('userData', requestedUserDataDir)
}
const userDataDir = app.getPath('userData')
writeBootLog(`userData: ${userDataDir}`)
const persist = createPersistence(userDataDir)
const settingsMgr = createSettingsManager(persist)

// ── LLM & Tools ────────────────────────────────────────
const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

interface ApiConfig {
  apiKey: string
  baseURL: string
  model: string
}

interface StoredApiConfig {
  encryptedApiKey?: string
  apiKey?: string
  baseURL?: string
  model?: string
}

let apiConfig: ApiConfig = {
  apiKey: config.apiKey,
  baseURL: config.baseURL || 'https://api.openai.com/v1',
  model: config.model,
}

function loadApiConfig(): ApiConfig {
  const stored = persist.loadJson<StoredApiConfig>('api-config', {})
  let apiKey = stored.apiKey || apiConfig.apiKey

  if (stored.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    }
    catch (error) {
      writeBootLog(`failed to decrypt API key: ${String(error)}`)
    }
  }

  return {
    apiKey,
    baseURL: stored.baseURL?.trim() || apiConfig.baseURL,
    model: stored.model?.trim() || apiConfig.model,
  }
}

function saveApiConfig() {
  const stored: StoredApiConfig = {
    baseURL: apiConfig.baseURL,
    model: apiConfig.model,
  }
  if (safeStorage.isEncryptionAvailable())
    stored.encryptedApiKey = safeStorage.encryptString(apiConfig.apiKey).toString('base64')
  else
    stored.apiKey = apiConfig.apiKey
  persist.saveJson('api-config', stored)
}

// ── Session store: load from disk on startup ────────────
const persistedSessions = persist.loadJson<Record<string, any[]>>('sessions', {})
const sessionStore = createSessionManager(200)

for (const [sessionId, messages] of Object.entries(persistedSessions)) {
  sessionStore.ensureSession(sessionId)
  for (const msg of messages)
    sessionStore.appendSessionMessage(sessionId, msg)
}

const sessionsCache = { default: sessionStore.getSessionMessages('default') }

function saveSessions() {
  sessionsCache.default = sessionStore.getSessionMessages('default')
  persist.saveJsonDebounced('sessions', sessionsCache)
}

// ── Memory store: load from disk on startup ─────────────
let memory: ReturnType<typeof createMemoryWriter> | undefined
const localMemoryScope = { ownerId: 'local-user', agentId: 'deskpet' }
if (config.memoryEnabled) {
  const store = createVectorStore({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseURL,
    embeddingModel: config.embeddingModel,
    storagePath: join(userDataDir, 'memories.json'),
  })
  memory = createMemoryWriter({ store })
  writeBootLog('long-term memory initialized')
}

// ── Runtime ─────────────────────────────────────────────
const settings = settingsMgr.get()
let agentName = settings.agentName || 'DeskPet'

function buildPersona(name: string): string {
  return [
    `Your name is ${name}. You are a friendly and helpful AI companion.`,
    `Always refer to yourself as "${name}" when introducing yourself or referring to yourself.`,
    `If someone asks your name, tell them it is ${name}.`,
    `Respond warmly and naturally, as ${name} would.`,
  ].join(' ')
}

let currentPersona = settings.agentName ? buildPersona(settings.agentName) : 'You are a helpful AI assistant named DeskPet.'

const hooks = createChatHooks()
hooks.onTokenLiteral(async (literal) => {
  mainWindow?.webContents.send('chat:token', literal)
})

let runtime: ReturnType<typeof createAgentRuntime>

function rebuildRuntime() {
  const llm = createOpenAILlm({ apiKey: apiConfig.apiKey, baseURL: apiConfig.baseURL })
  runtime = createAgentRuntime({
    persona: { systemPrompt: currentPersona, model: apiConfig.model },
    llm, session: sessionStore, memory,
    resolveMemoryScope: () => localMemoryScope,
    tools: tools.hasTools() ? tools : undefined,
    hooks,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── IPC ─────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('chat:send', async (_event, message: string, attachments?: { type: 'image'; data: string; mimeType: string }[]) => {
    if (!apiConfig.apiKey.trim())
      return { ok: false, error: '尚未配置 API Key，请点击右上角“API 设置”。' }
    try {
      const result = await runtime.send('default', message, attachments && attachments.length > 0 ? { attachments } : undefined)
      return { ok: true, text: result.text, toolCalls: result.toolCalls }
    }
    catch (error) {
      writeBootLog(`chat request failed: ${errorMessage(error)}`)
      return { ok: false, error: errorMessage(error) }
    }
    finally {
      saveSessions()
    }
  })

  ipcMain.handle('screen:capture', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: false,
    })
    if (sources.length === 0)
      return { ok: false, error: 'no sources' }
    // Use the first screen source
    const source = sources[0]!
    const thumbnail = source.thumbnail
    const dataUrl = thumbnail.toDataURL()
    // Parse data URL: data:image/jpeg;base64,xxxx
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl)
    if (!match)
      return { ok: false, error: 'failed to encode thumbnail' }
    return { ok: true, data: match[2]!, mimeType: match[1]! }
  })

  ipcMain.handle('settings:get', () => {
    return settingsMgr.get()
  })

  ipcMain.handle('settings:set-name', async (_event, name: string) => {
    settingsMgr.setName(name)
    agentName = name
    currentPersona = buildPersona(name)
    rebuildRuntime()
    mainWindow?.setTitle(name)
    return { ok: true }
  })

  ipcMain.handle('settings:set-theme', async (_event, theme: string) => {
    settingsMgr.setTheme(theme)
    return { ok: true }
  })

  ipcMain.handle('api:get', () => ({
    configured: !!apiConfig.apiKey.trim(),
    baseURL: apiConfig.baseURL,
    model: apiConfig.model,
  }))

  ipcMain.handle('api:set', (_event, input: { apiKey?: string; baseURL?: string; model?: string }) => {
    const apiKey = input.apiKey?.trim() || apiConfig.apiKey
    const baseURL = input.baseURL?.trim() || ''
    const model = input.model?.trim() || ''

    if (!apiKey)
      return { ok: false, error: '请输入 API Key。' }
    if (!baseURL)
      return { ok: false, error: '请输入 API Base URL。' }
    try {
      const url = new URL(baseURL)
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('unsupported protocol')
    }
    catch {
      return { ok: false, error: 'API Base URL 必须是有效的 HTTP 或 HTTPS 地址。' }
    }
    if (!model)
      return { ok: false, error: '请输入模型名称。' }

    apiConfig = { apiKey, baseURL: baseURL.replace(/\/$/, ''), model }
    saveApiConfig()
    rebuildRuntime()
    return { ok: true, configured: true }
  })

  ipcMain.handle('sessions:history', () => {
    return sessionStore.getSessionMessages('default')
  })

  ipcMain.handle('sessions:truncate-after', async (_event, messageId: string) => {
    const msgs = sessionStore.getSessionMessages('default')
    const idx = msgs.findIndex(m => m.id === messageId)
    if (idx < 0)
      return { ok: false, error: 'message not found' }
    msgs.splice(idx)
    saveSessions()
    return { ok: true }
  })

  ipcMain.handle('memory:status', async () => ({
    enabled: !!memory,
    count: memory ? await memory.count(localMemoryScope) : 0,
  }))

  ipcMain.handle('memory:clear', async () => {
    await memory?.clear(localMemoryScope)
    return { ok: true }
  })

  ipcMain.handle('app:reset', async () => {
    await memory?.clear(localMemoryScope)
    persist.saveJson('sessions', {})
    persist.saveJson('settings', { agentName: null, firstRunAt: null })
    persist.saveAllImmediately()
    app.relaunch()
    app.exit(0)
  })
  setupVoiceIPC()
}

// ── Window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 600,
    minHeight: 400,
    title: agentName,
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else
    mainWindow.loadFile(join(moduleDir, '../renderer/index.html'))
}

// ── App lifecycle ──────────────────────────────────────
app.whenReady().then(() => {
  apiConfig = loadApiConfig()
  rebuildRuntime()
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

app.on('before-quit', () => {
  sessionsCache.default = sessionStore.getSessionMessages('default')
  persist.saveJson('sessions', sessionsCache)
  persist.saveAllImmediately()
})
