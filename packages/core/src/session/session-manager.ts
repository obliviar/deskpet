import type { AgentSessionPort, ChatHistoryItem } from '@deskpet/contracts'
import { createInMemorySession } from './in-memory-session'

/**
 * Wraps a raw session store into the AgentSessionPort contract.
 *
 * Also generates ids and timestamps for newly appended items so callers do
 * not need to fabricate them.
 */
export function createSessionManager(maxPerSession = 100): AgentSessionPort {
  const store = createInMemorySession(maxPerSession)

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
