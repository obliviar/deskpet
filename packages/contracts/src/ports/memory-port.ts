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
  /** Last update time. Present for persistent stores that track deduplication updates. */
  updatedAt?: number
  status?: MemoryStatus
  origin?: MemoryOrigin
  importance?: number
  confidence?: number
  accessCount?: number
  lastAccessedAt?: number
  /** Start of real-world validity. */
  validFrom?: number
  /** End of real-world validity (exclusive). */
  validTo?: number
  /** System time at which this version was invalidated or superseded. */
  invalidatedAt?: number
  expiresAt?: number
  supersedes?: string
  memoryKey?: string
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
  sharePolicy?: MemorySharePolicy
  sensitivity?: MemorySensitivity
}

export type MemoryStatus = 'active' | 'superseded' | 'expired' | 'conflicted' | 'orphaned'
export type MemoryOrigin = 'automatic' | 'manual' | 'image'
export type MemorySharePolicy = 'allow-remote' | 'local-only' | 'ask'
export type MemorySensitivity = 'normal' | 'private' | 'secret'
export type MemoryTemporalMode = 'current' | 'historical' | 'all'

/** Optional policy filter applied before recall scoring and usage accounting. */
export interface MemoryRecallOptions {
  sharePolicies?: MemorySharePolicy[]
  sensitivities?: MemorySensitivity[]
  /** Defaults to query-derived current or historical intent. */
  temporalMode?: MemoryTemporalMode
  /** Real-world timestamp used for point-in-time recall. */
  asOf?: number
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
  attachments?: Array<{
    type: 'image'
    data: string
    mimeType: string
    id?: string
  }>
  metadata?: Record<string, unknown>
}

export interface MemoryUpdate {
  importance?: number
  expiresAt?: number | null
  sharePolicy?: MemorySharePolicy
  sensitivity?: MemorySensitivity
  status?: MemoryStatus
}

export interface MemorySourceSyncResult {
  updated: number
  orphaned: number
}

export interface AgentMemoryPort {
  /** List memories inside a scope, ordered by most recently updated first. */
  list: (scope: MemoryScope, limit?: number) => Promise<MemoryFragment[]>
  /** Retrieve the top-K relevant memories inside an isolation scope. */
  recall: (
    query: string,
    scope: MemoryScope,
    topK?: number,
    options?: MemoryRecallOptions,
  ) => Promise<MemoryFragment[]>
  /** Persist one already-sanitized fact. */
  remember: (content: string, scope: MemoryScope, metadata?: Record<string, unknown>) => Promise<void>
  /** Extract and persist durable facts from a completed conversation turn. */
  capture: (turn: MemoryCapture, scope: MemoryScope) => Promise<number>
  /** Remove a memory by id, constrained to its owner scope. */
  forget: (id: string, scope: MemoryScope) => Promise<void>
  /** Update user-managed lifecycle, privacy and importance fields. */
  update: (id: string, scope: MemoryScope, patch: MemoryUpdate) => Promise<boolean>
  /** Restore an inactive memory to the active set. */
  restore: (id: string, scope: MemoryScope) => Promise<boolean>
  /** Remove deleted chat messages as evidence and orphan unsupported automatic memories. */
  unlinkSources: (messageIds: string[], scope: MemoryScope) => Promise<MemorySourceSyncResult>
  /** Remove every memory inside a scope. */
  clear: (scope: MemoryScope) => Promise<void>
  /** Count memories inside a scope. */
  count: (scope: MemoryScope) => Promise<number>
}
