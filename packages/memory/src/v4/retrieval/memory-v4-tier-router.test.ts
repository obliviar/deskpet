import { describe, expect, it } from 'vitest'
import type { MemoryFactStatusV4, MemoryFactV4 } from '../domain/types'
import { createEmptyMemoryV4Snapshot } from '../repository/memory-v4-repository'
import {
  memoryV4TierSearchIds,
  routeMemoryV4Tiers,
} from './memory-v4-tier-router'

const NOW = 1_800_000_000_000
const scope = { ownerId: 'tier-route-user', agentId: 'deskpet' }

describe('Memory V4 tier router', () => {
  it('keeps cold dormant for an ordinary query and excludes quarantine before candidate generation', () => {
    const snapshot = tieredSnapshot()
    const eligible = new Set(snapshot.facts.map(fact => fact.id))
    const route = routeMemoryV4Tiers(snapshot, {
      scope,
      eligibleFactIds: eligible,
      intent: 'specific',
      temporalMode: 'current',
      candidateBudget: 24,
    })

    expect(route.coldPolicy).toBe('fallback')
    expect(route.candidateBudgets).toEqual({ hot: 8, warm: 16, cold: 8 })
    expect(memoryV4TierSearchIds(route)).toEqual(new Set(['hot', 'warm', 'unassigned']))
    expect(route.tiers.cold).toEqual(['cold', 'historical'])
    expect(route.quarantineFactIds).toEqual(['quarantine'])
    expect(route.unassignedFactIds).toEqual(['unassigned'])
  })

  it('eagerly opens a bounded cold lane for timeline and history navigation', () => {
    const snapshot = tieredSnapshot()
    const route = routeMemoryV4Tiers(snapshot, {
      scope,
      eligibleFactIds: new Set(snapshot.facts.map(fact => fact.id)),
      intent: 'timeline',
      temporalMode: 'all',
      candidateBudget: 64,
    })

    expect(route.coldPolicy).toBe('eager')
    expect(Object.values(route.candidateBudgets).reduce((sum, value) => sum + value, 0)).toBe(64)
    expect(memoryV4TierSearchIds(route)).toEqual(new Set(['hot', 'warm', 'unassigned', 'cold', 'historical']))
  })

  it('fails open through warm when the rebuildable assignment is stale', () => {
    const snapshot = tieredSnapshot()
    snapshot.derivedArtifacts[0]!.status = 'stale'
    const active = snapshot.facts.filter(fact => fact.status === 'active').map(fact => fact.id)
    const route = routeMemoryV4Tiers(snapshot, {
      scope,
      eligibleFactIds: new Set(active),
      intent: 'specific',
      temporalMode: 'current',
      candidateBudget: 24,
    })

    expect(route.assignmentVersion).toBeUndefined()
    expect(route.tiers.warm).toEqual(active.sort())
    expect(route.unassignedFactIds).toEqual(active.sort())
  })
})

function tieredSnapshot() {
  const snapshot = createEmptyMemoryV4Snapshot(NOW)
  snapshot.facts = [
    fact('hot'), fact('warm'), fact('cold'), fact('quarantine'), fact('unassigned'),
    fact('historical', 'superseded'),
  ]
  snapshot.derivedArtifacts.push({
    id: 'tier-index', scope, kind: 'tier-index', status: 'current',
    sourceEpisodeIds: [], sourceFactIds: ['hot', 'warm', 'cold', 'quarantine'],
    content: JSON.stringify({
      version: 'tier-test-v1', generatedAt: NOW,
      tiers: { hot: ['hot'], warm: ['warm'], cold: ['cold'], quarantine: ['quarantine'] },
      utilities: {},
    }),
    createdAt: NOW, updatedAt: NOW, builderVersion: 'tier-test-v1',
  })
  return snapshot
}

function fact(id: string, status: MemoryFactStatusV4 = 'active'): MemoryFactV4 {
  return {
    id, scope, subjectId: 'user', predicate: id, object: id, objectType: 'string', normalizedValue: id,
    canonicalText: `用户事实 ${id}`, memoryKey: `test.${id}`, cardinality: 'single', polarity: 'positive',
    modality: 'asserted', status, recordedAt: NOW, updatedAt: NOW, evidenceLinkIds: [],
    extractionScore: 1, verificationScore: 1, evidenceScore: 1, utilityScore: 0.5,
    importance: 0.5, accessCount: 0, userConfirmed: false, verificationState: 'verified',
    supersedesFactIds: [], conflictsWithFactIds: [], sensitivity: 'normal', sharePolicy: 'allow-remote',
    origin: 'manual', extractorVersion: 'test', verifierVersion: 'test',
  }
}
