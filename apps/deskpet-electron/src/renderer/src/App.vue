<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed } from 'vue'

const { ipcRenderer } = (window as any).require('electron')

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
  hasImage?: boolean
  memoryReview?: MemoryV4InternalCandidateReview
}

interface MemoryV4InternalCandidateReview {
  mode: 'internal-candidate'
  authoritativeAnswerSource: 'v3'
  v4InfluencedAnswer: false
  v3: { retrievedCount: number; injectedCount: number }
  v4: {
    abstained: boolean
    bestEvidenceScore: number
    threshold: number
    calibrationVersion: string
    candidates: Array<{
      factId: string
      content: string
      score: number
      routes: string[]
      status: string
      verificationState: string
    }>
  }
  agreement: { overlapCount: number; recallAtK: number; precisionAtK: number; jaccard: number }
}

interface Theme {
  id: string
  name: string
  bg: string
  surface: string
  surfaceHover: string
  border: string
  text: string
  textMuted: string
  accent: string
  accentHover: string
  accentSoft: string
  scrollThumb: string
}

interface MemoryItem {
  id: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
  status?: 'active' | 'superseded' | 'expired' | 'conflicted' | 'orphaned' | 'suppressed' | 'deleted'
  origin?: 'automatic' | 'manual' | 'image'
  importance?: number
  confidence?: number
  accessCount?: number
  lastAccessedAt?: number
  expiresAt?: number
  sharePolicy?: 'allow-remote' | 'local-only' | 'ask'
  sensitivity?: 'normal' | 'private' | 'secret'
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
}

interface MemorySettings {
  extractionMode: 'rules' | 'smart'
  semanticEnabled: boolean
  imageMemoryEnabled: boolean
  remotePolicy: 'normal-only' | 'allow-private' | 'disabled'
}

interface MemoryReviewItem {
  candidate: {
    id: string
    canonicalText: string
    predicate: string
    verificationScore?: number
    evidenceScore?: number
    calibratedActiveProbability?: number
    calibrationLowerBound?: number
    calibrationStatus?: 'calibrated' | 'insufficient-data' | 'out-of-distribution'
    durabilityScore: number
    ambiguityFlags: string[]
    decisionReasonCodes?: string[]
    createdAt: number
  }
  evidence: Array<{ id: string; content?: string; contentState: string; recordedAt: number }>
}

// ── Speech synthesis types (Chromium built-in TTS) ─────
// (speechSynthesis and SpeechSynthesisUtterance are global DOM types)

const CUSTOM_THEME_PREFIX = 'custom:'
const DEFAULT_CUSTOM_COLOR = '#7c5ce7'

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const hex = match[1]!
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0'))
    .join('')}`
}

function mixHex(color: string, target: string, targetWeight: number): string {
  const sourceRgb = parseHexColor(color)!
  const targetRgb = parseHexColor(target)!
  return rgbToHex(
    sourceRgb.r * (1 - targetWeight) + targetRgb.r * targetWeight,
    sourceRgb.g * (1 - targetWeight) + targetRgb.g * targetWeight,
    sourceRgb.b * (1 - targetWeight) + targetRgb.b * targetWeight,
  )
}

function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color)!
  const channels = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function ensureWhiteTextContrast(color: string): string {
  let result = color
  while (1.05 / (relativeLuminance(result) + 0.05) < 4.5)
    result = mixHex(result, '#000000', 0.12)
  return result
}

function createCustomTheme(color: string): Theme {
  const normalized = parseHexColor(color) ? color.toLowerCase() : DEFAULT_CUSTOM_COLOR
  const accent = ensureWhiteTextContrast(normalized)
  const accentRgb = parseHexColor(accent)!
  return {
    id: 'custom',
    name: '自定义颜色',
    bg: mixHex(normalized, '#ffffff', 0.82),
    surface: mixHex(normalized, '#ffffff', 0.95),
    surfaceHover: mixHex(normalized, '#ffffff', 0.88),
    border: mixHex(normalized, '#ffffff', 0.64),
    text: '#1f2937',
    textMuted: '#64748b',
    accent,
    accentHover: mixHex(accent, '#000000', 0.12),
    accentSoft: `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.14)`,
    scrollThumb: mixHex(normalized, '#ffffff', 0.52),
  }
}

const themes: Theme[] = [
  { id: 'dark', name: '深空黑', bg: '#0f1117', surface: '#1c1f26', surfaceHover: '#252830', border: '#252830', text: '#e1e4e8', textMuted: '#666', accent: '#2d7d46', accentHover: '#35954f', accentSoft: 'rgba(45,125,70,0.15)', scrollThumb: '#353840' },
  { id: 'light', name: '日光白', bg: '#f6f8fa', surface: '#ffffff', surfaceHover: '#eaeef2', border: '#d0d7de', text: '#1f2328', textMuted: '#656d76', accent: '#0969da', accentHover: '#0550ae', accentSoft: 'rgba(9,105,218,0.12)', scrollThumb: '#c0c7cf' },
  { id: 'forest', name: '清新绿', bg: '#e7f4e9', surface: '#f7fbf7', surfaceHover: '#dceee0', border: '#bed8c4', text: '#1f3525', textMuted: '#5f7664', accent: '#397a4b', accentHover: '#2f663f', accentSoft: 'rgba(57,122,75,0.14)', scrollThumb: '#aacbb2' },
  { id: 'warm', name: '暖杏色', bg: '#fff0e6', surface: '#fffaf6', surfaceHover: '#fbe4d6', border: '#e8c7b4', text: '#402b20', textMuted: '#7f685b', accent: '#bd5f3f', accentHover: '#9f4c31', accentSoft: 'rgba(189,95,63,0.14)', scrollThumb: '#dbb29a' },
  { id: 'ocean', name: '晴空蓝', bg: '#e8f3ff', surface: '#f8fbff', surfaceHover: '#dcecff', border: '#bfd7ef', text: '#19334d', textMuted: '#607891', accent: '#1769aa', accentHover: '#12578e', accentSoft: 'rgba(23,105,170,0.14)', scrollThumb: '#a9cae8' },
]

// ── State ───────────────────────────────────────────────
const agentName = ref('DeskPet')
const appVersion = ref('')
const isFirstRun = ref(true)
const loaded = ref(false)
const nameInput = ref('')
const messages = ref<Message[]>([])
const input = ref('')
const isLoading = ref(false)
const chatEl = ref<HTMLElement | null>(null)
const currentTheme = ref<Theme>(themes[0]!)
const showThemeMenu = ref(false)
const customColor = ref(DEFAULT_CUSTOM_COLOR)
let themePreviewOrigin: Theme | null = null

// API settings state
const showApiSettings = ref(false)
const apiConfigured = ref(false)
const apiKeyInput = ref('')
const apiBaseURL = ref('https://api.openai.com/v1')
const apiModel = ref('gpt-4o-mini')
const apiSaving = ref(false)
const apiStatusMessage = ref('')
const apiStatusError = ref(false)

// Long-term memory manager state
const showMemoryManager = ref(false)
const memoryEnabled = ref(false)
const memoryCount = ref(0)
const memoryStoragePath = ref('')
const memoryItems = ref<MemoryItem[]>([])
const memoryReviewItems = ref<MemoryReviewItem[]>([])
const pendingCaptureSegments = ref(0)
const manualMemoryInput = ref('')
const memoryLoading = ref(false)
const memoryMutating = ref(false)
const memoryStatusMessage = ref('')
const memoryStatusError = ref(false)
const pendingDeleteMemoryId = ref<string | null>(null)
const pendingPurgeMemoryId = ref<string | null>(null)
const purgeToken = ref('')
const purgePhrase = ref('')
const purgeWarning = ref('')
const editingMemoryId = ref<string | null>(null)
const editingMemoryContent = ref('')
const confirmClearMemories = ref(false)
const memorySettings = ref<MemorySettings>({
  extractionMode: 'rules',
  semanticEnabled: false,
  imageMemoryEnabled: true,
  remotePolicy: 'normal-only',
})
const memoryEncrypted = ref(false)
const semanticInstalled = ref(false)
const semanticModelName = ref('Xenova/bge-small-zh-v1.5')
const semanticModelProgress = ref<{
  status: string
  progress?: number
  file?: string
  error?: string
  total?: number
  ready?: number
  pending?: number
  integrity?: string
  checkedFiles?: number
  checkedBytes?: number
}>({ status: 'idle' })
const semanticInstalling = ref(false)

// Screen capture state
const pendingImage = ref<{ data: string; mimeType: string } | null>(null)
const isCapturing = ref(false)

// Voice state
const isListening = ref(false)
const autoSpeak = ref(false)
const voiceError = ref('')
const voiceSetup = ref<'idle' | 'checking' | 'needed' | 'installing' | 'ready'>('idle')
let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []

let resetTimer: ReturnType<typeof setTimeout> | null = null

const themeVars = computed(() => ({
  '--bg': currentTheme.value.bg,
  '--surface': currentTheme.value.surface,
  '--surface-hover': currentTheme.value.surfaceHover,
  '--border': currentTheme.value.border,
  '--text': currentTheme.value.text,
  '--text-muted': currentTheme.value.textMuted,
  '--accent': currentTheme.value.accent,
  '--accent-hover': currentTheme.value.accentHover,
  '--accent-soft': currentTheme.value.accentSoft,
  '--scroll-thumb': currentTheme.value.scrollThumb,
}))

// ── IPC token handler ───────────────────────────────────
function onToken(_event: unknown, token: string) {
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    last.content += token
    scrollToBottom()
  }
}

function onMemoryModelProgress(_event: unknown, progress: typeof semanticModelProgress.value) {
  semanticModelProgress.value = progress
}

// ── Lifecycle ───────────────────────────────────────────
onMounted(async () => {
  appVersion.value = await ipcRenderer.invoke('app:version')
  const settings = await ipcRenderer.invoke('settings:get')
  if (settings.agentName) {
    agentName.value = settings.agentName
    isFirstRun.value = false
  }
  if (settings.theme) {
    if (typeof settings.theme === 'string' && settings.theme.startsWith(CUSTOM_THEME_PREFIX)) {
      const savedColor = settings.theme.slice(CUSTOM_THEME_PREFIX.length)
      if (parseHexColor(savedColor)) {
        customColor.value = savedColor.toLowerCase()
        currentTheme.value = createCustomTheme(customColor.value)
      }
    }
    else {
      const t = themes.find(t => t.id === settings.theme)
      if (t) currentTheme.value = t
    }
  }

  await refreshApiStatus()
  await refreshMemoryStatus()

  const history = await ipcRenderer.invoke('sessions:history')
  if (history && history.length > 0) {
    messages.value = history
      .filter((h: { role: string }) => h.role === 'user' || h.role === 'assistant')
      .map((h: { id?: string; role: 'user' | 'assistant'; content: string }) => ({
        id: h.id || crypto.randomUUID(),
        role: h.role,
        content: h.content,
      }))
  }

  loaded.value = true
  if (!isFirstRun.value)
    scrollToBottom()

  ipcRenderer.on('chat:token', onToken)
  ipcRenderer.on('memory:model-progress', onMemoryModelProgress)
})

onUnmounted(() => {
  ipcRenderer.removeListener('chat:token', onToken)
  ipcRenderer.removeListener('memory:model-progress', onMemoryModelProgress)
  if (resetTimer) clearTimeout(resetTimer)
  if (mediaRecorder) {
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach(t => t.stop())
    mediaRecorder = null
  }
  isListening.value = false
  speechSynthesis.cancel()
})

// ── Naming ──────────────────────────────────────────────
async function confirmName() {
  const name = nameInput.value.trim()
  if (!name) return
  await ipcRenderer.invoke('settings:set-name', name)
  agentName.value = name
  isFirstRun.value = false
}

// ── API settings ────────────────────────────────────────
async function refreshApiStatus() {
  try {
    const status = await ipcRenderer.invoke('api:get')
    apiConfigured.value = !!status.configured
    apiBaseURL.value = status.baseURL || 'https://api.openai.com/v1'
    apiModel.value = status.model || 'gpt-4o-mini'
  }
  catch {
    apiConfigured.value = false
  }
}

async function openApiSettings() {
  closeThemeMenu(true)
  await refreshApiStatus()
  apiKeyInput.value = ''
  apiStatusMessage.value = ''
  apiStatusError.value = false
  showMemoryManager.value = false
  showApiSettings.value = true
}

function closeApiSettings() {
  if (!apiSaving.value)
    showApiSettings.value = false
}

async function saveApiSettings() {
  apiSaving.value = true
  apiStatusMessage.value = ''
  apiStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('api:set', {
      apiKey: apiKeyInput.value,
      baseURL: apiBaseURL.value,
      model: apiModel.value,
    })
    if (!result?.ok) {
      apiStatusError.value = true
      apiStatusMessage.value = result?.error || '保存失败。'
      return
    }
    apiConfigured.value = true
    apiKeyInput.value = ''
    apiStatusMessage.value = '保存成功，新配置已立即生效。'
  }
  catch (error) {
    apiStatusError.value = true
    apiStatusMessage.value = error instanceof Error ? error.message : '保存失败。'
  }
  finally {
    apiSaving.value = false
  }
}

// ── Long-term memory manager ────────────────────────────
async function refreshMemoryStatus() {
  try {
    const status = await ipcRenderer.invoke('memory:status')
    memoryEnabled.value = !!status?.enabled
    memoryCount.value = Number(status?.count) || 0
    memoryStoragePath.value = status?.storagePath || ''
    applyMemoryRuntimeStatus(status)
    if (status?.error) {
      memoryStatusError.value = true
      memoryStatusMessage.value = status.error
    }
  }
  catch {
    memoryEnabled.value = false
    memoryCount.value = 0
  }
}

function applyMemoryRuntimeStatus(status: any) {
  if (status?.settings)
    memorySettings.value = { ...memorySettings.value, ...status.settings }
  memoryEncrypted.value = !!status?.encrypted
  const integrityState = status?.semantic?.integrity?.state
  semanticInstalled.value = !!status?.semantic?.installed
    && integrityState !== 'corrupt'
    && integrityState !== 'incompatible'
  semanticModelName.value = status?.semantic?.model || semanticModelName.value
  if (status?.semantic?.progress)
    semanticModelProgress.value = status.semantic.progress
}

async function openMemoryManager() {
  showApiSettings.value = false
  closeThemeMenu(true)
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  pendingDeleteMemoryId.value = null
  cancelPurgeMemory()
  confirmClearMemories.value = false
  showMemoryManager.value = true
  await refreshMemoryList()
}

function closeMemoryManager() {
  if (!memoryMutating.value)
    showMemoryManager.value = false
}

async function refreshMemoryList() {
  memoryLoading.value = true
  try {
    const result = await ipcRenderer.invoke('memory:list', 1000)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '读取记忆失败。'
      return
    }
    memoryEnabled.value = !!result.enabled
    memoryCount.value = Number(result.count) || 0
    memoryStoragePath.value = result.storagePath || ''
    memoryItems.value = Array.isArray(result.items) ? result.items : []
    memoryReviewItems.value = Array.isArray(result.reviewItems) ? result.reviewItems : []
    pendingCaptureSegments.value = Number(result.pendingCaptureSegments) || 0
    applyMemoryRuntimeStatus(result)
    if (result.error) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result.error
    }
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '读取记忆失败。'
  }
  finally {
    memoryLoading.value = false
  }
}

async function reviewMemoryCandidate(id: string, outcome: 'approved' | 'rejected') {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:candidate-review', { id, outcome })
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '候选审核失败。'
      return
    }
    memoryStatusMessage.value = outcome === 'approved'
      ? '候选已由你确认，并作为手动确认事实进入正式记忆。'
      : '候选已拒绝，不会进入正式记忆。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '候选审核失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function reprocessMemoryCandidates() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    let cursor: string | undefined
    let processed = 0
    let changed = 0
    let calibrationSamples = 0
    do {
      const result = await ipcRenderer.invoke('memory:candidate-reprocess', { cursor, batchSize: 100 })
      if (!result?.ok) {
        memoryStatusError.value = true
        memoryStatusMessage.value = result?.error || '候选重处理失败。'
        return
      }
      processed += Number(result.report?.processed) || 0
      changed += Number(result.report?.changedDecisions) || 0
      calibrationSamples = Number(result.report?.calibration?.sampleCount) || 0
      cursor = result.report?.nextCursor
    } while (cursor)
    memoryStatusMessage.value = `影子重处理完成：检查 ${processed} 条候选，发现 ${changed} 条策略差异；使用 ${calibrationSamples} 条隔离审核反馈，仅供影子比较，不具备生产校准资格。`
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function flushMemoryCaptureQueue() {
  if (memoryMutating.value) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:capture-flush')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '后台写入队列处理失败。'
      return
    }
    memoryStatusMessage.value = '后台长消息写入队列已全部处理。'
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function saveMemorySettings(patch: Partial<MemorySettings>) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:settings-set', patch)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '记忆设置保存失败。'
    }
    if (result?.settings)
      memorySettings.value = { ...memorySettings.value, ...result.settings }
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '记忆设置保存失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function installSemanticModel() {
  if (semanticInstalling.value) return
  semanticInstalling.value = true
  memoryStatusMessage.value = '正在下载并校验本地语义模型，首次安装可能需要几分钟…'
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:model-install')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '本地语义模型安装失败。'
      return
    }
    semanticInstalled.value = true
    memorySettings.value = { ...memorySettings.value, ...result.settings }
    memoryStatusMessage.value = '本地语义模型及旧记忆索引已准备完成，语义检索已原子启用。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '本地语义模型安装失败。'
  }
  finally {
    semanticInstalling.value = false
  }
}

async function updateMemory(item: MemoryItem, patch: Record<string, unknown>) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:update', item.id, patch)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '更新记忆失败。'
      return
    }
    memoryStatusMessage.value = '记忆设置已更新。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '更新记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

function beginEditMemory(item: MemoryItem) {
  editingMemoryId.value = item.id
  editingMemoryContent.value = item.content
}

function cancelEditMemory() {
  editingMemoryId.value = null
  editingMemoryContent.value = ''
}

async function saveEditedMemory(item: MemoryItem) {
  const content = editingMemoryContent.value.trim()
  if (!content || content === item.content) {
    cancelEditMemory()
    return
  }
  await updateMemory(item, { content })
  if (!memoryStatusError.value)
    cancelEditMemory()
}

async function suppressMemory(item: MemoryItem) {
  await updateMemory(item, { status: 'suppressed' })
  if (!memoryStatusError.value)
    memoryStatusMessage.value = '记忆已停用，不再参与普通召回；可随时恢复。'
}

async function updateMemorySensitivity(item: MemoryItem) {
  await updateMemory(item, {
    sensitivity: item.sensitivity,
    ...(item.sensitivity === 'secret' ? { sharePolicy: 'local-only' } : {}),
  })
}

async function restoreMemory(item: MemoryItem) {
  if (memoryMutating.value) return
  memoryMutating.value = true
  try {
    const result = await ipcRenderer.invoke('memory:restore', item.id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '恢复记忆失败。'
      return
    }
    memoryStatusError.value = false
    memoryStatusMessage.value = '记忆已恢复为有效状态。'
    await refreshMemoryList()
  }
  finally {
    memoryMutating.value = false
  }
}

async function addManualMemory() {
  const content = manualMemoryInput.value.trim()
  if (!content || memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:add', content)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '添加记忆失败。'
      return
    }
    manualMemoryInput.value = ''
    memoryStatusMessage.value = '记忆已保存。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '添加记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function deleteMemory(id: string) {
  if (pendingDeleteMemoryId.value !== id) {
    pendingDeleteMemoryId.value = id
    return
  }
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:forget', id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '删除记忆失败。'
      return
    }
    pendingDeleteMemoryId.value = null
    memoryStatusMessage.value = '记忆已删除。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '删除记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function preparePurgeMemory(id: string) {
  if (memoryMutating.value) return
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:purge-prepare', id)
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '无法发起彻底清除。'
      return
    }
    pendingPurgeMemoryId.value = id
    purgeToken.value = result.token
    purgePhrase.value = ''
    purgeWarning.value = result.warning
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '无法发起彻底清除。'
  }
}

function cancelPurgeMemory() {
  pendingPurgeMemoryId.value = null
  purgeToken.value = ''
  purgePhrase.value = ''
  purgeWarning.value = ''
}

async function confirmPurgeMemory(id: string) {
  if (memoryMutating.value || pendingPurgeMemoryId.value !== id || purgePhrase.value.trim() !== '彻底清除') return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:purge-confirm', {
      id,
      token: purgeToken.value,
      phrase: purgePhrase.value,
    })
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '彻底清除失败。'
      return
    }
    const report = result.report
    memoryStatusMessage.value = `彻底清除完成：V3 已移除，V4 清理 ${report?.purgedEpisodes ?? 0} 条独占证据，残留 ${report?.residualCount ?? 0}。`
    cancelPurgeMemory()
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '彻底清除失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function clearAllMemories() {
  if (!confirmClearMemories.value) {
    confirmClearMemories.value = true
    return
  }
  if (memoryMutating.value) return
  memoryMutating.value = true
  memoryStatusMessage.value = ''
  memoryStatusError.value = false
  try {
    const result = await ipcRenderer.invoke('memory:clear')
    if (!result?.ok) {
      memoryStatusError.value = true
      memoryStatusMessage.value = result?.error || '清空记忆失败。'
      return
    }
    confirmClearMemories.value = false
    memoryStatusMessage.value = 'V3 记忆已普通清空；V4 保留审计墓碑。不可恢复删除请逐条使用“彻底清除”。'
    await refreshMemoryList()
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '清空记忆失败。'
  }
  finally {
    memoryMutating.value = false
  }
}

async function openMemoryLocation() {
  try {
    const result = await ipcRenderer.invoke('memory:open-location')
    if (result?.ok) return
    memoryStatusError.value = true
    memoryStatusMessage.value = result?.error || '无法打开记忆文件位置。'
  }
  catch (error) {
    memoryStatusError.value = true
    memoryStatusMessage.value = error instanceof Error ? error.message : '无法打开记忆文件位置。'
  }
}

function memoryKindLabel(item: MemoryItem): string {
  const kind = typeof item.metadata?.kind === 'string' ? item.metadata.kind : ''
  return ({
    identity: '身份',
    preference: '偏好',
    project: '项目',
    explicit: '明确记忆',
    manual: '手动添加',
    image: '图片记忆',
  } as Record<string, string>)[kind] || '自动记忆'
}

function memoryStatusLabel(item: MemoryItem): string {
  return ({
    active: '有效',
    superseded: '已被替代',
    expired: '已过期',
    conflicted: '待确认冲突',
    orphaned: '来源已删除',
    suppressed: '已停用',
    deleted: '已删除',
  } as Record<string, string>)[item.status || 'active'] || '有效'
}

function modelProgressLabel(): string {
  const progress = semanticModelProgress.value
  if (progress.status === 'error') return `安装错误：${progress.error || '未知错误'}`
  if (progress.status === 'ready') return '模型就绪'
  if (progress.status === 'verifying')
    return `正在校验模型完整性${typeof progress.checkedFiles === 'number' ? ` · ${progress.checkedFiles} 个文件` : ''}`
  if (progress.status === 'indexing')
    return `正在后台构建语义索引${typeof progress.ready === 'number' && typeof progress.total === 'number' ? ` ${progress.ready}/${progress.total}` : ''}${typeof progress.progress === 'number' ? ` · ${Math.round(progress.progress)}%` : ''}`
  if (progress.status === 'downloading')
    return `下载中${typeof progress.progress === 'number' ? ` ${Math.round(progress.progress)}%` : ''}${progress.file ? ` · ${progress.file}` : ''}`
  if (progress.status === 'loading') return '正在加载模型…'
  return semanticInstalled.value ? '模型已安装' : '尚未安装（聊天仍使用本地哈希检索）'
}

function formatMemoryDate(item: MemoryItem): string {
  const timestamp = item.updatedAt || item.createdAt
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : ''
}

// ── Send ────────────────────────────────────────────────
async function send() {
  const text = input.value.trim()
  const image = pendingImage.value
  if ((!text && !image) || isLoading.value) return

  isLoading.value = true
  input.value = ''
  pendingImage.value = null

  const displayContent = image ? (text || '[识屏请求]') : text
  const userMsg: Message = { role: 'user', content: displayContent, id: crypto.randomUUID(), hasImage: !!image }
  messages.value.push(userMsg)
  const assistantMsg: Message = { role: 'assistant', content: '', id: crypto.randomUUID() }
  messages.value.push(assistantMsg)
  scrollToBottom()

  try {
    const attachments = image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : undefined
    const prompt = image ? (text || '请描述这个屏幕截图中的内容。') : text
    const result = await ipcRenderer.invoke('chat:send', prompt, attachments)
    if (!result?.ok) {
      const detail = result?.error || '未知错误'
      assistantMsg.content = assistantMsg.content
        ? `${assistantMsg.content}\n\n[请求失败] ${detail}`
        : `[请求失败] ${detail}`
    }
    else if (!assistantMsg.content && result.text) {
      assistantMsg.content = result.text
    }
    if (result?.memoryReview)
      assistantMsg.memoryReview = result.memoryReview
    if (autoSpeak.value) {
      nextTick(() => speak(assistantMsg.content))
    }
  }
  catch (err) {
    assistantMsg.content = '[Error: ' + (err instanceof Error ? err.message : 'unknown') + ']'
  }
  finally {
    await refreshMemoryStatus()
    isLoading.value = false
    scrollToBottom()
  }
}

// ── Rollback ────────────────────────────────────────────
async function rollback(msgId: string) {
  if (isLoading.value) return
  const idx = messages.value.findIndex(m => m.id === msgId)
  if (idx < 0) return
  await ipcRenderer.invoke('sessions:truncate-after', msgId)
  messages.value.splice(idx)
}

// ── Screen capture (识屏) ───────────────────────────────
async function captureScreen() {
  if (isCapturing.value || isLoading.value) return
  isCapturing.value = true
  try {
    const result = await ipcRenderer.invoke('screen:capture')
    if (result.ok) {
      pendingImage.value = { data: result.data, mimeType: result.mimeType }
    }
    else {
      console.error('[deskpet] screen capture failed:', result.error)
    }
  }
  catch (err) {
    console.error('[deskpet] screen capture error:', err)
  }
  finally {
    isCapturing.value = false
  }
}

function clearPendingImage() {
  pendingImage.value = null
}

// ── Voice input / STT (语音输入 — Vosk 离线) ──────────
async function toggleListening() {
  if (isListening.value)
    await stopListening()
  else
    await startListening()
}

async function ensureVoiceSetup(): Promise<boolean> {
  if (voiceSetup.value === 'ready') return true
  voiceSetup.value = 'checking'
  voiceError.value = '检查语音环境...'
  const check = await ipcRenderer.invoke('voice:check-model')
  if (check.modelExists && check.pythonOk && check.voskOk && check.scriptExists) {
    voiceSetup.value = 'ready'
    voiceError.value = ''
    return true
  }
  voiceSetup.value = 'installing'
  voiceError.value = '正在安装语音识别组件（首次需要1-2分钟）...'
  try {
    await ipcRenderer.invoke('voice:setup')
    voiceSetup.value = 'ready'
    voiceError.value = ''
    return true
  }
  catch (err) {
    voiceSetup.value = 'needed'
    voiceError.value = '语音识别安装失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 5000)
    return false
  }
}

async function startListening() {
  voiceError.value = ''
  const ready = await ensureVoiceSetup()
  if (!ready) return

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } })
    audioChunks = []
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.start()
    isListening.value = true
  }
  catch (err) {
    voiceError.value = '麦克风访问失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 3000)
  }
}

async function stopListening() {
  isListening.value = false
  if (!mediaRecorder) return

  const recorder = mediaRecorder
  mediaRecorder = null

  voiceError.value = '识别中...'
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.stop()
    recorder.stream.getTracks().forEach(t => t.stop())
  })

  if (audioChunks.length === 0) {
    voiceError.value = ''
    return
  }

  const blob = new Blob(audioChunks, { type: 'audio/webm' })
  audioChunks = []
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const audioContext = new AudioContext({ sampleRate: 16000 })
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    const wavBuffer = audioBufferToWav(audioBuffer)
    audioContext.close()

    const result = await ipcRenderer.invoke('voice:transcribe', wavBuffer)
    if (result.ok && result.text) {
      input.value = result.text
    }
    else if (!result.ok) {
      voiceError.value = result.error || '识别失败'
      setTimeout(() => { voiceError.value = '' }, 3000)
    }
  }
  catch (err) {
    voiceError.value = '音频处理失败: ' + (err instanceof Error ? err.message : '未知错误')
    setTimeout(() => { voiceError.value = '' }, 3000)
  }
  finally {
    voiceError.value = ''
  }
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1
  const sampleRate = buffer.sampleRate
  const samples = buffer.getChannelData(0)
  const dataSize = samples.length * 2
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }
  return arrayBuffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i))
}

// ── Voice output / TTS (语音播报) ───────────────────────
function speak(text: string) {
  if (!text || !autoSpeak.value) return
  speechSynthesis.cancel()
  const utter = new SpeechSynthesisUtterance(text)
  utter.lang = 'zh-CN'
  utter.rate = 1.0
  speechSynthesis.speak(utter)
}

function toggleAutoSpeak() {
  autoSpeak.value = !autoSpeak.value
  if (!autoSpeak.value) speechSynthesis.cancel()
}

// ── Theme ───────────────────────────────────────────────
function closeThemeMenu(restorePreview: boolean) {
  if (restorePreview && themePreviewOrigin)
    currentTheme.value = themePreviewOrigin
  themePreviewOrigin = null
  showThemeMenu.value = false
}

function toggleThemeMenu() {
  if (showThemeMenu.value) {
    closeThemeMenu(true)
    return
  }
  themePreviewOrigin = currentTheme.value
  showThemeMenu.value = true
}

async function selectTheme(t: Theme) {
  currentTheme.value = t
  closeThemeMenu(false)
  await ipcRenderer.invoke('settings:set-theme', t.id)
}

function previewCustomTheme() {
  currentTheme.value = createCustomTheme(customColor.value)
}

async function applyCustomTheme() {
  currentTheme.value = createCustomTheme(customColor.value)
  closeThemeMenu(false)
  await ipcRenderer.invoke('settings:set-theme', `${CUSTOM_THEME_PREFIX}${customColor.value.toLowerCase()}`)
}

// ── Utils ───────────────────────────────────────────────
function scrollToBottom() {
  nextTick(() => {
    const el = chatEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

let confirmReset = false
async function doReset() {
  if (!confirmReset) {
    confirmReset = true
    resetTimer = setTimeout(() => { confirmReset = false }, 3000)
    return
  }
  await ipcRenderer.invoke('app:reset')
}
</script>

<template>
  <!-- Loading state -->
  <div v-if="!loaded" class="loading">
    <div class="spinner" />
  </div>

  <!-- First-run naming screen -->
  <div v-else-if="isFirstRun" class="setup" :style="themeVars">
    <div class="setup-card">
      <h1>欢迎使用 DeskPet</h1>
      <span v-if="appVersion" class="setup-version">v{{ appVersion }}</span>
      <p>给你的 AI 智能体取个名字吧</p>
      <input v-model="nameInput" placeholder="输入名字..." @keydown.enter="confirmName" autofocus />
      <button :disabled="!nameInput.trim()" @click="confirmName">确认</button>
    </div>
  </div>

  <!-- Chat screen -->
  <div v-else class="app" :style="themeVars">
    <div class="header">
      <span class="name">{{ agentName }}</span>
      <span v-if="appVersion" class="version-badge">v{{ appVersion }}</span>
      <span class="badge">在线</span>
      <span class="spacer" />
      <button class="icon-btn memory-btn" :class="{ active: memoryEnabled }" title="长期记忆管理" @click="openMemoryManager">
        🧠 记忆<span v-if="memoryEnabled" class="memory-count">{{ memoryCount }}</span>
      </button>
      <button class="icon-btn api-btn" :class="{ active: apiConfigured }" title="API 设置" @click="openApiSettings">
        <span class="api-dot" /> API
      </button>
      <button class="icon-btn" :class="{ active: autoSpeak }" title="语音播报" @click="toggleAutoSpeak">🔊</button>
      <div class="theme-picker">
        <button class="icon-btn" title="切换主题" @click="toggleThemeMenu">🎨</button>
        <div v-if="showThemeMenu" class="theme-menu" @click.stop>
          <div v-for="t in themes" :key="t.id" :class="['theme-item', { active: t.id === currentTheme.id }]" @click="selectTheme(t)">
            <span class="theme-swatch" :style="{ background: t.bg, border: `1px solid ${t.border}` }" />
            <span class="theme-dot" :style="{ background: t.accent }" />
            <span>{{ t.name }}</span>
          </div>
          <div :class="['theme-custom', { active: currentTheme.id === 'custom' }]">
            <label for="custom-theme-color">自定义颜色</label>
            <div class="theme-custom-controls">
              <input id="custom-theme-color" v-model="customColor" type="color" title="选择自定义颜色" @input="previewCustomTheme" />
              <span>{{ customColor.toUpperCase() }}</span>
              <button type="button" @click="applyCustomTheme">应用</button>
            </div>
            <small>自动生成明亮背景并保持文字清晰</small>
          </div>
        </div>
      </div>
      <button class="icon-btn reset-btn" @click="doReset">{{ confirmReset ? '确认?' : '重新开始' }}</button>
    </div>

    <!-- API settings dialog -->
    <div v-if="showApiSettings" class="modal-backdrop" @click.self="closeApiSettings">
      <div class="api-dialog" role="dialog" aria-modal="true" aria-label="API 设置">
        <div class="dialog-header">
          <div>
            <h2>API 设置</h2>
            <p>配置 OpenAI 兼容接口，保存后立即生效</p>
          </div>
          <button class="dialog-close" :disabled="apiSaving" title="关闭" @click="closeApiSettings">✕</button>
        </div>

        <label class="field-label" for="api-key">API Key</label>
        <input
          id="api-key"
          v-model="apiKeyInput"
          class="settings-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="apiConfigured ? '已配置；留空可保持原密钥' : '请输入 API Key'"
        />
        <div class="field-hint">密钥不会在界面中回显，并使用系统加密存储。</div>

        <label class="field-label" for="api-base-url">Base URL</label>
        <input id="api-base-url" v-model="apiBaseURL" class="settings-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1" />

        <label class="field-label" for="api-model">模型名称</label>
        <input id="api-model" v-model="apiModel" class="settings-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" @keydown.enter="saveApiSettings" />

        <div v-if="apiStatusMessage" :class="['api-status-message', { error: apiStatusError }]">{{ apiStatusMessage }}</div>

        <div class="dialog-actions">
          <span :class="['configured-state', { ready: apiConfigured }]">{{ apiConfigured ? '● 已配置' : '○ 未配置' }}</span>
          <span class="dialog-spacer" />
          <button class="secondary-btn" :disabled="apiSaving" @click="closeApiSettings">取消</button>
          <button class="primary-btn" :disabled="apiSaving" @click="saveApiSettings">{{ apiSaving ? '保存中...' : '保存配置' }}</button>
        </div>
      </div>
    </div>

    <!-- Long-term memory manager dialog -->
    <div v-if="showMemoryManager" class="modal-backdrop" @click.self="closeMemoryManager">
      <div class="memory-dialog" role="dialog" aria-modal="true" aria-label="长期记忆管理">
        <div class="dialog-header">
          <div>
            <h2>长期记忆管理</h2>
            <p>查看、手动添加或删除 DeskPet 跨会话保存的事实</p>
          </div>
          <button class="dialog-close" :disabled="memoryMutating" title="关闭" @click="closeMemoryManager">✕</button>
        </div>

        <div class="memory-summary">
          <span :class="['configured-state', { ready: memoryEnabled }]">
            {{ memoryEnabled ? `● 已启用 · ${memoryCount} 条` : '○ 已关闭' }}
          </span>
          <span class="dialog-spacer" />
          <button class="secondary-btn" :disabled="memoryLoading" @click="refreshMemoryList">{{ memoryLoading ? '读取中...' : '刷新' }}</button>
          <button class="secondary-btn" @click="openMemoryLocation">打开文件位置</button>
        </div>

        <div v-if="memoryStoragePath" class="memory-path" :title="memoryStoragePath">{{ memoryStoragePath }}</div>

        <div v-if="memoryStatusMessage" :class="['api-status-message', { error: memoryStatusError }]">{{ memoryStatusMessage }}</div>

        <section class="memory-settings-panel">
          <div class="memory-settings-title">
            <strong>方案 A 设置</strong>
            <span :class="['memory-encryption-state', { ready: memoryEncrypted }]">{{ memoryEncrypted ? '🔒 AES-256-GCM 加密' : '⚠ 加密存储不可用' }}</span>
          </div>
          <div class="memory-settings-grid">
            <label>
              <span>事实提取</span>
              <select v-model="memorySettings.extractionMode" :disabled="memoryMutating" @change="saveMemorySettings({ extractionMode: memorySettings.extractionMode })">
                <option value="rules">本地规则（稳定、免费）</option>
                <option value="smart">智能提取（调用当前聊天模型）</option>
              </select>
            </label>
            <label>
              <span>发送给聊天模型</span>
              <select v-model="memorySettings.remotePolicy" :disabled="memoryMutating" @change="saveMemorySettings({ remotePolicy: memorySettings.remotePolicy })">
                <option value="normal-only">仅普通且允许分享</option>
                <option value="allow-private">允许已授权的隐私记忆</option>
                <option value="disabled">完全不发送长期记忆</option>
              </select>
            </label>
          </div>
          <label class="memory-check-row">
            <input v-model="memorySettings.imageMemoryEnabled" type="checkbox" :disabled="memoryMutating" @change="saveMemorySettings({ imageMemoryEnabled: memorySettings.imageMemoryEnabled })" />
            <span>仅在我明确说“记住图片/截图”时，本地 OCR 提取图片文字</span>
          </label>
          <div class="semantic-model-card">
            <div>
              <strong>中文本地语义检索</strong>
              <p>{{ semanticModelName }} · {{ modelProgressLabel() }}</p>
            </div>
            <button v-if="!semanticInstalled" class="secondary-btn" :disabled="semanticInstalling" @click="installSemanticModel">
              {{ semanticInstalling ? '安装中…' : '下载并启用' }}
            </button>
            <button v-else :class="['secondary-btn', { selected: memorySettings.semanticEnabled }]" :disabled="memoryMutating" @click="saveMemorySettings({ semanticEnabled: !memorySettings.semanticEnabled })">
              {{ memorySettings.semanticEnabled ? '语义检索已启用' : '启用语义检索' }}
            </button>
          </div>
          <div class="field-hint">模型与 OCR 数据保存在可执行文件旁的 DeskPetData；智能提取只分析用户原话，失败时自动退回本地规则。</div>
        </section>

        <div v-if="!memoryEnabled" class="memory-disabled">
          长期记忆当前不可用。请查看上方错误；若是主动关闭，请检查 <code>config.json</code> 中的 <code>memoryEnabled</code> 或 <code>DESKPET_MEMORY</code> 环境变量。
        </div>

        <template v-else>
          <label class="field-label" for="manual-memory">手动添加记忆</label>
          <div class="memory-add-row">
            <textarea
              id="manual-memory"
              v-model="manualMemoryInput"
              class="settings-input memory-input"
              maxlength="1000"
              placeholder="例如：我偏好简短的中文回答"
              @keydown.ctrl.enter="addManualMemory"
            />
            <button class="primary-btn" :disabled="memoryMutating || !manualMemoryInput.trim()" @click="addManualMemory">
              {{ memoryMutating ? '处理中...' : '添加' }}
            </button>
          </div>
          <div class="field-hint">按 Ctrl + Enter 可添加。疑似密钥、密码或指令注入内容会被拒绝。</div>

          <section v-if="memoryReviewItems.length > 0 || pendingCaptureSegments > 0" class="memory-review-panel">
            <div class="memory-list-header">
              <strong>待确认候选</strong>
              <span>隔离内容不会参与回答</span>
            </div>
            <div v-if="pendingCaptureSegments > 0" class="memory-queue-status">
              <span>后台仍有 {{ pendingCaptureSegments }} 个长消息分段待处理</span>
              <button class="secondary-btn" :disabled="memoryMutating" @click="flushMemoryCaptureQueue">等待全部完成</button>
            </div>
            <div v-for="review in memoryReviewItems" :key="review.candidate.id" class="memory-review-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ review.candidate.predicate }}</span>
                  <span class="memory-state conflicted">待确认</span>
                  <span v-if="review.candidate.calibrationStatus === 'calibrated'">
                    校准概率 {{ Math.round((review.candidate.calibratedActiveProbability || 0) * 100) }}%
                    （保守下界 {{ Math.round((review.candidate.calibrationLowerBound || 0) * 100) }}%）
                  </span>
                  <span v-else>启发式验证分 {{ Math.round((review.candidate.verificationScore || 0) * 100) }}%（尚未校准）</span>
                  <span>证据 {{ Math.round((review.candidate.evidenceScore || 0) * 100) }}%</span>
                </div>
                <div class="memory-content">{{ review.candidate.canonicalText }}</div>
                <details v-if="review.evidence.length > 0" class="memory-review-evidence">
                  <summary>查看原始证据与隔离原因</summary>
                  <div v-for="evidence in review.evidence" :key="evidence.id">{{ evidence.content || '[证据已删除或不可用]' }}</div>
                  <div>原因：{{ (review.candidate.decisionReasonCodes || []).join('、') || (review.candidate.ambiguityFlags || []).join('、') }}</div>
                </details>
              </div>
              <div class="memory-item-actions">
                <button class="memory-restore-btn" :disabled="memoryMutating" @click="reviewMemoryCandidate(review.candidate.id, 'approved')">确认并保存</button>
                <button class="memory-delete-btn" :disabled="memoryMutating" @click="reviewMemoryCandidate(review.candidate.id, 'rejected')">拒绝</button>
              </div>
            </div>
            <div class="memory-review-toolbar">
              <span>策略升级后可影子重跑全部候选，不会直接改动正式记忆。</span>
              <button class="secondary-btn" :disabled="memoryMutating" @click="reprocessMemoryCandidates">影子重处理</button>
            </div>
          </section>

          <div class="memory-list-header">
            <strong>已保存的记忆</strong>
            <span>按最近更新时间排序</span>
          </div>

          <div v-if="memoryLoading" class="memory-empty">正在读取长期记忆...</div>
          <div v-else-if="memoryItems.length === 0" class="memory-empty">还没有长期记忆。你可以手动添加，或在聊天中说“请记住……”。</div>
          <div v-else class="memory-list">
            <div v-for="item in memoryItems" :key="item.id" class="memory-item">
              <div class="memory-item-main">
                <div class="memory-item-meta">
                  <span class="memory-kind">{{ memoryKindLabel(item) }}</span>
                  <span :class="['memory-state', item.status || 'active']">{{ memoryStatusLabel(item) }}</span>
                  <span>{{ formatMemoryDate(item) }}</span>
                  <span v-if="item.accessCount">召回 {{ item.accessCount }} 次</span>
                </div>
                <div v-if="editingMemoryId !== item.id" class="memory-content">{{ item.content }}</div>
                <div v-else class="memory-edit-row">
                  <textarea v-model="editingMemoryContent" class="settings-input memory-input" maxlength="1000" />
                  <div>
                    <button class="memory-restore-btn" :disabled="memoryMutating || !editingMemoryContent.trim()" @click="saveEditedMemory(item)">保存新版本</button>
                    <button class="memory-delete-btn" :disabled="memoryMutating" @click="cancelEditMemory">取消</button>
                  </div>
                </div>
                <div class="memory-item-controls">
                  <label>重要度
                    <select v-model.number="item.importance" :disabled="memoryMutating" @change="updateMemory(item, { importance: item.importance })">
                      <option :value="0.25">低</option>
                      <option :value="0.6">中</option>
                      <option :value="0.85">高</option>
                      <option :value="1">最高</option>
                    </select>
                  </label>
                  <label>敏感级别
                    <select v-model="item.sensitivity" :disabled="memoryMutating" @change="updateMemorySensitivity(item)">
                      <option value="normal">普通</option>
                      <option value="private">隐私</option>
                      <option value="secret">机密（绝不发送）</option>
                    </select>
                  </label>
                  <label>分享策略
                    <select v-model="item.sharePolicy" :disabled="memoryMutating || item.sensitivity === 'secret'" @change="updateMemory(item, { sharePolicy: item.sharePolicy })">
                      <option value="allow-remote">允许随请求发送</option>
                      <option value="local-only">仅限本机</option>
                      <option value="ask">待授权（暂不发送）</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="memory-item-actions">
                <button v-if="editingMemoryId !== item.id && item.status !== 'deleted'" class="memory-restore-btn" :disabled="memoryMutating" @click="beginEditMemory(item)">编辑正文</button>
                <button v-if="(!item.status || item.status === 'active')" class="memory-restore-btn" :disabled="memoryMutating" @click="suppressMemory(item)">停止使用</button>
                <button v-if="item.status && item.status !== 'active'" class="memory-restore-btn" :disabled="memoryMutating" @click="restoreMemory(item)">恢复</button>
                <button
                  :class="['memory-delete-btn', { confirm: pendingDeleteMemoryId === item.id }]"
                  :disabled="memoryMutating"
                  @click="deleteMemory(item.id)"
                >
                  {{ pendingDeleteMemoryId === item.id ? '确认普通删除' : '普通删除' }}
                </button>
                <button class="memory-purge-btn" :disabled="memoryMutating" @click="preparePurgeMemory(item.id)">彻底清除…</button>
              </div>
              <div v-if="pendingPurgeMemoryId === item.id" class="memory-purge-confirm">
                <strong>不可恢复操作</strong>
                <span>{{ purgeWarning }}</span>
                <label>输入“彻底清除”确认
                  <input v-model="purgePhrase" class="settings-input" type="text" autocomplete="off" @keydown.enter="confirmPurgeMemory(item.id)" />
                </label>
                <div>
                  <button class="danger-btn" :disabled="memoryMutating || purgePhrase.trim() !== '彻底清除'" @click="confirmPurgeMemory(item.id)">清除正文、版本、证据和受管备份</button>
                  <button class="memory-restore-btn" :disabled="memoryMutating" @click="cancelPurgeMemory">取消</button>
                </div>
              </div>
            </div>
          </div>

          <div class="memory-footer">
            <span>记忆加密写入 <code>memories.enc</code>；普通删除保留 V4 审计墓碑，“彻底清除”才会移除可恢复正文、版本、独占证据和受管备份。</span>
            <button class="danger-btn" :disabled="memoryMutating || memoryItems.length === 0" @click="clearAllMemories">
              {{ confirmClearMemories ? '再次确认普通清空' : '普通清空全部（保留审计）' }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="chat" ref="chatEl">
      <div v-if="messages.length === 0" class="empty">
        <h1>{{ agentName }}</h1>
        <p>你的 AI 桌面助手，输入消息开始对话</p>
      </div>
      <div v-for="msg in messages" :key="msg.id" :class="['message', msg.role]">
        <div class="message-body">
          <div class="bubble">
            <span v-if="msg.hasImage" class="img-tag">📷 识屏</span>
            {{ msg.content || (msg.role === 'assistant' && isLoading ? '...' : '') }}
          </div>
          <details v-if="msg.memoryReview" class="v4-internal-review">
            <summary>
              V4 内部候选 · 不参与正式回答 ·
              {{ msg.memoryReview.v4.abstained ? '已拒答' : `${msg.memoryReview.v4.candidates.length} 条证据` }}
            </summary>
            <div class="v4-review-warning">
              当前回复仍完全由 V3 记忆生成；这里仅用于本地比较，不会再次发送给模型。
            </div>
            <div class="v4-review-metrics">
              <span>V3 注入 {{ msg.memoryReview.v3.injectedCount }}</span>
              <span>V4 最佳证据 {{ Math.round(msg.memoryReview.v4.bestEvidenceScore * 100) }}%</span>
              <span>拒答门槛 {{ Math.round(msg.memoryReview.v4.threshold * 100) }}%</span>
              <span>重合 {{ msg.memoryReview.agreement.overlapCount }}</span>
            </div>
            <div v-for="candidate in msg.memoryReview.v4.candidates" :key="candidate.factId" class="v4-review-candidate">
              <div>{{ candidate.content }}</div>
              <small>
                证据 {{ Math.round(candidate.score * 100) }}% · {{ candidate.status }} ·
                {{ candidate.routes.join(' + ') }}
              </small>
            </div>
            <div v-if="msg.memoryReview.v4.candidates.length === 0" class="v4-review-empty">
              V4 判断当前没有足够可靠的长期记忆。
            </div>
          </details>
        </div>
        <button v-if="!isLoading" class="rollback-btn" title="从这条消息撤回" @click="rollback(msg.id)">↩</button>
      </div>
    </div>

    <!-- Pending image preview -->
    <div v-if="pendingImage" class="image-preview">
      <img :src="`data:${pendingImage.mimeType};base64,${pendingImage.data}`" alt="screenshot" />
      <button class="clear-img" @click="clearPendingImage">✕</button>
    </div>

    <!-- Voice error toast -->
    <div v-if="voiceError" class="voice-error">{{ voiceError }}</div>

    <div class="input-area">
      <button class="tool-btn" :disabled="isCapturing || isLoading" title="识屏" @click="captureScreen">
        {{ isCapturing ? '⏳' : '📷' }}
      </button>
      <button class="tool-btn" :class="{ listening: isListening }" :disabled="isLoading" title="语音输入" @click="toggleListening">
        {{ isListening ? '🔴' : '🎤' }}
      </button>
      <textarea v-model="input" placeholder="输入消息..." :disabled="isLoading" @keydown="onKeydown" rows="1" />
      <button class="send-btn" :disabled="isLoading || (!input.trim() && !pendingImage)" @click="send">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13" /><path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

/* Loading */
.loading { display: flex; align-items: center; justify-content: center; height: 100vh; background: #0f1117; }
.spinner { width: 28px; height: 28px; border: 3px solid #353840; border-top-color: #2d7d46; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Setup */
.setup { display: flex; align-items: center; justify-content: center; height: 100vh; background: var(--bg); color: var(--text); }
.setup-card { text-align: center; display: flex; flex-direction: column; gap: 16px; width: 320px; }
.setup-card h1 { font-size: 24px; font-weight: 600; }
.setup-version { align-self: center; margin-top: -10px; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.setup-card p { opacity: 0.6; font-size: 14px; }
.setup-card input { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; font-size: 16px; outline: none; text-align: center; font-family: inherit; }
.setup-card input:focus { border-color: var(--accent); }
.setup-card button { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 12px; font-size: 15px; cursor: pointer; font-family: inherit; }
.setup-card button:disabled { opacity: 0.4; cursor: default; }

/* Chat */
.app { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); }

.header { display: flex; align-items: center; gap: 10px; padding: 10px 20px; background: var(--bg); border-bottom: 1px solid var(--border); position: relative; }
.header .name { font-size: 15px; font-weight: 600; }
.header .version-badge { color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.header .badge { font-size: 11px; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 6px; }
.header .spacer { flex: 1; }
.icon-btn { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 14px; cursor: pointer; font-family: inherit; }
.icon-btn:hover { background: var(--surface); color: var(--text); }
.icon-btn.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.reset-btn { white-space: nowrap; font-size: 12px; }
.api-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.api-dot { width: 7px; height: 7px; border-radius: 50%; background: #d97757; box-shadow: 0 0 0 2px rgba(217,119,87,0.15); }
.api-btn.active .api-dot { background: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.memory-btn { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; }
.memory-count { min-width: 18px; padding: 1px 5px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); text-align: center; font-size: 10px; }

/* API settings dialog */
.modal-backdrop { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.58); backdrop-filter: blur(3px); }
.api-dialog, .memory-dialog { max-height: calc(100vh - 48px); overflow-y: auto; padding: 22px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 24px 70px rgba(0,0,0,0.45); }
.api-dialog { width: min(480px, 100%); }
.memory-dialog { width: min(780px, 100%); }
.dialog-header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
.dialog-header h2 { font-size: 19px; font-weight: 650; }
.dialog-header p { margin-top: 5px; color: var(--text-muted); font-size: 12px; }
.dialog-close { margin-left: auto; border: 0; background: transparent; color: var(--text-muted); padding: 4px; font-size: 16px; cursor: pointer; }
.dialog-close:hover { color: var(--text); }
.field-label { display: block; margin: 14px 0 7px; color: var(--text); font-size: 13px; font-weight: 600; }
.settings-input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; outline: none; background: var(--bg); color: var(--text); font-family: inherit; font-size: 13px; }
.settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field-hint { margin-top: 6px; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
.api-status-message { margin-top: 14px; padding: 9px 11px; border-radius: 7px; background: var(--accent-soft); color: var(--accent); font-size: 12px; }
.api-status-message.error { background: rgba(231,76,60,0.14); color: #e76f61; }
.dialog-actions { display: flex; align-items: center; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.configured-state { color: var(--text-muted); font-size: 11px; }
.configured-state.ready { color: var(--accent); }
.dialog-spacer { flex: 1; }
.secondary-btn, .primary-btn { border-radius: 7px; padding: 8px 13px; font-family: inherit; font-size: 12px; cursor: pointer; }
.secondary-btn { border: 1px solid var(--border); background: transparent; color: var(--text); }
.primary-btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
.secondary-btn:disabled, .primary-btn:disabled, .dialog-close:disabled { opacity: 0.5; cursor: default; }

/* Long-term memory manager */
.memory-summary { display: flex; align-items: center; gap: 8px; }
.memory-path { margin-top: 10px; padding: 8px 10px; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text-muted); font-family: Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.memory-settings-panel { margin-top: 14px; padding: 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.memory-settings-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.memory-encryption-state { color: #e76f61; font-size: 10px; }
.memory-encryption-state.ready { color: var(--accent); }
.memory-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 11px; }
.memory-settings-grid label, .memory-item-controls label { color: var(--text-muted); font-size: 10px; }
.memory-settings-grid label > span { display: block; margin-bottom: 5px; }
.memory-settings-grid select, .memory-item-controls select { width: 100%; padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; outline: none; background: var(--surface); color: var(--text); font: inherit; }
.memory-check-row { display: flex; align-items: center; gap: 7px; margin-top: 11px; color: var(--text); font-size: 11px; cursor: pointer; }
.memory-check-row input { accent-color: var(--accent); }
.semantic-model-card { display: flex; align-items: center; gap: 12px; margin-top: 11px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.semantic-model-card > div { min-width: 0; flex: 1; }
.semantic-model-card strong { font-size: 11px; }
.semantic-model-card p { margin-top: 3px; overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.secondary-btn.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.memory-disabled, .memory-empty { margin-top: 16px; padding: 22px 16px; border: 1px dashed var(--border); border-radius: 9px; color: var(--text-muted); text-align: center; font-size: 12px; line-height: 1.6; }
.memory-disabled code, .memory-footer code { font-family: Consolas, monospace; color: var(--text); }
.memory-add-row { display: flex; align-items: stretch; gap: 8px; }
.memory-input { min-height: 62px; resize: vertical; line-height: 1.45; }
.memory-add-row .primary-btn { min-width: 72px; }
.memory-review-panel { margin-top: 16px; padding: 12px; border: 1px solid rgba(217,119,87,0.45); border-radius: 9px; background: rgba(217,119,87,0.06); }
.memory-review-panel .memory-list-header { margin-top: 0; }
.memory-review-item { display: flex; gap: 12px; margin-top: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.memory-review-evidence { margin-top: 8px; color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.memory-review-evidence summary { cursor: pointer; color: var(--accent); }
.memory-review-evidence div { margin-top: 5px; padding: 6px; border-radius: 5px; background: var(--surface); white-space: pre-wrap; }
.memory-review-toolbar, .memory-queue-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; color: var(--text-muted); font-size: 10px; }
.memory-list-header { display: flex; align-items: baseline; justify-content: space-between; margin: 20px 0 8px; }
.memory-list-header strong { font-size: 13px; }
.memory-list-header span { color: var(--text-muted); font-size: 10px; }
.memory-list { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow-y: auto; padding-right: 3px; }
.memory-list::-webkit-scrollbar { width: 5px; }
.memory-list::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--scroll-thumb); }
.memory-item { display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.memory-item-main { min-width: 0; flex: 1; }
.memory-item-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--text-muted); font-size: 10px; }
.memory-kind { padding: 2px 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); }
.memory-state { padding: 2px 5px; border-radius: 5px; background: rgba(231,76,60,0.12); color: #e76f61; }
.memory-state.active { background: rgba(45,125,70,0.13); color: var(--accent); }
.memory-state.conflicted { background: rgba(217,119,87,0.15); color: #d97757; }
.memory-content { color: var(--text); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.memory-edit-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
.memory-edit-row > div { display: flex; flex-direction: column; gap: 6px; }
.memory-item-controls { display: grid; grid-template-columns: 0.65fr 1fr 1.2fr; gap: 7px; margin-top: 9px; }
.memory-item-controls select { display: block; margin-top: 4px; padding: 5px 6px; font-size: 9px; }
.memory-item-actions { display: flex; flex-direction: column; flex-shrink: 0; gap: 6px; }
.memory-restore-btn { padding: 6px 9px; border: 1px solid var(--accent); border-radius: 7px; background: transparent; color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; }
.memory-delete-btn, .memory-purge-btn, .danger-btn { border: 1px solid rgba(231,76,60,0.45); border-radius: 7px; background: transparent; color: #e76f61; cursor: pointer; font-family: inherit; font-size: 11px; }
.memory-delete-btn { flex-shrink: 0; padding: 6px 9px; }
.memory-purge-btn { flex-shrink: 0; padding: 6px 9px; border-style: dashed; }
.memory-delete-btn.confirm, .danger-btn:hover { background: rgba(231,76,60,0.14); border-color: #e76f61; }
.memory-delete-btn:disabled, .memory-purge-btn:disabled, .danger-btn:disabled { opacity: 0.45; cursor: default; }
.memory-purge-confirm { grid-column: 1 / -1; display: grid; gap: 8px; margin-top: 10px; padding: 12px; border: 1px solid rgba(231,76,60,0.45); border-radius: 8px; background: rgba(231,76,60,0.08); color: var(--text); font-size: 12px; }
.memory-purge-confirm > div { display: flex; gap: 8px; flex-wrap: wrap; }
.memory-purge-confirm .danger-btn, .memory-purge-confirm .memory-restore-btn { padding: 7px 10px; }
.memory-footer { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.memory-footer > span { flex: 1; color: var(--text-muted); font-size: 10px; }
.danger-btn { padding: 7px 10px; }

@media (max-width: 720px) {
  .memory-settings-grid, .memory-item-controls { grid-template-columns: 1fr; }
  .memory-item { flex-direction: column; }
  .memory-review-item { flex-direction: column; }
  .memory-item-actions { width: 100%; flex-direction: row; }
}

.theme-picker { position: relative; }
.theme-menu { position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 100; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px; min-width: 150px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.theme-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text); }
.theme-item:hover { background: var(--surface-hover); }
.theme-item.active { background: var(--accent-soft); color: var(--accent); }
.theme-swatch { width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; }
.theme-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.theme-custom { margin-top: 5px; padding: 9px 10px 7px; border-top: 1px solid var(--border); color: var(--text); }
.theme-custom.active { color: var(--accent); }
.theme-custom > label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
.theme-custom-controls { display: flex; align-items: center; gap: 7px; }
.theme-custom-controls input { width: 30px; height: 26px; padding: 0; border: 1px solid var(--border); border-radius: 5px; background: transparent; cursor: pointer; }
.theme-custom-controls span { flex: 1; color: var(--text-muted); font-family: Consolas, monospace; font-size: 10px; }
.theme-custom-controls button { padding: 5px 9px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; font-size: 11px; }
.theme-custom small { display: block; margin-top: 6px; color: var(--text-muted); font-size: 9px; white-space: nowrap; }

.chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.5; gap: 8px; }
.empty h1 { font-size: 28px; font-weight: 600; }

.message { display: flex; max-width: 85%; }
.message.user { align-self: flex-end; }
.message.assistant { align-self: flex-start; }
.message-body { display: flex; min-width: 0; flex-direction: column; gap: 6px; }

.bubble { padding: 10px 16px; border-radius: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
.message.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.message.assistant .bubble { background: var(--surface); color: var(--text); border-bottom-left-radius: 4px; }
.img-tag { display: inline-block; margin-right: 6px; opacity: 0.8; }

.rollback-btn { opacity: 0; transition: opacity 0.15s; background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; align-self: center; margin: 0 4px; }
.rollback-btn:hover { background: var(--surface); color: var(--text); border-color: var(--text-muted); }
.message:hover .rollback-btn { opacity: 1; }
.v4-internal-review { max-width: 620px; padding: 7px 9px; border: 1px dashed rgba(217,119,87,0.55); border-radius: 8px; background: rgba(217,119,87,0.07); color: var(--text-muted); font-size: 10px; }
.v4-internal-review summary { cursor: pointer; color: #d97757; font-weight: 600; }
.v4-review-warning { margin-top: 7px; line-height: 1.45; }
.v4-review-metrics { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 7px; }
.v4-review-candidate { margin-top: 7px; padding: 7px; border-radius: 6px; background: var(--surface); color: var(--text); line-height: 1.4; }
.v4-review-candidate small { display: block; margin-top: 4px; color: var(--text-muted); }
.v4-review-empty { margin-top: 7px; color: var(--text-muted); }

/* Image preview */
.image-preview { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--surface); border-top: 1px solid var(--border); }
.image-preview img { height: 60px; border-radius: 6px; border: 1px solid var(--border); }
.clear-img { background: transparent; color: var(--text-muted); border: none; cursor: pointer; font-size: 16px; padding: 4px; }
.clear-img:hover { color: var(--text); }

/* Voice error */
.voice-error { padding: 8px 16px; background: rgba(231,76,60,0.15); color: #e74c3c; font-size: 13px; text-align: center; border-top: 1px solid rgba(231,76,60,0.3); }

/* Input area */
.input-area { display: flex; gap: 8px; padding: 12px 16px; background: var(--bg); border-top: 1px solid var(--border); align-items: flex-end; }
.tool-btn { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; font-size: 18px; transition: background 0.15s; }
.tool-btn:hover { background: var(--surface-hover); }
.tool-btn:disabled { opacity: 0.4; cursor: default; }
.tool-btn.listening { animation: pulse 1.2s ease-in-out infinite; border-color: #e74c3c; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.input-area textarea { flex: 1; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 14px; outline: none; font-family: inherit; resize: none; max-height: 120px; }
.input-area textarea:focus { border-color: var(--accent); }
.send-btn { background: var(--accent); color: #fff; border: none; border-radius: 10px; width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s; flex-shrink: 0; }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.send-btn:not(:disabled):hover { background: var(--accent-hover); }

.chat::-webkit-scrollbar { width: 6px; }
.chat::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 3px; }
</style>
