import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { V3V4ShadowComparison } from '../retrieval/memory-v4-shadow-retriever'
import {
  createMemoryV4ShadowEvaluationStore,
  createMemoryV4ShadowTaskQueue,
} from './memory-v4-shadow-evaluation'

const NOW = Date.UTC(2026, 7, 25)

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate())
      return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for asynchronous queue state')
}

function comparison(index: number, intent = 'specific'): V3V4ShadowComparison {
  return {
    queryHash: createHash('sha256').update(`query-${index}`).digest('hex'),
    comparedAt: NOW + index,
    queryIntent: intent,
    retrievalRoutes: ['fact-lexical', 'summary-down-drill'],
    snapshotRevision: index,
    candidateCount: 10,
    summaryCandidates: 3,
    indexRebuildCount: 1,
    v3RetrievedCount: 2,
    v3InjectedCount: 1,
    v4RetrievedCount: 2,
    overlapCount: 1,
    v3AgreementRecallAtK: 0.5,
    v3AgreementPrecisionAtK: 0.5,
    jaccard: 1 / 3,
    v4LatencyMs: index + 1,
    privacyFiltered: 1,
    temporalFiltered: 2,
  }
}

describe('persistent V4 shadow evaluation', () => {
  it('persists bounded plaintext-free records and restores percentile rollups', () => {
    let payload: string | undefined
    const persistence = {
      storagePath: 'memory-v4-shadow-eval.enc',
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    const store = createMemoryV4ShadowEvaluationStore({
      persistence,
      encrypted: true,
      maxRecords: 100,
      flushDelayMs: 0,
      now: () => NOW,
    })
    for (let index = 0; index < 105; index++)
      store.recordComparison(comparison(index, index % 2 === 0 ? 'specific' : 'temporal'))
    store.recordFailure({
      queryHash: createHash('sha256').update('private query').digest('hex'),
      errorName: 'Error',
      errorFingerprint: createHash('sha256').update('offline').digest('hex'),
      failedAt: NOW + 200,
    })
    store.flush()

    expect(payload).toBeDefined()
    expect(payload).not.toContain('private query')
    const status = store.status()
    expect(status).toMatchObject({
      encrypted: true,
      retainedRecords: 100,
      droppedRecords: 6,
      failures: 1,
      comparisons: 99,
    })
    expect(status.overall.latencyMs.p50).toBeGreaterThan(0)
    expect(status.overall.latencyMs.p95).toBeGreaterThanOrEqual(status.overall.latencyMs.p50)
    expect(status.byIntent.specific?.count).toBeGreaterThan(0)
    expect(status.byIntent.temporal?.count).toBeGreaterThan(0)

    const restored = createMemoryV4ShadowEvaluationStore({
      persistence,
      encrypted: true,
      now: () => NOW + 1_000,
    })
    expect(restored.status()).toStrictEqual(status)
  })

  it('rejects malformed or unknown persisted schemas', () => {
    expect(() => createMemoryV4ShadowEvaluationStore({
      persistence: { load: () => '{"schemaVersion":99,"records":[]}', save: () => undefined },
    })).toThrow(/Unsupported V4 shadow evaluation schema/u)
  })

  it('does not infer encryption from a path and contains delayed persistence failures', () => {
    let fail = false
    const onPersistenceError = vi.fn()
    const store = createMemoryV4ShadowEvaluationStore({
      persistence: {
        storagePath: 'plain-looking-like-encrypted.enc',
        load: () => undefined,
        save: () => {
          if (fail)
            throw new Error('disk offline')
        },
      },
      flushDelayMs: 0,
      onPersistenceError,
      now: () => NOW,
    })
    expect(store.status().encrypted).toBe(false)
    fail = true
    expect(() => store.recordComparison(comparison(1))).not.toThrow()
    expect(onPersistenceError).toHaveBeenCalledTimes(1)
    expect(store.status().pendingWrites).toBe(1)
  })
})

describe('bounded V4 shadow task queue', () => {
  it('runs one task at a time and drops overload instead of growing without bound', async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    const queue = createMemoryV4ShadowTaskQueue<number>({
      maxPending: 2,
      run: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>(resolve => releases.push(resolve))
        active -= 1
      },
    })

    expect(queue.enqueue(1)).toBe(true)
    expect(queue.enqueue(2)).toBe(true)
    expect(queue.enqueue(3)).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(queue.status()).toMatchObject({ active: true, pending: 1, dropped: 1 })
    releases.shift()?.()
    await waitFor(() => releases.length > 0)
    releases.shift()?.()
    await queue.drain()

    expect(maxActive).toBe(1)
    expect(queue.status()).toMatchObject({ completed: 2, failures: 0, pending: 0 })
  })

  it('drops stale work and reports tasks that exceed the observational budget', async () => {
    let clock = NOW
    const queue = createMemoryV4ShadowTaskQueue<number>({
      now: () => clock,
      maxQueueAgeMs: 10,
      maxTaskMs: 1,
      run: () => {
        const until = performance.now() + 3
        while (performance.now() < until) {
          // Deliberately occupy the test task long enough to cross the budget.
        }
      },
    })
    queue.enqueue(1)
    clock += 20
    await queue.drain()
    expect(queue.status()).toMatchObject({ staleDropped: 1, completed: 0 })

    queue.enqueue(2)
    await queue.drain()
    expect(queue.status()).toMatchObject({ completed: 1, budgetExceeded: 1 })
    queue.stop()
    expect(queue.enqueue(3)).toBe(false)
  })

  it('clears queued pre-reset work without disabling future comparisons', async () => {
    const releases: Array<() => void> = []
    const completed: number[] = []
    const queue = createMemoryV4ShadowTaskQueue<number>({
      maxPending: 3,
      run: async (task) => {
        await new Promise<void>(resolve => releases.push(resolve))
        completed.push(task)
      },
    })
    queue.enqueue(1)
    queue.enqueue(2)
    await waitFor(() => queue.status().active)
    expect(queue.clearPending()).toBe(1)
    releases.shift()?.()
    await queue.drain()
    expect(completed).toEqual([1])
    expect(queue.status()).toMatchObject({ dropped: 1, clearedDropped: 1 })

    queue.enqueue(3)
    await waitFor(() => releases.length > 0)
    releases.shift()?.()
    await queue.drain()
    expect(completed).toEqual([1, 3])
  })
})
