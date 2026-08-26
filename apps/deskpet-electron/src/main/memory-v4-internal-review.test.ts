import { describe, expect, it, vi } from 'vitest'
import type { MemoryV4ShadowRecallResult, V3V4ShadowComparison } from '@deskpet/memory'
import { createMemoryV4InternalReviewController } from './memory-v4-internal-review'

const NOW = Date.UTC(2026, 7, 25)

describe('Memory V4 internal candidate review', () => {
  it('is disabled by default and cannot influence an answer', () => {
    const controller = createMemoryV4InternalReviewController()
    expect(controller.begin('我喜欢喝什么？')).toBeUndefined()
    expect(controller.status()).toMatchObject({ enabled: false, completed: 0, pending: 0 })
  })

  it('matches a pending turn without retaining query plaintext and returns bounded local candidates', async () => {
    const controller = createMemoryV4InternalReviewController({
      enabled: true,
      now: () => NOW,
      idFactory: () => 'review-1',
    })
    const handle = controller.begin('我喜欢喝什么？')!
    const requestId = controller.claim('我喜欢喝什么?')
    // NFKC intentionally equates full-width and ASCII punctuation.
    expect(requestId).toBe('review-1')

    controller.complete(requestId!, comparison(), recall())
    const review = await handle.finish()

    expect(review).toMatchObject({
      mode: 'internal-candidate',
      authoritativeAnswerSource: 'v3',
      v4InfluencedAnswer: false,
      queryHash: 'a'.repeat(64),
      v3: { retrievedCount: 2, injectedCount: 1 },
      v4: {
        abstained: false,
        bestEvidenceScore: 0.91,
        threshold: 0.42,
        calibrationVersion: 'memory-v4-absolute-evidence-v1:policy-fallback',
      },
      agreement: { overlapCount: 1, recallAtK: 0.5, precisionAtK: 1, jaccard: 0.5 },
    })
    expect(review?.v4.candidates).toEqual([
      expect.objectContaining({ sourceMemoryId: 'coffee', content: '用户喜欢喝手冲咖啡' }),
    ])
    expect(JSON.stringify(controller.status())).not.toContain('我喜欢喝什么')
    expect(controller.status()).toMatchObject({ pending: 0, begun: 1, claimed: 1, completed: 1 })
  })

  it('finishes immediately when the V4 path was never claimed', async () => {
    const controller = createMemoryV4InternalReviewController({ enabled: true })
    const handle = controller.begin('无需记忆的请求')!
    await expect(handle.finish()).resolves.toBeUndefined()
    expect(controller.status()).toMatchObject({ pending: 0, cancelled: 1 })
  })

  it('switches stages at runtime and fail-closes pending internal reviews', async () => {
    const controller = createMemoryV4InternalReviewController({ enabled: false })
    expect(controller.setEnabled(true)).toBe(0)
    expect(controller.status().enabled).toBe(true)
    const pending = controller.begin('切换阶段时不能泄漏挂起任务')!
    expect(controller.claim('切换阶段时不能泄漏挂起任务')).toBeTruthy()

    expect(controller.setEnabled(false)).toBe(1)
    await expect(pending.finish()).resolves.toBeUndefined()
    expect(controller.status()).toMatchObject({ enabled: false, pending: 0, cancelled: 1 })
    expect(controller.begin('关闭后不能再开始')).toBeUndefined()

    expect(controller.setEnabled(true)).toBe(0)
    expect(controller.begin('重新开启后可以评审')).toBeDefined()
    controller.setEnabled(false)
  })

  it('settles dropped, timed-out and lifecycle-cancelled work without leaking pending promises', async () => {
    vi.useFakeTimers()
    try {
      const controller = createMemoryV4InternalReviewController({
        enabled: true,
        timeoutMs: 100,
        idFactory: vi.fn()
          .mockReturnValueOnce('drop')
          .mockReturnValueOnce('timeout')
          .mockReturnValueOnce('cancel'),
      })
      const dropped = controller.begin('drop me')!
      expect(controller.claim('drop me')).toBe('drop')
      controller.drop('drop', 'overload')
      await expect(dropped.finish()).resolves.toBeUndefined()

      const timedOut = controller.begin('timeout me')!
      expect(controller.claim('timeout me')).toBe('timeout')
      await vi.advanceTimersByTimeAsync(100)
      await expect(timedOut.finish()).resolves.toBeUndefined()

      const cancelled = controller.begin('cancel me')!
      expect(controller.cancelAll()).toBe(1)
      await expect(cancelled.finish()).resolves.toBeUndefined()
      expect(controller.status()).toMatchObject({ pending: 0, dropped: 2, timedOut: 1, cancelled: 1 })
    }
    finally {
      vi.useRealTimers()
    }
  })
})

function comparison(): V3V4ShadowComparison {
  return {
    queryHash: 'a'.repeat(64),
    comparedAt: NOW,
    queryIntent: 'specific',
    retrievalRoutes: ['fact-structured'],
    snapshotRevision: 1,
    candidateCount: 1,
    summaryCandidates: 0,
    indexRebuildCount: 1,
    v3RetrievedCount: 2,
    v3InjectedCount: 1,
    v4RetrievedCount: 1,
    v4Abstained: false,
    v4BestEvidenceScore: 0.91,
    v4AbstentionThreshold: 0.42,
    v4AbstentionVersion: 'memory-v4-absolute-evidence-v1:policy-fallback',
    overlapCount: 1,
    v3AgreementRecallAtK: 0.5,
    v3AgreementPrecisionAtK: 1,
    jaccard: 0.5,
    v4LatencyMs: 2,
    privacyFiltered: 0,
    temporalFiltered: 0,
  }
}

function recall(): MemoryV4ShadowRecallResult {
  return {
    version: 'memory-v4-shadow-retriever-v2',
    snapshotRevision: 1,
    queryIntent: 'specific',
    routes: ['fact-structured'],
    candidateCount: 1,
    summaryCandidates: 0,
    summariesUsed: [],
    privacyFiltered: 0,
    temporalFiltered: 0,
    hits: [{
      factId: 'fact-coffee',
      sourceMemoryId: 'coffee',
      content: '用户喜欢喝手冲咖啡',
      score: 0.91,
      routes: ['fact-structured'],
      summaryIds: [],
      status: 'active',
      verificationState: 'verified',
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
    }],
    abstention: {
      abstained: false,
      threshold: 0.42,
      bestScore: 0.91,
      version: 'memory-v4-absolute-evidence-v1:policy-fallback',
    },
    latencyMs: 2,
    index: { summaries: 0, facts: 1, rebuildCount: 1 },
  }
}
