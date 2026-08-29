import { createAgentRuntime, createSessionManager } from '@deskpet/core'
import type { AgentRuntimeDeps } from '@deskpet/core'
import type { MemoryV4ShadowRecallResult } from '@deskpet/memory'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEMORY_V4_READ_MODE,
  createMemoryV4ReadController,
  resolveMemoryV4ReadMode,
} from './memory-v4-read-controller'

const scope = { ownerId: 'owner', agentId: 'deskpet' }
type AgentMemoryPort = NonNullable<AgentRuntimeDeps['memory']>
type AgentLLMPort = AgentRuntimeDeps['llm']
type ChatMessage = Parameters<AgentLLMPort['stream']>[1][number]
type AdaptiveMemoryRecallResult = Awaited<ReturnType<NonNullable<AgentMemoryPort['recallAdaptive']>>>

describe('Memory V4 desktop official read controller', () => {
  it('defaults to auto while preserving explicit environment and file overrides', () => {
    expect(DEFAULT_MEMORY_V4_READ_MODE).toBe('auto')
    expect(resolveMemoryV4ReadMode(undefined, undefined)).toBe('auto')
    expect(resolveMemoryV4ReadMode('v3', 'auto')).toBe('v3')
    expect(resolveMemoryV4ReadMode('', 'v4-beta')).toBe('v4-beta')
    expect(resolveMemoryV4ReadMode('invalid', 'auto')).toBe('v3')
  })

  it('forces V3 without touching the V4 Worker adapter', async () => {
    const recallV4 = vi.fn()
    const controller = createMemoryV4ReadController({
      mode: 'v3',
      recallV3: async () => v3Result('v3-only'),
      recallV4,
    })

    const result = await controller.recallAdaptive('我的名字？', scope)

    expect(result.injectedMemoryIds).toEqual(['v3-only'])
    expect(recallV4).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({
      configuredMode: 'v3',
      reads: 1,
      v3Reads: 1,
      v4Reads: 0,
      last: { authoritativeReadSource: 'v3', injectedFactIds: [] },
    })
  })

  it('injects accepted V4 evidence into the real AgentRuntime system prompt', async () => {
    const observed: ChatMessage[][] = []
    const controller = createMemoryV4ReadController({
      mode: 'v4-beta',
      recallV3: async () => v3Result('v3-fallback'),
      recallV4: async () => v4Result(),
    })
    const memory = memoryPort((query, recallScope, options) =>
      controller.recallAdaptive(query, recallScope, options))
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test persona', model: 'test-model' },
      llm: observingLlm(observed),
      session: createSessionManager(20),
      memory,
      resolveMemoryScope: () => scope,
    })

    await runtime.send('session', '我的名字是什么？')

    const systemPrompt = String(observed[0]?.find(message => message.role === 'system')?.content)
    expect(systemPrompt).toContain('用户姓名：小秦')
    expect(systemPrompt).toContain('id="M1"')
    expect(systemPrompt).not.toContain('V3 fallback content')
    expect(controller.status()).toMatchObject({
      configuredMode: 'v4-beta',
      v4Reads: 1,
      fallbacks: 0,
      last: {
        authoritativeReadSource: 'v4',
        injectedMemoryIds: ['v3-name'],
        injectedFactIds: ['fact-name'],
        snapshotRevision: 7,
        retrievalPolicy: { policyId: 'test-policy', fingerprint: 'test-fingerprint' },
      },
    })
  })

  it('uses V3 for one request when auto mode reports the Worker is busy', async () => {
    const recallV4 = vi.fn()
    const controller = createMemoryV4ReadController({
      mode: 'auto',
      recallV3: async () => v3Result('fallback-memory'),
      recallV4,
      isV4Ready: () => false,
    })

    await expect(controller.recallAdaptive('我的名字？', scope)).resolves.toMatchObject({
      injectedMemoryIds: ['fallback-memory'],
    })
    expect(recallV4).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({
      fallbacks: 1,
      fallbackReasons: { 'v4-not-ready': 1 },
      last: { authoritativeReadSource: 'v3', fallbackReason: 'v4-not-ready' },
    })
  })
})

function observingLlm(observed: ChatMessage[][]): AgentLLMPort {
  return {
    async *stream(_model, messages) {
      observed.push(messages)
      yield { type: 'text-delta', text: '你叫小秦 [M1]' }
    },
  }
}

function memoryPort(
  recallAdaptive: NonNullable<AgentMemoryPort['recallAdaptive']>,
): AgentMemoryPort {
  return {
    list: async () => [],
    recall: async () => [],
    recallAdaptive,
    remember: async () => undefined,
    capture: async () => 0,
    forget: async () => undefined,
    update: async () => false,
    restore: async () => false,
    unlinkSources: async () => ({ updated: 0, orphaned: 0 }),
    clear: async () => undefined,
    count: async () => 0,
  }
}

function v3Result(memoryId: string): AdaptiveMemoryRecallResult {
  return {
    memories: [{ id: memoryId, content: 'V3 fallback content', createdAt: 1 }],
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
      version: 'memory-v4-tier-router-v1', coldPolicy: 'fallback', coldAwakened: false,
      candidateBudgets: { hot: 8, warm: 16, cold: 8 },
      eligibleCounts: { hot: 1, warm: 0, cold: 0 }, searchedCounts: { hot: 1, warm: 0, cold: 0 },
      quarantineExcluded: 0, unassignedAsWarm: 0,
    },
    evidenceSelection: {
      version: 'memory-v4-evidence-selector-v1', evaluatedCount: 1, selectedCount: 1,
      coveredRequirements: ['concept:profile.name'], stopReason: 'coverage-satisfied', usedCharacters: 8,
    },
    hits: [{
      factId: 'fact-name',
      sourceMemoryId: 'v3-name',
      content: '用户姓名：小秦',
      score: 0.93,
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
    abstention: { abstained: false, threshold: 0.5, bestScore: 0.93, version: 'gate-v1' },
    latencyMs: 3,
    index: { summaries: 0, facts: 1, rebuildCount: 1 },
  }
}
