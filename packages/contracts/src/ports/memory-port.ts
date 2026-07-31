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

export interface AgentMemoryPort {
  /** Retrieve the top-K most relevant memories for a query. */
  recall: (query: string, topK?: number) => Promise<MemoryFragment[]>
  /** Persist a memory fragment for future recall. */
  remember: (content: string, metadata?: Record<string, unknown>) => Promise<void>
  /** Remove a memory by id. */
  forget: (id: string) => Promise<void>
}
