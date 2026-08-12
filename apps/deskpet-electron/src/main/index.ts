import { app, BrowserWindow, ipcMain, desktopCapturer, safeStorage, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

import { createAgentRuntime, createSessionManager, createChatHooks } from '@deskpet/core'
import { createOpenAILlm } from '@deskpet/llm-openai'
import {
  createEncryptedFilePersistence,
  createEncryptedV4Persistence,
  createMemoryV4Repository,
  createMemoryWriter,
  createSmartMemoryExtractor,
  createVectorStore,
  extractMemoryCandidates,
  inferMemoryPrivacy,
  isSafeMemoryContent,
  LOCAL_EMBEDDING_MODEL,
  migrateV3SourceIntoV4,
} from '@deskpet/memory'
import type { MemoryCandidate, MemoryExtractor } from '@deskpet/memory'
import { createToolRegistry, webSearchTool, fileReadTool, httpFetchTool } from '@deskpet/tools'

import { createPersistence } from './persist'
import { createSettingsManager } from './settings'
import { setupVoiceIPC } from './voice'
import { createImageMemoryService, isExplicitImageMemoryRequest } from './image-memory'
import { createSemanticMemoryService, SEMANTIC_MEMORY_MODEL, SEMANTIC_MEMORY_REVISION } from './semantic-memory'

// Some Windows systems cannot initialize Electron's GPU subprocess. Disable
// hardware acceleration before app readiness so the packaged app still starts.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null

const bootLogPath = process.env.DESKPET_BOOT_LOG?.trim()
function writeBootLog(message: string) {
  if (!bootLogPath)
    return
  try {
    mkdirSync(dirname(bootLogPath), { recursive: true })
    appendFileSync(bootLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8')
  }
  catch {
    // Diagnostics must not be able to crash the desktop app.
  }
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
  embeddingModel: process.env.DESKPET_EMBEDDING_MODEL || fileConfig.embeddingModel || LOCAL_EMBEDDING_MODEL,
}

// ── Persistence ─────────────────────────────────────────
// Packaged builds are portable by default: chat history, encrypted memories,
// models and settings stay next to DeskPet.exe instead of AppData on C:.
const requestedUserDataDir = process.env.DESKPET_USER_DATA_DIR?.trim()
  || (app.isPackaged ? join(dirname(process.execPath), 'DeskPetData') : '')
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

// ── Encrypted session store ─────────────────────────────
const sessionStore = createSessionManager(200)
const sessionsCache = { default: sessionStore.getSessionMessages('default') }
const sessionStoragePath = join(userDataDir, 'sessions.enc')
const sessionKeyPath = join(userDataDir, 'session-key.json')
const legacySessionStoragePath = join(userDataDir, 'sessions.json')
let sessionPersistence: ReturnType<typeof createEncryptedFilePersistence> | undefined

function initializeSessions(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    writeBootLog('session persistence disabled because system encryption is unavailable')
    return
  }
  try {
    sessionPersistence = createEncryptedFilePersistence({
      encryptedPath: sessionStoragePath,
      keyPath: sessionKeyPath,
      legacyPath: legacySessionStoragePath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    const payload = sessionPersistence.load()
    const persistedSessions = payload ? JSON.parse(payload) as Record<string, any[]> : {}
    if (!persistedSessions || typeof persistedSessions !== 'object' || Array.isArray(persistedSessions))
      throw new Error('Encrypted session payload is not an object')
    for (const [sessionId, messages] of Object.entries(persistedSessions)) {
      if (!Array.isArray(messages))
        throw new Error(`Encrypted session ${sessionId} is not an array`)
      sessionStore.ensureSession(sessionId)
      for (const msg of messages)
        sessionStore.appendSessionMessage(sessionId, msg)
    }
    if (!payload)
      sessionPersistence.save('{}')
    writeBootLog(`encrypted sessions initialized${sessionPersistence.wasLegacyMigrated() ? ' (legacy migrated)' : ''}`)
  }
  catch (error) {
    sessionPersistence = undefined
    writeBootLog(`session persistence disabled after initialization error: ${errorMessage(error)}`)
  }
}

function saveSessions() {
  if (!sessionPersistence)
    return
  sessionsCache.default = sessionStore.getSessionMessages('default')
  sessionPersistence.save(JSON.stringify(sessionsCache))
}

// ── Scheme A long-term memory ───────────────────────────
type MemoryExtractionMode = 'rules' | 'smart'
type MemoryRemotePolicy = 'normal-only' | 'allow-private' | 'disabled'

interface MemorySettings {
  extractionMode: MemoryExtractionMode
  semanticEnabled: boolean
  imageMemoryEnabled: boolean
  remotePolicy: MemoryRemotePolicy
}

const defaultMemorySettings: MemorySettings = {
  extractionMode: 'rules',
  semanticEnabled: false,
  imageMemoryEnabled: true,
  remotePolicy: 'normal-only',
}

function normalizeMemorySettings(value: Partial<MemorySettings> | undefined): MemorySettings {
  return {
    extractionMode: value?.extractionMode === 'smart' ? 'smart' : 'rules',
    semanticEnabled: value?.semanticEnabled === true,
    imageMemoryEnabled: value?.imageMemoryEnabled !== false,
    remotePolicy: value?.remotePolicy === 'allow-private' || value?.remotePolicy === 'disabled'
      ? value.remotePolicy
      : 'normal-only',
  }
}

let memorySettings = normalizeMemorySettings(persist.loadJson<Partial<MemorySettings>>('memory-settings', defaultMemorySettings))
let memory: ReturnType<typeof createMemoryWriter> | undefined
let memoryInitializationError = ''
let memoryLegacyMigrated = false
const localMemoryScope = { ownerId: 'local-user', agentId: 'deskpet' }
const memoryStoragePath = join(userDataDir, 'memories.enc')
const memoryKeyPath = join(userDataDir, 'memory-key.json')
const legacyMemoryStoragePath = join(userDataDir, 'memories.json')
const memoryV4StoragePath = join(userDataDir, 'memory-v4.enc')
const memoryV4KeyPath = join(userDataDir, 'memory-v4-key.json')
let semanticModelProgress: { status: string; progress?: number; file?: string; error?: string } = { status: 'idle' }
let imageMemoryProgress: { status: string; progress?: number } = { status: 'idle' }
const semanticMemory = createSemanticMemoryService(join(userDataDir, 'models', 'memory'), (progress) => {
  semanticModelProgress = progress
  mainWindow?.webContents.send('memory:model-progress', progress)
})
const imageMemory = createImageMemoryService(join(userDataDir, 'models', 'ocr'), (progress) => {
  imageMemoryProgress = progress
  mainWindow?.webContents.send('memory:ocr-progress', progress)
})

function saveMemorySettings(): void {
  persist.saveJson('memory-settings', memorySettings)
}

function mergeMemoryCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates)
    unique.set(candidate.content.toLocaleLowerCase(), candidate)
  return [...unique.values()].slice(0, 8)
}

function createConfiguredMemoryExtractor(): MemoryExtractor {
  const smartExtractor = createSmartMemoryExtractor({
    getConfig: () => ({ apiKey: apiConfig.apiKey, baseURL: apiConfig.baseURL, model: apiConfig.model }),
    fallback: extractMemoryCandidates,
  })
  return async (turn) => {
    const candidates = memorySettings.extractionMode === 'smart' && memorySettings.remotePolicy !== 'disabled'
      ? await smartExtractor(turn)
      : await extractMemoryCandidates(turn)
    if (!memorySettings.imageMemoryEnabled
      || !turn.attachments?.length
      || !isExplicitImageMemoryRequest(turn.userMessage))
      return candidates

    const imageCandidates: MemoryCandidate[] = []
    for (const attachment of turn.attachments) {
      try {
        const candidate = await imageMemory.extractCandidate(attachment)
        if (candidate)
          imageCandidates.push(candidate)
      }
      catch (error) {
        writeBootLog(`image memory OCR failed: ${errorMessage(error)}`)
      }
    }
    return mergeMemoryCandidates([...candidates, ...imageCandidates])
  }
}

function initializeMemory(): void {
  memory = undefined
  memoryInitializationError = ''
  memoryLegacyMigrated = false
  if (!config.memoryEnabled)
    return
  try {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('系统安全存储不可用，为避免明文保存，长期记忆未启动。')
    const persistence = createEncryptedFilePersistence({
      encryptedPath: memoryStoragePath,
      keyPath: memoryKeyPath,
      legacyPath: legacyMemoryStoragePath,
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
    })
    const semanticActive = memorySettings.semanticEnabled && semanticMemory.isInstalled()
    const store = createVectorStore({
      persistence,
      embeddingModel: semanticActive
        ? `${SEMANTIC_MEMORY_MODEL}@${SEMANTIC_MEMORY_REVISION}`
        : LOCAL_EMBEDDING_MODEL,
      ...(semanticActive ? { embedder: semanticMemory.embed } : {}),
    })
    memory = createMemoryWriter({ store, extractor: createConfiguredMemoryExtractor() })
    memoryLegacyMigrated = persistence.wasLegacyMigrated()
    writeBootLog(`long-term memory initialized (${semanticActive ? 'semantic' : 'local-hash'})`)
    try {
      const v4Persistence = createEncryptedV4Persistence({
        encryptedPath: memoryV4StoragePath,
        keyPath: memoryV4KeyPath,
        protectKey: key => safeStorage.encryptString(key.toString('base64')),
        unprotectKey: protectedKey => Buffer.from(safeStorage.decryptString(protectedKey), 'base64'),
      })
      const v4Repository = createMemoryV4Repository({ persistence: v4Persistence })
      const migration = migrateV3SourceIntoV4(
        { load: persistence.loadReadOnly, storagePath: persistence.encryptedPath },
        v4Repository,
        { refreshMigrationOnlyTarget: true },
      )
      writeBootLog(`Memory V4 shadow ${migration.migrated ? 'migrated' : 'verified'}: ${migration.factCount} facts, ${migration.warningCount} warnings`)
    }
    catch (error) {
      // V4 remains a shadow copy in stage one. Its failure must never disable
      // the verified V3 runtime or overwrite the V3 source.
      writeBootLog(`Memory V4 shadow migration failed: ${errorMessage(error)}`)
    }
  }
  catch (error) {
    memoryInitializationError = errorMessage(error)
    writeBootLog(`long-term memory disabled after initialization error: ${memoryInitializationError}`)
  }
}

function memoryForRemoteRuntime() {
  if (!memory)
    return undefined
  const localMemory = memory
  return {
    ...localMemory,
    async recall(query: string, scope: Parameters<typeof localMemory.recall>[1], topK = 5) {
      if (memorySettings.remotePolicy === 'disabled')
        return []
      return localMemory.recall(query, scope, topK, {
        sharePolicies: ['allow-remote'],
        sensitivities: memorySettings.remotePolicy === 'allow-private'
          ? ['normal', 'private']
          : ['normal'],
      })
    },
    async recallAdaptive(query: string, scope: Parameters<typeof localMemory.recall>[1]) {
      if (memorySettings.remotePolicy === 'disabled') {
        return {
          memories: [], retrievedMemoryIds: [], injectedMemoryIds: [],
          candidateCount: 0, evaluatedCount: 0, batchesEvaluated: 0,
          stopReason: 'no-candidates' as const,
        }
      }
      return localMemory.recallAdaptive!(query, scope, {
        sharePolicies: ['allow-remote'],
        sensitivities: memorySettings.remotePolicy === 'allow-private'
          ? ['normal', 'private']
          : ['normal'],
      })
    },
  }
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
    llm, session: sessionStore, memory: memoryForRemoteRuntime(),
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
      const result = await runtime.send('default', message, attachments && attachments.length > 0
        ? { attachments, input: { type: 'image' } }
        : undefined)
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
    const removedMessageIds = msgs.slice(idx).map(message => message.id)
    msgs.splice(idx)
    if (memory && removedMessageIds.length > 0)
      await memory.unlinkSources(removedMessageIds, localMemoryScope)
    saveSessions()
    return { ok: true }
  })

  ipcMain.handle('memory:status', async () => ({
    enabled: !!memory,
    count: memory ? await memory.count(localMemoryScope) : 0,
    storagePath: memoryStoragePath,
    encrypted: !!memory,
    error: memoryInitializationError,
    legacyMigrated: memoryLegacyMigrated,
    settings: memorySettings,
    semantic: {
      installed: semanticMemory.isInstalled(),
      active: memorySettings.semanticEnabled && semanticMemory.isInstalled(),
      model: SEMANTIC_MEMORY_MODEL,
      progress: semanticModelProgress,
      cachePath: semanticMemory.cacheDir,
    },
    ocr: { progress: imageMemoryProgress, cachePath: imageMemory.cachePath },
  }))

  ipcMain.handle('memory:list', async (_event, limit = 200) => ({
    ok: true,
    enabled: !!memory,
    count: memory ? await memory.count(localMemoryScope) : 0,
    storagePath: memoryStoragePath,
    encrypted: !!memory,
    error: memoryInitializationError,
    settings: memorySettings,
    semantic: {
      installed: semanticMemory.isInstalled(),
      active: memorySettings.semanticEnabled && semanticMemory.isInstalled(),
      model: SEMANTIC_MEMORY_MODEL,
      progress: semanticModelProgress,
    },
    items: memory ? await memory.list(localMemoryScope, Number(limit)) : [],
  }))

  ipcMain.handle('memory:add', async (_event, content: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    const normalized = typeof content === 'string' ? content.trim() : ''
    if (!isSafeMemoryContent(normalized))
      return { ok: false, error: '内容为空，或包含指令注入、密钥、密码等不安全信息。' }
    const privacy = inferMemoryPrivacy(normalized)
    await memory.remember(normalized, localMemoryScope, {
      kind: 'manual',
      importance: 1,
      confidence: 1,
      origin: 'manual',
      ...privacy,
      source: 'memory-manager',
    })
    return { ok: true, count: await memory.count(localMemoryScope) }
  })

  ipcMain.handle('memory:forget', async (_event, id: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    if (typeof id !== 'string' || !id.trim())
      return { ok: false, error: '无效的记忆 ID。' }
    await memory.forget(id, localMemoryScope)
    return { ok: true, count: await memory.count(localMemoryScope) }
  })

  ipcMain.handle('memory:update', async (_event, id: string, patch: Record<string, unknown>) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    if (typeof id !== 'string' || !id.trim() || !patch || typeof patch !== 'object')
      return { ok: false, error: '无效的记忆更新。' }
    const allowed: Record<string, unknown> = {}
    if (typeof patch.importance === 'number')
      allowed.importance = patch.importance
    if (patch.expiresAt === null || typeof patch.expiresAt === 'number')
      allowed.expiresAt = patch.expiresAt
    if (patch.sharePolicy === 'allow-remote' || patch.sharePolicy === 'local-only' || patch.sharePolicy === 'ask')
      allowed.sharePolicy = patch.sharePolicy
    if (patch.sensitivity === 'normal' || patch.sensitivity === 'private' || patch.sensitivity === 'secret')
      allowed.sensitivity = patch.sensitivity
    if (patch.status === 'active' || patch.status === 'superseded' || patch.status === 'expired'
      || patch.status === 'conflicted' || patch.status === 'orphaned')
      allowed.status = patch.status
    const updated = await memory.update(id, localMemoryScope, allowed)
    return updated ? { ok: true } : { ok: false, error: '没有找到该记忆。' }
  })

  ipcMain.handle('memory:restore', async (_event, id: string) => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    const restored = typeof id === 'string' && await memory.restore(id, localMemoryScope)
    return restored ? { ok: true } : { ok: false, error: '没有找到该记忆。' }
  })

  ipcMain.handle('memory:settings-set', async (_event, input: Partial<MemorySettings>) => {
    memorySettings = normalizeMemorySettings({ ...memorySettings, ...input })
    if (memorySettings.semanticEnabled && !semanticMemory.isInstalled()) {
      memorySettings.semanticEnabled = false
      saveMemorySettings()
      return { ok: false, error: '请先下载本地语义模型。', settings: memorySettings }
    }
    saveMemorySettings()
    initializeMemory()
    rebuildRuntime()
    return { ok: true, settings: memorySettings }
  })

  ipcMain.handle('memory:model-install', async () => {
    try {
      await semanticMemory.install()
      memorySettings.semanticEnabled = true
      saveMemorySettings()
      initializeMemory()
      rebuildRuntime()
      return { ok: true, settings: memorySettings }
    }
    catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('memory:clear', async () => {
    if (!memory)
      return { ok: false, error: '长期记忆已关闭。' }
    await memory.clear(localMemoryScope)
    return { ok: true, count: 0 }
  })

  ipcMain.handle('memory:open-location', async () => {
    if (existsSync(memoryStoragePath)) {
      shell.showItemInFolder(memoryStoragePath)
      return { ok: true }
    }
    const error = await shell.openPath(userDataDir)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('app:reset', async () => {
    await memory?.clear(localMemoryScope)
    sessionStore.getSessionMessages('default').splice(0)
    sessionPersistence?.save('{}')
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

  mainWindow.webContents.on('did-finish-load', () => {
    writeBootLog('renderer finished loading')
    // Deterministic, API-free packaged/startup smoke test. It is inactive in
    // normal launches and lets CI/debug runs verify the renderer plus memory
    // initialization without leaving Electron processes behind.
    if (process.env.DESKPET_SMOKE_TEST === 'true') {
      writeBootLog('smoke test completed')
      setTimeout(() => app.quit(), 100)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    writeBootLog(`renderer failed to load: ${code} ${description}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeBootLog(`renderer process gone: ${details.reason} (${details.exitCode})`)
  })
  mainWindow.once('ready-to-show', () => writeBootLog('window ready to show'))

  if (process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else
    mainWindow.loadFile(join(moduleDir, '../renderer/index.html'))
}

// ── App lifecycle ──────────────────────────────────────
app.whenReady().then(() => {
  apiConfig = loadApiConfig()
  initializeSessions()
  initializeMemory()
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
  saveSessions()
  persist.saveAllImmediately()
})
