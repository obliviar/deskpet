import { describe, expect, it } from 'vitest'
import { createMemoryWriter } from '../../long-term/memory-writer'
import { createVectorStore } from '../../long-term/vector-store'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import type { MemoryFactV4, MemoryV4Snapshot } from '../domain/types'
import { createV4ShadowWriter } from '../dual-write/v4-shadow-writer'
import {
  assignTiers,
  computeFactUtility,
  createMemoryTieringService,
} from './memory-tiering-service'

const scope = { ownerId: 'tiering-user', agentId: 'deskpet' }
const NOW = 1_800_000_000_000

interface SeedFact {
  key: string
  text: string
  importance: number
}

async function seedFacts(facts: SeedFact[]): Promise<ReturnType<typeof createMemoryV4Repository>> {
  const repository = createMemoryV4Repository({ now: () => NOW })
  const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
  let index = 0
  const writer = createMemoryWriter({
    store: createVectorStore({ onCommittedChange: shadow.enqueueCommit }),
    extractor: turn => [{
      content: `${facts[index]!.key}：${turn.userMessage}`,
      metadata: {
        kind: 'identity', memoryKey: facts[index]!.key, cardinality: 'multiple' as const,
        confidence: 0.95, importance: facts[index]!.importance,
        extractionChannel: 'rules', extractorVersion: 'test-rules',
      },
    }],
    onCaptured: shadow.enqueueCapture,
  })
  for (const fact of facts) {
    await writer.capture({
      userMessage: fact.text,
      assistantMessage: '',
      metadata: { sessionId: `session-${fact.key}`, sourceMessageIds: [`message-${fact.key}`] },
    }, scope)
    index += 1
  }
  shadow.flush()
  return repository
}

function activeFact(snapshot: MemoryV4Snapshot, key: string) {
  return snapshot.facts.find(fact => fact.status === 'active' && fact.memoryKey === key)!
}

describe('memory tiering service', () => {
  it('assigns tiers, persists a tier-index artifact and writes back utility', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.5 },
      { key: 'work.project', text: '小秦在做DeskPet项目', importance: 0.5 },
    ])
    const service = createMemoryTieringService(repository, { now: () => NOW })

    const report = await service.run(scope)
    expect(report.factCount).toBe(3)
    expect(report.tierCounts.hot + report.tierCounts.warm + report.tierCounts.cold + report.tierCounts.quarantine).toBe(3)
    expect(report.skipped).toBe(false)

    const artifact = repository.snapshot().derivedArtifacts.find(item => item.kind === 'tier-index')
    expect(artifact?.status).toBe('current')
    expect(artifact?.sourceFactIds).toHaveLength(3)

    const view = service.listTierAssignment(scope)
    const total = view ? view.tiers.hot.length + view.tiers.warm.length + view.tiers.cold.length + view.tiers.quarantine.length : 0
    expect(total).toBe(3)

    for (const fact of repository.snapshot().facts)
      expect(fact.utilityScore).toBeGreaterThan(0)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('is idempotent when nothing changed since the last run', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.5 },
    ])
    const service = createMemoryTieringService(repository, { now: () => NOW })
    await service.run(scope)

    const second = await service.run(scope)
    expect(second.skipped).toBe(true)
    const assignment = service.listTierAssignment(scope)
    expect(assignment && assignment.tiers.hot.length + assignment.tiers.warm.length + assignment.tiers.cold.length)
      .toBeGreaterThan(0)
  })

  it('is idempotent when wall-clock time advances but rounded utility and membership do not', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
    ])
    let clock = NOW
    const service = createMemoryTieringService(repository, { now: () => clock })
    await service.run(scope)
    clock += 1

    const second = await service.run(scope)
    expect(second.skipped).toBe(true)
  })

  it('honours utility thresholds and hard non-protected capacity budgets', () => {
    const facts = Array.from({ length: 6 }, (_, index) => ({
      ...utilityFact(`threshold-${index}`),
      importance: 0.1,
      evidenceScore: 0.1,
      updatedAt: NOW - 365 * 24 * 60 * 60 * 1000,
    }))
    const signals = new Map(facts.map(fact => [fact.id, {
      adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 2,
    }]))
    const breakdown = assignTiers(facts, signals, {
      hotBudget: 1, warmBudget: 1, coldBudget: 1,
      hotUtility: 0.99, warmUtility: 0.98,
    }, NOW)

    expect(breakdown.filter(item => item.tier === 'hot')).toHaveLength(0)
    expect(breakdown.filter(item => item.tier === 'warm')).toHaveLength(0)
    expect(breakdown.filter(item => item.tier === 'cold' && !item.archiveCandidate)).toHaveLength(1)
    expect(breakdown.filter(item => item.archiveCandidate)).toHaveLength(5)
  })

  it('routes facts with repeated denials to quarantine', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.5 },
    ])
    const deniedFact = activeFact(repository.snapshot(), 'preference.drink')
    repository.transaction((draft) => {
      for (const offset of [0, 1]) {
        draft.retrievalEvents.push({
          id: `retrieval-denied-${offset}`,
          scope,
          queryHash: `hash-${offset}`,
          queryType: 'fixed',
          retrievedFactIds: [deniedFact.id],
          injectedFactIds: [deniedFact.id],
          adoptedFactIds: [],
          correctedFactIds: [],
          deniedFactIds: [deniedFact.id],
          createdAt: NOW + 100 + offset,
          retrievalVersion: 'test',
        })
      }
    })

    const service = createMemoryTieringService(repository, { now: () => NOW })
    const report = await service.run(scope)
    expect(report.tierCounts.quarantine).toBe(1)
    expect(service.listTierAssignment(scope)?.tiers.quarantine).toContain(deniedFact.id)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('rebuilds the tier index after a lifecycle edit marks it stale', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.5 },
    ])
    const service = createMemoryTieringService(repository, { now: () => NOW })
    await service.run(scope)

    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => NOW + 1000 })
    const fact = activeFact(repository.snapshot(), 'preference.drink')
    lifecycle.editFact(fact.id, fact.scope, {
      canonicalText: 'preference.drink：小秦只喝茶',
      reason: 'tiering test refine',
      idempotencyKey: 'tiering-refine-1',
    })
    const stale = repository.snapshot().derivedArtifacts.find(item => item.kind === 'tier-index')
    expect(stale?.status).toBe('stale')

    const rebuilt = await service.run(scope)
    expect(rebuilt.skipped).toBe(false)
    expect(repository.snapshot().derivedArtifacts.find(item => item.kind === 'tier-index')?.status).toBe('current')
  })

  it('archives cold overflow through the lifecycle and restores it afterwards', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.2 },
      { key: 'preference.food', text: '小秦不吃香菜', importance: 0.2 },
      { key: 'work.project', text: '小秦在做DeskPet项目', importance: 0.2 },
    ])
    const service = createMemoryTieringService(repository, { now: () => NOW })
    const budgets = { hotBudget: 1, warmBudget: 1, coldBudget: 1 }

    const report = await service.run(scope, budgets)
    expect(report.archiveCandidates).toHaveLength(2)
    const candidate = report.archiveCandidates[0]!
    expect(candidate).not.toBe(activeFact(repository.snapshot(), 'profile.name').id)

    const archived = await service.archiveColdFacts(scope, { ...budgets, maxArchives: 2 })
    expect(archived.archived).toEqual(report.archiveCandidates)
    expect(archived.failed).toEqual([])

    const archivedFact = repository.snapshot().facts.find(fact => fact.id === candidate)
    expect(archivedFact?.status).toBe('archived')
    expect(repository.snapshot().domainEvents.some(event => event.type === 'FACT_ARCHIVED')).toBe(true)
    expect(repository.snapshot().derivedArtifacts.find(item => item.kind === 'tier-index')?.status).toBe('current')
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()

    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => NOW + 5000 })
    lifecycle.restoreFact(candidate, archivedFact!.scope, {
      reason: 'tiering test restore',
      idempotencyKey: 'tiering-restore-1',
    })
    expect(repository.snapshot().facts.find(fact => fact.id === candidate)?.status).toBe('active')
    expect(repository.snapshot().derivedArtifacts.find(item => item.kind === 'tier-index')?.status).toBe('stale')
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('never archives user-confirmed or high-importance facts', async () => {
    const repository = await seedFacts([
      { key: 'profile.name', text: '小秦', importance: 0.9 },
      { key: 'preference.drink', text: '小秦喜欢喝咖啡', importance: 0.2 },
      { key: 'preference.food', text: '小秦不吃香菜', importance: 0.2 },
      { key: 'work.project', text: '小秦在做DeskPet项目', importance: 0.2 },
      { key: 'home.city', text: '小秦住在杭州', importance: 0.2 },
    ])
    // Mark one low-importance fact as user-confirmed through a direct but
    // consistency-safe transaction (userConfirmed is not version-checked).
    const confirmed = activeFact(repository.snapshot(), 'preference.drink')
    repository.transaction((draft) => {
      const fact = draft.facts.find(item => item.id === confirmed.id)!
      fact.userConfirmed = true
    })

    const service = createMemoryTieringService(repository, { now: () => NOW })
    const report = await service.run(scope, { hotBudget: 1, warmBudget: 1, coldBudget: 1 })
    expect(report.protectedCount).toBe(2)
    expect(report.archiveCandidates).not.toContain(confirmed.id)
    expect(report.archiveCandidates).not.toContain(activeFact(repository.snapshot(), 'profile.name').id)
    expect(report.archiveCandidates).toHaveLength(2)
  })
})

describe('fact utility computation', () => {
  const baseFact: MemoryFactV4 = {
    id: 'fact-base',
    scope,
    subjectId: 'user',
    predicate: 'likes',
    object: 'coffee',
    objectType: 'string',
    normalizedValue: 'coffee',
    canonicalText: '用户喜欢咖啡',
    memoryKey: 'preference.drink',
    cardinality: 'single',
    polarity: 'positive',
    modality: 'asserted',
    status: 'active',
    recordedAt: NOW,
    updatedAt: NOW,
    evidenceLinkIds: [],
    extractionScore: 0.9,
    verificationScore: 0.9,
    evidenceScore: 0.8,
    utilityScore: 0,
    importance: 0.5,
    accessCount: 0,
    userConfirmed: false,
    verificationState: 'verified',
    supersedesFactIds: [],
    conflictsWithFactIds: [],
    sensitivity: 'normal',
    sharePolicy: 'allow-remote',
    origin: 'automatic',
    extractorVersion: 'test',
    verifierVersion: 'test',
  }

  it('penalizes negative feedback and rewards adoption and confirmation', () => {
    const neutral = computeFactUtility(baseFact, { adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }, { recencyHalfLifeMs: 30 * 24 * 3600 * 1000 }, NOW)
    const adopted = computeFactUtility(baseFact, { adoptedCount: 2, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }, { recencyHalfLifeMs: 30 * 24 * 3600 * 1000 }, NOW)
    const denied = computeFactUtility(baseFact, { adoptedCount: 0, correctedCount: 0, deniedCount: 2, keyGroupSize: 1 }, { recencyHalfLifeMs: 30 * 24 * 3600 * 1000 }, NOW)
    const confirmed = computeFactUtility({ ...baseFact, userConfirmed: true }, { adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }, { recencyHalfLifeMs: 30 * 24 * 3600 * 1000 }, NOW)
    expect(adopted).toBeGreaterThan(neutral)
    expect(confirmed).toBeGreaterThan(neutral)
    expect(denied).toBeLessThan(neutral)
  })

  it('decays utility with time since last access', () => {
    const halfLife = 30 * 24 * 3600 * 1000
    const fresh = computeFactUtility(baseFact, { adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }, { recencyHalfLifeMs: halfLife }, NOW)
    const stale = computeFactUtility(baseFact, { adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }, { recencyHalfLifeMs: halfLife }, NOW + 4 * halfLife)
    expect(stale).toBeLessThan(fresh)
  })
})

describe('tier assignment capacity stress', () => {
  it('assigns 100k facts within the capacity budgets in bounded time', () => {
    const facts: MemoryFactV4[] = Array.from({ length: 100_000 }, (_, index) => ({
      id: `fact-${index}`,
      scope,
      subjectId: 'user',
      predicate: 'pref',
      object: index,
      objectType: 'number',
      normalizedValue: index,
      canonicalText: `item-${index}`,
      memoryKey: `key.${index % 500}`,
      cardinality: 'multiple',
      polarity: 'positive',
      modality: 'asserted',
      status: 'active',
      recordedAt: NOW - index * 1000,
      updatedAt: NOW - index * 1000,
      evidenceLinkIds: [],
      extractionScore: 0.9,
      verificationScore: 0.9,
      evidenceScore: 0.8,
      utilityScore: 0,
      importance: 0.2 + (index % 10) / 20,
      accessCount: index % 7,
      userConfirmed: index % 9973 === 0,
      verificationState: 'verified',
      supersedesFactIds: [],
      conflictsWithFactIds: [],
      sensitivity: 'normal',
      sharePolicy: 'allow-remote',
      origin: 'automatic',
      extractorVersion: 'test',
      verifierVersion: 'test',
    }))
    const signals = new Map(facts.map(fact => [fact.id, {
      adoptedCount: 0,
      correctedCount: 0,
      deniedCount: 0,
      keyGroupSize: 200,
    }]))

    const budgets = { hotBudget: 500, warmBudget: 2_000, coldBudget: 10_000 }
    const startedAt = Date.now()
    const breakdown = assignTiers(facts, signals, budgets, NOW)
    const elapsed = Date.now() - startedAt

    expect(breakdown).toHaveLength(100_000)
    expect(breakdown.filter(item => item.tier === 'hot').length).toBeLessThanOrEqual(500)
    expect(breakdown.filter(item => item.tier === 'warm' && !item.protectedFromArchive).length).toBeLessThanOrEqual(2_000)
    expect(breakdown.filter(item => item.tier === 'cold' && !item.archiveCandidate).length).toBeLessThanOrEqual(10_000)
    // Protected facts (user-confirmed) never become archive candidates.
    expect(breakdown.filter(item => item.protectedFromArchive && item.archiveCandidate)).toHaveLength(0)
    expect(elapsed).toBeLessThan(2_000)
  })
})

function utilityFact(id: string): MemoryFactV4 {
  return {
    id,
    scope,
    subjectId: 'user',
    predicate: 'pref',
    object: id,
    objectType: 'string',
    normalizedValue: id,
    canonicalText: id,
    memoryKey: id,
    cardinality: 'multiple',
    polarity: 'positive',
    modality: 'asserted',
    status: 'active',
    recordedAt: NOW,
    updatedAt: NOW,
    evidenceLinkIds: [],
    extractionScore: 0.9,
    verificationScore: 0.9,
    evidenceScore: 0.8,
    utilityScore: 0,
    importance: 0.5,
    accessCount: 0,
    userConfirmed: false,
    verificationState: 'verified',
    supersedesFactIds: [],
    conflictsWithFactIds: [],
    sensitivity: 'normal',
    sharePolicy: 'allow-remote',
    origin: 'automatic',
    extractorVersion: 'test',
    verifierVersion: 'test',
  }
}
