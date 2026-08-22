import { createHash } from 'node:crypto'
import type {
  MemoryDerivedArtifactV4,
  MemoryEpisodeV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export const MEMORY_CONSOLIDATION_SERVICE_VERSION = 'memory-consolidation-v1'
export const MEMORY_DETERMINISTIC_SUMMARIZER_VERSION = 'deterministic-summarizer-v1'

export type ConsolidationGranularity = 'session' | 'day'

/** One consolidation unit: the episodes and facts that a summary must cover. */
export interface ConsolidationBucket {
  granularity: ConsolidationGranularity
  bucketKey: string
  scope: MemoryV4Scope
  episodes: MemoryEpisodeV4[]
  facts: MemoryFactV4[]
}

export interface ConsolidationSummaryOutput {
  /** Human-readable abstract covering every source fact. */
  content: string
  /** Concrete clue anchors (memoryKey=value) for down-drill navigation. */
  anchors: string[]
}

export type ConsolidationSummarizer = (bucket: ConsolidationBucket) => Promise<ConsolidationSummaryOutput>

export interface ConsolidationScopeFilter {
  ownerId: string
  agentId?: string
}

export interface ConsolidationRunOptions {
  /** Granularities to build in this run. Defaults to session and day. */
  granularity?: readonly ConsolidationGranularity[]
  /** Buckets summarized per repository transaction. */
  batchSize?: number
  /** Maximum buckets built in a single run; leftovers resume on the next run. */
  maxBuckets?: number
  /** Wall-clock budget for one run; checked between batches. */
  maxRuntimeMs?: number
  /** Cooperative cancellation checked between buckets and batches. */
  shouldCancel?: () => boolean
  /** Yield call between batches so the host stays responsive. */
  yieldToEventLoop?: () => Promise<void>
}

export type ConsolidationStopReason
  = 'completed' | 'no-work' | 'cancelled' | 'bucket-budget' | 'runtime-budget'

export interface ConsolidationRunReport {
  version: string
  granularity: ConsolidationGranularity[]
  bucketsTotal: number
  built: number
  rebuilt: number
  skipped: number
  pruned: number
  emptyBuckets: number
  batches: number
  elapsedMs: number
  cancelled: boolean
  stopReason: ConsolidationStopReason
}

export interface MemoryConsolidationServiceOptions {
  summarizer?: ConsolidationSummarizer
  builderVersion?: string
  now?: () => number
}

export interface MemoryConsolidationService {
  /** Build, refresh or prune derived summary artifacts for one scope. */
  consolidate: (scope: ConsolidationScopeFilter, runOptions?: ConsolidationRunOptions) => Promise<ConsolidationRunReport>
  /** List current summary artifacts with their source references. */
  listSummaries: (scope: ConsolidationScopeFilter) => Array<Pick<MemoryDerivedArtifactV4,
    'id' | 'scope' | 'status' | 'content' | 'sourceEpisodeIds' | 'sourceFactIds' | 'updatedAt'>>
}

/**
 * Offline consolidation over the V4 evidence graph. Summaries live in
 * `derivedArtifacts` (kind 'summary'), always carry the full source episode
 * and fact id lists, and are rebuilt whenever lifecycle edits mark them
 * stale or the underlying source set changes. Runs are idempotent, so an
 * interrupted pass resumes where it stopped: already-current buckets are
 * skipped on the next call.
 */
export function createMemoryConsolidationService(
  repository: MemoryV4Repository,
  options: MemoryConsolidationServiceOptions = {},
): MemoryConsolidationService {
  const summarizer = options.summarizer ?? createDeterministicSummarizer()
  const builderVersion = options.builderVersion ?? summarizerVersion(summarizer)
  const now = options.now ?? Date.now

  function listSummaries(scope: ConsolidationScopeFilter) {
    return repository.snapshot().derivedArtifacts
      .filter(artifact => artifact.kind === 'summary' && matchesScopeFilter(artifact.scope, scope))
      .map(artifact => ({
        id: artifact.id,
        scope: artifact.scope,
        status: artifact.status,
        ...(artifact.content === undefined ? {} : { content: artifact.content }),
        sourceEpisodeIds: [...artifact.sourceEpisodeIds],
        sourceFactIds: [...artifact.sourceFactIds],
        updatedAt: artifact.updatedAt,
      }))
  }

  async function consolidate(
    scope: ConsolidationScopeFilter,
    runOptions: ConsolidationRunOptions = {},
  ): Promise<ConsolidationRunReport> {
    if (repository.readOnly)
      throw new Error('Memory consolidation requires a writable V4 repository')
    const granularities = normalizeGranularities(runOptions.granularity)
    const batchSize = clampInteger(runOptions.batchSize ?? 4, 1, 64)
    const maxBuckets = clampInteger(runOptions.maxBuckets ?? 64, 1, 10_000)
    const maxRuntimeMs = clampInteger(runOptions.maxRuntimeMs ?? 30_000, 1, 3_600_000)
    const startedAt = now()
    const report: ConsolidationRunReport = {
      version: MEMORY_CONSOLIDATION_SERVICE_VERSION,
      granularity: [...granularities],
      bucketsTotal: 0,
      built: 0,
      rebuilt: 0,
      skipped: 0,
      pruned: 0,
      emptyBuckets: 0,
      batches: 0,
      elapsedMs: 0,
      cancelled: false,
      stopReason: 'no-work',
    }

    const snapshot = repository.snapshot()
    const buckets = collectBuckets(snapshot, scope, granularities)
    const artifactIndex = indexSummaries(snapshot, scope, granularities)
    const expectedArtifactIds = new Set(buckets.map(summaryArtifactId))
    const missingBuckets = [...artifactIndex.values()]
      .filter(artifact => artifact.status !== 'deleted' && !expectedArtifactIds.has(artifact.id))
    const workItems: Array<
      { kind: 'missing-bucket'; artifactId: string }
      | { kind: 'bucket'; bucket: ConsolidationBucket }
    > = [
      // Privacy/integrity cleanup is ordered first: a summary whose complete
      // source bucket disappeared must not wait behind new summary work.
      ...missingBuckets.map(artifact => ({ kind: 'missing-bucket' as const, artifactId: artifact.id })),
      ...buckets.map(bucket => ({ kind: 'bucket' as const, bucket })),
    ]
    report.bucketsTotal = workItems.length
    if (workItems.length === 0)
      return finish(report, now, startedAt)

    // Only actionable rebuild/prune work consumes maxBuckets. Current buckets
    // must remain free to scan; otherwise the first N already-built buckets
    // consume the same budget on every run and permanently starve newer work.
    let processed = 0
    let cursor = 0
    while (cursor < workItems.length) {
      if (runOptions.shouldCancel?.()) {
        report.cancelled = true
        report.stopReason = 'cancelled'
        break
      }
      if (processed >= maxBuckets) {
        report.stopReason = 'bucket-budget'
        break
      }
      if (now() - startedAt >= maxRuntimeMs) {
        report.stopReason = 'runtime-budget'
        break
      }

      const take = Math.min(batchSize, workItems.length - cursor)
      const slice = workItems.slice(cursor, cursor + take)
      cursor += slice.length
      const batch: Array<
        { kind: 'prune'; artifactId: string }
        | { kind: 'summary'; bucket: ConsolidationBucket; summary: ConsolidationSummaryOutput }
      > = []
      let interrupted = false
      for (const work of slice) {
        if (runOptions.shouldCancel?.()) {
          report.cancelled = true
          report.stopReason = 'cancelled'
          interrupted = true
          break
        }
        if (now() - startedAt >= maxRuntimeMs) {
          report.stopReason = 'runtime-budget'
          interrupted = true
          break
        }
        if (work.kind === 'missing-bucket') {
          if (processed >= maxBuckets) {
            report.stopReason = 'bucket-budget'
            interrupted = true
            break
          }
          processed += 1
          batch.push({ kind: 'prune', artifactId: work.artifactId })
          continue
        }
        const bucket = work.bucket
        const artifactId = summaryArtifactId(bucket)
        const existing = artifactIndex.get(artifactId)
        if (bucket.facts.length === 0) {
          // All evidence for this bucket is gone; the summary must not survive.
          if (existing && existing.status !== 'deleted') {
            if (processed >= maxBuckets) {
              report.stopReason = 'bucket-budget'
              interrupted = true
              break
            }
            processed += 1
            batch.push({ kind: 'prune', artifactId })
          }
          else {
            report.emptyBuckets += 1
          }
          continue
        }
        if (existing && existing.status === 'current'
          && existing.builderVersion === builderVersion
          && sameMembers(existing.sourceEpisodeIds, bucket.episodes.map(episode => episode.id))
          && sameMembers(existing.sourceFactIds, bucket.facts.map(fact => fact.id))) {
          report.skipped += 1
          continue
        }
        if (processed >= maxBuckets) {
          report.stopReason = 'bucket-budget'
          interrupted = true
          break
        }
        processed += 1
        batch.push({ kind: 'summary', bucket, summary: await summarizer(bucket) })
      }

      if (batch.length > 0) {
        repository.transaction((draft) => {
          const artifacts = new Map(draft.derivedArtifacts.map(artifact => [artifact.id, artifact]))
          for (const write of batch) {
            const artifactId = write.kind === 'prune' ? write.artifactId : summaryArtifactId(write.bucket)
            const existing = artifacts.get(artifactId)
            if (write.kind === 'prune') {
              if (!existing || existing.status === 'deleted')
                continue
              existing.status = 'deleted'
              existing.content = undefined
              existing.contentHash = undefined
              existing.invalidatedAt = Math.max(now(), existing.updatedAt)
              existing.updatedAt = existing.invalidatedAt
              report.pruned += 1
              continue
            }
            const summary = write.summary
            const timestamp = Math.max(now(), existing?.updatedAt ?? 0)
            const next: MemoryDerivedArtifactV4 = {
              id: artifactId,
              scope: write.bucket.scope,
              kind: 'summary',
              status: 'current',
              sourceEpisodeIds: [...write.bucket.episodes.map(episode => episode.id)].sort(),
              sourceFactIds: [...write.bucket.facts.map(fact => fact.id)].sort(),
              content: summary.content,
              contentHash: sha256(summary.content),
              createdAt: existing?.createdAt ?? timestamp,
              updatedAt: timestamp,
              builderVersion,
            }
            if (!existing)
              report.built += 1
            else
              report.rebuilt += 1
            if (existing)
              draft.derivedArtifacts.splice(draft.derivedArtifacts.indexOf(existing), 1, next)
            else
              draft.derivedArtifacts.push(next)
            artifacts.set(artifactId, next)
          }
        })
        report.batches += 1
      }
      if (interrupted)
        break
      if (processed >= maxBuckets && cursor < workItems.length) {
        report.stopReason = 'bucket-budget'
        break
      }
      if (runOptions.shouldCancel?.()) {
        report.cancelled = true
        report.stopReason = 'cancelled'
        break
      }
      await runOptions.yieldToEventLoop?.()
    }

    if (report.built + report.rebuilt + report.skipped + report.pruned > 0 && !report.cancelled
      && report.stopReason === 'no-work')
      report.stopReason = 'completed'
    return finish(report, now, startedAt)
  }

  return { consolidate, listSummaries }
}

/**
 * Deterministic extractive default summarizer. Product builds inject an LLM
 * summarizer; tests and offline fallbacks use this one. It only reads fact
 * canonical text (never raw episode content) so a summary never resurrects
 * deleted source plaintext.
 */
export function createDeterministicSummarizer(): ConsolidationSummarizer {
  return async (bucket) => {
    const grouped = new Map<string, string[]>()
    for (const fact of bucket.facts) {
      const key = fact.memoryKey || fact.predicate
      grouped.set(key, [...(grouped.get(key) ?? []), fact.canonicalText])
    }
    const anchors = [...grouped.entries()]
      .map(([key, values]) => `${key}=${[...new Set(values)].join(' | ')}`)
      .sort()
    const label = bucket.granularity === 'session'
      ? `会话 ${bucket.bucketKey}`
      : `日期 ${bucket.bucketKey}`
    const recorded = bucket.episodes.map(episode => episode.recordedAt)
    const range = recorded.length > 0
      ? `${new Date(Math.min(...recorded)).toISOString()} ~ ${new Date(Math.max(...recorded)).toISOString()}`
      : '无记录时间'
    const content = [
      `[${label}] 覆盖 ${bucket.facts.length} 条事实、${bucket.episodes.length} 条证据（${range}）。`,
      ...anchors,
    ].join('\n')
    return { content, anchors }
  }
}

export interface IdleConsolidationRunnerOptions {
  service: MemoryConsolidationService
  scope: ConsolidationScopeFilter
  /** Host-provided idleness check (for example powerMonitor idle time). */
  isIdle: () => boolean
  runOptions?: ConsolidationRunOptions
  intervalMs?: number
  /** Minimum spacing between two consolidation passes. */
  cooldownMs?: number
  onError?: (error: unknown) => void
  /** Stop the runner when this returns true. */
  shouldStop?: () => boolean
  /** Extra maintenance work (tiering, dedup) before summary consolidation. */
  onIdle?: () => Promise<void>
}

export interface IdleConsolidationRunner {
  start: () => void
  stop: () => void
  /** Run one pass immediately, ignoring the idle gate but respecting cooldown. */
  runOnce: () => Promise<ConsolidationRunReport | undefined>
  running: () => boolean
  lastRunAt: () => number | undefined
  lastReport: () => ConsolidationRunReport | undefined
}

/**
 * Idle-time gate for the consolidation service. The timer only triggers a
 * pass when the host reports idle and the cooldown has elapsed; a pass that
 * was interrupted by cancellation or a budget resumes on the next tick
 * because the service itself is idempotent.
 */
export function createIdleConsolidationRunner(options: IdleConsolidationRunnerOptions): IdleConsolidationRunner {
  const intervalMs = clampInteger(options.intervalMs ?? 60_000, 1_000, 3_600_000)
  const cooldownMs = clampInteger(options.cooldownMs ?? 10 * 60_000, 0, 86_400_000)
  let timer: ReturnType<typeof setInterval> | undefined
  let active: Promise<ConsolidationRunReport | undefined> | undefined
  let lastRunAt: number | undefined
  let lastReport: ConsolidationRunReport | undefined
  let stopped = false

  async function trigger(force: boolean): Promise<ConsolidationRunReport | undefined> {
    if (active)
      return undefined
    if (stopped || options.shouldStop?.())
      return undefined
    const timestamp = Date.now()
    if (!force && (!options.isIdle() || (lastRunAt !== undefined && timestamp - lastRunAt < cooldownMs)))
      return undefined
    lastRunAt = timestamp
    if (options.onIdle) {
      try {
        await options.onIdle()
      }
      catch (error) {
        // Maintenance work is independent from summary consolidation; one
        // failure must not cancel the pass.
        try {
          options.onError?.(error)
        }
        catch {
          // Runner diagnostics must never crash the timer.
        }
      }
    }
    active = (async () => options.service.consolidate(options.scope, {
      ...options.runOptions,
      shouldCancel: () => stopped || options.shouldStop?.() === true || options.runOptions?.shouldCancel?.() === true,
    }))()
    try {
      const report = await active
      lastReport = report
      return report
    }
    catch (error) {
      try {
        options.onError?.(error)
      }
      catch {
        // Runner diagnostics must never crash the timer.
      }
      return undefined
    }
    finally {
      active = undefined
    }
  }

  return {
    start() {
      if (timer || options.shouldStop?.())
        return
      stopped = false
      timer = setInterval(() => {
        if (options.shouldStop?.()) {
          this.stop()
          return
        }
        void trigger(false)
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    runOnce: () => trigger(true),
    running: () => active !== undefined,
    lastRunAt: () => lastRunAt,
    lastReport: () => lastReport,
  }
}

function collectBuckets(
  snapshot: MemoryV4Snapshot,
  filter: ConsolidationScopeFilter,
  granularities: readonly ConsolidationGranularity[],
): ConsolidationBucket[] {
  const factsById = new Map(snapshot.facts.map(fact => [fact.id, fact]))
  const factIdsByEpisode = new Map<string, Set<string>>()
  for (const link of snapshot.evidenceLinks) {
    if (!link.active)
      continue
    const ids = factIdsByEpisode.get(link.episodeId) ?? new Set<string>()
    ids.add(link.factId)
    factIdsByEpisode.set(link.episodeId, ids)
  }

  const buckets = new Map<string, ConsolidationBucket>()
  for (const granularity of granularities) {
    for (const episode of snapshot.episodes) {
      if (episode.contentState === 'deleted' || !matchesScopeFilter(episode.scope, filter))
        continue
      // Summary artifacts always live at owner/agent scope: the validator's
      // scopeCanContain requires an artifact scope to be a superset of every
      // referenced fact scope, and facts captured at owner scope carry no
      // sessionId. The session identity is carried by bucketKey (and thus the
      // stable artifact id) instead.
      const bucketScope = { ownerId: episode.scope.ownerId, agentId: episode.scope.agentId }
      const bucketKey = granularity === 'session'
        ? (episode.scope.sessionId ?? '')
        : utcDayKey(episode.recordedAt)
      const mapKey = `${granularity}\0${scopeKey(bucketScope)}\0${bucketKey}`
      const bucket: ConsolidationBucket = buckets.get(mapKey) ?? {
        granularity,
        bucketKey,
        scope: bucketScope,
        episodes: [],
        facts: [],
      }
      bucket.episodes.push(episode)
      for (const factId of factIdsByEpisode.get(episode.id) ?? []) {
        const fact = factsById.get(factId)
        // Only currently-answerable facts enter a summary; historical and
        // quarantined states remain reachable through fact versions.
        if (fact && fact.status === 'active' && scopeCanContain(bucketScope, fact.scope) && !bucket.facts.includes(fact))
          bucket.facts.push(fact)
      }
      buckets.set(mapKey, bucket)
    }
  }
  return [...buckets.values()].sort((left, right) =>
    left.granularity.localeCompare(right.granularity) || left.bucketKey.localeCompare(right.bucketKey))
}

function indexSummaries(
  snapshot: MemoryV4Snapshot,
  filter: ConsolidationScopeFilter,
  granularities: readonly ConsolidationGranularity[],
): Map<string, MemoryDerivedArtifactV4> {
  const allowed = new Set(granularities)
  return new Map(snapshot.derivedArtifacts
    .filter(artifact => artifact.kind === 'summary' && allowed.has(summaryGranularity(artifact))
      && matchesScopeFilter(artifact.scope, filter))
    .map(artifact => [artifact.id, artifact]))
}

/** The granularity is encoded in the stable artifact id namespace. */
function summaryGranularity(artifact: MemoryDerivedArtifactV4): ConsolidationGranularity {
  return artifact.id.startsWith('consolidation-summary:session:') ? 'session' : 'day'
}

function summaryArtifactId(bucket: ConsolidationBucket): string {
  return stableId(`consolidation-summary:${bucket.granularity}`, `${scopeKey(bucket.scope)}\0${bucket.bucketKey}`)
}

function scopeKey(scope: MemoryV4Scope): string {
  return JSON.stringify([scope.ownerId, scope.agentId, scope.sessionId ?? ''])
}

function matchesScopeFilter(scope: MemoryV4Scope, filter: ConsolidationScopeFilter): boolean {
  return scope.ownerId === filter.ownerId
    && (filter.agentId === undefined || scope.agentId === filter.agentId)
}

/** Same containment rule the snapshot validator enforces for derived artifacts. */
function scopeCanContain(container: MemoryV4Scope, contained: MemoryV4Scope): boolean {
  return container.ownerId === contained.ownerId
    && container.agentId === contained.agentId
    && (container.sessionId === undefined || container.sessionId === contained.sessionId)
}

function normalizeGranularities(value?: readonly ConsolidationGranularity[]): ConsolidationGranularity[] {
  const granularities = [...new Set(value ?? ['session', 'day'] as const)]
  if (granularities.length === 0 || granularities.some(item => item !== 'session' && item !== 'day'))
    throw new Error('Consolidation granularity must be a non-empty subset of session and day')
  return granularities
}

function summarizerVersion(summarizer: ConsolidationSummarizer): string {
  const version = (summarizer as { version?: unknown }).version
  return typeof version === 'string' && version.trim() ? version.trim() : MEMORY_DETERMINISTIC_SUMMARIZER_VERSION
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length)
    return false
  const set = new Set(left)
  for (const value of right) {
    if (!set.has(value))
      return false
  }
  return true
}

function utcDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const clamped = Math.floor(value)
  if (!Number.isFinite(clamped))
    throw new Error(`Expected a finite number, received ${String(value)}`)
  return Math.min(maximum, Math.max(minimum, clamped))
}

function stableId(namespace: string, source: string): string {
  return `${namespace}:${sha256(source).slice(0, 24)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function finish(
  report: ConsolidationRunReport,
  now: () => number,
  startedAt: number,
): ConsolidationRunReport {
  report.elapsedMs = Math.max(0, now() - startedAt)
  return report
}
