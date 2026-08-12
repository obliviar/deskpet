import type { AgentMemoryPort } from '@deskpet/contracts'
import type { VectorStore } from './vector-store'
import { extractMemoryCandidates, isSafeMemoryContent } from './memory-extractor'
import type { MemoryExtractor } from './memory-extractor'

export interface MemoryWriterOptions {
  store: VectorStore
  extractor?: MemoryExtractor
}

export function createMemoryWriter(options: MemoryWriterOptions): AgentMemoryPort {
  const { store, extractor = extractMemoryCandidates } = options

  const remember: AgentMemoryPort['remember'] = async (content, scope, metadata) => {
    if (!isSafeMemoryContent(content))
      throw new Error('Memory content is empty or contains unsafe instructions or sensitive data')
    await store.remember(content, scope, metadata)
  }

  return {
    list: store.list,
    recall: store.recall,
    recallAdaptive: store.recallAdaptive,
    remember,
    forget: store.forget,
    update: store.update,
    restore: store.restore,
    unlinkSources: store.unlinkSources,
    clear: store.clear,
    count: store.count,
    async capture(turn, scope): Promise<number> {
      const candidates = await extractor(turn)
      for (const candidate of candidates) {
        await remember(candidate.content, scope, {
          ...turn.metadata,
          ...candidate.metadata,
          origin: candidate.metadata.origin ?? (turn.attachments?.length ? 'image' : 'automatic'),
        })
      }
      return candidates.length
    },
  }
}

export type { MemoryExtractor } from './memory-extractor'
export { extractMemoryCandidates, inferMemoryPrivacy, isSafeMemoryContent } from './memory-extractor'
