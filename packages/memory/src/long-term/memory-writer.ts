import type { AgentMemoryPort, MemoryCapture, MemoryScope, MemorySourceSyncResult } from '@deskpet/contracts'
import type { V3MemoryRecord, VectorStore } from './vector-store'
import { extractMemoryCandidates, isSafeMemoryContent } from './memory-extractor'
import type { MemoryCandidate, MemoryExtractor } from './memory-extractor'
import { normalizeMemoryCandidate } from './memory-normalizer'
import { planMemoryCapture } from './memory-capture-planner'
import {
  createLocalMemoryCandidateVerifier,
  quarantinedVerifierFailure,
} from './memory-write-policy'
import type {
  MemoryCandidateEvaluation,
  MemoryCandidateVerifier,
} from './memory-write-policy'

export interface MemoryCaptureCommit {
  turn: MemoryCapture
  scope: MemoryScope
  memories: Array<{ candidate: MemoryCandidate; record: V3MemoryRecord }>
  evaluations: MemoryCandidateEvaluation[]
  capturedAt: number
}

export interface MemorySourceUnlinkCommit {
  messageIds: string[]
  scope: MemoryScope
  result: MemorySourceSyncResult
  unlinkedAt: number
}

export interface MemoryWriterOptions {
  store: VectorStore
  extractor?: MemoryExtractor
  verifier?: MemoryCandidateVerifier
  /** Post-V3 capture observer used by the additive V4 evidence shadow. */
  onCaptured?: (commit: MemoryCaptureCommit) => void
  onCaptureObserverError?: (error: unknown, commit: MemoryCaptureCommit) => void
  onSourcesUnlinked?: (commit: MemorySourceUnlinkCommit) => void
  onSourceUnlinkObserverError?: (error: unknown, commit: MemorySourceUnlinkCommit) => void
  /** Maximum characters extracted synchronously per segment. */
  maximumSegmentCharacters?: number
  /** Queue backpressure threshold. Overflow waits for the current queue instead of being dropped. */
  maximumQueuedSegments?: number
  onBackgroundCaptureError?: (error: unknown, turn: MemoryCapture, scope: MemoryScope) => void
}

export interface MemoryWriter extends AgentMemoryPort {
  pendingCaptureCount: () => number
  flushPendingCaptures: () => Promise<void>
}

export function createMemoryWriter(options: MemoryWriterOptions): MemoryWriter {
  const {
    store,
    extractor = extractMemoryCandidates,
    verifier = createLocalMemoryCandidateVerifier(),
    onCaptured,
    onCaptureObserverError,
    onSourcesUnlinked,
    onSourceUnlinkObserverError,
  } = options
  const maximumQueuedSegments = Math.max(1, Math.floor(options.maximumQueuedSegments ?? 64))
  let pendingCaptureSegments = 0
  let backgroundCaptures: Promise<void> = Promise.resolve()

  const remember: AgentMemoryPort['remember'] = async (content, scope, metadata) => {
    if (!isSafeMemoryContent(content))
      throw new Error('Memory content is empty or contains unsafe instructions or sensitive data')
    await store.remember(content, scope, metadata)
  }

  async function processCapture(turn: MemoryCapture, scope: MemoryScope): Promise<number> {
    const extracted = await extractor(turn)
    const candidates = extracted.map(candidate => normalizeMemoryCandidate(candidate, turn))
    const memories: MemoryCaptureCommit['memories'] = []
    const evaluations: MemoryCandidateEvaluation[] = []
    for (const candidate of candidates) {
      let evaluation: MemoryCandidateEvaluation
      try {
        const memoryKey = typeof candidate.metadata.memoryKey === 'string'
          ? candidate.metadata.memoryKey.trim()
          : typeof candidate.metadata.predicate === 'string' ? candidate.metadata.predicate.trim() : undefined
        const matches = await store.inspectWriteMatches(candidate.content, scope, memoryKey)
        evaluation = await verifier(candidate, { turn, scope, matches })
      }
      catch {
        evaluation = quarantinedVerifierFailure(candidate)
      }
      evaluations.push(evaluation)
      if (evaluation.status !== 'accepted' || evaluation.action === 'NOOP')
        continue
      const record = await store.remember(candidate.content, scope, {
        ...turn.metadata,
        ...candidate.metadata,
        memoryWriteAction: evaluation.action,
        memoryVerificationScore: evaluation.verificationScore,
        memoryEvidenceScore: evaluation.evidenceScore,
        memoryDurabilityScore: evaluation.durabilityScore,
        memoryAmbiguityFlags: evaluation.ambiguityFlags,
        memoryVerifierVersion: evaluation.verifierVersion,
        memoryPolicyVersion: evaluation.policyVersion,
        ...(evaluation.matchedMemoryId ? { memoryMatchedId: evaluation.matchedMemoryId } : {}),
        origin: candidate.metadata.origin ?? (turn.attachments?.length ? 'image' : 'automatic'),
      })
      if (record)
        memories.push({ candidate, record })
    }
    if (onCaptured && evaluations.length > 0) {
      const commit: MemoryCaptureCommit = {
        turn,
        scope,
        memories,
        evaluations,
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
    return memories.length
  }

  async function processCaptureSafely(turn: MemoryCapture, scope: MemoryScope): Promise<number> {
    try {
      return await processCapture(turn, scope)
    }
    catch (error) {
      try { options.onBackgroundCaptureError?.(error, turn, scope) }
      catch { /* diagnostics must not stop later capture segments */ }
      return 0
    }
  }

  function enqueueBackground(turn: MemoryCapture, scope: MemoryScope): void {
    pendingCaptureSegments += 1
    backgroundCaptures = backgroundCaptures
      .then(async () => { await processCaptureSafely(turn, scope) })
      .finally(() => { pendingCaptureSegments -= 1 })
  }

  async function flushPendingCaptures(): Promise<void> {
    while (pendingCaptureSegments > 0) {
      const pending = backgroundCaptures
      await pending
      if (pending === backgroundCaptures)
        break
    }
  }

  const writer: MemoryWriter = {
    list: store.list,
    recall: store.recall,
    recallAdaptive: store.recallAdaptive,
    remember,
    forget: store.forget,
    purge: store.purge,
    update: store.update,
    restore: store.restore,
    async unlinkSources(messageIds, scope) {
      const normalizedMessageIds = [...new Set(messageIds
        .filter(id => typeof id === 'string' && id.trim())
        .map(id => id.trim()))]
      const result = await store.unlinkSources(normalizedMessageIds, scope)
      if (onSourcesUnlinked && normalizedMessageIds.length > 0) {
        const commit: MemorySourceUnlinkCommit = {
          messageIds: normalizedMessageIds,
          scope,
          result,
          unlinkedAt: Date.now(),
        }
        try {
          onSourcesUnlinked(commit)
        }
        catch (error) {
          try {
            onSourceUnlinkObserverError?.(error, commit)
          }
          catch {
            // V4 cleanup diagnostics must never make the authoritative V3 unlink fail.
          }
        }
      }
      return result
    },
    clear: store.clear,
    count: store.count,
    async capture(turn, scope): Promise<number> {
      const plan = planMemoryCapture(turn, options.maximumSegmentCharacters)
      if (plan.length === 0)
        return 0
      const written = await processCaptureSafely(plan[0]!.turn, scope)
      const continuation = plan.slice(1)
      for (const segment of continuation) {
        if (pendingCaptureSegments >= maximumQueuedSegments)
          await flushPendingCaptures()
        enqueueBackground(segment.turn, scope)
      }
      return written
    },
    pendingCaptureCount: () => pendingCaptureSegments,
    flushPendingCaptures,
  }
  return writer
}

export type { MemoryExtractor } from './memory-extractor'
export type { MemoryCandidateEvaluation, MemoryCandidateVerifier } from './memory-write-policy'
export { extractMemoryCandidates, inferMemoryPrivacy, isSafeMemoryContent } from './memory-extractor'
