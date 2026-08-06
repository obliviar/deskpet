import type { AgentSessionPort, ChatHistoryItem } from '@deskpet/contracts'
import { createInMemorySession } from './in-memory-session'

/**
 * Wraps a raw session store into the AgentSessionPort contract.
 *
 * Accepts an optional store for dependency injection; defaults to in-memory.
 */
export function createSessionManager(maxPerSession = 100, store = createInMemorySession(maxPerSession)): AgentSessionPort {

  return {
    ensureSession: store.ensureSession,
    getSessionMessages: store.getSessionMessages,
    getSessionGeneration: store.getSessionGeneration,
    bumpSessionGeneration: store.bumpSessionGeneration,
    appendSessionMessage(sessionId, item) {
      store.appendSessionMessage(sessionId, {
        ...item,
        id: item.id || crypto.randomUUID(),
        createdAt: item.createdAt || Date.now(),
      })
    },
  }
}
