import type { AdaptiveMemoryRecallResult } from '@deskpet/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryV4ShadowRecallResult } from '../retrieval/memory-v4-shadow-retriever'
import { createMemoryV4ReadRouter } from './memory-v4-read-router'

const scope = { ownerId: 'owner', agentId: 'deskpet' }

describe('Memory V4 official read router', () => {
  it('keeps forced V3 authoritative without invoking V4', async () => {
    const recallV4 = vi.fn()
    const router = createMemoryV4ReadRouter({
      mode: 'v3',
      recallV3: async () => v3Result('v3-memory'),
      recallV4,
    })

    const decision = await router.read('我的名字？', scope)

    expect(decision).toMatchObject({ requestedMode: 'v3', authoritativeReadSource: 'v3' })
    expect(decision.result.injectedMemoryIds).toEqual(['v3-memory'])
    expect(recallV4).not.toHaveBeenCalled()
  })

  it('maps an accepted V4 fact into citable prompt evidence', async () => {
    const router = createMemoryV4ReadRouter({
      mode: 'v4-beta',
      recallV3: async () => v3Result('v3-memory'),
      recallV4: async () => v4Result(),
    })

    const decision = await router.read('我的名字？', scope)

    expect(decision).toMatchObject({
      requestedMode: 'v4-beta',
      authoritativeReadSource: 'v4',
      evidenceBundle: {
        selectedFactIds: ['fact-name'],
        selectedMemoryIds: ['v3-name'],
      },
    })
    expect(decision.result.memories).toEqual([
      expect.objectContaining({ id: 'v3-name', content: '用户姓名：小秦' }),
    ])
    expect(decision.result.evidencePack).toEqual([
      expect.objectContaining({ memoryId: 'v3-name', citation: 'M1' }),
    ])
  })

  it('falls back before calling V4 when auto mode reports it is not ready', async () => {
    const recallV4 = vi.fn()
    const router = createMemoryV4ReadRouter({
      mode: 'auto',
      recallV3: async () => v3Result('fallback-memory'),
      recallV4,
      isV4Ready: () => false,
    })

    const decision = await router.read('我的名字？', scope)

    expect(decision).toMatchObject({
      authoritativeReadSource: 'v3',
      fallbackReason: 'v4-not-ready',
    })
    expect(recallV4).not.toHaveBeenCalled()
  })

  it.each([
    ['worker error', async () => { throw new Error('worker failed') }, 'v4-error'],
    ['empty result', async () => ({ ...v4Result(), hits: [], candidateCount: 0 }), 'v4-empty'],
    ['abstention', async () => ({
      ...v4Result(),
      hits: [],
      abstention: { abstained: true, threshold: 0.6, bestScore: 0.2, version: 'gate-v1' },
    }), 'v4-abstained'],
  ])('falls back to V3 on %s', async (_name, recallV4, fallbackReason) => {
    const router = createMemoryV4ReadRouter({
      mode: 'v4-beta',
      recallV3: async () => v3Result('fallback-memory'),
      recallV4,
    })

    await expect(router.read('我的名字？', scope)).resolves.toMatchObject({
      authoritativeReadSource: 'v3',
      fallbackReason,
      result: { injectedMemoryIds: ['fallback-memory'] },
    })
  })
})

function v3Result(memoryId: string): AdaptiveMemoryRecallResult {
  return {
    memories: [{ id: memoryId, content: 'V3 用户姓名', createdAt: 1 }],
    retrievedMemoryIds: [memoryId],
    injectedMemoryIds: [memoryId],
    candidateCount: 1,
    evaluatedCount: 1,
    batchesEvaluated: 1,
    stopReason: 'candidates-exhausted',
  }
}

function v4Result(): MemoryV4ShadowRecallResult {
  return {
    version: 'memory-v4-shadow-retriever-v2',
    policy: { policyId: 'test-policy', policyVersion: 'test-v1', fingerprint: 'test-fingerprint' },
    snapshotRevision: 7,
    queryIntent: 'specific',
    routes: ['fact-bm25'],
    candidateCount: 1,
    summaryCandidates: 0,
    summariesUsed: [],
    privacyFiltered: 0,
    temporalFiltered: 0,
    tierRouting: {
      version: 'memory-v4-tier-router-v1',
      coldPolicy: 'fallback', coldAwakened: false,
      candidateBudgets: { hot: 8, warm: 16, cold: 8 },
      eligibleCounts: { hot: 1, warm: 0, cold: 0 },
      searchedCounts: { hot: 1, warm: 0, cold: 0 },
      quarantineExcluded: 0, unassignedAsWarm: 0,
    },
    evidenceSelection: {
      version: 'memory-v4-evidence-selector-v1', evaluatedCount: 1, selectedCount: 1,
      coveredRequirements: ['concept:name'], stopReason: 'coverage-satisfied', usedCharacters: 8,
    },
    hits: [{
      factId: 'fact-name',
      sourceMemoryId: 'v3-name',
      content: '用户姓名：小秦',
      score: 0.91,
      routes: ['fact-bm25'],
      summaryIds: [],
      status: 'active',
      verificationState: 'verified',
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
      recordedAt: 10,
      updatedAt: 11,
      origin: 'manual',
      importance: 0.9,
      accessCount: 2,
    }],
    abstention: { abstained: false, threshold: 0.5, bestScore: 0.91, version: 'gate-v1' },
    latencyMs: 3,
    index: { summaries: 0, facts: 1, rebuildCount: 1 },
  }
}
