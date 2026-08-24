import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryWriter } from '../../long-term/memory-writer'
import { createVectorStore } from '../../long-term/vector-store'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createV4ShadowWriter } from '../dual-write/v4-shadow-writer'
import {
  createDeterministicSummarizer,
  createIdleConsolidationRunner,
  createMemoryConsolidationService,
} from './memory-consolidation-service'

const scope = { ownerId: 'consolidation-user', agentId: 'deskpet' }
const NOW = 1_800_000_000_000

async function seedTwoSessions(): Promise<ReturnType<typeof createMemoryV4Repository>> {
  const repository = createMemoryV4Repository({ now: () => NOW })
  const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
  let memoryKey = 'profile.name'
  const writer = createMemoryWriter({
    store: createVectorStore({ onCommittedChange: shadow.enqueueCommit }),
    extractor: turn => [{
      content: `用户姓名/名字：${turn.userMessage}`,
      metadata: {
        kind: 'identity', memoryKey, cardinality: 'multiple' as const,
        confidence: 0.95, importance: 0.9, extractionChannel: 'rules', extractorVersion: 'test-rules',
      },
    }],
    onCaptured: shadow.enqueueCapture,
  })
  await writer.capture({
    userMessage: '小秦',
    assistantMessage: '',
    metadata: { sessionId: 'session-a', sourceMessageIds: ['message-a1'] },
  }, scope)
  memoryKey = 'preference.drink'
  await writer.capture({
    userMessage: '小秦喜欢喝咖啡',
    assistantMessage: '',
    metadata: { sessionId: 'session-b', sourceMessageIds: ['message-b1'] },
  }, scope)
  shadow.flush()
  return repository
}

describe('memory consolidation service', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds session and day summaries with full source references', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)

    const report = await service.consolidate(scope)
    expect(report.built).toBe(3)
    expect(report.stopReason).toBe('completed')

    const summaries = service.listSummaries(scope)
    expect(summaries).toHaveLength(3)
    const sessionSummaries = summaries.filter(summary => summary.id.startsWith('consolidation-summary:session:'))
    const daySummaries = summaries.filter(summary => summary.id.startsWith('consolidation-summary:day:'))
    expect(sessionSummaries).toHaveLength(2)
    expect(daySummaries).toHaveLength(1)

    for (const summary of summaries) {
      expect(summary.status).toBe('current')
      expect(summary.sourceFactIds.length).toBeGreaterThan(0)
      expect(summary.sourceEpisodeIds.length).toBeGreaterThan(0)
      expect(summary.content).toContain('条事实')
    }
    // Day summaries span both sessions; session summaries stay per-session.
    expect(daySummaries[0]!.sourceFactIds).toHaveLength(2)
    expect(sessionSummaries.every(summary => summary.sourceFactIds.length === 1)).toBe(true)
    const joined = summaries.map(summary => summary.content ?? '').join('\n')
    expect(joined).toContain('小秦')
    expect(joined).toContain('咖啡')
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('builds topic, entity and temporal-stage summaries as traceable navigation layers', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)

    const report = await service.consolidate(scope, {
      granularity: ['session', 'day', 'topic', 'entity', 'stage'],
    })

    expect(report.built).toBe(7)
    const summaries = service.listSummaries(scope)
    expect(summaries.filter(item => item.id.startsWith('consolidation-summary:topic:'))).toHaveLength(2)
    expect(summaries.filter(item => item.id.startsWith('consolidation-summary:entity:'))).toHaveLength(1)
    expect(summaries.filter(item => item.id.startsWith('consolidation-summary:stage:'))).toHaveLength(1)
    expect(summaries.map(item => item.content ?? '').join('\n')).toContain('[阶段 ')
    expect(summaries.every(item => item.sourceFactIds.length > 0 && item.sourceEpisodeIds.length > 0)).toBe(true)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('is idempotent: a second pass skips every current bucket', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    await service.consolidate(scope)

    const second = await service.consolidate(scope)
    expect(second.built).toBe(0)
    expect(second.rebuilt).toBe(0)
    expect(second.skipped).toBe(3)
    expect(second.stopReason).toBe('completed')
    expect(service.listSummaries(scope)).toHaveLength(3)
  })

  it('rebuilds summaries marked stale by a lifecycle fact edit', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    await service.consolidate(scope)

    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => NOW + 1000 })
    const fact = repository.snapshot().facts.find(item => item.canonicalText.includes('小秦') && !item.canonicalText.includes('咖啡'))!
    lifecycle.editFact(fact.id, fact.scope, {
      canonicalText: '用户姓名/名字：小秦秦',
      reason: 'consolidation test refine',
      idempotencyKey: 'consolidation-refine-1',
    })
    const staleBefore = repository.snapshot().derivedArtifacts.filter(artifact => artifact.status === 'stale')
    expect(staleBefore.length).toBeGreaterThan(0)

    const rebuilt = await service.consolidate(scope)
    expect(rebuilt.rebuilt).toBeGreaterThan(0)
    const contents = service.listSummaries(scope).map(summary => summary.content ?? '').join('\n')
    expect(contents).toContain('小秦秦')
    expect(repository.snapshot().derivedArtifacts.every(artifact => artifact.status !== 'stale')).toBe(true)
  })

  it('prunes a summary when every source fact leaves the active state', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    await service.consolidate(scope)

    const target = repository.snapshot().derivedArtifacts.find(artifact =>
      artifact.id.startsWith('consolidation-summary:session:'))!
    // Unlink every source episode of one session summary through the lifecycle
    // API: its fact becomes orphaned (a legal non-active state) and the bucket
    // loses all active coverage, so the summary must be pruned.
    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => NOW + 2000 })
    lifecycle.unlinkEpisodes(target.sourceEpisodeIds, scope, {
      reason: 'consolidation test unlink',
      idempotencyKey: 'consolidation-unlink-1',
    })

    const pruned = await service.consolidate(scope)
    expect(pruned.pruned).toBe(1)
    expect(service.listSummaries(scope).find(summary => summary.id === target.id)?.status).toBe('deleted')
  })

  it('prunes a summary whose complete source bucket disappeared after chat deletion', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    await service.consolidate(scope)
    const target = repository.snapshot().derivedArtifacts.find(artifact =>
      artifact.id.startsWith('consolidation-summary:session:')
      && artifact.sourceEpisodeIds.some(id => repository.snapshot().episodes.find(episode => episode.id === id)?.sourceMessageId === 'message-a1'))!
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 3000, flushDelayMs: 10_000 })
    shadow.enqueueSourceUnlink({
      messageIds: ['message-a1'],
      scope,
      result: { updated: 1, orphaned: 1 },
      unlinkedAt: NOW + 3000,
    })
    shadow.flush()

    const report = await service.consolidate(scope)
    const pruned = repository.snapshot().derivedArtifacts.find(artifact => artifact.id === target.id)
    expect(report.pruned).toBeGreaterThanOrEqual(1)
    expect(pruned?.status).toBe('deleted')
    expect(pruned).not.toHaveProperty('content')
    expect(pruned).not.toHaveProperty('contentHash')
  })

  it('rebuilds current summaries when the builder version changes', async () => {
    const repository = await seedTwoSessions()
    await createMemoryConsolidationService(repository, { builderVersion: 'builder-v1' }).consolidate(scope)

    const report = await createMemoryConsolidationService(repository, { builderVersion: 'builder-v2' }).consolidate(scope)

    expect(report.rebuilt).toBe(3)
    expect(repository.snapshot().derivedArtifacts
      .filter(artifact => artifact.kind === 'summary' && artifact.status === 'current')
      .every(artifact => artifact.builderVersion === 'builder-v2')).toBe(true)
  })

  it('respects bucket budgets and resumes from where it stopped', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)

    const first = await service.consolidate(scope, { maxBuckets: 1 })
    expect(first.built).toBe(1)
    expect(first.stopReason).toBe('bucket-budget')

    const resumed = await service.consolidate(scope, { maxBuckets: 1 })
    expect(resumed.built).toBe(1)
    expect(resumed.skipped).toBe(1)
    expect(resumed.stopReason).toBe('bucket-budget')

    const completed = await service.consolidate(scope, { maxBuckets: 1 })
    expect(completed.built).toBe(1)
    expect(completed.skipped).toBe(2)
    expect(completed.stopReason).toBe('completed')
    expect(service.listSummaries(scope)).toHaveLength(3)
  })

  it('honours cooperative cancellation between batches', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)

    const report = await service.consolidate(scope, { shouldCancel: () => true })
    expect(report.cancelled).toBe(true)
    expect(report.stopReason).toBe('cancelled')
    expect(report.built).toBe(0)
  })

  it('produces deterministic summaries and anchors', async () => {
    const repository = await seedTwoSessions()
    const snapshot = repository.snapshot()
    const bucket = {
      granularity: 'day' as const,
      bucketKey: '2026-08-18',
      scope: { ownerId: scope.ownerId, agentId: scope.agentId },
      episodes: snapshot.episodes,
      facts: snapshot.facts,
    }
    const summarizer = createDeterministicSummarizer()
    const first = await summarizer(bucket)
    const second = await summarizer(bucket)
    expect(first.content).toBe(second.content)
    expect(first.anchors).toStrictEqual(second.anchors)
    expect(first.anchors.some(anchor => anchor.includes('小秦'))).toBe(true)
  })
})

describe('idle consolidation runner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('only triggers while idle and respects the cooldown', async () => {
    vi.useFakeTimers()
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    const isIdle = vi.fn(() => false)
    const runner = createIdleConsolidationRunner({
      service,
      scope,
      isIdle,
      intervalMs: 1_000,
      cooldownMs: 60_000,
    })

    runner.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isIdle).toHaveBeenCalled()
    expect(runner.lastRunAt()).toBeUndefined()

    isIdle.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runner.lastRunAt()).toBeDefined()
    expect(service.listSummaries(scope)).toHaveLength(3)

    // The cooldown gate blocks an immediate second pass.
    const runsBefore = runner.lastRunAt()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runner.lastRunAt()).toBe(runsBefore)
    runner.stop()
  })

  it('runs a forced pass immediately and reports failures through onError', async () => {
    const repository = await seedTwoSessions()
    const failing = {
      consolidate: async () => {
        throw new Error('consolidation offline')
      },
      listSummaries: () => [],
    }
    const onError = vi.fn()
    const runner = createIdleConsolidationRunner({
      service: failing,
      scope,
      isIdle: () => true,
      onError,
    })

    await expect(runner.runOnce()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(runner.running()).toBe(false)
  })

  it('runs onIdle maintenance before consolidating and survives its failures', async () => {
    const repository = await seedTwoSessions()
    const service = createMemoryConsolidationService(repository)
    const order: string[] = []
    const onError = vi.fn()
    const runner = createIdleConsolidationRunner({
      service: {
        consolidate: async (runScope, options) => {
          order.push('consolidate')
          return service.consolidate(runScope, options)
        },
        listSummaries: service.listSummaries,
      },
      scope,
      isIdle: () => true,
      onError,
      onIdle: async () => {
        order.push('onIdle')
        if (order.length === 1)
          throw new Error('tiering offline')
      },
    })

    const report = await runner.runOnce()
    expect(order).toEqual(['onIdle', 'consolidate'])
    expect(report?.built).toBe(3)
    expect(onError).toHaveBeenCalledTimes(1)
    runner.stop()
  })
})
