import { describe, expect, it } from 'vitest'
import { createEmptyMemoryV4Snapshot } from '@deskpet/memory'
import type { MemoryV4ShadowRecallResult } from '@deskpet/memory'
import { createMemoryV4ShadowWorkerClient } from './memory-v4-shadow-worker-client'
import type {
  MemoryV4ShadowWorkerRequest,
  MemoryV4ShadowWorkerResponse,
} from './memory-v4-shadow-worker-protocol'

type HandlerMap = {
  message: Array<(message: MemoryV4ShadowWorkerResponse) => void>
  error: Array<(error: Error) => void>
  exit: Array<(exitCode: number) => void>
}

class FakeWorker {
  readonly messages: MemoryV4ShadowWorkerRequest[] = []
  terminated = false
  private readonly handlers: HandlerMap = { message: [], error: [], exit: [] }

  constructor(private readonly respond?: (request: MemoryV4ShadowWorkerRequest, worker: FakeWorker) => void) {}

  on(event: 'message', listener: (message: MemoryV4ShadowWorkerResponse) => void): FakeWorker
  on(event: 'error', listener: (error: Error) => void): FakeWorker
  on(event: 'exit', listener: (exitCode: number) => void): FakeWorker
  on(event: keyof HandlerMap, listener: HandlerMap[keyof HandlerMap][number]): FakeWorker {
    if (event === 'message')
      this.handlers.message.push(listener as (message: MemoryV4ShadowWorkerResponse) => void)
    else if (event === 'error')
      this.handlers.error.push(listener as (error: Error) => void)
    else
      this.handlers.exit.push(listener as (exitCode: number) => void)
    return this
  }

  postMessage(request: MemoryV4ShadowWorkerRequest): void {
    this.messages.push(request)
    this.respond?.(request, this)
  }

  reply(response: MemoryV4ShadowWorkerResponse): void {
    for (const listener of this.handlers.message)
      listener(response)
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

describe('Memory V4 shadow worker client', () => {
  it('sends a snapshot only when its repository revision changes', async () => {
    let snapshot = { ...createEmptyMemoryV4Snapshot(1), revision: 3 }
    const worker = new FakeWorker((request, current) => current.reply({
      type: 'result',
      requestId: request.requestId,
      result: result(request.snapshot?.revision ?? snapshot.revision),
    }))
    const client = createMemoryV4ShadowWorkerClient({
      workerPath: 'worker.js',
      getSnapshot: () => structuredClone(snapshot),
      getSemanticIndex: current => ({
        version: 1,
        snapshotRevision: current.revision,
        semanticRevision: current.revision,
        model: 'verified-bge-test',
        dimension: 2,
        factVectors: [],
        summaryVectors: [],
      }),
      workerFactory: () => worker,
    })

    await client.recall('first', recallOptions())
    await client.recall('second', recallOptions())
    snapshot = { ...snapshot, revision: 4, updatedAt: 2 }
    await client.recall('third', recallOptions())

    expect(worker.messages.map(message => message.snapshot?.revision)).toEqual([3, undefined, 4])
    expect(worker.messages.map(message => message.semanticIndex?.snapshotRevision)).toEqual([3, undefined, 4])
    expect(client.status()).toMatchObject({
      starts: 1,
      restarts: 0,
      requests: 3,
      completed: 3,
      snapshotSyncs: 2,
      semanticSyncs: 2,
      lastIndex: { revision: 4 },
    })
  })

  it('hard-terminates a timed-out worker and restarts with a fresh snapshot', async () => {
    const workers: FakeWorker[] = []
    const client = createMemoryV4ShadowWorkerClient({
      workerPath: 'worker.js',
      getSnapshot: () => ({ ...createEmptyMemoryV4Snapshot(1), revision: 2 }),
      timeoutMs: 10,
      workerFactory: () => {
        const worker = workers.length === 0
          ? new FakeWorker()
          : new FakeWorker((request, current) => current.reply({
              type: 'result',
              requestId: request.requestId,
              result: result(request.snapshot?.revision ?? 0),
            }))
        workers.push(worker)
        return worker
      },
    })

    await expect(client.recall('timeout', recallOptions())).rejects.toThrow(/timed out/u)
    expect(workers[0]?.terminated).toBe(true)
    await expect(client.recall('retry', recallOptions())).resolves.toMatchObject({ snapshotRevision: 2 })
    expect(workers[1]?.messages[0]?.snapshot?.revision).toBe(2)
    expect(client.status()).toMatchObject({ starts: 2, restarts: 1, timeouts: 1, completed: 1 })
  })

  it('cancels an in-flight generation without permanently stopping the client', async () => {
    const workers: FakeWorker[] = []
    const client = createMemoryV4ShadowWorkerClient({
      workerPath: 'worker.js',
      getSnapshot: () => createEmptyMemoryV4Snapshot(1),
      workerFactory: () => {
        const worker = workers.length === 0
          ? new FakeWorker()
          : new FakeWorker((request, current) => current.reply({
              type: 'result',
              requestId: request.requestId,
              result: result(request.snapshot?.revision ?? 0),
            }))
        workers.push(worker)
        return worker
      },
    })

    const pending = client.recall('old generation', recallOptions())
    client.cancelAll()
    await expect(pending).rejects.toThrow(/cancelled/u)
    await expect(client.recall('new generation', recallOptions())).resolves.toMatchObject({ snapshotRevision: 0 })
    expect(client.status()).toMatchObject({ cancellations: 1, starts: 2, restarts: 1 })
  })
})

function recallOptions() {
  return { scope: { ownerId: 'test-owner', agentId: 'deskpet' }, limit: 5 }
}

function result(snapshotRevision: number): MemoryV4ShadowRecallResult {
  return {
    version: 'memory-v4-shadow-retriever-v2',
    policy: { policyId: 'test-policy', policyVersion: 'test-v1', fingerprint: 'test-fingerprint' },
    snapshotRevision,
    queryIntent: 'personal-specific',
    routes: [],
    candidateCount: 0,
    summaryCandidates: 0,
    summariesUsed: [],
    privacyFiltered: 0,
    temporalFiltered: 0,
    tierRouting: {
      version: 'memory-v4-tier-router-v1', coldPolicy: 'fallback', coldAwakened: false,
      candidateBudgets: { hot: 8, warm: 16, cold: 8 },
      eligibleCounts: { hot: 0, warm: 0, cold: 0 }, searchedCounts: { hot: 0, warm: 0, cold: 0 },
      quarantineExcluded: 0, unassignedAsWarm: 0,
    },
    evidenceSelection: {
      version: 'memory-v4-evidence-selector-v1', evaluatedCount: 0, selectedCount: 0,
      coveredRequirements: [], stopReason: 'no-candidates', usedCharacters: 0,
    },
    hits: [],
    latencyMs: 1,
    index: { summaries: 0, facts: 0, rebuildCount: 1 },
  }
}
