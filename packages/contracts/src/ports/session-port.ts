import type { ChatHistoryItem } from '../types/chat'

/**
 * Session history boundary.
 *
 * Keeps per-session conversation history isolated and exposes a monotonic
 * generation number so the runtime can reject stale queued sends.
 */
export interface AgentSessionPort {
  /** Ensure a session exists before appending messages. */
  ensureSession: (sessionId: string) => void
  /** Return chronological chat history for a session. */
  getSessionMessages: (sessionId: string) => ChatHistoryItem[]
  /** Append a finalized user/assistant/tool history item. */
  appendSessionMessage: (sessionId: string, message: ChatHistoryItem) => void
  /** Monotonic generation used to reject stale queued sends. */
  getSessionGeneration: (sessionId: string) => number
  /** Bump the generation, invalidating in-flight queued sends. */
  bumpSessionGeneration: (sessionId: string) => void
}
