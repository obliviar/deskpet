import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { MemoryFactV4, MemoryV4Snapshot } from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'
import { createMemoryV4ShadowRetriever } from './memory-v4-shadow-retriever'

const NOW = Date.UTC(2026, 7, 25)
const FACT_COUNT = 20_000
const QUERY_COUNT = 12
const scope = { ownerId: 'v4-scale-owner', agentId: 'deskpet' }

describe('Memory V4 sparse retrieval scale', () => {
  it('keeps repeated exact recall bounded across 20,000 active facts', () => {
    const snapshot = scaleSnapshot(FACT_COUNT)
    const repository = {
      readOnly: true,
      snapshot: () => snapshot,
      transaction: () => { throw new Error('read-only stress repository') },
      replace: () => { throw new Error('read-only stress repository') },
    } as unknown as MemoryV4Repository
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    // Exclude the one-time rebuild: production performs it in an isolated
    // worker, while this gate measures steady-state recall latency.
    const warmupId = FACT_COUNT - 1
    expect(retriever.recall(queryFor(warmupId), { scope, limit: 3 }).hits[0]?.sourceMemoryId)
      .toBe(`memory-${warmupId}`)

    const durations: number[] = []
    let maximumCandidates = 0
    for (let iteration = 0; iteration < QUERY_COUNT; iteration++) {
      const target = Math.floor(iteration * (FACT_COUNT - 1) / Math.max(1, QUERY_COUNT - 1))
      const startedAt = performance.now()
      const recalled = retriever.recall(queryFor(target), { scope, limit: 3 })
      durations.push(performance.now() - startedAt)
      maximumCandidates = Math.max(maximumCandidates, recalled.candidateCount)
      expect(recalled.hits[0]?.sourceMemoryId).toBe(`memory-${target}`)
      expect(recalled.hits).toHaveLength(1)
    }

    const p95Milliseconds = percentile(durations, 0.95)
    expect(retriever.indexStatus().facts).toBe(FACT_COUNT)
    expect(maximumCandidates).toBeLessThanOrEqual(48)
    expect(p95Milliseconds).toBeLessThan(100)

    console.info(JSON.stringify({
      stage: 'memory-v4-sparse-retrieval-stress',
      factCount: FACT_COUNT,
      queryCount: QUERY_COUNT,
      maximumCandidates,
      meanMilliseconds: mean(durations),
      p95Milliseconds,
      maxMilliseconds: Math.max(...durations),
      targetP95Milliseconds: 100,
      targetMet: p95Milliseconds < 100,
    }))
  })
})

function scaleSnapshot(count: number): MemoryV4Snapshot {
  return {
    schemaVersion: 4,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    episodes: [],
    candidates: [],
    facts: Array.from({ length: count }, (_, index) => fact(index)),
    evidenceLinks: [],
    factVersions: [],
    derivedArtifacts: [],
    domainEvents: [],
    retrievalEvents: [],
    migrationManifests: [],
    legacyImports: [],
  }
}

function fact(index: number): MemoryFactV4 {
  const code = marker(index)
  return {
    id: `fact-${index}`,
    scope,
    subjectId: 'owner:v4-scale-owner',
    predicate: 'archive.marker',
    object: code,
    objectType: 'string',
    normalizedValue: code,
    canonicalText: `用户保存的唯一归档标记：${code}`,
    memoryKey: `archive.marker.${index}`,
    cardinality: 'single',
    polarity: 'positive',
    modality: 'asserted',
    status: 'active',
    recordedAt: NOW - countOffset(index),
    updatedAt: NOW - countOffset(index),
    evidenceLinkIds: [],
    extractionScore: 1,
    verificationScore: 1,
    evidenceScore: 1,
    utilityScore: 0.8,
    importance: 0.7,
    accessCount: 0,
    userConfirmed: true,
    verificationState: 'verified',
    supersedesFactIds: [],
    conflictsWithFactIds: [],
    sensitivity: 'normal',
    sharePolicy: 'allow-remote',
    origin: 'manual',
    metadata: { v3SourceId: `memory-${index}` },
    extractorVersion: 'v4-scale-test',
    verifierVersion: 'v4-scale-test',
  }
}

function queryFor(index: number): string {
  return `我的归档标记 ${marker(index)} 是什么？`
}

function marker(index: number): string {
  return (Math.imul(index + 1, 2_654_435_761) >>> 0).toString(36).padStart(7, '0')
}

function countOffset(index: number): number {
  return (index % 10_000) + 1
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}
