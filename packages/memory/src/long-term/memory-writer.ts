import type { AgentMemoryPort, MemoryCapture, MemoryScope } from '@deskpet/contracts'
import type { V3MemoryRecord, VectorStore } from './vector-store'
import { extractMemoryCandidates, isSafeMemoryContent } from './memory-extractor'
import type { MemoryCandidate, MemoryExtractor } from './memory-extractor'

export interface MemoryCaptureCommit {
  turn: MemoryCapture
  scope: MemoryScope
  memories: Array<{ candidate: MemoryCandidate; record: V3MemoryRecord }>
  capturedAt: number
}

export interface MemoryWriterOptions {
  store: VectorStore
  extractor?: MemoryExtractor
  /** Post-V3 capture observer used by the additive V4 evidence shadow. */
  onCaptured?: (commit: MemoryCaptureCommit) => void
  onCaptureObserverError?: (error: unknown, commit: MemoryCaptureCommit) => void
}

export function createMemoryWriter(options: MemoryWriterOptions): AgentMemoryPort {
  const { store, extractor = extractMemoryCandidates, onCaptured, onCaptureObserverError } = options

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
      const memories: MemoryCaptureCommit['memories'] = []
      for (const candidate of candidates) {
        if (!isSafeMemoryContent(candidate.content))
          throw new Error('Memory content is empty or contains unsafe instructions or sensitive data')
        const record = await store.remember(candidate.content, scope, {
          ...turn.metadata,
          ...candidate.metadata,
          origin: candidate.metadata.origin ?? (turn.attachments?.length ? 'image' : 'automatic'),
        })
        if (record)
          memories.push({ candidate, record })
      }
      if (onCaptured && memories.length > 0) {
        const commit: MemoryCaptureCommit = {
          turn,
          scope,
          memories,
          capturedAt: Date.now(),
        }
        try {
          onCaptured(commit)
        }
        catch (error) {
          try {
            onCaptureObserverError?.(error, commit)
          }
          catch {
            // Shadow diagnostics must never make the working V3 capture fail.
          }
        }
      }
      return candidates.length
    },
  }
}

export type { MemoryExtractor } from './memory-extractor'
export { extractMemoryCandidates, inferMemoryPrivacy, isSafeMemoryContent } from './memory-extractor'
