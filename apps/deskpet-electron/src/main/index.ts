import { app, BrowserWindow, ipcMain, desktopCapturer } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { createAgentRuntime, createSessionManager, createChatHooks } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import { createMemoryWriter, createVectorStore } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

import { createPersistence } from './persist'
import { createSettingsManager } from './settings'
import { setupVoiceIPC } from './voice'

let mainWindow: BrowserWindow | null = null

// ── Config ────────────────────────────────────────────
function loadFileConfig() {
  const cfgPath = join(app.getAppPath(), '..', 'config.json')
  if (existsSync(cfgPath)) {
    try { return JSON.parse(readFileSync(cfgPath, 'utf-8')) }
    catch { /* ignore */ }
  }
  return {}
}
const fileConfig = loadFileConfig()

const config = {
  apiKey: process.env.OPENAI_API_KEY || fileConfig.apiKey || '',
  baseURL: process.env.OPENAI_BASE_URL || fileConfig.baseURL || undefined,
  model: process.env.DESKPET_MODEL || fileConfig.model || 'gpt-4o-mini',
  memoryEnabled: process.env.DESKPET_MEMORY ? process.env.DESKPET_MEMORY !== 'false' : (fileConfig.memoryEnabled !== false),
}

// ── Persistence ─────────────────────────────────────────
const userDataDir = app.getPath('userData')
const persist = createPersistence(userDataDir)
const settingsMgr = createSettingsManager(persist)

// ── LLM & Tools ────────────────────────────────────────
const llm = createOpenAILlm({ apiKey: config.apiKey, baseURL: config.baseURL })
const tools = createToolRegistry([webSearchTool, fileReadTool, httpFetchTool])

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
if (config.memoryEnabled) {
  const store = createVectorStore({ apiKey: config.apiKey })
  memory = createMemoryWriter({ store })
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

let runtime = createAgentRuntime({
  persona: { systemPrompt: currentPersona, model: config.model },
  llm, session: sessionStore, memory,
  tools: tools.hasTools() ? tools : undefined,
  hooks,
})

// ── IPC ─────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('chat:send', async (_event, message: string, attachments?: { type: 'image'; data: string; mimeType: string }[]) => {
    const result = await runtime.send('default', message, attachments && attachments.length > 0 ? { attachments } : undefined)
    saveSessions()
    return { text: result.text, toolCalls: result.toolCalls }
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
    runtime = createAgentRuntime({
      persona: { systemPrompt: currentPersona, model: config.model },
      llm, session: sessionStore, memory,
      tools: tools.hasTools() ? tools : undefined,
      hooks,
    })
    mainWindow?.setTitle(name)
    return { ok: true }
  })

  ipcMain.handle('settings:set-theme', async (_event, theme: string) => {
    settingsMgr.setTheme(theme)
    return { ok: true }
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

  ipcMain.handle('app:reset', async () => {
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
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// ── App lifecycle ──────────────────────────────────────
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

app.on('before-quit', () => {
  sessionsCache.default = sessionStore.getSessionMessages('default')
  persist.saveJson('sessions', sessionsCache)
  persist.saveAllImmediately()
})