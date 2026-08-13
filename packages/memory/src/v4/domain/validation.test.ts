import { describe, expect, it } from 'vitest'
import { migrateV3PayloadToV4 } from '../migration/v3-to-v4'
import { createEmptyMemoryV4Snapshot } from '../repository/memory-v4-repository'
import { assertMemoryV4Snapshot } from './validation'

const NOW = 1_800_000_000_000

describe('Memory V4 structural and isolation invariants', () => {
  it('rejects evidence and retrieval references crossing owner boundaries', () => {
    const snapshot = migrated([
      v3Item('a', 'owner-a', 'agent'),
      v3Item('b', 'owner-b', 'agent'),
    ])
    snapshot.evidenceLinks[0]!.episodeId = snapshot.evidenceLinks[1]!.episodeId
    expect(() => assertMemoryV4Snapshot(snapshot)).toThrow('crosses owner, agent, or session scope')

    const retrievalSnapshot = migrated([
      v3Item('a', 'owner-a', 'agent'),
      v3Item('b', 'owner-b', 'agent'),
    ])
    retrievalSnapshot.retrievalEvents.push({
      id: 'cross-owner-retrieval', scope: { ownerId: 'owner-a', agentId: 'agent' },
      queryHash: 'hash', queryType: 'test', retrievedFactIds: [retrievalSnapshot.facts[1]!.id],
      injectedFactIds: [], adoptedFactIds: [], correctedFactIds: [], deniedFactIds: [],
      createdAt: NOW, retrievalVersion: 'test',
    })
    expect(() => assertMemoryV4Snapshot(retrievalSnapshot)).toThrow('outside its scope')
  })

  it('rejects version and migration links owned by another fact', () => {
    const versionSnapshot = migrated([
      v3Item('a', 'owner', 'agent'),
      v3Item('b', 'owner', 'agent'),
    ])
    versionSnapshot.factVersions[0]!.evidenceLinkIds = [versionSnapshot.evidenceLinks[1]!.id]
    expect(() => assertMemoryV4Snapshot(versionSnapshot)).toThrow('evidence owned by another fact')

    const mappingSnapshot = migrated([
      v3Item('a', 'owner', 'agent'),
      v3Item('b', 'owner', 'agent'),
    ])
    mappingSnapshot.migrationManifests[0]!.mappings[0]!.versionId = mappingSnapshot.factVersions[1]!.id
    expect(() => assertMemoryV4Snapshot(mappingSnapshot)).toThrow('version to the wrong fact')
  })

  it('rejects invalid enums, non-JSON values, duplicate references and bad chronology', () => {
    const invalidEnum = migrated([v3Item('a', 'owner', 'agent')])
    Object.assign(invalidEnum.facts[0]!, { status: 'invented-status' })
    expect(() => assertMemoryV4Snapshot(invalidEnum)).toThrow('unsupported value')

    const invalidJson = migrated([v3Item('a', 'owner', 'agent')])
    invalidJson.facts[0]!.object = Number.NaN
    expect(() => assertMemoryV4Snapshot(invalidJson)).toThrow('not a JSON value')

    const duplicate = migrated([v3Item('a', 'owner', 'agent')])
    duplicate.facts[0]!.evidenceLinkIds.push(duplicate.facts[0]!.evidenceLinkIds[0]!)
    expect(() => assertMemoryV4Snapshot(duplicate)).toThrow('duplicate reference')

    const chronology = migrated([v3Item('a', 'owner', 'agent')])
    chronology.facts[0]!.validFrom = 200
    chronology.facts[0]!.validTo = 100
    expect(() => assertMemoryV4Snapshot(chronology)).toThrow('validTo precedes validFrom')
  })

  it('rejects supersession cycles and cross-owner relationships', () => {
    const cycle = migrated([
      v3Item('a', 'owner', 'agent'),
      v3Item('b', 'owner', 'agent'),
    ])
    cycle.facts[0]!.supersedesFactIds = [cycle.facts[1]!.id]
    cycle.facts[1]!.supersedesFactIds = [cycle.facts[0]!.id]
    expect(() => assertMemoryV4Snapshot(cycle)).toThrow('contains a cycle')

    const crossOwner = migrated([
      v3Item('a', 'owner-a', 'agent'),
      v3Item('b', 'owner-b', 'agent'),
    ])
    crossOwner.facts[0]!.conflictsWithFactIds = [crossOwner.facts[1]!.id]
    expect(() => assertMemoryV4Snapshot(crossOwner)).toThrow('outside its owner or agent scope')
  })

  it('allows owner-wide facts to aggregate evidence from one of their sessions', () => {
    const snapshot = migrated([v3Item('a', 'owner', 'agent')])
    snapshot.episodes[0]!.scope.sessionId = 'session-a'
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('validates a 12,000-version supersession chain without overflowing the call stack', () => {
    const snapshot = createEmptyMemoryV4Snapshot(NOW)
    for (let index = 0; index < 12_000; index++) {
      snapshot.facts.push({
        id: `fact-${index}`,
        scope: { ownerId: 'owner', agentId: 'agent' },
        subjectId: 'owner:owner', predicate: 'history.item', object: index,
        objectType: 'number', normalizedValue: index,
        canonicalText: `history-${index}`, memoryKey: `history.${index}`,
        cardinality: 'multiple', polarity: 'unknown', modality: 'asserted', status: 'archived',
        recordedAt: 1000 + index, updatedAt: 1000 + index, evidenceLinkIds: [],
        extractionScore: 1, verificationScore: 1, evidenceScore: 1,
        utilityScore: 0.5, importance: 0.5, accessCount: 0, userConfirmed: false,
        verificationState: 'verified',
        supersedesFactIds: index === 0 ? [] : [`fact-${index - 1}`],
        conflictsWithFactIds: [], sensitivity: 'normal', sharePolicy: 'local-only',
        origin: 'automatic', extractorVersion: 'stress', verifierVersion: 'stress',
      })
      snapshot.factVersions.push({
        id: `version-${index}`, factId: `fact-${index}`, version: 1,
        operation: 'ADD', subjectId: 'owner:owner', predicate: 'history.item', object: index,
        objectType: 'number', normalizedValue: index, canonicalText: `history-${index}`,
        polarity: 'unknown', modality: 'asserted', status: 'archived',
        evidenceLinkIds: [], recordedAt: 1000 + index, reason: 'stress history',
      })
    }
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('requires unique and current fact version history', () => {
    const duplicate = migrated([v3Item('a', 'owner', 'agent')])
    duplicate.factVersions.push({ ...duplicate.factVersions[0]!, id: 'duplicate-version-id' })
    expect(() => assertMemoryV4Snapshot(duplicate)).toThrow('duplicate version number')

    const stale = migrated([v3Item('a', 'owner', 'agent')])
    stale.factVersions[0]!.canonicalText = 'stale-version-text'
    expect(() => assertMemoryV4Snapshot(stale)).toThrow('does not match its latest version')
  })
})

function migrated(items: ReturnType<typeof v3Item>[]) {
  return migrateV3PayloadToV4(JSON.stringify({ version: 3, items }), { now: () => NOW })
}

function v3Item(id: string, ownerId: string, agentId: string) {
  return {
    id,
    content: `memory-${id}`,
    status: 'active',
    origin: 'manual',
    scope: { ownerId, agentId },
    sourceMessageIds: [],
    sourceAttachmentIds: [],
    embedding: [],
    embeddingModel: 'test',
    createdAt: 1000,
    updatedAt: 1000,
  }
}
