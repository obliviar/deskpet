import { createHash, randomUUID } from 'node:crypto'
import type {
  MemoryV4ShadowRecallResult,
  V3V4ShadowComparison,
} from '@deskpet/memory'

export const MEMORY_V4_INTERNAL_REVIEW_VERSION = 'memory-v4-internal-candidate-review-v1'

export interface MemoryV4InternalCandidateReview {
  version: typeof MEMORY_V4_INTERNAL_REVIEW_VERSION
  reviewId: string
  mode: 'internal-candidate'
  authoritativeAnswerSource: 'v3'
  v4InfluencedAnswer: false
  createdAt: number
  queryHash: string
  queryIntent: string
  v3: {
    retrievedCount: number
    injectedCount: number
  }
  v4: {
    abstained: boolean
    bestEvidenceScore: number
    threshold: number
    calibrationVersion: string
    candidates: Array<{
      factId: string
      sourceMemoryId?: string
      content: string
      score: number
      routes: string[]
      summaryIds: string[]
      status: string
      verificationState: string
    }>
  }
  agreement: {
    overlapCount: number
    recallAtK: number
    precisionAtK: number
    jaccard: number
  }
}

export interface MemoryV4InternalReviewStatus {
  version: typeof MEMORY_V4_INTERNAL_REVIEW_VERSION
  enabled: boolean
  pending: number
  begun: number
  claimed: number
  completed: number
  dropped: number
  timedOut: number
  cancelled: number
  last?: {
    queryHash: string
    createdAt: number
    v4Abstained: boolean
    candidateCount: number
    overlapCount: number
  }
}

export interface MemoryV4InternalReviewHandle {
  finish: () => Promise<MemoryV4InternalCandidateReview | undefined>
}

export interface MemoryV4InternalReviewController {
  /** Runtime-safe stage switch. Disabling settles every pending review. */
  setEnabled: (enabled: boolean) => number
  begin: (query: string) => MemoryV4InternalReviewHandle | undefined
  claim: (query: string) => string | undefined
  complete: (
    requestId: string,
    comparison: V3V4ShadowComparison,
    recall: MemoryV4ShadowRecallResult,
  ) => MemoryV4InternalCandidateReview | undefined
  drop: (requestId: string, reason: string) => void
  cancelAll: () => number
  status: () => MemoryV4InternalReviewStatus
}

interface PendingReview {
  id: string
  queryKey: string
  claimed: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout>
  promise: Promise<MemoryV4InternalCandidateReview | undefined>
  resolve: (value: MemoryV4InternalCandidateReview | undefined) => void
}

/**
 * Coordinate an ephemeral, local-only V4 review payload with a completed V3
 * turn. Query plaintext is never retained: pending requests are matched by a
 * SHA-256 key and candidate content leaves this controller when settled.
 */
export function createMemoryV4InternalReviewController(options: {
  enabled?: boolean
  timeoutMs?: number
  now?: () => number
  idFactory?: () => string
} = {}): MemoryV4InternalReviewController {
  let enabled = options.enabled === true
  const timeoutMs = clampInteger(options.timeoutMs ?? 1_500, 100, 10_000)
  const now = options.now ?? Date.now
  const idFactory = options.idFactory ?? randomUUID
  const pendingById = new Map<string, PendingReview>()
  const idsByQueryKey = new Map<string, string[]>()
  let begun = 0
  let claimed = 0
  let completed = 0
  let dropped = 0
  let timedOut = 0
  let cancelled = 0
  let last: MemoryV4InternalReviewStatus['last']

  function removePending(request: PendingReview): void {
    pendingById.delete(request.id)
    const ids = idsByQueryKey.get(request.queryKey)
    if (!ids)
      return
    const index = ids.indexOf(request.id)
    if (index >= 0)
      ids.splice(index, 1)
    if (ids.length === 0)
      idsByQueryKey.delete(request.queryKey)
  }

  function settle(request: PendingReview, value: MemoryV4InternalCandidateReview | undefined): boolean {
    if (request.settled)
      return false
    request.settled = true
    clearTimeout(request.timer)
    removePending(request)
    request.resolve(value)
    return true
  }

  function begin(query: string): MemoryV4InternalReviewHandle | undefined {
    if (!enabled || !query.trim())
      return undefined
    const queryKey = queryFingerprint(query)
    const id = idFactory()
    let resolve!: PendingReview['resolve']
    const promise = new Promise<MemoryV4InternalCandidateReview | undefined>((settlePromise) => {
      resolve = settlePromise
    })
    const request = {
      id,
      queryKey,
      claimed: false,
      settled: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      promise,
      resolve,
    }
    request.timer = setTimeout(() => {
      if (settle(request, undefined)) {
        timedOut += 1
        dropped += 1
      }
    }, timeoutMs)
    request.timer.unref?.()
    pendingById.set(id, request)
    idsByQueryKey.set(queryKey, [...(idsByQueryKey.get(queryKey) ?? []), id])
    begun += 1
    return {
      finish: () => {
        if (!request.claimed && settle(request, undefined))
          cancelled += 1
        return request.promise
      },
    }
  }

  function claim(query: string): string | undefined {
    if (!enabled)
      return undefined
    const ids = idsByQueryKey.get(queryFingerprint(query))
    while (ids && ids.length > 0) {
      const id = ids.shift()!
      const request = pendingById.get(id)
      if (!request || request.settled)
        continue
      request.claimed = true
      claimed += 1
      if (ids.length === 0)
        idsByQueryKey.delete(request.queryKey)
      return id
    }
    return undefined
  }

  function complete(
    requestId: string,
    comparison: V3V4ShadowComparison,
    recall: MemoryV4ShadowRecallResult,
  ): MemoryV4InternalCandidateReview | undefined {
    const request = pendingById.get(requestId)
    if (!request || request.settled)
      return undefined
    const review = buildReview(request.id, comparison, recall, now())
    if (!settle(request, review))
      return undefined
    completed += 1
    last = {
      queryHash: review.queryHash,
      createdAt: review.createdAt,
      v4Abstained: review.v4.abstained,
      candidateCount: review.v4.candidates.length,
      overlapCount: review.agreement.overlapCount,
    }
    return review
  }

  function drop(requestId: string, _reason: string): void {
    const request = pendingById.get(requestId)
    if (request && settle(request, undefined))
      dropped += 1
  }

  function cancelAll(): number {
    const requests = [...pendingById.values()]
    for (const request of requests) {
      if (settle(request, undefined))
        cancelled += 1
    }
    return requests.length
  }

  function setEnabled(nextEnabled: boolean): number {
    if (enabled === nextEnabled)
      return 0
    enabled = nextEnabled
    return enabled ? 0 : cancelAll()
  }

  return {
    setEnabled,
    begin,
    claim,
    complete,
    drop,
    cancelAll,
    status: () => ({
      version: MEMORY_V4_INTERNAL_REVIEW_VERSION,
      enabled,
      pending: pendingById.size,
      begun,
      claimed,
      completed,
      dropped,
      timedOut,
      cancelled,
      ...(last ? { last } : {}),
    }),
  }
}

function buildReview(
  reviewId: string,
  comparison: V3V4ShadowComparison,
  recall: MemoryV4ShadowRecallResult,
  createdAt: number,
): MemoryV4InternalCandidateReview {
  const abstention = recall.abstention
  return {
    version: MEMORY_V4_INTERNAL_REVIEW_VERSION,
    reviewId,
    mode: 'internal-candidate',
    authoritativeAnswerSource: 'v3',
    v4InfluencedAnswer: false,
    createdAt,
    queryHash: comparison.queryHash,
    queryIntent: boundedString(recall.queryIntent, 64, 'unknown'),
    v3: {
      retrievedCount: comparison.v3RetrievedCount,
      injectedCount: comparison.v3InjectedCount,
    },
    v4: {
      abstained: abstention?.abstained ?? recall.hits.length === 0,
      bestEvidenceScore: clamp01(abstention?.bestScore ?? recall.hits[0]?.score ?? 0),
      threshold: nonNegative(abstention?.threshold ?? 0),
      calibrationVersion: boundedString(abstention?.version, 128, 'unknown'),
      candidates: recall.hits.slice(0, 10).map(hit => ({
        factId: boundedString(hit.factId, 256, 'unknown'),
        ...(hit.sourceMemoryId ? { sourceMemoryId: boundedString(hit.sourceMemoryId, 256, 'unknown') } : {}),
        content: boundedString(hit.content, 1_000, ''),
        score: clamp01(hit.score),
        routes: uniqueStrings(hit.routes, 12, 64),
        summaryIds: uniqueStrings(hit.summaryIds, 12, 256),
        status: boundedString(hit.status, 64, 'unknown'),
        verificationState: boundedString(hit.verificationState, 64, 'unknown'),
      })),
    },
    agreement: {
      overlapCount: Math.max(0, Math.floor(comparison.overlapCount)),
      recallAtK: clamp01(comparison.v3AgreementRecallAtK),
      precisionAtK: clamp01(comparison.v3AgreementPrecisionAtK),
      jaccard: clamp01(comparison.jaccard),
    },
  }
}

function queryFingerprint(query: string): string {
  return createHash('sha256').update(query.normalize('NFKC').trim()).digest('hex')
}

function uniqueStrings(values: readonly string[], maximumItems: number, maximumLength: number): string[] {
  return [...new Set(values.map(value => boundedString(value, maximumLength, '')).filter(Boolean))].slice(0, maximumItems)
}

function boundedString(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function clamp01(value: unknown): number {
  return Math.min(1, nonNegative(value))
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum
}
