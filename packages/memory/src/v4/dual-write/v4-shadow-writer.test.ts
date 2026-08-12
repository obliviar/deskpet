import { describe, expect, it } from 'vitest'
import { createMemoryWriter } from '../../long-term/memory-writer'
import { createVectorStore } from '../../long-term/vector-store'
import type { V3MemoryCommit, V3MemoryRecord } from '../../long-term/vector-store'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import type { MemoryV4Persistence } from '../repository/memory-v4-repository'
import { createV4ShadowWriter } from './v4-shadow-writer'

const scope = { ownerId: 'stage2-user', agentId: 'deskpet' }
const NOW = 1_800_000_000_000

describe('Memory V4 stage-two shadow writer', () => {
  it('dual-writes an accepted fact with its original user episode and stable V3 identity', async () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
    const store = createVectorStore({
      onCommittedChange: shadow.enqueueCommit,
    })
    const writer = createMemoryWriter({
      store,
      onCaptured: shadow.enqueueCapture,
    })

    expect(await writer.capture({
      userMessage: '我叫小秦',
      assistantMessage: '',
      metadata: { sessionId: 'default', sourceMessageIds: ['message-1'] },
    }, scope)).toBe(1)
    shadow.flush()

    const v3 = (await writer.list(scope))[0]!
    const snapshot = repository.snapshot()
    const fact = snapshot.facts.find(item => item.metadata?.v3SourceId === v3.id)!
    const candidate = snapshot.candidates[0]!
    const episode = snapshot.episodes.find(item => item.sourceMessageId === 'message-1')!
    const evidence = snapshot.evidenceLinks.find(item => item.factId === fact.id && item.episodeId === episode.id)!

    expect(fact.status).toBe('active')
    expect(fact.canonicalText).toContain('小秦')
    expect(fact.evidenceScore).toBe(1)
    expect(fact.verificationState).toBe('pending')
    expect(candidate.status).toBe('accepted')
    expect(candidate.evidenceEpisodeIds).toEqual([episode.id])
    expect(episode.content).toBe('我叫小秦')
    expect(episode.scope.sessionId).toBe('default')
    expect(evidence).toMatchObject({ role: 'supports', strength: 'direct', active: true })
    expect(snapshot.factVersions.filter(item => item.factId === fact.id).map(item => item.operation))
      .toEqual(['ADD', 'MERGE_EVIDENCE'])
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('keeps automatic V3-only facts quarantined until original evidence arrives', () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
    shadow.enqueueCommit(commit([record({ origin: 'automatic', sourceMessageIds: [] })]))
    shadow.flush()

    const snapshot = repository.snapshot()
    expect(snapshot.facts[0]).toMatchObject({
      status: 'quarantined',
      verificationState: 'pending',
      evidenceScore: 0.4,
    })
    expect(snapshot.evidenceLinks[0]).toMatchObject({
      role: 'legacy-derived',
      strength: 'legacy-derived',
    })
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('mirrors supersession, source unlinking and explicit deletion as auditable versions', () => {
    let tick = NOW
    const repository = createMemoryV4Repository({ now: () => ++tick })
    const shadow = createV4ShadowWriter({ repository, now: () => ++tick, flushDelayMs: 10_000 })
    const first = record({
      id: 'old-name', content: '用户姓名：小秦', memoryKey: 'profile.name',
      metadata: { kind: 'identity', cardinality: 'single' }, sourceMessageIds: ['old-message'],
    })
    const second = record({
      id: 'new-name', content: '用户姓名：小明', memoryKey: 'profile.name', supersedes: first.id,
      metadata: { kind: 'identity', cardinality: 'single' }, sourceMessageIds: ['new-message'],
      createdAt: NOW + 50, updatedAt: NOW + 50,
    })
    shadow.enqueueCommit(commit([first], [], 'remember', NOW + 1))
    shadow.enqueueCommit(commit([
      { ...first, status: 'superseded', validTo: NOW + 50, invalidatedAt: NOW + 50, updatedAt: NOW + 50 },
      second,
    ], [], 'remember', NOW + 50))
    shadow.enqueueCommit(commit([
      { ...second, status: 'orphaned', sourceMessageIds: [], updatedAt: NOW + 60 },
    ], [], 'unlink-sources', NOW + 60))
    shadow.enqueueCommit(commit([], [first.id], 'forget', NOW + 70))
    shadow.flush()

    const snapshot = repository.snapshot()
    const oldFact = snapshot.facts.find(item => item.metadata?.v3SourceId === first.id)!
    const newFact = snapshot.facts.find(item => item.metadata?.v3SourceId === second.id)!
    expect(oldFact.status).toBe('deleted')
    expect(newFact.status).toBe('orphaned')
    expect(newFact.supersedesFactIds).toEqual([oldFact.id])
    expect(snapshot.factVersions.filter(item => item.factId === oldFact.id).at(-1))
      .toMatchObject({ status: 'deleted', operation: 'DELETE' })
    expect(snapshot.factVersions.filter(item => item.factId === newFact.id).map(item => item.operation))
      .toContain('SUPERSEDE')
    expect(snapshot.evidenceLinks.filter(item => item.factId === newFact.id).every(item => !item.active)).toBe(true)
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('records retrieval candidates and actual prompt injection separately', () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 1, flushDelayMs: 10_000 })
    shadow.enqueueCommit(commit([record({ id: 'm1', origin: 'manual' }), record({ id: 'm2', origin: 'manual' })]))
    shadow.enqueueRetrieval({
      query: '我喜欢什么？',
      scope,
      retrievedMemoryIds: ['m1', 'm2', 'missing'],
      injectedMemoryIds: ['m2'],
      queryType: 'adaptive',
      answerModel: 'test-model',
      createdAt: NOW + 2,
    })
    shadow.flush()

    const snapshot = repository.snapshot()
    const event = snapshot.retrievalEvents[0]!
    const m1 = snapshot.facts.find(item => item.metadata?.v3SourceId === 'm1')!
    const m2 = snapshot.facts.find(item => item.metadata?.v3SourceId === 'm2')!
    expect(event.retrievedFactIds).toEqual([m1.id, m2.id])
    expect(event.injectedFactIds).toEqual([m2.id])
    expect(event.queryHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(event)).not.toContain('我喜欢什么')
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('retains a failed V4 batch for retry without undoing the acknowledged V3 path', () => {
    let payload: string | undefined
    let fail = true
    const persistence: MemoryV4Persistence = {
      load: () => payload,
      save: (next) => {
        if (fail)
          throw new Error('simulated V4 disk failure')
        payload = next
      },
    }
    const repository = createMemoryV4Repository({ persistence, now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 1, flushDelayMs: 10_000 })
    shadow.enqueueCommit(commit([record()]))

    expect(() => shadow.flush()).toThrow('simulated V4 disk failure')
    expect(shadow.pendingCount()).toBe(1)
    expect(repository.snapshot().facts).toHaveLength(0)
    fail = false
    shadow.flush()
    expect(shadow.pendingCount()).toBe(0)
    expect(repository.snapshot().facts).toHaveLength(1)
  })

  it('reconciles missed V3 records idempotently after restart and tombstones removed sources', () => {
    let tick = NOW
    const repository = createMemoryV4Repository({ now: () => ++tick })
    const shadow = createV4ShadowWriter({ repository, now: () => ++tick, flushDelayMs: 10_000 })
    const first = record({ id: 'persisted-1', origin: 'manual' })
    const second = record({ id: 'persisted-2', content: '用户喜欢茶', origin: 'manual' })
    const both = JSON.stringify({ version: 3, items: [first, second] })
    const firstResult = shadow.reconcileV3Payload(both)
    const revision = repository.snapshot().revision
    const secondResult = shadow.reconcileV3Payload(both)
    const one = JSON.stringify({ version: 3, items: [second] })
    const thirdResult = shadow.reconcileV3Payload(one)

    expect(firstResult).toEqual({ changed: true, sourceCount: 2, mirroredCount: 2, deletedCount: 0 })
    expect(secondResult).toEqual({ changed: false, sourceCount: 2, mirroredCount: 2, deletedCount: 0 })
    expect(repository.snapshot().revision).toBe(revision + 1)
    expect(thirdResult.deletedCount).toBe(1)
    expect(repository.snapshot().facts.find(item => item.metadata?.v3SourceId === first.id)?.status).toBe('deleted')
    expect(repository.snapshot().facts.find(item => item.metadata?.v3SourceId === second.id)?.status).toBe('active')
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('isolates a throwing post-commit observer from the successful V3 operation', async () => {
    const errors: unknown[] = []
    const store = createVectorStore({
      onCommittedChange: () => {
        throw new Error('shadow unavailable')
      },
      onCommitObserverError: error => errors.push(error),
    })

    await expect(store.remember('用户喜欢咖啡', scope, { origin: 'manual' })).resolves.toBeDefined()
    expect(await store.count(scope)).toBe(1)
    expect(errors).toHaveLength(1)
  })
})

function record(patch: Partial<V3MemoryRecord> = {}): V3MemoryRecord {
  const id = patch.id ?? 'memory-1'
  return {
    id,
    content: '用户喜欢咖啡',
    metadata: { kind: 'preference', ...(patch.metadata ?? {}) },
    status: 'active',
    origin: 'automatic',
    importance: 0.8,
    confidence: 0.9,
    accessCount: 0,
    sourceMessageIds: ['message-1'],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope,
    embedding: [1, 0],
    embeddingModel: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  }
}

function commit(
  upserts: V3MemoryRecord[],
  deletedIds: string[] = [],
  reason: V3MemoryCommit['reason'] = 'remember',
  committedAt = NOW + 1,
): V3MemoryCommit {
  return { reason, upserts, deletedIds, committedAt }
}
