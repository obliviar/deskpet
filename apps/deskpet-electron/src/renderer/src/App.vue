<script setup lang="ts">
import { ref, nextTick, onMounted, computed } from 'vue'

const { ipcRenderer } = (window as any).require('electron')

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
}

const agentName = ref('DeskPet')
const isFirstRun = ref(true)
const nameInput = ref('')
const messages = ref<Message[]>([])
const input = ref('')
const isLoading = ref(false)
const chatEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  const settings = await ipcRenderer.invoke('settings:get')
  if (settings.agentName) {
    agentName.value = settings.agentName
    isFirstRun.value = false
  }

  const history = await ipcRenderer.invoke('sessions:history')
  if (history && history.length > 0) {
    messages.value = history.map((h: any) => ({
      id: h.id || crypto.randomUUID(),
      role: h.role,
      content: h.content,
    }))
  }

  if (!isFirstRun.value)
    scrollToBottom()

  ipcRenderer.on('chat:token', (_event: any, token: string) => {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content += token
      scrollToBottom()
    }
  })
})

async function confirmName() {
  const name = nameInput.value.trim()
  if (!name) return
  await ipcRenderer.invoke('settings:set-name', name)
  agentName.value = name
  isFirstRun.value = false
}

async function send() {
  const text = input.value.trim()
  if (!text || isLoading.value) return

  isLoading.value = true
  input.value = ''

  const userMsg: Message = { role: 'user', content: text, id: crypto.randomUUID() }
  messages.value.push(userMsg)
  const assistantMsg: Message = { role: 'assistant', content: '', id: crypto.randomUUID() }
  messages.value.push(assistantMsg)
  scrollToBottom()

  try {
    await ipcRenderer.invoke('chat:send', text)
  }
  catch (err) {
    assistantMsg.content = '[Error: ' + (err instanceof Error ? err.message : 'unknown') + ']'
  }
  finally {
    isLoading.value = false
    scrollToBottom()
  }
}

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
    setTimeout(() => { confirmReset = false }, 3000)
    return
  }
  await ipcRenderer.invoke('app:reset')
}
</script>

<template>
  <!-- First-run naming screen -->
  <div v-if="isFirstRun" class="setup">
    <div class="setup-card">
      <h1>欢迎使用 DeskPet</h1>
      <p>给你的 AI 智能体取个名字吧</p>
      <input
        v-model="nameInput"
        placeholder="输入名字..."
        @keydown.enter="confirmName"
        autofocus
      />
      <button :disabled="!nameInput.trim()" @click="confirmName">
        确认
      </button>
    </div>
  </div>

  <!-- Chat screen -->
  <div v-else class="app">
    <div class="header">
      <span class="name">{{ agentName }}</span>
      <span class="badge">在线</span>
      <span class="spacer" />
      <button class="reset-btn" @click="doReset">
        {{ confirmReset ? '确认重置?' : '重新开始' }}
      </button>
    </div>
    <div class="chat" ref="chatEl">
      <div v-if="messages.length === 0" class="empty">
        <h1>{{ agentName }}</h1>
        <p>你的 AI 桌面助手，输入消息开始对话</p>
      </div>
      <div
        v-for="msg in messages"
        :key="msg.id"
        :class="['message', msg.role]"
      >
        <div class="bubble">{{ msg.content || (msg.role === 'assistant' && isLoading ? '...' : '') }}</div>
      </div>
    </div>
    <div class="input-area">
      <textarea
        v-model="input"
        placeholder="输入消息..."
        :disabled="isLoading"
        @keydown="onKeydown"
        rows="1"
      />
      <button :disabled="isLoading || !input.trim()" @click="send">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13" /><path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; }

/* Setup screen */
.setup {
  display: flex; align-items: center; justify-content: center; height: 100vh;
}
.setup-card {
  text-align: center; display: flex; flex-direction: column; gap: 16px;
  width: 320px;
}
.setup-card h1 { font-size: 24px; font-weight: 600; }
.setup-card p { opacity: 0.6; font-size: 14px; }
.setup-card input {
  background: #1c1f26; color: #e1e4e8; border: 1px solid #353840;
  border-radius: 10px; padding: 12px 16px; font-size: 16px; outline: none;
  text-align: center; font-family: inherit;
}
.setup-card input:focus { border-color: #2d7d46; }
.setup-card button {
  background: #2d7d46; color: #fff; border: none; border-radius: 10px;
  padding: 12px; font-size: 15px; cursor: pointer; font-family: inherit;
}
.setup-card button:disabled { opacity: 0.4; cursor: default; }

/* Chat */
.app { display: flex; flex-direction: column; height: 100vh; }

.header {
  display: flex; align-items: center; gap: 10px; padding: 12px 20px;
  background: #0f1117; border-bottom: 1px solid #252830;
}
.header .name { font-size: 15px; font-weight: 600; }
.header .badge { font-size: 11px; color: #2d7d46; background: rgba(45,125,70,0.15); padding: 2px 8px; border-radius: 6px; }
.header .spacer { flex: 1; }
.header .reset-btn {
  background: transparent; color: #666; border: 1px solid #353840; border-radius: 6px;
  padding: 3px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.header .reset-btn:hover { background: #1c1f26; color: #e1e4e8; }

.chat {
  flex: 1; overflow-y: auto; padding: 20px;
  display: flex; flex-direction: column; gap: 16px;
}
.empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; opacity: 0.5; gap: 8px;
}
.empty h1 { font-size: 28px; font-weight: 600; }

.message { display: flex; max-width: 85%; }
.message.user { align-self: flex-end; }
.message.assistant { align-self: flex-start; }

.bubble {
  padding: 10px 16px; border-radius: 14px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; font-size: 14px;
}
.message.user .bubble { background: #2d7d46; color: #fff; border-bottom-right-radius: 4px; }
.message.assistant .bubble { background: #1c1f26; color: #e1e4e8; border-bottom-left-radius: 4px; }

.input-area {
  display: flex; gap: 8px; padding: 12px 16px; background: #0f1117;
  border-top: 1px solid #252830;
}
.input-area textarea {
  flex: 1; background: #1c1f26; color: #e1e4e8; border: 1px solid #353840;
  border-radius: 10px; padding: 10px 14px; font-size: 14px; outline: none;
  font-family: inherit; resize: none; max-height: 120px;
}
.input-area textarea:focus { border-color: #2d7d46; }
.input-area button {
  background: #2d7d46; color: #fff; border: none; border-radius: 10px;
  width: 42px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: opacity 0.15s; flex-shrink: 0;
}
.input-area button:disabled { opacity: 0.4; cursor: default; }
.input-area button:not(:disabled):hover { background: #35954f; }

.chat::-webkit-scrollbar { width: 6px; }
.chat::-webkit-scrollbar-thumb { background: #353840; border-radius: 3px; }
</style>