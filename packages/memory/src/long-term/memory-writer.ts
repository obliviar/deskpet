import type { AgentMemoryPort } from '@deskpet/contracts'
import type { VectorStore } from './vector-store'
import { extractMemoryCandidates } from './memory-extractor'
import type { MemoryExtractor } from './memory-extractor'

export interface MemoryWriterOptions {
  store: VectorStore
  extractor?: MemoryExtractor
}

export function createMemoryWriter(options: MemoryWriterOptions): AgentMemoryPort {
  const { store, extractor = extractMemoryCandidates } = options

  return {
    recall: store.recall,
    remember: store.remember,
    forget: store.forget,
    clear: store.clear,
    count: store.count,
    async capture(turn, scope): Promise<number> {
      const candidates = await extractor(turn)
      for (const candidate of candidates) {
        await store.remember(candidate.content, scope, {
          ...turn.metadata,
          ...candidate.metadata,
        })
      }
      return candidates.length
    },
  }
}

export type { MemoryExtractor } from './memory-extractor'
export { extractMemoryCandidates } from './memory-extractor'
