/**
 * Long-term memory boundary.
 *
 * Decouples the runtime from any concrete vector store. Implementations may
 * back onto pgvector, DuckDB, in-memory cosine, or a hosted service.
 */

/** A single recalled memory fragment. */
export interface MemoryFragment {
  id: string
  content: string
  /** Relevance score in [0, 1] when produced by a retrieval call. */
  score?: number
  metadata?: Record<string, unknown>
  createdAt: number
}

/** Isolation boundary for long-term memories. */
export interface MemoryScope {
  /** Stable owner identifier. Server callers must derive this from authentication. */
  ownerId: string
  /** Stable agent/persona identifier. */
  agentId?: string
  /** Optional session restriction. Omit to recall across the owner's sessions. */
  sessionId?: string
}

/** A completed turn from which durable facts may be extracted. */
export interface MemoryCapture {
  userMessage: string
  assistantMessage: string
  metadata?: Record<string, unknown>
}

export interface AgentMemoryPort {
  /** Retrieve the top-K relevant memories inside an isolation scope. */
  recall: (query: string, scope: MemoryScope, topK?: number) => Promise<MemoryFragment[]>
  /** Persist one already-sanitized fact. */
  remember: (content: string, scope: MemoryScope, metadata?: Record<string, unknown>) => Promise<void>
  /** Extract and persist durable facts from a completed conversation turn. */
  capture: (turn: MemoryCapture, scope: MemoryScope) => Promise<number>
  /** Remove a memory by id, constrained to its owner scope. */
  forget: (id: string, scope: MemoryScope) => Promise<void>
  /** Remove every memory inside a scope. */
  clear: (scope: MemoryScope) => Promise<void>
  /** Count memories inside a scope. */
  count: (scope: MemoryScope) => Promise<number>
}
