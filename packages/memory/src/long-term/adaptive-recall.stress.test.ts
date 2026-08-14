import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createVectorStore } from './vector-store'

const ITEM_COUNT = 20_000
const QUERY_COUNT = 12
const NOW = 1_800_000_000_000

describe('adaptive recall scale', () => {
  it(`keeps ${ITEM_COUNT.toLocaleString()}-record repeated recall bounded and reports P95`, async () => {
    const deltas: Array<{ upserts: unknown[] }> = []
    let queryEmbeddings = 0
    const store = createVectorStore({
      persistence: {
        load: () => JSON.stringify({
          version: 3,
          items: Array.from({ length: ITEM_COUNT }, (_, index) => persistedItem(index)),
        }),
        save: () => undefined,
        appendDelta: delta => deltas.push(delta),
      },
      embeddingModel: 'adaptive-stress',
      minScore: 0.1,
      minSemanticScore: 0.1,
      embedder: async () => {
        queryEmbeddings += 1
        return [1, 0, 0]
      },
    })
    const latencies: number[] = []
    let result: Awaited<ReturnType<typeof store.recallAdaptive>> | undefined
    for (let index = 0; index < QUERY_COUNT; index++) {
      const startedAt = performance.now()
      result = await store.recallAdaptive(
        '总结你记得的关于我的信息',
        { ownerId: 'stress-owner', agentId: 'deskpet' },
      )
      latencies.push(performance.now() - startedAt)
    }
    const orderedLatencies = [...latencies].sort((left, right) => left - right)
    const p95Milliseconds = orderedLatencies[Math.ceil(orderedLatencies.length * 0.95) - 1] ?? 0

    expect(queryEmbeddings).toBe(QUERY_COUNT)
    expect(result).toBeDefined()
    expect(result!.candidateCount).toBeLessThanOrEqual(80)
    expect(result!.evaluatedCount).toBeLessThanOrEqual(64)
    expect(result!.memories.length).toBeLessThanOrEqual(10)
    expect(result!.memories.length).toBeGreaterThan(1)
    expect(deltas).toHaveLength(QUERY_COUNT)
    expect(deltas.every(delta => delta.upserts.length === result!.memories.length)).toBe(true)
    expect(p95Milliseconds).toBeLessThan(100)

    console.info(JSON.stringify({
      stage: 'adaptive-memory-recall-stress',
      itemCount: ITEM_COUNT,
      queryCount: QUERY_COUNT,
      candidateCount: result!.candidateCount,
      evaluatedCount: result!.evaluatedCount,
      injectedCount: result!.memories.length,
      batchesEvaluated: result!.batchesEvaluated,
      stopReason: result!.stopReason,
      queryIntent: result!.queryIntent,
      candidateBudget: result!.candidateBudget,
      retrievalRoutes: result!.retrievalRoutes,
      routeCandidateCounts: result!.routeCandidateCounts,
      fusionMethod: result!.fusionMethod,
      meanMilliseconds: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      p95Milliseconds: Math.round(p95Milliseconds),
      maxMilliseconds: Math.round(orderedLatencies.at(-1) ?? 0),
      targetP95Milliseconds: 100,
      targetMet: p95Milliseconds < 100,
    }))
  }, 30_000)
})

function persistedItem(index: number) {
  return {
    id: `stress-memory-${index}`,
    content: `Personal profile fact unique-${index} category-${index % 97}`,
    metadata: { kind: `stress-${index % 31}` },
    status: 'active',
    origin: 'automatic',
    importance: 0.5 + (index % 5) / 10,
    confidence: 0.9,
    accessCount: index % 3,
    sourceMessageIds: [`message-${index}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope: { ownerId: 'stress-owner', agentId: 'deskpet' },
    embedding: [1, (index % 17) / 100, (index % 31) / 100],
    embeddingModel: 'adaptive-stress',
    createdAt: NOW - index,
    updatedAt: NOW - index,
  }
}
