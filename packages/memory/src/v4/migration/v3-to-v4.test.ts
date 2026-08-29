import { describe, expect, it, vi } from 'vitest'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createMemoryV4ShadowRetriever } from '../retrieval/memory-v4-shadow-retriever'
import { migrateV3PayloadToV4, migrateV3SourceIntoV4 } from './v3-to-v4'

const MIGRATION_TIME = 1_800_000_000_000

function v3Payload() {
  return JSON.stringify({
    version: 3,
    items: [
      {
        id: 'memory-name',
        content: '用户姓名/名字：小秦',
        metadata: { kind: 'identity', cardinality: 'single', custom: { preserved: true } },
        status: 'active',
        origin: 'manual',
        importance: 0.9,
        confidence: 0.95,
        accessCount: 7,
        lastAccessedAt: 1_750_000_000_000,
        validFrom: 1_700_000_000_000,
        memoryKey: 'profile.name',
        sourceMessageIds: [],
        sourceAttachmentIds: [],
        sharePolicy: 'allow-remote',
        sensitivity: 'normal',
        scope: { ownerId: 'local-user', agentId: 'deskpet' },
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: 'local-hash-v2',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_710_000_000_000,
      },
      {
        id: 'memory-project',
        content: '用户当前项目：DeskPet',
        metadata: { kind: 'project', cardinality: 'single' },
        status: 'superseded',
        origin: 'automatic',
        importance: 0.7,
        confidence: 0.88,
        accessCount: 2,
        validFrom: 1_600_000_000_000,
        validTo: 1_650_000_000_000,
        invalidatedAt: 1_650_000_000_100,
        memoryKey: 'project.current',
        sourceMessageIds: ['message-1', 'message-1'],
        sourceAttachmentIds: ['image-hash-1'],
        sharePolicy: 'local-only',
        sensitivity: 'private',
        scope: { ownerId: 'local-user', agentId: 'deskpet', sessionId: 'session-a' },
        embedding: [0.9, 0.8],
        embeddingModel: 'Xenova/bge-small-zh-v1.5@revision',
        createdAt: 1_600_000_000_000,
        updatedAt: 1_650_000_000_100,
        unknownFutureField: { keep: ['yes', 1] },
      },
    ],
  })
}

describe('V3 to V4 migration', () => {
  it('preserves every V3 record and creates traceable V4 facts', () => {
    const payload = v3Payload()
    const migrated = migrateV3PayloadToV4(payload, { now: () => MIGRATION_TIME })

    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.facts).toHaveLength(2)
    expect(migrated.legacyImports).toHaveLength(2)
    expect(migrated.factVersions).toHaveLength(2)
    expect(migrated.migrationManifests[0]?.sourceItemCount).toBe(2)
    expect(migrated.migrationManifests[0]?.mappings).toHaveLength(2)

    const original = JSON.parse(payload) as { items: unknown[] }
    expect(migrated.legacyImports.map(item => item.raw)).toEqual(original.items)

    const manual = migrated.facts.find(item => item.memoryKey === 'profile.name')!
    expect(manual.userConfirmed).toBe(true)
    expect(manual.verificationState).toBe('verified')
    expect(manual.accessCount).toBe(7)
    expect(manual.evidenceLinkIds).toHaveLength(1)

    const automatic = migrated.facts.find(item => item.memoryKey === 'project.current')!
    expect(automatic.status).toBe('superseded')
    expect(automatic.validTo).toBe(1_650_000_000_000)
    expect(automatic.verificationState).toBe('legacy-unverified')
    expect(automatic.evidenceLinkIds).toHaveLength(3)
    expect(migrated.episodes.filter(item => item.sourceMessageId === 'message-1')).toHaveLength(1)
    expect(migrated.migrationManifests[0]?.warnings).toHaveLength(1)
  })

  it('quarantines active automatic V3 facts until their evidence is re-verified', () => {
    const payload = JSON.stringify({
      version: 3,
      items: [{
        id: 'automatic-active', content: '用户喜欢茶', status: 'active', origin: 'automatic',
        scope: { ownerId: 'owner', agentId: 'agent' }, sourceMessageIds: ['message-a'],
        sourceAttachmentIds: [], embedding: [], embeddingModel: 'local-hash-v2',
        createdAt: 1000, updatedAt: 1001,
      }],
    })
    const migrated = migrateV3PayloadToV4(payload, { now: () => MIGRATION_TIME })
    expect(migrated.facts[0]?.status).toBe('quarantined')
    expect(migrated.facts[0]?.verificationState).toBe('legacy-unverified')
  })

  it('infers an unambiguous key for legacy manual facts and makes them V4-readable', () => {
    const payload = JSON.stringify({
      version: 3,
      items: [{
        id: 'legacy-manual-name', content: '用户姓名：小秦', metadata: { kind: 'identity', cardinality: 'single' },
        status: 'active', origin: 'manual', importance: 0.9, confidence: 1, accessCount: 0,
        sourceMessageIds: [], sourceAttachmentIds: [], sharePolicy: 'allow-remote', sensitivity: 'normal',
        scope: { ownerId: 'local-user', agentId: 'deskpet' }, embedding: [], embeddingModel: 'local-hash-v2',
        createdAt: 1000, updatedAt: 1001,
      }],
    })
    const migrated = migrateV3PayloadToV4(payload, { now: () => MIGRATION_TIME })
    expect(migrated.facts[0]?.memoryKey).toBe('profile.name')
    const repository = createMemoryV4Repository({ now: () => MIGRATION_TIME })
    repository.replace(migrated)

    const recalled = createMemoryV4ShadowRetriever(repository, { now: () => MIGRATION_TIME })
      .recall('我叫什么名字？', {
        scope: { ownerId: 'local-user', agentId: 'deskpet' },
        sharePolicies: ['allow-remote'],
        sensitivities: ['normal'],
        limit: 3,
      })

    expect(recalled.abstention?.abstained).toBe(false)
    expect(recalled.hits.map(hit => hit.sourceMemoryId)).toEqual(['legacy-manual-name'])
  })

  it('uses conservative privacy defaults for missing or damaged V3 fields', () => {
    const payload = JSON.stringify({
      version: 3,
      items: [{
        id: 'privacy-unknown', content: '用户的敏感偏好', status: 'active', origin: 'automatic',
        scope: { ownerId: 'owner', agentId: 'agent' }, sourceMessageIds: [],
        sourceAttachmentIds: [], embedding: [], embeddingModel: 'local-hash-v2',
        sharePolicy: 'unexpected', sensitivity: 'unexpected', createdAt: 1000, updatedAt: 1001,
      }],
    })
    const migrated = migrateV3PayloadToV4(payload, { now: () => MIGRATION_TIME })
    expect(migrated.facts[0]).toMatchObject({ sharePolicy: 'local-only', sensitivity: 'private' })
    expect(migrated.episodes[0]).toMatchObject({ sharePolicy: 'local-only', sensitivity: 'private' })
    expect(migrated.migrationManifests[0]?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('restricted to local-only'),
      expect.stringContaining('classified as private'),
    ]))
  })

  it('produces stable record ids for the same payload', () => {
    const first = migrateV3PayloadToV4(v3Payload(), { now: () => MIGRATION_TIME })
    const second = migrateV3PayloadToV4(v3Payload(), { now: () => MIGRATION_TIME + 1 })
    expect(second.facts.map(item => item.id)).toEqual(first.facts.map(item => item.id))
    expect(second.evidenceLinks.map(item => item.id)).toEqual(first.evidenceLinks.map(item => item.id))
    expect(second.migrationManifests[0]?.id).toBe(first.migrationManifests[0]?.id)
  })

  it('reads the V3 source without modifying it and is idempotent', () => {
    const payload = v3Payload()
    const load = vi.fn(() => payload)
    const target = createMemoryV4Repository({ now: () => MIGRATION_TIME })

    const first = migrateV3SourceIntoV4({ load }, target, { now: () => MIGRATION_TIME })
    const second = migrateV3SourceIntoV4({ load }, target, { now: () => MIGRATION_TIME + 10 })

    expect(first.migrated).toBe(true)
    expect(second.migrated).toBe(false)
    expect(load).toHaveBeenCalledTimes(2)
    expect(target.snapshot().facts).toHaveLength(2)
    expect(target.snapshot().revision).toBe(0)
  })

  it('refreshes only a migration-only shadow target when V3 changes', () => {
    let payload = v3Payload()
    const target = createMemoryV4Repository({ now: () => MIGRATION_TIME })
    migrateV3SourceIntoV4({ load: () => payload }, target, {
      now: () => MIGRATION_TIME,
      refreshMigrationOnlyTarget: true,
    })
    const parsed = JSON.parse(payload) as { version: 3; items: unknown[] }
    parsed.items = parsed.items.slice(0, 1)
    payload = JSON.stringify(parsed)

    const refreshed = migrateV3SourceIntoV4({ load: () => payload }, target, {
      now: () => MIGRATION_TIME + 10,
      refreshMigrationOnlyTarget: true,
    })

    expect(refreshed.migrated).toBe(true)
    expect(target.snapshot().facts).toHaveLength(1)
    expect(target.snapshot().legacyImports).toHaveLength(1)
    expect(target.snapshot().revision).toBe(1)
  })

  it('refuses to refresh a target after native V4 data exists', () => {
    let payload = v3Payload()
    const target = createMemoryV4Repository({ now: () => MIGRATION_TIME })
    migrateV3SourceIntoV4({ load: () => payload }, target, {
      now: () => MIGRATION_TIME,
      refreshMigrationOnlyTarget: true,
    })
    target.transaction((draft) => {
      draft.retrievalEvents.push({
        id: 'native-event', scope: { ownerId: 'owner', agentId: 'agent' },
        queryHash: 'query', queryType: 'test', retrievedFactIds: [], injectedFactIds: [],
        adoptedFactIds: [], correctedFactIds: [], deniedFactIds: [], createdAt: MIGRATION_TIME,
        retrievalVersion: 'v4-native',
      })
    })
    const parsed = JSON.parse(payload) as { version: 3; items: unknown[] }
    parsed.items = parsed.items.slice(0, 1)
    payload = JSON.stringify(parsed)

    expect(() => migrateV3SourceIntoV4({ load: () => payload }, target, {
      now: () => MIGRATION_TIME + 10,
      refreshMigrationOnlyTarget: true,
    })).toThrow('not empty')
    expect(target.snapshot().retrievalEvents).toHaveLength(1)
  })

  it('does not publish a partial migration when target persistence fails', () => {
    const target = createMemoryV4Repository({
      persistence: {
        load: () => undefined,
        save: () => { throw new Error('simulated disk failure') },
      },
      now: () => MIGRATION_TIME,
    })
    expect(() => migrateV3SourceIntoV4(
      { load: () => v3Payload() },
      target,
      { now: () => MIGRATION_TIME },
    )).toThrow('simulated disk failure')
    expect(target.snapshot().facts).toEqual([])
    expect(target.snapshot().migrationManifests).toEqual([])
  })

  it('rejects malformed V3 input instead of dropping records', () => {
    expect(() => migrateV3PayloadToV4(JSON.stringify({ version: 2, items: [] })))
      .toThrow('requires a version 3 snapshot')
    expect(() => migrateV3PayloadToV4(JSON.stringify({
      version: 3,
      items: [{ id: 'bad', content: 'bad' }],
    }))).toThrow('has no valid scope')
  })
})
