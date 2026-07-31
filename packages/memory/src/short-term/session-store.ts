import type { ChatHistoryItem, ChatRole, ToolCall } from '@deskpet/contracts'

/**
 * Short-term session store backed by an in-memory ring buffer.
 *
 * Replace this module with DuckDB WASM or pglite for persistence.
 */
export interface SessionStoreOptions {
  /** Max history items to keep per session. */
  maxPerSession?: number
}

export interface SessionRecord {
  messages: ChatHistoryItem[]
  generation: number
}

export function createShortTermSessionStore(options: SessionStoreOptions = {}) {
  const { maxPerSession = 100 } = options
  const sessions = new Map<string, SessionRecord>()

  return {
    ensureSession(sessionId: string) {
      if (!sessions.has(sessionId))
        sessions.set(sessionId, { messages: [], generation: 0 })
    },

    getMessages(sessionId: string): ChatHistoryItem[] {
      return sessions.get(sessionId)?.messages ?? []
    },

    append(sessionId: string, item: { role: ChatRole; content: string; toolCallId?: string; toolCalls?: ToolCall[] }) {
      const s = sessions.get(sessionId)
      if (!s)
        return
      const entry: ChatHistoryItem = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...item,
      }
      s.messages.push(entry)
      if (s.messages.length > maxPerSession)
        s.messages.splice(0, s.messages.length - maxPerSession)
    },

    getGeneration(sessionId: string): number {
      return sessions.get(sessionId)?.generation ?? 0
    },

    bumpGeneration(sessionId: string) {
      const s = sessions.get(sessionId)
      if (s)
        s.generation++
    },

    deleteSession(sessionId: string) {
      sessions.delete(sessionId)
    },

    allSessionIds(): string[] {
      return [...sessions.keys()]
    },
  }
}

export type ShortTermSessionStore = ReturnType<typeof createShortTermSessionStore>