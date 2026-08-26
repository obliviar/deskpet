import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createMemoryConsolidationService } from '../consolidation/memory-consolidation-service'
import { migrateV3PayloadToV4 } from '../migration/v3-to-v4'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import {
  createMemoryV4ShadowRetriever,
  createV3V4ShadowComparator,
} from './memory-v4-shadow-retriever'

const NOW = Date.UTC(2026, 7, 24)
const scope = { ownerId: 'shadow-user', agentId: 'deskpet' }

function v3Item(
  id: string,
  content: string,
  memoryKey: string,
  patch: Record<string, unknown> = {},
) {
  return {
    id,
    content,
    metadata: { kind: memoryKey.split('.')[0], cardinality: 'single' },
    status: 'active',
    origin: 'manual',
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    memoryKey,
    sourceMessageIds: [`source-${id}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope: { ...scope, sessionId: 'session-a' },
    embedding: [],
    embeddingModel: 'local-hash-v3',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...patch,
  }
}

async function seedRepository() {
  const payload = JSON.stringify({
    version: 3,
    items: [
      v3Item('coffee', '用户喜欢喝手冲咖啡', 'preference.drink'),
      v3Item('name', '用户姓名/名字：小秦', 'profile.name'),
      v3Item('secret', '用户的私人备注：不可外发', 'profile.note', {
        sharePolicy: 'local-only', sensitivity: 'private',
      }),
      v3Item('old-project', '用户以前的项目：OldDesk', 'project.current', {
        status: 'superseded',
        validFrom: Date.UTC(2024, 0, 1),
        validTo: Date.UTC(2025, 0, 1),
        invalidatedAt: Date.UTC(2025, 0, 2),
        createdAt: Date.UTC(2024, 0, 1),
        updatedAt: Date.UTC(2025, 0, 2),
      }),
    ],
  })
  const repository = createMemoryV4Repository({ now: () => NOW })
  repository.replace(migrateV3PayloadToV4(payload, { now: () => NOW }))
  await createMemoryConsolidationService(repository).consolidate(scope, {
    granularity: ['session', 'day', 'topic', 'entity', 'stage'],
  })
  return repository
}

describe('Memory V4 read-only shadow retrieval', () => {
  it('uses hierarchical summaries for down-drill and keeps restricted facts local', async () => {
    const repository = await seedRepository()
    const revisionBefore = repository.snapshot().revision
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const recalled = retriever.recall('我平时喝什么？', {
      scope,
      sharePolicies: ['allow-remote'],
      sensitivities: ['normal'],
      limit: 3,
    })

    expect(recalled.hits[0]).toMatchObject({ sourceMemoryId: 'coffee' })
    expect(recalled.hits.map(hit => hit.sourceMemoryId)).toEqual(['coffee'])
    expect(recalled.abstention?.abstained).toBe(false)
    expect(recalled.hits[0]?.routes).toContain('summary-down-drill')
    expect(recalled.hits[0]?.summaryIds.length).toBeGreaterThan(0)
    expect(recalled.hits.some(hit => hit.sourceMemoryId === 'secret')).toBe(false)
    expect(recalled.privacyFiltered).toBeGreaterThan(0)
    expect(recalled.index.summaries).toBeGreaterThanOrEqual(6)
    // A shadow read must not append events, usage counters or revisions.
    expect(repository.snapshot().revision).toBe(revisionBefore)
  })

  it('keeps historical facts out of current recall and retrieves them for explicit history queries', async () => {
    const repository = await seedRepository()
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const current = retriever.recall('我现在做什么项目？', { scope, limit: 5 })
    expect(current.hits).toEqual([])
    expect(current.abstention?.abstained).toBe(true)

    const historical = retriever.recall('我以前做过什么项目？', { scope, limit: 5 })
    expect(historical.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMemoryId: 'old-project', status: 'superseded' }),
    ]))
  })

  it('returns no memories when the requested fact is filtered or no relevant fact exists', async () => {
    const repository = await seedRepository()
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const privateNote = retriever.recall('我的私人备注是什么？', {
      scope,
      sharePolicies: ['allow-remote'],
      sensitivities: ['normal'],
      limit: 5,
    })
    expect(privateNote.privacyFiltered).toBeGreaterThan(0)
    expect(privateNote.hits).toEqual([])
    expect(privateNote.abstention?.abstained).toBe(true)

    const absentDoorCode = retriever.recall('我的门禁码是多少？', { scope, limit: 5 })
    expect(absentDoorCode.hits).toEqual([])
    expect(absentDoorCode.abstention?.abstained).toBe(true)

    const weather = retriever.recall('明天会不会下雨？', { scope, limit: 5 })
    expect(weather.queryIntent).toBe('external')
    expect(weather.routes).toEqual([])
    expect(weather.hits).toEqual([])
  })

  it('keeps exact lexical facts retrievable without relying on a known semantic field', async () => {
    const payload = JSON.stringify({
      version: 3,
      items: [v3Item('door', '用户的门禁码：2468', 'private.door-code')],
    })
    const repository = createMemoryV4Repository({ now: () => NOW })
    repository.replace(migrateV3PayloadToV4(payload, { now: () => NOW }))
    await createMemoryConsolidationService(repository).consolidate(scope, { granularity: ['session', 'day'] })
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const recalled = retriever.recall('我的门禁码是多少？', { scope, limit: 5 })
    expect(recalled.hits.map(hit => hit.sourceMemoryId)).toEqual(['door'])
    expect(recalled.hits[0]?.routes).toContain('fact-lexical')
    expect(recalled.abstention).toMatchObject({
      abstained: false,
      version: 'memory-v4-local-calibration-v1:deskpet-v4-local-synthetic-calibration-v1',
    })
  })

  it('retrieves each independently supported fact for a multi-fact query', async () => {
    const repository = await seedRepository()
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const recalled = retriever.recall('我的姓名和饮品偏好分别是什么？', { scope, limit: 5 })
    expect(new Set(recalled.hits.map(hit => hit.sourceMemoryId))).toEqual(new Set(['coffee', 'name']))
    expect(recalled.hits.every(hit => hit.score >= (recalled.abstention?.threshold ?? 1))).toBe(true)
  })

  it('rebuilds its derived indexes only when facts or summaries actually change', async () => {
    const repository = await seedRepository()
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })
    retriever.recall('我叫什么？', { scope })
    expect(retriever.indexStatus().rebuildCount).toBe(1)

    // Retrieval telemetry revisions do not change the index signature.
    repository.transaction((draft) => {
      draft.retrievalEvents.push({
        id: 'retrieval-event-1',
        scope: { ownerId: scope.ownerId, agentId: scope.agentId },
        queryHash: 'hash',
        queryType: 'shadow-test',
        retrievedFactIds: [],
        injectedFactIds: [],
        adoptedFactIds: [],
        correctedFactIds: [],
        deniedFactIds: [],
        createdAt: NOW,
        retrievalVersion: 'test',
      })
    })
    retriever.recall('我叫什么？', { scope })
    expect(retriever.indexStatus().rebuildCount).toBe(1)
  })

  it('uses a verified learned embedding for paraphrases while retaining hash fallback', () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    repository.replace(migrateV3PayloadToV4(JSON.stringify({
      version: 3,
      items: [
        v3Item('coffee', '用户偏爱手工冲泡的咖啡', 'custom.fact.coffee'),
        v3Item('shoe', '用户穿四十二码的鞋', 'custom.fact.shoe'),
      ],
    }), { now: () => NOW }))
    const snapshot = repository.snapshot()
    const coffee = snapshot.legacyImports.find(item => item.sourceItemId === 'coffee')!
    const shoe = snapshot.legacyImports.find(item => item.sourceItemId === 'shoe')!
    const factById = new Map(snapshot.facts.map(fact => [fact.id, fact]))
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })
    retriever.replaceSemanticIndex({
      version: 1,
      snapshotRevision: snapshot.revision,
      semanticRevision: 1,
      model: 'verified-bge-test',
      dimension: 2,
      factVectors: [
        semanticEntry(coffee.factId, factById.get(coffee.factId)!.canonicalText, [1, 0]),
        semanticEntry(shoe.factId, factById.get(shoe.factId)!.canonicalText, [0, 1]),
      ],
      summaryVectors: [],
    })

    const recalled = retriever.recall('我钟意哪一种现磨饮品？', {
      scope,
      semanticQuery: { model: 'verified-bge-test', vector: [1, 0] },
      limit: 3,
    })
    expect(recalled.hits[0]).toMatchObject({ sourceMemoryId: 'coffee' })
    expect(recalled.hits[0]?.routes).toContain('fact-semantic-learned')
    expect(recalled.index).toMatchObject({
      semanticModel: 'verified-bge-test',
      semanticDimension: 2,
      semanticFacts: 2,
      semanticQueryUsed: true,
    })
  })

  it('ignores stale learned vectors and safely falls back on a model mismatch', () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    repository.replace(migrateV3PayloadToV4(JSON.stringify({
      version: 3,
      items: [v3Item('coffee', '用户偏爱手工冲泡的咖啡', 'custom.fact.coffee')],
    }), { now: () => NOW }))
    const snapshot = repository.snapshot()
    const factId = snapshot.legacyImports[0]!.factId
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })
    retriever.replaceSemanticIndex({
      version: 1,
      snapshotRevision: snapshot.revision,
      semanticRevision: 1,
      model: 'verified-bge-test',
      dimension: 2,
      factVectors: [{ id: factId, contentHash: '0'.repeat(64), vector: [1, 0] }],
      summaryVectors: [],
    })
    expect(retriever.indexStatus().semanticFacts).toBe(0)

    const recalled = retriever.recall('我钟意哪一种现磨饮品？', {
      scope,
      semanticQuery: { model: 'different-model', vector: [1, 0] },
    })
    expect(recalled.index.semanticQueryUsed).toBe(false)
    expect(recalled.routes).not.toContain('fact-semantic-learned')
  })
})

function semanticEntry(id: string, content: string, vector: number[]) {
  return {
    id,
    contentHash: createHash('sha256').update(content.normalize('NFKC')).digest('hex'),
    vector,
  }
}

describe('V3/V4 shadow comparator', () => {
  it('reports agreement without retaining plaintext queries', async () => {
    const repository = await seedRepository()
    const retriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })
    const recalled = retriever.recall('我喜欢喝什么？', { scope, limit: 3 })
    const sink = { recordComparison: vi.fn(), recordFailure: vi.fn() }
    const comparator = createV3V4ShadowComparator({
      now: () => NOW + 100,
      queryHasher: () => 'a'.repeat(64),
      sink,
    })

    const comparison = comparator.compare('我喜欢喝什么？', ['coffee'], ['coffee'], recalled)
    expect(comparison).toMatchObject({
      overlapCount: 1,
      v3AgreementRecallAtK: 1,
      v3AgreementPrecisionAtK: 1,
      v4Abstained: false,
      v4BestEvidenceScore: recalled.abstention?.bestScore,
      v4AbstentionThreshold: recalled.abstention?.threshold,
      v4AbstentionVersion: 'memory-v4-local-calibration-v1:deskpet-v4-local-synthetic-calibration-v1',
    })
    expect(comparison.queryHash).toBe('a'.repeat(64))
    expect(comparison).toMatchObject({
      queryIntent: recalled.queryIntent,
      snapshotRevision: recalled.snapshotRevision,
      candidateCount: recalled.candidateCount,
    })
    expect(sink.recordComparison).toHaveBeenCalledWith(comparison)
    expect(JSON.stringify(comparator.status())).not.toContain('喜欢喝什么')
  })

  it('isolates failures from comparison aggregates', () => {
    const comparator = createV3V4ShadowComparator({ now: () => NOW })
    comparator.recordFailure('私密查询', new Error('shadow unavailable'))
    expect(comparator.status()).toMatchObject({ comparisons: 0, failures: 1 })
    expect(comparator.status().lastFailure?.queryHash).toMatch(/^[a-f0-9]{64}$/u)
  })
})
