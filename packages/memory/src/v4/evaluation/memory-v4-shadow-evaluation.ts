import type {
  V3V4ShadowComparison,
  V3V4ShadowComparisonSink,
  V3V4ShadowFailure,
} from '../retrieval/memory-v4-shadow-retriever'

export const MEMORY_V4_SHADOW_EVALUATION_VERSION = 'memory-v4-shadow-evaluation-v1'
export const MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION = 1 as const
export const MEMORY_V4_SHADOW_TASK_QUEUE_VERSION = 'memory-v4-shadow-task-queue-v1'

export interface MemoryV4ShadowEvaluationPersistence {
  load: () => string | undefined
  save: (payload: string) => void
  storagePath?: string
}

type PersistedEvaluationRecord
  = { type: 'comparison'; value: V3V4ShadowComparison }
    | { type: 'failure'; value: V3V4ShadowFailure }

interface MemoryV4ShadowEvaluationSnapshot {
  schemaVersion: typeof MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION
  createdAt: number
  updatedAt: number
  droppedRecords: number
  records: PersistedEvaluationRecord[]
}

export interface MemoryV4ShadowMetricRollup {
  count: number
  averageAgreementRecallAtK: number
  averageAgreementPrecisionAtK: number
  averageJaccard: number
  latencyMs: {
    average: number
    p50: number
    p95: number
    p99: number
    max: number
  }
}

export interface MemoryV4ShadowEvaluationStatus {
  version: typeof MEMORY_V4_SHADOW_EVALUATION_VERSION
  storagePath?: string
  encrypted: boolean
  retainedRecords: number
  droppedRecords: number
  pendingWrites: number
  failures: number
  comparisons: number
  overall: MemoryV4ShadowMetricRollup
  byIntent: Record<string, MemoryV4ShadowMetricRollup>
  firstRecordedAt?: number
  lastRecordedAt?: number
  lastComparison?: V3V4ShadowComparison
  lastFailure?: V3V4ShadowFailure
}

export interface MemoryV4ShadowEvaluationStore extends V3V4ShadowComparisonSink {
  status: () => MemoryV4ShadowEvaluationStatus
  flush: () => void
  clear: () => void
}

/**
 * Bounded encrypted rollout history. Records contain hashes, counts, ranks and
 * timings only; query text, answer text and memory content are never accepted.
 */
export function createMemoryV4ShadowEvaluationStore(options: {
  persistence?: MemoryV4ShadowEvaluationPersistence
  /** Must be asserted by the caller; a filename alone cannot prove encryption. */
  encrypted?: boolean
  maxRecords?: number
  flushDelayMs?: number
  now?: () => number
  onPersistenceError?: (error: unknown) => void
} = {}): MemoryV4ShadowEvaluationStore {
  const now = options.now ?? Date.now
  const maxRecords = clampInteger(options.maxRecords ?? 4_096, 100, 100_000)
  const flushDelayMs = clampInteger(options.flushDelayMs ?? 5_000, 0, 60_000)
  const loaded = options.persistence?.load()
  let snapshot = loaded ? parseSnapshot(loaded) : emptySnapshot(now())
  if (snapshot.records.length > maxRecords) {
    const overflow = snapshot.records.length - maxRecords
    snapshot.records.splice(0, overflow)
    snapshot.droppedRecords += overflow
  }
  let dirty = false
  let pendingWrites = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.persistence && loaded === undefined)
    options.persistence.save(JSON.stringify(snapshot))

  function reportPersistenceError(error: unknown): void {
    try {
      options.onPersistenceError?.(error)
    }
    catch {
      // Telemetry diagnostics must never escape into the answer path.
    }
  }

  function flushSafely(): void {
    try {
      flush()
    }
    catch (error) {
      // Keep dirty=true so a later append or explicit shutdown flush can
      // retry. A best-effort metric store must not crash the desktop host.
      reportPersistenceError(error)
    }
  }

  function scheduleFlush(): void {
    dirty = true
    pendingWrites += 1
    if (!options.persistence || timer)
      return
    if (flushDelayMs === 0) {
      flushSafely()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      flushSafely()
    }, flushDelayMs)
    timer.unref?.()
  }

  function append(record: PersistedEvaluationRecord): void {
    snapshot.records.push(record)
    if (snapshot.records.length > maxRecords) {
      const overflow = snapshot.records.length - maxRecords
      snapshot.records.splice(0, overflow)
      snapshot.droppedRecords += overflow
    }
    snapshot.updatedAt = Math.max(snapshot.updatedAt, recordTimestamp(record))
    scheduleFlush()
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty || !options.persistence) {
      pendingWrites = 0
      return
    }
    options.persistence.save(JSON.stringify(snapshot))
    dirty = false
    pendingWrites = 0
  }

  return {
    recordComparison(comparison) {
      append({ type: 'comparison', value: normalizeComparison(comparison) })
    },
    recordFailure(failure) {
      append({ type: 'failure', value: normalizeFailure(failure) })
    },
    status: () => evaluationStatus(
      snapshot,
      options.persistence?.storagePath,
      options.encrypted === true && options.persistence !== undefined,
      pendingWrites,
    ),
    flush,
    clear() {
      snapshot = emptySnapshot(now())
      scheduleFlush()
      flushSafely()
    },
  }
}

export interface MemoryV4ShadowTaskQueueStatus {
  version: typeof MEMORY_V4_SHADOW_TASK_QUEUE_VERSION
  active: boolean
  pending: number
  enqueued: number
  completed: number
  dropped: number
  staleDropped: number
  clearedDropped: number
  failures: number
  budgetExceeded: number
  maxObservedPending: number
  lastTaskMs?: number
}

export interface MemoryV4ShadowTaskQueue<T> {
  enqueue: (task: T) => boolean
  status: () => MemoryV4ShadowTaskQueueStatus
  drain: () => Promise<void>
  /** Drop queued work while retaining the queue for future comparisons. */
  clearPending: () => number
  stop: () => void
}

/**
 * A bounded single-flight queue for non-authoritative shadow work. It prevents
 * chat bursts from building an unbounded backlog. `maxTaskMs` is observational
 * for synchronous tasks; hard CPU isolation remains a later Worker-thread step.
 */
export function createMemoryV4ShadowTaskQueue<T>(options: {
  run: (task: T) => void | Promise<void>
  maxPending?: number
  maxQueueAgeMs?: number
  maxTaskMs?: number
  now?: () => number
  onError?: (error: unknown) => void
  onDrop?: (reason: 'overload' | 'stale' | 'cleared' | 'stopped', task: T) => void
}): MemoryV4ShadowTaskQueue<T> {
  const now = options.now ?? Date.now
  const maxPending = clampInteger(options.maxPending ?? 4, 1, 1_000)
  const maxQueueAgeMs = clampInteger(options.maxQueueAgeMs ?? 10_000, 1, 600_000)
  const maxTaskMs = clampInteger(options.maxTaskMs ?? 1_000, 1, 600_000)
  const pending: Array<{ task: T; enqueuedAt: number }> = []
  const drainWaiters: Array<() => void> = []
  let scheduled = false
  let active = false
  let stopped = false
  let enqueued = 0
  let completed = 0
  let dropped = 0
  let staleDropped = 0
  let clearedDropped = 0
  let failures = 0
  let budgetExceeded = 0
  let maxObservedPending = 0
  let lastTaskMs: number | undefined

  function safeDrop(reason: 'overload' | 'stale' | 'cleared' | 'stopped', task: T): void {
    try {
      options.onDrop?.(reason, task)
    }
    catch {
      // Diagnostics must not break the queue.
    }
  }

  function settleDrainers(): void {
    if (active || scheduled || pending.length > 0)
      return
    for (const resolve of drainWaiters.splice(0))
      resolve()
  }

  function schedule(): void {
    if (scheduled || active || stopped || pending.length === 0) {
      settleDrainers()
      return
    }
    scheduled = true
    setImmediate(() => {
      scheduled = false
      void pump()
    })
  }

  async function pump(): Promise<void> {
    if (active || stopped) {
      settleDrainers()
      return
    }
    let next = pending.shift()
    while (next && now() - next.enqueuedAt > maxQueueAgeMs) {
      dropped += 1
      staleDropped += 1
      safeDrop('stale', next.task)
      next = pending.shift()
    }
    if (!next) {
      settleDrainers()
      return
    }
    active = true
    const startedAt = performance.now()
    try {
      await options.run(next.task)
    }
    catch (error) {
      failures += 1
      try {
        options.onError?.(error)
      }
      catch {
        // Diagnostics must not break the queue.
      }
    }
    finally {
      lastTaskMs = Math.max(0, performance.now() - startedAt)
      if (lastTaskMs > maxTaskMs)
        budgetExceeded += 1
      completed += 1
      active = false
      schedule()
    }
  }

  return {
    enqueue(task) {
      if (stopped) {
        dropped += 1
        safeDrop('stopped', task)
        return false
      }
      if (pending.length >= maxPending) {
        dropped += 1
        safeDrop('overload', task)
        return false
      }
      pending.push({ task, enqueuedAt: now() })
      enqueued += 1
      maxObservedPending = Math.max(maxObservedPending, pending.length)
      schedule()
      return true
    },
    status: () => ({
      version: MEMORY_V4_SHADOW_TASK_QUEUE_VERSION,
      active,
      pending: pending.length,
      enqueued,
      completed,
      dropped,
      staleDropped,
      clearedDropped,
      failures,
      budgetExceeded,
      maxObservedPending,
      ...(lastTaskMs === undefined ? {} : { lastTaskMs }),
    }),
    drain: () => active || scheduled || pending.length > 0
      ? new Promise(resolve => drainWaiters.push(resolve))
      : Promise.resolve(),
    clearPending() {
      const count = pending.length
      if (count === 0)
        return 0
      dropped += count
      clearedDropped += count
      for (const item of pending)
        safeDrop('cleared', item.task)
      pending.splice(0)
      settleDrainers()
      return count
    },
    stop() {
      if (stopped)
        return
      stopped = true
      if (pending.length > 0) {
        dropped += pending.length
        for (const item of pending)
          safeDrop('stopped', item.task)
        pending.splice(0)
      }
      settleDrainers()
    },
  }
}

function evaluationStatus(
  snapshot: MemoryV4ShadowEvaluationSnapshot,
  storagePath: string | undefined,
  encrypted: boolean,
  pendingWrites: number,
): MemoryV4ShadowEvaluationStatus {
  const comparisons = snapshot.records
    .filter((record): record is Extract<PersistedEvaluationRecord, { type: 'comparison' }> => record.type === 'comparison')
    .map(record => record.value)
  const failures = snapshot.records
    .filter((record): record is Extract<PersistedEvaluationRecord, { type: 'failure' }> => record.type === 'failure')
    .map(record => record.value)
  const byIntent: Record<string, MemoryV4ShadowMetricRollup> = {}
  for (const intent of [...new Set(comparisons.map(item => item.queryIntent))].sort())
    byIntent[intent] = metricRollup(comparisons.filter(item => item.queryIntent === intent))
  const timestamps = snapshot.records.map(recordTimestamp).sort((left, right) => left - right)
  return {
    version: MEMORY_V4_SHADOW_EVALUATION_VERSION,
    ...(storagePath ? { storagePath } : {}),
    encrypted,
    retainedRecords: snapshot.records.length,
    droppedRecords: snapshot.droppedRecords,
    pendingWrites,
    failures: failures.length,
    comparisons: comparisons.length,
    overall: metricRollup(comparisons),
    byIntent,
    ...(timestamps[0] === undefined ? {} : { firstRecordedAt: timestamps[0] }),
    ...(timestamps.at(-1) === undefined ? {} : { lastRecordedAt: timestamps.at(-1) }),
    ...(comparisons.at(-1) ? { lastComparison: comparisons.at(-1) } : {}),
    ...(failures.at(-1) ? { lastFailure: failures.at(-1) } : {}),
  }
}

function metricRollup(comparisons: readonly V3V4ShadowComparison[]): MemoryV4ShadowMetricRollup {
  const latencies = comparisons.map(item => item.v4LatencyMs).sort((left, right) => left - right)
  return {
    count: comparisons.length,
    averageAgreementRecallAtK: average(comparisons.map(item => item.v3AgreementRecallAtK)),
    averageAgreementPrecisionAtK: average(comparisons.map(item => item.v3AgreementPrecisionAtK)),
    averageJaccard: average(comparisons.map(item => item.jaccard)),
    latencyMs: {
      average: average(latencies),
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1) ?? 0,
    },
  }
}

function normalizeComparison(value: V3V4ShadowComparison): V3V4ShadowComparison {
  assertHash(value.queryHash, 'comparison queryHash')
  return {
    ...value,
    queryIntent: boundedString(value.queryIntent, 64, 'unknown'),
    retrievalRoutes: [...new Set(value.retrievalRoutes.map(route => boundedString(route, 64, 'unknown')))].slice(0, 16),
    comparedAt: positiveTimestamp(value.comparedAt),
    snapshotRevision: nonNegativeInteger(value.snapshotRevision),
    candidateCount: nonNegativeInteger(value.candidateCount),
    summaryCandidates: nonNegativeInteger(value.summaryCandidates),
    indexRebuildCount: nonNegativeInteger(value.indexRebuildCount),
    v3RetrievedCount: nonNegativeInteger(value.v3RetrievedCount),
    v3InjectedCount: nonNegativeInteger(value.v3InjectedCount),
    v4RetrievedCount: nonNegativeInteger(value.v4RetrievedCount),
    overlapCount: nonNegativeInteger(value.overlapCount),
    v3AgreementRecallAtK: clamp01(value.v3AgreementRecallAtK),
    v3AgreementPrecisionAtK: clamp01(value.v3AgreementPrecisionAtK),
    jaccard: clamp01(value.jaccard),
    v4LatencyMs: nonNegativeNumber(value.v4LatencyMs),
    privacyFiltered: nonNegativeInteger(value.privacyFiltered),
    temporalFiltered: nonNegativeInteger(value.temporalFiltered),
  }
}

function normalizeFailure(value: V3V4ShadowFailure): V3V4ShadowFailure {
  assertHash(value.queryHash, 'failure queryHash')
  assertHash(value.errorFingerprint, 'failure errorFingerprint')
  return {
    queryHash: value.queryHash,
    errorName: boundedString(value.errorName, 64, 'UnknownError'),
    errorFingerprint: value.errorFingerprint,
    failedAt: positiveTimestamp(value.failedAt),
  }
}

function parseSnapshot(payload: string): MemoryV4ShadowEvaluationSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse V4 shadow evaluation: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('V4 shadow evaluation payload is not an object')
  const source = parsed as Partial<MemoryV4ShadowEvaluationSnapshot>
  if (source.schemaVersion !== MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION || !Array.isArray(source.records))
    throw new Error('Unsupported V4 shadow evaluation schema')
  const records = source.records.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid V4 shadow evaluation record')
    const record = raw as PersistedEvaluationRecord
    if (record.type === 'comparison')
      return { type: 'comparison' as const, value: normalizeComparison(record.value) }
    if (record.type === 'failure')
      return { type: 'failure' as const, value: normalizeFailure(record.value) }
    throw new Error('Unknown V4 shadow evaluation record type')
  })
  return {
    schemaVersion: MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION,
    createdAt: positiveTimestamp(source.createdAt),
    updatedAt: positiveTimestamp(source.updatedAt),
    droppedRecords: nonNegativeInteger(source.droppedRecords),
    records,
  }
}

function emptySnapshot(now: number): MemoryV4ShadowEvaluationSnapshot {
  const timestamp = positiveTimestamp(now)
  return {
    schemaVersion: MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    droppedRecords: 0,
    records: [],
  }
}

function recordTimestamp(record: PersistedEvaluationRecord): number {
  return record.type === 'comparison' ? record.value.comparedAt : record.value.failedAt
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0)
    return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`Invalid ${label}`)
}

function boundedString(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback
}

function positiveTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('Expected a positive timestamp')
  return Math.floor(value)
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Expected a non-negative integer')
  return Math.floor(value)
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Expected a non-negative number')
  return value
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected a finite score')
  return Math.max(0, Math.min(1, value))
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}
