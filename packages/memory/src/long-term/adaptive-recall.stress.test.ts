import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createVectorStore } from './vector-store'

const ITEM_COUNT = 5000
const NOW = 1_800_000_000_000

describe('adaptive recall scale', () => {
  it(`ranks ${ITEM_COUNT.toLocaleString()} records once and injects only the bounded selection`, async () => {
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
    const startedAt = performance.now()

    const result = await store.recallAdaptive(
      '总结你记得的关于我的信息',
      { ownerId: 'stress-owner', agentId: 'deskpet' },
    )
    const elapsedMilliseconds = performance.now() - startedAt

    expect(queryEmbeddings).toBe(1)
    expect(result.candidateCount).toBeLessThanOrEqual(20)
    expect(result.evaluatedCount).toBeLessThanOrEqual(12)
    expect(result.memories.length).toBeLessThanOrEqual(10)
    expect(result.memories.length).toBeGreaterThan(1)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]!.upserts).toHaveLength(result.memories.length)
    expect(elapsedMilliseconds).toBeLessThan(5000)

    console.info(JSON.stringify({
      stage: 'adaptive-memory-recall-stress',
      itemCount: ITEM_COUNT,
      candidateCount: result.candidateCount,
      evaluatedCount: result.evaluatedCount,
      injectedCount: result.memories.length,
      batchesEvaluated: result.batchesEvaluated,
      stopReason: result.stopReason,
      elapsedMilliseconds: Math.round(elapsedMilliseconds),
    }))
  }, 15_000)
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
