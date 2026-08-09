<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed } from 'vue'

const { ipcRenderer } = (window as any).require('electron')

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
  hasImage?: boolean
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

// ── Speech synthesis types (Chromium built-in TTS) ─────
// (speechSynthesis and SpeechSynthesisUtterance are global DOM types)

const themes: Theme[] = [
  { id: 'dark', name: '深空黑', bg: '#0f1117', surface: '#1c1f26', surfaceHover: '#252830', border: '#252830', text: '#e1e4e8', textMuted: '#666', accent: '#2d7d46', accentHover: '#35954f', accentSoft: 'rgba(45,125,70,0.15)', scrollThumb: '#353840' },
  { id: 'light', name: '日光白', bg: '#f6f8fa', surface: '#ffffff', surfaceHover: '#eaeef2', border: '#d0d7de', text: '#1f2328', textMuted: '#656d76', accent: '#0969da', accentHover: '#0550ae', accentSoft: 'rgba(9,105,218,0.12)', scrollThumb: '#c0c7cf' },
  { id: 'forest', name: '护眼绿', bg: '#1a2e1f', surface: '#243a2c', surfaceHover: '#2d4534', border: '#2d4534', text: '#d4e8d4', textMuted: '#7a9a7a', accent: '#5cb85c', accentHover: '#6cc96c', accentSoft: 'rgba(92,184,92,0.15)', scrollThumb: '#3a5240' },
  { id: 'warm', name: '暖夕阳', bg: '#1f1a17', surface: '#2a221e', surfaceHover: '#332923', border: '#332923', text: '#f0e0d0', textMuted: '#8a7a6a', accent: '#d97757', accentHover: '#e88566', accentSoft: 'rgba(217,119,87,0.15)', scrollThumb: '#3d322c' },
  { id: 'ocean', name: '深海蓝', bg: '#0d1929', surface: '#16263d', surfaceHover: '#1e3251', border: '#1e3251', text: '#c8daf0', textMuted: '#5a7a9a', accent: '#3b82f6', accentHover: '#4c92f8', accentSoft: 'rgba(59,130,246,0.15)', scrollThumb: '#243a55' },
]

// ── State ───────────────────────────────────────────────
const agentName = ref('DeskPet')
const isFirstRun = ref(true)
const loaded = ref(false)
const nameInput = ref('')
const messages = ref<Message[]>([])
const input = ref('')
const isLoading = ref(false)
const chatEl = ref<HTMLElement | null>(null)
const currentTheme = ref<Theme>(themes[0]!)
const showThemeMenu = ref(false)

// API settings state
const showApiSettings = ref(false)
const apiConfigured = ref(false)
const apiKeyInput = ref('')
const apiBaseURL = ref('https://api.openai.com/v1')
const apiModel = ref('gpt-4o-mini')
const apiSaving = ref(false)
const apiStatusMessage = ref('')
const apiStatusError = ref(false)

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

// ── Lifecycle ───────────────────────────────────────────
onMounted(async () => {
  const settings = await ipcRenderer.invoke('settings:get')
  if (settings.agentName) {
    agentName.value = settings.agentName
    isFirstRun.value = false
  }
  if (settings.theme) {
    const t = themes.find(t => t.id === settings.theme)
    if (t) currentTheme.value = t
  }

  await refreshApiStatus()

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
})

onUnmounted(() => {
  ipcRenderer.removeListener('chat:token', onToken)
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
  await refreshApiStatus()
  apiKeyInput.value = ''
  apiStatusMessage.value = ''
  apiStatusError.value = false
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
    if (autoSpeak.value) {
      nextTick(() => speak(assistantMsg.content))
    }
  }
  catch (err) {
    assistantMsg.content = '[Error: ' + (err instanceof Error ? err.message : 'unknown') + ']'
  }
  finally {
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
async function selectTheme(t: Theme) {
  currentTheme.value = t
  showThemeMenu.value = false
  await ipcRenderer.invoke('settings:set-theme', t.id)
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
      <p>给你的 AI 智能体取个名字吧</p>
      <input v-model="nameInput" placeholder="输入名字..." @keydown.enter="confirmName" autofocus />
      <button :disabled="!nameInput.trim()" @click="confirmName">确认</button>
    </div>
  </div>

  <!-- Chat screen -->
  <div v-else class="app" :style="themeVars">
    <div class="header">
      <span class="name">{{ agentName }}</span>
      <span class="badge">在线</span>
      <span class="spacer" />
      <button class="icon-btn api-btn" :class="{ active: apiConfigured }" title="API 设置" @click="openApiSettings">
        <span class="api-dot" /> API
      </button>
      <button class="icon-btn" :class="{ active: autoSpeak }" title="语音播报" @click="toggleAutoSpeak">🔊</button>
      <div class="theme-picker">
        <button class="icon-btn" title="切换主题" @click="showThemeMenu = !showThemeMenu">🎨</button>
        <div v-if="showThemeMenu" class="theme-menu" @click.stop>
          <div v-for="t in themes" :key="t.id" :class="['theme-item', { active: t.id === currentTheme.id }]" @click="selectTheme(t)">
            <span class="theme-swatch" :style="{ background: t.bg, border: `1px solid ${t.border}` }" />
            <span class="theme-dot" :style="{ background: t.accent }" />
            <span>{{ t.name }}</span>
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

    <div class="chat" ref="chatEl">
      <div v-if="messages.length === 0" class="empty">
        <h1>{{ agentName }}</h1>
        <p>你的 AI 桌面助手，输入消息开始对话</p>
      </div>
      <div v-for="msg in messages" :key="msg.id" :class="['message', msg.role]">
        <div class="bubble">
          <span v-if="msg.hasImage" class="img-tag">📷 识屏</span>
          {{ msg.content || (msg.role === 'assistant' && isLoading ? '...' : '') }}
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
.setup-card p { opacity: 0.6; font-size: 14px; }
.setup-card input { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; font-size: 16px; outline: none; text-align: center; font-family: inherit; }
.setup-card input:focus { border-color: var(--accent); }
.setup-card button { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 12px; font-size: 15px; cursor: pointer; font-family: inherit; }
.setup-card button:disabled { opacity: 0.4; cursor: default; }

/* Chat */
.app { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); }

.header { display: flex; align-items: center; gap: 10px; padding: 10px 20px; background: var(--bg); border-bottom: 1px solid var(--border); position: relative; }
.header .name { font-size: 15px; font-weight: 600; }
.header .badge { font-size: 11px; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 6px; }
.header .spacer { flex: 1; }
.icon-btn { background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 14px; cursor: pointer; font-family: inherit; }
.icon-btn:hover { background: var(--surface); color: var(--text); }
.icon-btn.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.reset-btn { white-space: nowrap; font-size: 12px; }
.api-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.api-dot { width: 7px; height: 7px; border-radius: 50%; background: #d97757; box-shadow: 0 0 0 2px rgba(217,119,87,0.15); }
.api-btn.active .api-dot { background: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

/* API settings dialog */
.modal-backdrop { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.58); backdrop-filter: blur(3px); }
.api-dialog { width: min(480px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; padding: 22px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 24px 70px rgba(0,0,0,0.45); }
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

.theme-picker { position: relative; }
.theme-menu { position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 100; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px; min-width: 150px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.theme-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text); }
.theme-item:hover { background: var(--surface-hover); }
.theme-item.active { background: var(--accent-soft); color: var(--accent); }
.theme-swatch { width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; }
.theme-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

.chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.5; gap: 8px; }
.empty h1 { font-size: 28px; font-weight: 600; }

.message { display: flex; max-width: 85%; }
.message.user { align-self: flex-end; }
.message.assistant { align-self: flex-start; }

.bubble { padding: 10px 16px; border-radius: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
.message.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.message.assistant .bubble { background: var(--surface); color: var(--text); border-bottom-left-radius: 4px; }
.img-tag { display: inline-block; margin-right: 6px; opacity: 0.8; }

.rollback-btn { opacity: 0; transition: opacity 0.15s; background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; align-self: center; margin: 0 4px; }
.rollback-btn:hover { background: var(--surface); color: var(--text); border-color: var(--text-muted); }
.message:hover .rollback-btn { opacity: 1; }

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
