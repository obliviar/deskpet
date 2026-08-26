import {
  createMemoryV4InternalFeedbackStore as createCoreStore,
  isMemoryV4InternalFeedbackLabel,
  type MemoryV4InternalFeedbackLabel,
  type MemoryV4InternalFeedbackPersistence,
  type MemoryV4InternalFeedbackResult,
  type MemoryV4InternalFeedbackStatus,
} from '@deskpet/memory'
import type { MemoryV4InternalCandidateReview } from './memory-v4-internal-review'

export {
  isMemoryV4InternalFeedbackLabel,
  type MemoryV4InternalFeedbackLabel,
  type MemoryV4InternalFeedbackPersistence,
  type MemoryV4InternalFeedbackResult,
  type MemoryV4InternalFeedbackStatus,
}

export interface MemoryV4InternalFeedbackStore {
  registerReview: (review: MemoryV4InternalCandidateReview) => void
  recordFeedback: (input: {
    reviewId: string
    factId?: string
    label: MemoryV4InternalFeedbackLabel
  }) => MemoryV4InternalFeedbackResult
  feedbackFor: (reviewId: string, factId?: string) => MemoryV4InternalFeedbackLabel | undefined
  removeFactIds: (factIds: readonly string[]) => number
  hasFact: (factId: string) => boolean
  status: () => MemoryV4InternalFeedbackStatus
  flush: () => void
  clear: () => void
}

/** Electron adapter: strips transient candidate content before core storage. */
export function createMemoryV4InternalFeedbackStore(options: {
  persistence?: MemoryV4InternalFeedbackPersistence
  encrypted?: boolean
  maxReviews?: number
  flushDelayMs?: number
  now?: () => number
  onPersistenceError?: (error: unknown) => void
} = {}): MemoryV4InternalFeedbackStore {
  const core = createCoreStore(options)
  return {
    registerReview(review) {
      core.registerReview({
        reviewId: review.reviewId,
        queryHash: review.queryHash,
        calibrationVersion: review.v4.calibrationVersion,
        createdAt: review.createdAt,
        candidates: review.v4.candidates.map(candidate => ({
          factId: candidate.factId,
          ...(candidate.sourceMemoryId ? { sourceMemoryId: candidate.sourceMemoryId } : {}),
          score: candidate.score,
        })),
      })
    },
    recordFeedback: core.recordFeedback,
    feedbackFor: core.feedbackFor,
    removeFactIds: core.removeFactIds,
    hasFact: core.hasFact,
    status: core.status,
    flush: core.flush,
    clear: core.clear,
  }
}
