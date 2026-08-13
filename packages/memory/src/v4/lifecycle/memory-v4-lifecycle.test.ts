import { describe, expect, it } from 'vitest'
import { migrateV3PayloadToV4 } from '../migration/v3-to-v4'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4LifecycleService } from './memory-v4-lifecycle'

const NOW = 1_800_000_000_000
const scope = { ownerId: 'owner', agentId: 'agent' }

describe('Memory V4 authoritative lifecycle', () => {
  it('edits content as an auditable version and invalidates derived artifacts idempotently', () => {
    let tick = NOW + 100
    const repository = migratedRepository()
    const fact = repository.snapshot().facts[0]!
    repository.transaction((draft) => {
      draft.derivedArtifacts.push({
        id: 'summary-1', scope, kind: 'summary', status: 'current',
        sourceEpisodeIds: [], sourceFactIds: [fact.id], content: '旧摘要',
        createdAt: NOW, updatedAt: NOW, builderVersion: 'test',
      })
    })
    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => ++tick })
    const first = lifecycle.editFact(fact.id, scope, {
      canonicalText: '用户姓名：小明', object: '小明', normalizedValue: '小明',
      predicate: 'profile.name', reason: '用户在管理界面纠正姓名', idempotencyKey: 'edit-name-1',
    })
    const duplicate = lifecycle.editFact(fact.id, scope, {
      canonicalText: '这次调用应被幂等忽略', reason: '重复请求', idempotencyKey: 'edit-name-1',
    })
    const snapshot = repository.snapshot()
    expect(first).toMatchObject({ changed: true, version: 2, invalidatedDerivedArtifacts: 1 })
    expect(duplicate.changed).toBe(false)
    expect(snapshot.facts[0]).toMatchObject({ canonicalText: '用户姓名:小明', object: '小明', predicate: 'profile.name' })
    expect(snapshot.factVersions).toHaveLength(2)
    expect(snapshot.factVersions[0]!.transactionClosedAt).toBeDefined()
    expect(snapshot.factVersions[1]!.transactionClosedAt).toBeUndefined()
    expect(snapshot.derivedArtifacts[0]!.status).toBe('stale')
    expect(snapshot.domainEvents.filter(event => event.idempotencyKey === 'edit-name-1')).toHaveLength(1)
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('supports suppress, restore, delete and irreversible content purge', () => {
    let tick = NOW + 200
    const repository = migratedRepository()
    const factId = repository.snapshot().facts[0]!.id
    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => ++tick })

    expect(lifecycle.deleteFact(factId, scope, 'suppress', { reason: '暂时不使用', idempotencyKey: 'suppress-1' }).changed).toBe(true)
    expect(repository.snapshot().facts[0]!.status).toBe('suppressed')
    expect(repository.snapshot().evidenceLinks.some(link => link.active)).toBe(true)

    lifecycle.restoreFact(factId, scope, { reason: '恢复使用', idempotencyKey: 'restore-1' })
    expect(repository.snapshot().facts[0]!.status).toBe('active')

    const deleted = lifecycle.deleteFact(factId, scope, 'delete', { reason: '删除', idempotencyKey: 'delete-1' })
    expect(deleted.invalidatedEvidence).toBeGreaterThan(0)
    expect(repository.snapshot().facts[0]!.status).toBe('deleted')

    lifecycle.restoreFact(factId, scope, { reason: '撤销删除', idempotencyKey: 'restore-2' })
    const purged = lifecycle.deleteFact(factId, scope, 'purge', { reason: '彻底清除', idempotencyKey: 'purge-1' })
    const snapshot = repository.snapshot()
    expect(purged.purgedEpisodes).toBeGreaterThan(0)
    expect(snapshot.facts[0]).toMatchObject({ status: 'deleted', canonicalText: '[purged]', object: '[purged]' })
    expect(snapshot.facts[0]!.metadata?.v3SourceId).toBe('name')
    expect(snapshot.episodes.every(episode => episode.contentState === 'deleted')).toBe(true)
    expect(snapshot.episodes.every(episode => episode.content === undefined && episode.contentHash === undefined)).toBe(true)
    expect(snapshot.episodes.every(episode => episode.sourceMessageId === undefined && episode.sourceAttachmentIds.length === 0)).toBe(true)
    expect(snapshot.factVersions.every(version => version.canonicalText === '[purged]' && version.object === '[purged]')).toBe(true)
    expect(JSON.stringify(snapshot.legacyImports)).not.toContain('用户姓名')
    expect(() => lifecycle.restoreFact(factId, scope, { reason: '不可恢复', idempotencyKey: 'restore-purged' }))
      .toThrow('cannot be restored')
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('unlinks evidence and orphans unsupported automatic facts while preserving manual facts', () => {
    let tick = NOW + 300
    const automatic = v3Item({ id: 'auto', origin: 'automatic', sourceMessageIds: ['message-auto'] })
    const manual = v3Item({ id: 'manual', origin: 'manual', sourceMessageIds: ['message-manual'] })
    const migrated = migrateV3PayloadToV4(JSON.stringify({ version: 3, items: [automatic, manual] }), { now: () => NOW })
    // The shadow capture normally upgrades these references to direct evidence; activate for lifecycle testing.
    for (const link of migrated.evidenceLinks)
      link.active = true
    migrated.facts[0]!.status = 'active'
    migrated.facts[0]!.verificationState = 'pending'
    migrated.factVersions[0]!.status = 'active'
    for (const fact of migrated.facts) {
      if (fact.status === 'active')
        fact.evidenceScore = 1
    }
    const repository = createMemoryV4Repository({ now: () => ++tick })
    repository.replace(migrated)
    const lifecycle = createMemoryV4LifecycleService(repository, { now: () => ++tick })
    const autoEpisode = repository.snapshot().episodes.find(episode => episode.sourceMessageId === 'message-auto')!
    const result = lifecycle.unlinkEpisodes([autoEpisode.id], scope, { reason: '源聊天被删除', idempotencyKey: 'unlink-auto' })
    expect(result).toMatchObject({ changed: true, orphanedFacts: 0 })
    // The legacy derived record remains supporting evidence; removing all automatic evidence causes orphaning.
    const autoFactId = repository.snapshot().legacyImports.find(item => item.sourceItemId === 'auto')!.factId
    const autoFact = repository.snapshot().facts.find(fact => fact.id === autoFactId)!
    const remaining = repository.snapshot().evidenceLinks.filter(link => link.factId === autoFact.id && link.active).map(link => link.episodeId)
    const second = lifecycle.unlinkEpisodes(remaining, scope, { reason: '删除全部来源', idempotencyKey: 'unlink-auto-rest' })
    expect(second.orphanedFacts).toBe(1)
    expect(repository.snapshot().facts.find(fact => fact.id === autoFact.id)!.status).toBe('orphaned')
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })
})

function migratedRepository() {
  const repository = createMemoryV4Repository({ now: () => NOW + 1 })
  const migrated = migrateV3PayloadToV4(JSON.stringify({ version: 3, items: [v3Item({})] }), { now: () => NOW })
  repository.replace(migrated)
  return repository
}

function v3Item(overrides: Record<string, unknown>) {
  return {
    id: 'name', content: '用户姓名：小秦', status: 'active', scope,
    createdAt: NOW - 10, updatedAt: NOW - 10, metadata: { kind: 'identity', cardinality: 'single' },
    origin: 'manual', importance: 1, confidence: 1, accessCount: 0,
    memoryKey: 'profile.name', sourceMessageIds: [], sourceAttachmentIds: [],
    sharePolicy: 'allow-remote', sensitivity: 'normal', embedding: [1], embeddingModel: 'test',
    ...overrides,
  }
}
