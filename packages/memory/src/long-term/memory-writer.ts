import type { AgentMemoryPort } from '@deskpet/contracts'
import type { VectorStore } from './vector-store'

/**
 * Wraps a vector store into the AgentMemoryPort interface,
 * optionally adding summarization / deduplication logic.
 */
export interface MemoryWriterOptions {
  store: VectorStore
}

export function createMemoryWriter(options: MemoryWriterOptions): AgentMemoryPort {
  const { store } = options

  return {
    recall: store.recall,
    remember: store.remember,
    forget: store.forget,
  }
}