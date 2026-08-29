import { describe, expect, it } from 'vitest'
import { createMemoryConsolidationService } from '../consolidation/memory-consolidation-service'
import { createMemoryTieringService } from '../consolidation/memory-tiering-service'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createV4ShadowWriter } from '../dual-write/v4-shadow-writer'
import { createMemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createMemoryV4ShadowRetriever } from '../retrieval/memory-v4-shadow-retriever'

const START = Date.UTC(2026, 7, 24)
const scope = { ownerId: 'timeline-user', agentId: 'deskpet' }
const tierOptions = {
  hotUtility: 0.99,
  warmUtility: 0.99,
  hotBudget: 1,
  warmBudget: 8,
  coldBudget: 64,
}

describe('Memory V4 lifecycle timeline', () => {
  it('preserves write, version, summary, rebuild, recall, conflict, archive and restore invariants', async () => {
    let clock = START
    const now = () => ++clock
    const repository = createMemoryV4Repository({ now })
    const writer = createV4ShadowWriter({ repository, now, flushDelayMs: 10_000 })

    // T0: authoritative shadow write, including one supersession chain and a
    // pair of explicitly unresolved historical alternatives.
    const written = writer.reconcileV3Payload(JSON.stringify({
      version: 3,
      items: [
        v3Item('name', '用户姓名：小秦', 'profile.name', { importance: 0.95 }),
        v3Item('project-old', '用户以前开发 OldDesk', 'project.current', {
          origin: 'automatic',
          status: 'superseded', validFrom: Date.UTC(2024, 0, 1), validTo: Date.UTC(2025, 0, 1),
          invalidatedAt: Date.UTC(2025, 0, 2), createdAt: Date.UTC(2024, 0, 1), updatedAt: Date.UTC(2025, 0, 2),
        }),
        v3Item('project-new', '用户当前项目：DeskPet', 'project.current', {
          origin: 'automatic', supersedes: 'project-old', validFrom: Date.UTC(2025, 0, 1), importance: 0.4,
        }),
        v3Item('city-hangzhou', '用户居住在杭州', 'profile.location', { status: 'conflicted' }),
        v3Item('city-shanghai', '用户居住在上海', 'profile.location', { status: 'conflicted' }),
      ],
    }))
    expect(written).toMatchObject({ changed: true, sourceCount: 5, mirroredCount: 5 })
    const hangzhou = sourceFact(repository, 'city-hangzhou')
    const shanghai = sourceFact(repository, 'city-shanghai')
    const capturedProject = sourceFact(repository, 'project-new')
    repository.transaction((draft) => {
      draft.facts.find(fact => fact.id === hangzhou.id)!.conflictsWithFactIds = [shanghai.id]
      draft.facts.find(fact => fact.id === shanghai.id)!.conflictsWithFactIds = [hangzhou.id]
      // Simulate the direct-evidence upgrade performed by the capture channel
      // after the V3 commit was mirrored. The fact remains automatic and is
      // therefore still eligible for capacity archival later in the timeline.
      const fact = draft.facts.find(item => item.id === capturedProject.id)!
      fact.status = 'active'
      fact.verificationState = 'verified'
      fact.verificationScore = 1
      fact.evidenceScore = 1
      for (const link of draft.evidenceLinks.filter(item => item.factId === fact.id)) {
        link.active = true
        link.role = 'supports'
        link.strength = 'direct'
      }
      const version = draft.factVersions.find(item => item.factId === fact.id && item.version === 1)!
      version.status = 'active'
    })
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()

    // T1: build navigation summaries and capacity tiers over the authoritative graph.
    const consolidation = createMemoryConsolidationService(repository, { now })
    const tiering = createMemoryTieringService(repository, { now })
    const initialSummary = await consolidation.consolidate(scope, {
      granularity: ['session', 'day', 'topic', 'entity', 'stage'],
    })
    await tiering.run(scope, tierOptions)
    expect(initialSummary.built).toBeGreaterThan(0)
    expect(repository.snapshot().derivedArtifacts.some(item => item.kind === 'summary' && item.status === 'current')).toBe(true)
    expect(repository.snapshot().derivedArtifacts.some(item => item.kind === 'tier-index' && item.status === 'current')).toBe(true)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()

    // T2: user refinement appends a version and invalidates every dependent view.
    const project = sourceFact(repository, 'project-new')
    const lifecycle = createMemoryV4LifecycleService(repository, { now })
    const edited = lifecycle.editFact(project.id, project.scope, {
      canonicalText: '用户当前项目：DeskPet V4 长期记忆',
      object: 'DeskPet V4 长期记忆',
      normalizedValue: 'deskpet v4 长期记忆',
      reason: '项目进入 V4 长期记忆阶段',
      idempotencyKey: 'timeline-project-v4',
    })
    expect(edited.version).toBe(2)
    expect(repository.snapshot().factVersions.filter(version => version.factId === project.id).map(version => version.version))
      .toEqual([1, 2])
    expect(repository.snapshot().derivedArtifacts.some(item => item.kind === 'summary' && item.status === 'stale')).toBe(true)
    expect(repository.snapshot().derivedArtifacts.some(item => item.kind === 'tier-index' && item.status === 'stale')).toBe(true)

    // T3: deterministic rebuild closes the stale-view window before official recall.
    const rebuiltSummary = await consolidation.consolidate(scope, {
      granularity: ['session', 'day', 'topic', 'entity', 'stage'],
    })
    await tiering.run(scope, tierOptions)
    expect(rebuiltSummary.rebuilt).toBeGreaterThan(0)
    expect(repository.snapshot().derivedArtifacts.filter(item => item.kind === 'summary').every(item => item.status === 'current')).toBe(true)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()

    const retriever = createMemoryV4ShadowRetriever(repository, { now })

    // T4: an ordinary warm lookup must not touch cold, while an exact cold miss
    // wakes only the bounded cold lane. Broad recall navigates via summaries.
    const nameRecall = retriever.recall('我的姓名是什么？', { scope, limit: 8 })
    expect(nameRecall.hits.map(hit => hit.sourceMemoryId)).toEqual(['name'])
    expect(nameRecall.tierRouting).toMatchObject({ coldPolicy: 'fallback', coldAwakened: false })
    expect(nameRecall.tierRouting.searchedCounts.cold).toBe(0)

    const currentProject = retriever.recall('我现在做什么项目？', { scope, limit: 8 })
    expect(currentProject.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: 'project-new', content: '用户当前项目:DeskPet V4 长期记忆', tier: 'cold' }),
    ]))
    expect(currentProject.tierRouting).toMatchObject({ coldPolicy: 'fallback', coldAwakened: true })

    const broad = retriever.recall('总结我的项目信息', { scope, limit: 10 })
    expect(broad.queryIntent).toBe('enumerative')
    expect(broad.tierRouting).toMatchObject({ coldPolicy: 'eager', coldAwakened: true })
    expect(broad.hits.some(hit => hit.routes.includes('summary-down-drill'))).toBe(true)
    expect(broad.evidenceSelection.selectedCount).toBeLessThanOrEqual(broad.candidateCount)

    // T5: timeline recall keeps old/current versions distinct and returns both
    // sides of an unresolved conflict group rather than silently picking one.
    const projectTimeline = retriever.recall('我的项目从以前到现在有什么变化？', { scope, limit: 12 })
    expect(new Set(projectTimeline.hits.map(hit => hit.sourceMemoryId))).toEqual(new Set(['project-old', 'project-new']))
    expect(projectTimeline.hits.every(hit => hit.tier === 'cold')).toBe(true)

    const conflictTimeline = retriever.recall('我的居住城市历史记录是什么？', { scope, limit: 12 })
    expect(new Set(conflictTimeline.hits.map(hit => hit.sourceMemoryId))).toEqual(new Set(['city-hangzhou', 'city-shanghai']))
    expect(conflictTimeline.hits.every(hit => hit.status === 'conflicted')).toBe(true)

    // T6: archive removes the fact from current answers without destroying its
    // evidence; historical cold recall still finds it, then restore reactivates it.
    lifecycle.archiveFact(project.id, project.scope, {
      reason: '生命周期时间线归档验证', idempotencyKey: 'timeline-archive-project',
    })
    expect(retriever.recall('我现在做什么项目？', { scope, limit: 8 }).hits).toEqual([])
    const archivedRecall = retriever.recall('我的项目历史记录是什么？', { scope, limit: 12 })
    expect(archivedRecall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: 'project-new', status: 'archived', tier: 'cold' }),
    ]))
    lifecycle.restoreFact(project.id, project.scope, {
      reason: '生命周期时间线恢复验证', idempotencyKey: 'timeline-restore-project',
    })
    await consolidation.consolidate(scope, { granularity: ['session', 'day', 'topic', 'entity', 'stage'] })
    await tiering.run(scope, tierOptions)
    const restoredRecall = retriever.recall('我现在做什么项目？', { scope, limit: 8 })
    expect(restoredRecall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: 'project-new', status: 'active' }),
    ]))
    const eventTypes = repository.snapshot().domainEvents.map(event => event.type)
    expect(eventTypes).toEqual(expect.arrayContaining(['FACT_VERSIONED', 'FACT_ARCHIVED', 'FACT_RESTORED']))
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })
})

function sourceFact(repository: ReturnType<typeof createMemoryV4Repository>, sourceId: string) {
  const factId = repository.snapshot().legacyImports.find(item => item.sourceItemId === sourceId)?.factId
    ?? repository.snapshot().facts.find(fact => fact.metadata?.v3SourceId === sourceId)?.id
  const fact = repository.snapshot().facts.find(item => item.id === factId)
  if (!fact)
    throw new Error(`Missing timeline fact for ${sourceId}`)
  return fact
}

function v3Item(id: string, content: string, memoryKey: string, patch: Record<string, unknown> = {}) {
  return {
    id, content, metadata: { kind: memoryKey.split('.')[0], cardinality: 'single' },
    status: 'active', origin: 'manual', importance: 0.6, confidence: 1, accessCount: 0,
    memoryKey, sourceMessageIds: [`source-${id}`], sourceAttachmentIds: [],
    sharePolicy: 'allow-remote', sensitivity: 'normal', scope: { ...scope, sessionId: 'timeline-session' },
    embedding: [], embeddingModel: 'local-hash-v3', createdAt: START - 1_000, updatedAt: START - 1_000,
    ...patch,
  }
}
