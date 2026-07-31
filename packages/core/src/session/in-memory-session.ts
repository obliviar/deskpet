import type { ChatHistoryItem } from '@deskpet/contracts'

/**
 * Default in-memory session store.
 *
 * Keeps a per-session ring of history items and a monotonic generation
 * counter used to reject stale queued sends.
 */
export function createInMemorySession(maxPerSession = 100) {
  const sessions = new Map<string, { messages: ChatHistoryItem[]; generation: number }>()

  return {
    ensureSession(sessionId: string) {
      if (!sessions.has(sessionId))
        sessions.set(sessionId, { messages: [], generation: 0 })
    },
    getSessionMessages(sessionId: string): ChatHistoryItem[] {
      return sessions.get(sessionId)?.messages ?? []
    },
    appendSessionMessage(sessionId: string, message: ChatHistoryItem) {
      const s = sessions.get(sessionId)
      if (!s)
        return
      s.messages.push(message)
      // Trim to the recent window to bound memory growth.
      if (s.messages.length > maxPerSession)
        s.messages.splice(0, s.messages.length - maxPerSession)
    },
    getSessionGeneration(sessionId: string): number {
      return sessions.get(sessionId)?.generation ?? 0
    },
    bumpSessionGeneration(sessionId: string) {
      const s = sessions.get(sessionId)
      if (s)
        s.generation++
    },
  }
}
