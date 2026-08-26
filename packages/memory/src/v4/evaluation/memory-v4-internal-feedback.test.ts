import { describe, expect, it } from 'vitest'
import { createMemoryV4InternalFeedbackStore } from './memory-v4-internal-feedback'

const NOW = Date.UTC(2026, 7, 26)
const QUERY = 'a'.repeat(64)

describe('Memory V4 Internal feedback store', () => {
  it('binds labels to issued reviews and persists no query or memory plaintext', () => {
    let payload: string | undefined
    const persistence = {
      storagePath: 'memory-v4-internal-feedback.enc',
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    let tick = NOW
    const store = createMemoryV4InternalFeedbackStore({
      persistence,
      encrypted: true,
      flushDelayMs: 0,
      now: () => tick++,
    })
    store.registerReview(review())
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'correct' }))
      .toEqual({ ok: true, label: 'correct' })
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'incorrect' }))
      .toEqual({ ok: true, label: 'incorrect' })

    expect(store.feedbackFor('review-1', 'fact-coffee')).toBe('incorrect')
    expect(store.status()).toMatchObject({
      encrypted: true,
      retainedReviews: 1,
      labeledCandidates: 1,
      missingFeedback: 0,
      byLabel: { correct: 0, incorrect: 1 },
    })
    expect(payload).not.toContain('我的饮品偏好是什么')
    expect(payload).not.toContain('用户喜欢喝手冲咖啡')
  })

  it('rejects forged targets and accepts a review-level missing label', () => {
    const store = createMemoryV4InternalFeedbackStore({ now: () => NOW })
    store.registerReview(review())
    expect(store.recordFeedback({ reviewId: 'forged', factId: 'fact-coffee', label: 'correct' }))
      .toEqual({ ok: false, reason: 'unknown-review' })
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-forged', label: 'correct' }))
      .toEqual({ ok: false, reason: 'unknown-candidate' })
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'missing' }))
      .toEqual({ ok: false, reason: 'invalid-target' })
    expect(store.recordFeedback({ reviewId: 'review-1', label: 'missing' }))
      .toEqual({ ok: true, label: 'missing' })
    expect(store.feedbackFor('review-1')).toBe('missing')
    expect(store.status()).toMatchObject({ missingFeedback: 1, byLabel: { missing: 1 } })
  })

  it('collects an explicit no-memory negative without allowing a correct candidate conflict', () => {
    const store = createMemoryV4InternalFeedbackStore({ now: () => NOW })
    store.registerReview(review())
    expect(store.recordFeedback({ reviewId: 'review-1', label: 'no-memory' }))
      .toEqual({ ok: true, label: 'no-memory' })
    expect(store.recordFeedback({ reviewId: 'review-1', factId: 'fact-coffee', label: 'correct' }))
      .toEqual({ ok: false, reason: 'invalid-target' })
    expect(store.calibrationReviews()[0]).toMatchObject({
      queryIntent: 'specific',
      bestEvidenceScore: 0.9,
      queryLabel: 'no-memory',
    })
    expect(store.status()).toMatchObject({ queryFeedback: 1, noMemoryFeedback: 1 })
  })

  it('purges references by either V4 fact ID or V3 source memory ID', () => {
    const store = createMemoryV4InternalFeedbackStore({ now: () => NOW })
    store.registerReview(review())
    expect(store.hasFact('fact-coffee')).toBe(true)
    expect(store.hasFact('memory-coffee')).toBe(true)
    expect(store.removeFactIds(['memory-coffee'])).toBe(1)
    expect(store.hasFact('fact-coffee')).toBe(false)
    expect(store.status().retainedReviews).toBe(0)
  })

  it('fails closed for corrupted or unsupported persisted data', () => {
    expect(() => createMemoryV4InternalFeedbackStore({
      persistence: { load: () => '{bad-json', save: () => undefined },
    })).toThrow(/Unable to parse Internal feedback/u)
    expect(() => createMemoryV4InternalFeedbackStore({
      persistence: { load: () => JSON.stringify({ schemaVersion: 99, reviews: [] }), save: () => undefined },
    })).toThrow(/Unsupported Internal feedback schema/u)
  })


  it('loads the v1 schema as v2 without inventing plaintext or intent', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      droppedReviews: 0,
      reviews: [{
        reviewId: 'legacy-review',
        queryHash: QUERY,
        calibrationVersion: 'legacy-calibration',
        createdAt: NOW,
        candidates: [{ factId: 'legacy-fact', score: 0.4 }],
        labels: {},
        missing: { label: 'missing', recordedAt: NOW },
      }],
    })
    const store = createMemoryV4InternalFeedbackStore({
      persistence: { load: () => payload, save: () => undefined },
    })
    expect(store.calibrationReviews()[0]).toMatchObject({
      queryIntent: 'unknown',
      bestEvidenceScore: 0.4,
      queryLabel: 'missing',
    })
  })
})

function review() {
  return {
    reviewId: 'review-1',
    queryHash: QUERY,
    queryIntent: 'specific',
    calibrationVersion: 'calibration-v1',
    bestEvidenceScore: 0.9,
    createdAt: NOW,
    candidates: [{ factId: 'fact-coffee', sourceMemoryId: 'memory-coffee', score: 0.9 }],
  }
}
