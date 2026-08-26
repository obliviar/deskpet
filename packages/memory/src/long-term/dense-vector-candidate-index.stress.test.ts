import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { createDenseVectorCandidateIndex } from './dense-vector-candidate-index'

const VECTOR_COUNT = 20_000
const BGE_DIMENSION = 512
const QUERY_COUNT = 12

describe('dense learned-vector candidate index scale', () => {
  it('keeps exact BGE-size recall bounded across 20,000 vectors', () => {
    const index = createDenseVectorCandidateIndex()
    const targets = new Map<number, number[]>()
    const targetIndexes = Array.from({ length: QUERY_COUNT }, (_, queryIndex) =>
      Math.floor(queryIndex * (VECTOR_COUNT - 1) / Math.max(1, QUERY_COUNT - 1)))
    const targetSet = new Set(targetIndexes)

    for (let vectorIndex = 0; vectorIndex < VECTOR_COUNT; vectorIndex++) {
      const vector = deterministicNormalizedVector(vectorIndex, BGE_DIMENSION)
      index.upsert(`fact-${vectorIndex}`, vector)
      if (targetSet.has(vectorIndex))
        targets.set(vectorIndex, vector)
    }

    const durations: number[] = []
    for (const targetIndex of targetIndexes) {
      const query = targets.get(targetIndex)!
      const startedAt = performance.now()
      const hits = index.search(query, { limit: 5, minScore: 0.45 })
      durations.push(performance.now() - startedAt)
      expect(hits[0]).toMatchObject({ id: `fact-${targetIndex}` })
      expect(hits[0]!.score).toBeGreaterThan(0.99)
    }

    const p95Milliseconds = percentile(durations, 0.95)
    expect(index.size()).toBe(VECTOR_COUNT)
    expect(index.dimension()).toBe(BGE_DIMENSION)
    // The production Worker has a 1 s task timeout. Keep a conservative 5x
    // safety margin here while avoiding a machine-specific microbenchmark.
    expect(p95Milliseconds).toBeLessThan(200)

    console.info(JSON.stringify({
      stage: 'memory-v4-dense-vector-stress',
      vectorCount: VECTOR_COUNT,
      dimension: BGE_DIMENSION,
      queryCount: QUERY_COUNT,
      meanMilliseconds: mean(durations),
      p95Milliseconds,
      maxMilliseconds: Math.max(...durations),
      targetP95Milliseconds: 200,
      targetMet: p95Milliseconds < 200,
    }))
  }, 30_000)
})

function deterministicNormalizedVector(seed: number, dimension: number): number[] {
  let state = (seed + 1) >>> 0
  const vector = Array.from({ length: dimension }, () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0xFFFF_FFFF * 2 - 1
  })
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return vector.map(value => value / norm)
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}
