<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'

const { ipcRenderer } = (window as any).require('electron')

interface Message {
  role: 'user' | 'assistant'
  content: string
  id: string
}

const messages = ref<Message[]>([])
const input = ref('')
const isLoading = ref(false)
const chatEl = ref<HTMLElement | null>(null)

onMounted(() => {
  ipcRenderer.on('chat:token', (_event: any, token: string) => {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.content += token
      scrollToBottom()
    }
  })
})

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
</script>

<template>
  <div class="app">
    <div class="chat" ref="chatEl">
      <div v-if="messages.length === 0" class="empty">
        <h1>DeskPet</h1>
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

.app {
  display: flex; flex-direction: column; height: 100vh; max-height: 100vh;
}

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