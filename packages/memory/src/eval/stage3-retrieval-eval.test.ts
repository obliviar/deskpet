import type { MemoryRecallOptions, MemoryTemporalMode } from '@deskpet/contracts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createVectorStore } from '../long-term/vector-store'
import { runMemoryStage3RetrievalEval, type MemoryStage3RetrievalEvalCase } from './stage3-retrieval-eval'

interface RetrievalFixture {
  datasetVersion: string
  facts: Array<{
    key: string
    content: string
    kind: string
    importance?: number
    memoryKey?: string
    validFrom?: string
    suppressAfterWrite?: boolean
  }>
  cases: Array<{
    id: string
    category: string
    query: string
    relevantKeys: string[]
    temporalMode?: MemoryTemporalMode
  }>
}

describe('stage 3 mainstream retrieval evaluation', () => {
  it('compares hybrid RRF with the rollback linear baseline on long-memory dimensions', async () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../evals/memory/stage3-retrieval-dev-v1.json', import.meta.url)), 'utf-8')) as RetrievalFixture
    const cases: MemoryStage3RetrievalEvalCase[] = fixture.cases.map(testCase => ({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      relevantKeys: testCase.relevantKeys,
      ...(testCase.temporalMode ? { options: { temporalMode: testCase.temporalMode } } : {}),
    }))
    const rrf = await evaluateStrategy('rrf-v1', fixture, cases)
    const linear = await evaluateStrategy('weighted-linear-v1', fixture, cases)

    console.info(JSON.stringify({
      stage: 'memory-stage3-retrieval-dev-eval',
      note: 'repository-visible development set; not an external blind result',
      rrf,
      linear,
    }))

    expect(rrf.recallAtK).toBeGreaterThanOrEqual(0.9)
    expect(rrf.top1Accuracy).toBeGreaterThanOrEqual(0.85)
    expect(rrf.abstentionAccuracy).toBe(1)
    expect(rrf.byCategory.temporal?.top1Accuracy).toBeGreaterThanOrEqual(0.8)
    expect(rrf.recallAtK).toBeGreaterThanOrEqual(linear.recallAtK)
    expect(rrf.top1Accuracy).toBeGreaterThanOrEqual(linear.top1Accuracy)
  }, 30_000)
})

async function evaluateStrategy(
  retrievalFusion: 'rrf-v1' | 'weighted-linear-v1',
  fixture: RetrievalFixture,
  cases: readonly MemoryStage3RetrievalEvalCase[],
) {
  const store = createVectorStore({ retrievalFusion })
  const scope = { ownerId: `stage3-eval-${retrievalFusion}`, agentId: 'deskpet' }
  for (const fact of fixture.facts) {
    const metadata: Record<string, unknown> = {
      evalKey: fact.key,
      kind: fact.kind,
      importance: fact.importance ?? 0.85,
      confidence: 0.95,
      ...(fact.memoryKey ? { memoryKey: fact.memoryKey, cardinality: 'single' } : {}),
      ...(fact.validFrom ? { validFrom: Date.parse(fact.validFrom) } : {}),
    }
    const remembered = await store.remember(fact.content, scope, metadata)
    if (fact.suppressAfterWrite && remembered)
      await store.update(remembered.id, scope, { status: 'suppressed' })
  }
  for (let index = 0; index < 250; index++) {
    await store.remember(`归档干扰记录 ${index}：通用事项编号 noise-${index}`, scope, {
      evalKey: `noise-${index}`, kind: `noise-${index % 17}`, importance: 0.2, confidence: 0.7,
    })
  }

  return runMemoryStage3RetrievalEval(
    cases,
    (query: string, topK: number, options?: MemoryRecallOptions) => store.recall(query, scope, topK, options),
    { datasetVersion: fixture.datasetVersion, topK: 5 },
  )
}
