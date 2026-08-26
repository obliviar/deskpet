import { describe, expect, it } from 'vitest'
import type { MemoryV4InternalCandidateReview } from './memory-v4-internal-review'
import { createMemoryV4InternalFeedbackStore } from './memory-v4-internal-feedback'

const NOW = Date.UTC(2026, 7, 26)

describe('Electron Memory V4 Internal feedback adapter', () => {
  it('strips transient content, restores encrypted labels and updates idempotently', () => {
    let payload: string | undefined
    const persistence = {
      storagePath: 'memory-v4-internal-feedback.enc',
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    const store = createMemoryV4InternalFeedbackStore({ persistence, encrypted: true, flushDelayMs: 0, now: () => NOW })
    store.registerReview(review())
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'correct' }))
      .toEqual({ ok: true, label: 'correct' })
    expect(payload).not.toContain('用户喜欢喝手冲咖啡')
    expect(payload).not.toContain('我的饮品偏好是什么')
    expect(payload).toContain('fact-coffee')

    const restored = createMemoryV4InternalFeedbackStore({ persistence, encrypted: true, flushDelayMs: 0, now: () => NOW })
    expect(restored.feedbackFor('review-1', 'fact-coffee')).toBe('correct')
    expect(restored.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'expired' }))
      .toEqual({ ok: true, label: 'expired' })
    expect(restored.status()).toMatchObject({
      encrypted: true,
      retainedReviews: 1,
      labeledCandidates: 1,
      byLabel: { correct: 0, expired: 1 },
    })
  })

  it('supports omission feedback and purges source-linked candidates', () => {
    const store = createMemoryV4InternalFeedbackStore({ now: () => NOW })
    store.registerReview(review())
    expect(store.recordFeedback({ reviewId: 'review-1', label: 'missing' }))
      .toEqual({ ok: true, label: 'missing' })
    expect(store.hasFact('memory-coffee')).toBe(true)
    expect(store.removeFactIds(['memory-coffee'])).toBe(1)
    expect(store.hasFact('memory-coffee')).toBe(false)
    expect(store.feedbackFor('review-1')).toBe('missing')
  })
})

function review(): MemoryV4InternalCandidateReview {
  return {
    version: 'memory-v4-internal-candidate-review-v1',
    reviewId: 'review-1',
    mode: 'internal-candidate',
    authoritativeAnswerSource: 'v3',
    v4InfluencedAnswer: false,
    createdAt: NOW,
    queryHash: 'a'.repeat(64),
    queryIntent: 'specific',
    v3: { retrievedCount: 1, injectedCount: 1 },
    v4: {
      abstained: false,
      bestEvidenceScore: 0.9,
      threshold: 0.5,
      calibrationVersion: 'test',
      candidates: [{
        factId: 'fact-coffee', sourceMemoryId: 'memory-coffee', content: '用户喜欢喝手冲咖啡', score: 0.9,
        routes: ['fact-semantic-learned'], summaryIds: [], status: 'active', verificationState: 'verified',
      }],
    },
    agreement: { overlapCount: 1, recallAtK: 1, precisionAtK: 1, jaccard: 1 },
  }
}
