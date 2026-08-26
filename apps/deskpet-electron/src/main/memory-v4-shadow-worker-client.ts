import { Worker } from 'node:worker_threads'
import type {
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4SemanticIndexSnapshot,
  MemoryV4Snapshot,
} from '@deskpet/memory'
import type {
  MemoryV4ShadowWorkerRequest,
  MemoryV4ShadowWorkerResponse,
} from './memory-v4-shadow-worker-protocol'

export const MEMORY_V4_SHADOW_WORKER_CLIENT_VERSION = 'memory-v4-shadow-worker-client-v1'

interface WorkerLike {
  on(event: 'message', listener: (message: MemoryV4ShadowWorkerResponse) => void): WorkerLike
  on(event: 'error', listener: (error: Error) => void): WorkerLike
  on(event: 'exit', listener: (exitCode: number) => void): WorkerLike
  postMessage: (message: MemoryV4ShadowWorkerRequest) => void
  terminate: () => Promise<number>
}

export interface MemoryV4ShadowWorkerClientStatus {
  version: typeof MEMORY_V4_SHADOW_WORKER_CLIENT_VERSION
  running: boolean
  active: boolean
  starts: number
  restarts: number
  requests: number
  completed: number
  failures: number
  timeouts: number
  cancellations: number
  snapshotSyncs: number
  semanticSyncs: number
  lastTaskMs?: number
  lastIndex?: MemoryV4ShadowRecallResult['index'] & { revision: number }
}

export interface MemoryV4ShadowWorkerClient {
  recall: (query: string, options: MemoryV4ShadowRecallOptions) => Promise<MemoryV4ShadowRecallResult>
  cancelAll: () => void
  stop: () => void
  status: () => MemoryV4ShadowWorkerClientStatus
}

export interface MemoryV4ShadowWorkerClientOptions {
  workerPath: string
  getSnapshot: () => MemoryV4Snapshot
  /** Learned vectors are synchronized only for their matching snapshot. */
  getSemanticIndex?: (snapshot: MemoryV4Snapshot) => MemoryV4SemanticIndexSnapshot | undefined
  timeoutMs?: number
  workerFactory?: (workerPath: string) => WorkerLike
  now?: () => number
}

interface ActiveRequest {
  requestId: number
  snapshotRevision?: number
  semanticIdentity?: string
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  resolve: (result: MemoryV4ShadowRecallResult) => void
  reject: (error: Error) => void
}

export function createMemoryV4ShadowWorkerClient(
  options: MemoryV4ShadowWorkerClientOptions,
): MemoryV4ShadowWorkerClient {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 1_000, 'timeoutMs')
  const now = options.now ?? performance.now.bind(performance)
  const workerFactory = options.workerFactory ?? (workerPath => new Worker(workerPath))
  let worker: WorkerLike | undefined
  let active: ActiveRequest | undefined
  let stopped = false
  let startedBefore = false
  let nextRequestId = 1
  let syncedRevision: number | undefined
  let syncedSemanticIdentity: string | undefined
  let starts = 0
  let restarts = 0
  let requests = 0
  let completed = 0
  let failures = 0
  let timeouts = 0
  let cancellations = 0
  let snapshotSyncs = 0
  let semanticSyncs = 0
  let lastTaskMs: number | undefined
  let lastIndex: MemoryV4ShadowWorkerClientStatus['lastIndex']

  function ensureWorker(): WorkerLike {
    if (stopped)
      throw new Error('Memory V4 shadow worker client is stopped')
    if (worker)
      return worker
    const current = workerFactory(options.workerPath)
    worker = current
    starts += 1
    if (startedBefore)
      restarts += 1
    startedBefore = true
    current.on('message', message => handleMessage(current, message))
    current.on('error', error => handleWorkerFailure(current, error))
    current.on('exit', exitCode => {
      if (worker !== current)
        return
      handleWorkerFailure(current, new Error(`Memory V4 shadow worker exited with code ${exitCode}`))
    })
    return current
  }

  function detachAndTerminate(current: WorkerLike | undefined): void {
    if (!current)
      return
    if (worker === current)
      worker = undefined
    syncedRevision = undefined
    syncedSemanticIdentity = undefined
    void current.terminate().catch(() => undefined)
  }

  function rejectActive(error: Error): void {
    const request = active
    if (!request)
      return
    active = undefined
    clearTimeout(request.timer)
    lastTaskMs = Math.max(0, now() - request.startedAt)
    request.reject(error)
  }

  function handleWorkerFailure(current: WorkerLike, error: Error): void {
    if (worker !== current)
      return
    failures += 1
    detachAndTerminate(current)
    rejectActive(error)
  }

  function handleMessage(current: WorkerLike, message: MemoryV4ShadowWorkerResponse): void {
    if (worker !== current || !active || !message || message.requestId !== active.requestId)
      return
    const request = active
    active = undefined
    clearTimeout(request.timer)
    lastTaskMs = Math.max(0, now() - request.startedAt)
    if (message.type === 'error') {
      failures += 1
      request.reject(new Error(`Memory V4 shadow worker ${message.errorName} (${message.errorFingerprint})`))
      return
    }
    if (message.type !== 'result' || !message.result) {
      failures += 1
      request.reject(new Error('Memory V4 shadow worker returned an invalid response'))
      return
    }
    completed += 1
    if (request.snapshotRevision !== undefined) {
      syncedRevision = request.snapshotRevision
      snapshotSyncs += 1
    }
    if (request.semanticIdentity !== undefined) {
      syncedSemanticIdentity = request.semanticIdentity
      semanticSyncs += 1
    }
    lastIndex = { ...message.result.index, revision: message.result.snapshotRevision }
    request.resolve(message.result)
  }

  return {
    recall(query, recallOptions) {
      if (active)
        return Promise.reject(new Error('Memory V4 shadow worker already has an active request'))
      let current: WorkerLike
      try {
        current = ensureWorker()
      }
      catch (error) {
        return Promise.reject(error)
      }
      const snapshot = options.getSnapshot()
      const requiresSync = syncedRevision !== snapshot.revision
      const semanticIndex = options.getSemanticIndex?.(snapshot)
      const semanticIdentity = semanticIndex
        ? `${semanticIndex.snapshotRevision}:${semanticIndex.semanticRevision}:${semanticIndex.model}`
        : undefined
      const requiresSemanticSync = semanticIdentity !== undefined && semanticIdentity !== syncedSemanticIdentity
      const requestId = nextRequestId++
      requests += 1
      return new Promise<MemoryV4ShadowRecallResult>((resolve, reject) => {
        const startedAt = now()
        const timer = setTimeout(() => {
          if (!active || active.requestId !== requestId)
            return
          timeouts += 1
          detachAndTerminate(current)
          rejectActive(new Error(`Memory V4 shadow worker timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        active = {
          requestId,
          ...(requiresSync ? { snapshotRevision: snapshot.revision } : {}),
          ...(requiresSemanticSync ? { semanticIdentity } : {}),
          startedAt,
          timer,
          resolve,
          reject,
        }
        try {
          current.postMessage({
            type: 'recall',
            requestId,
            query,
            options: recallOptions,
            ...(requiresSync ? { snapshot } : {}),
            ...(requiresSemanticSync && semanticIndex ? { semanticIndex } : {}),
          })
        }
        catch (error) {
          failures += 1
          detachAndTerminate(current)
          rejectActive(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    cancelAll() {
      if (!worker && !active)
        return
      cancellations += active ? 1 : 0
      const current = worker
      detachAndTerminate(current)
      rejectActive(new Error('Memory V4 shadow worker request cancelled'))
    },
    stop() {
      stopped = true
      const current = worker
      detachAndTerminate(current)
      rejectActive(new Error('Memory V4 shadow worker client stopped'))
    },
    status: () => ({
      version: MEMORY_V4_SHADOW_WORKER_CLIENT_VERSION,
      running: !!worker,
      active: !!active,
      starts,
      restarts,
      requests,
      completed,
      failures,
      timeouts,
      cancellations,
      snapshotSyncs,
      semanticSyncs,
      ...(lastTaskMs === undefined ? {} : { lastTaskMs }),
      ...(lastIndex ? { lastIndex: { ...lastIndex } } : {}),
    }),
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`)
  return value
}
