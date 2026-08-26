export const MEMORY_V4_INTERNAL_FEEDBACK_VERSION = 'memory-v4-internal-feedback-v2'
export const MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION = 2 as const

export const MEMORY_V4_INTERNAL_FEEDBACK_LABELS = [
  'correct',
  'should-not-use',
  'incorrect',
  'expired',
  'missing',
  'no-memory',
  'privacy',
] as const

export type MemoryV4InternalFeedbackLabel = typeof MEMORY_V4_INTERNAL_FEEDBACK_LABELS[number]

export interface MemoryV4InternalFeedbackCandidate {
  factId: string
  sourceMemoryId?: string
  score: number
}

export interface MemoryV4InternalFeedbackReviewInput {
  reviewId: string
  queryHash: string
  queryIntent: string
  calibrationVersion: string
  bestEvidenceScore: number
  createdAt: number
  candidates: readonly MemoryV4InternalFeedbackCandidate[]
}

export interface MemoryV4InternalFeedbackPersistence {
  load: () => string | undefined
  save: (payload: string) => void
  storagePath?: string
}

interface PersistedLabel {
  label: MemoryV4InternalFeedbackLabel
  recordedAt: number
}

interface PersistedReview {
  reviewId: string
  queryHash: string
  queryIntent: string
  calibrationVersion: string
  bestEvidenceScore: number
  createdAt: number
  candidates: MemoryV4InternalFeedbackCandidate[]
  labels: Record<string, PersistedLabel>
  queryLabel?: PersistedLabel
}

interface MemoryV4InternalFeedbackSnapshot {
  schemaVersion: typeof MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION
  createdAt: number
  updatedAt: number
  droppedReviews: number
  reviews: PersistedReview[]
}

export interface MemoryV4InternalFeedbackStatus {
  version: typeof MEMORY_V4_INTERNAL_FEEDBACK_VERSION
  storagePath?: string
  encrypted: boolean
  retainedReviews: number
  labeledCandidates: number
  queryFeedback: number
  missingFeedback: number
  noMemoryFeedback: number
  droppedReviews: number
  pendingWrites: number
  byLabel: Record<MemoryV4InternalFeedbackLabel, number>
  firstReviewAt?: number
  lastReviewAt?: number
}

export type MemoryV4InternalFeedbackResult =
  | { ok: true; label: MemoryV4InternalFeedbackLabel }
  | { ok: false; reason: 'unknown-review' | 'unknown-candidate' | 'invalid-target' }

export interface MemoryV4InternalFeedbackStore {
  registerReview: (review: MemoryV4InternalFeedbackReviewInput) => void
  recordFeedback: (input: {
    reviewId: string
    factId?: string
    label: MemoryV4InternalFeedbackLabel
  }) => MemoryV4InternalFeedbackResult
  feedbackFor: (reviewId: string, factId?: string) => MemoryV4InternalFeedbackLabel | undefined
  calibrationReviews: () => MemoryV4InternalFeedbackCalibrationReview[]
  removeFactIds: (factIds: readonly string[]) => number
  hasFact: (factId: string) => boolean
  status: () => MemoryV4InternalFeedbackStatus
  flush: () => void
  clear: () => void
}

export interface MemoryV4InternalFeedbackCalibrationCandidate extends MemoryV4InternalFeedbackCandidate {
  label?: Exclude<MemoryV4InternalFeedbackLabel, 'missing' | 'no-memory'>
  recordedAt?: number
}

export interface MemoryV4InternalFeedbackCalibrationReview {
  reviewId: string
  queryHash: string
  queryIntent: string
  calibrationVersion: string
  bestEvidenceScore: number
  createdAt: number
  candidates: MemoryV4InternalFeedbackCalibrationCandidate[]
  queryLabel?: Extract<MemoryV4InternalFeedbackLabel, 'missing' | 'no-memory'>
  queryLabelRecordedAt?: number
}

/**
 * Stores bounded human labels for Internal V4 calibration. A review must be
 * registered before it can be labelled, so renderer input cannot invent a
 * query/candidate pair. The schema deliberately excludes query, answer and
 * memory plaintext; only a query hash, IDs, scores and labels are retained.
 */
export function createMemoryV4InternalFeedbackStore(options: {
  persistence?: MemoryV4InternalFeedbackPersistence
  encrypted?: boolean
  maxReviews?: number
  flushDelayMs?: number
  now?: () => number
  onPersistenceError?: (error: unknown) => void
} = {}): MemoryV4InternalFeedbackStore {
  const now = options.now ?? Date.now
  const maxReviews = clampInteger(options.maxReviews ?? 4_096, 100, 100_000)
  const flushDelayMs = clampInteger(options.flushDelayMs ?? 1_000, 0, 60_000)
  const loaded = options.persistence?.load()
  let snapshot = loaded ? parseSnapshot(loaded) : emptySnapshot(now())
  trimSnapshot()
  let dirty = false
  let pendingWrites = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.persistence && loaded === undefined)
    options.persistence.save(JSON.stringify(snapshot))

  function trimSnapshot(): void {
    if (snapshot.reviews.length <= maxReviews)
      return
    const overflow = snapshot.reviews.length - maxReviews
    snapshot.reviews.splice(0, overflow)
    snapshot.droppedReviews += overflow
  }

  function reportPersistenceError(error: unknown): void {
    try {
      options.onPersistenceError?.(error)
    }
    catch {
      // Diagnostics cannot be allowed to affect the authoritative answer path.
    }
  }

  function flushSafely(): void {
    try {
      flush()
    }
    catch (error) {
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

  function registerReview(input: MemoryV4InternalFeedbackReviewInput): void {
    const review = normalizeReview(input)
    const existingIndex = snapshot.reviews.findIndex(item => item.reviewId === review.reviewId)
    if (existingIndex >= 0) {
      const existing = snapshot.reviews[existingIndex]!
      const eligibleIds = new Set(review.candidates.map(candidate => candidate.factId))
      review.labels = Object.fromEntries(Object.entries(existing.labels)
        .filter(([factId]) => eligibleIds.has(factId)))
      review.queryLabel = existing.queryLabel
      snapshot.reviews.splice(existingIndex, 1)
    }
    snapshot.reviews.push(review)
    trimSnapshot()
    snapshot.updatedAt = Math.max(snapshot.updatedAt, review.createdAt)
    scheduleFlush()
  }

  function recordFeedback(input: {
    reviewId: string
    factId?: string
    label: MemoryV4InternalFeedbackLabel
  }): MemoryV4InternalFeedbackResult {
    const reviewId = optionalId(input.reviewId)
    const factId = optionalId(input.factId)
    const review = snapshot.reviews.find(item => item.reviewId === reviewId)
    if (!review)
      return { ok: false, reason: 'unknown-review' }
    if (!isMemoryV4InternalFeedbackLabel(input.label))
      return { ok: false, reason: 'invalid-target' }
    const recordedAt = timestamp(now(), 'recordedAt')
    if (input.label === 'missing' || input.label === 'no-memory') {
      if (factId)
        return { ok: false, reason: 'invalid-target' }
      if (input.label === 'no-memory' && Object.values(review.labels).some(feedback => feedback.label === 'correct'))
        return { ok: false, reason: 'invalid-target' }
      review.queryLabel = { label: input.label, recordedAt }
    }
    else {
      if (!factId)
        return { ok: false, reason: 'invalid-target' }
      if (!review.candidates.some(candidate => candidate.factId === factId))
        return { ok: false, reason: 'unknown-candidate' }
      if (input.label === 'correct' && review.queryLabel?.label === 'no-memory')
        return { ok: false, reason: 'invalid-target' }
      review.labels[factId] = { label: input.label, recordedAt }
    }
    snapshot.updatedAt = Math.max(snapshot.updatedAt, recordedAt)
    scheduleFlush()
    return { ok: true, label: input.label }
  }

  function removeFactIds(factIds: readonly string[]): number {
    const targets = new Set(factIds.map(optionalId).filter((id): id is string => !!id))
    if (targets.size === 0)
      return 0
    let removed = 0
    const retained: PersistedReview[] = []
    for (const review of snapshot.reviews) {
      const candidates = review.candidates.filter((candidate) => {
        if (!targets.has(candidate.factId) && !targets.has(candidate.sourceMemoryId ?? ''))
          return true
        removed += 1
        return false
      })
      const eligibleIds = new Set(candidates.map(candidate => candidate.factId))
      const labels = Object.fromEntries(Object.entries(review.labels)
        .filter(([factId]) => eligibleIds.has(factId)))
      if (candidates.length > 0 || review.queryLabel)
        retained.push({ ...review, candidates, labels })
    }
    if (removed > 0) {
      snapshot.reviews = retained
      snapshot.updatedAt = timestamp(now(), 'updatedAt')
      scheduleFlush()
    }
    return removed
  }

  return {
    registerReview,
    recordFeedback,
    feedbackFor: (reviewId, factId) => {
      const review = snapshot.reviews.find(item => item.reviewId === reviewId)
      return factId ? review?.labels[factId]?.label : review?.queryLabel?.label
    },
    calibrationReviews: () => snapshot.reviews.map(review => ({
      reviewId: review.reviewId,
      queryHash: review.queryHash,
      queryIntent: review.queryIntent,
      calibrationVersion: review.calibrationVersion,
      bestEvidenceScore: review.bestEvidenceScore,
      createdAt: review.createdAt,
      candidates: review.candidates.map(candidate => ({
        ...candidate,
        ...(review.labels[candidate.factId]
          ? {
              label: review.labels[candidate.factId]!.label as Exclude<MemoryV4InternalFeedbackLabel, 'missing' | 'no-memory'>,
              recordedAt: review.labels[candidate.factId]!.recordedAt,
            }
          : {}),
      })),
      ...(review.queryLabel
        ? {
            queryLabel: review.queryLabel.label as Extract<MemoryV4InternalFeedbackLabel, 'missing' | 'no-memory'>,
            queryLabelRecordedAt: review.queryLabel.recordedAt,
          }
        : {}),
    })),
    removeFactIds,
    hasFact: factId => snapshot.reviews.some(review => review.candidates.some(candidate => (
      candidate.factId === factId || candidate.sourceMemoryId === factId
    ))),
    status: () => buildStatus(snapshot, options.persistence?.storagePath, options.encrypted === true && !!options.persistence, pendingWrites),
    flush,
    clear() {
      snapshot = emptySnapshot(now())
      scheduleFlush()
      flushSafely()
    },
  }
}

function normalizeReview(input: MemoryV4InternalFeedbackReviewInput): PersistedReview {
  const reviewId = requiredId(input.reviewId, 'reviewId')
  if (typeof input.queryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.queryHash))
    throw new Error('Internal feedback queryHash is invalid')
  const candidates = [...new Map(input.candidates.slice(0, 10).map(candidate => {
    const factId = requiredId(candidate.factId, 'factId')
    return [factId, {
      factId,
      ...(candidate.sourceMemoryId ? { sourceMemoryId: requiredId(candidate.sourceMemoryId, 'sourceMemoryId') } : {}),
      score: clamp01(candidate.score),
    }]
  })).values()]
  return {
    reviewId,
    queryHash: input.queryHash,
    queryIntent: boundedString(input.queryIntent, 64, 'unknown'),
    calibrationVersion: boundedString(input.calibrationVersion, 160, 'unknown'),
    bestEvidenceScore: clamp01(input.bestEvidenceScore),
    createdAt: timestamp(input.createdAt, 'createdAt'),
    candidates,
    labels: {},
  }
}

function parseSnapshot(payload: string): MemoryV4InternalFeedbackSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse Internal feedback: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Internal feedback payload must be an object')
  const value = parsed as {
    schemaVersion?: unknown
    createdAt?: unknown
    updatedAt?: unknown
    droppedReviews?: unknown
    reviews?: unknown
  }
  if ((value.schemaVersion !== 1 && value.schemaVersion !== MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION)
    || !Array.isArray(value.reviews))
    throw new Error('Unsupported Internal feedback schema')
  return {
    schemaVersion: MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION,
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
    droppedReviews: nonNegativeInteger(value.droppedReviews, 'droppedReviews'),
    reviews: value.reviews.map(review => parseReview(review, value.schemaVersion as 1 | 2)),
  }
}

function parseReview(value: unknown, schemaVersion: 1 | 2): PersistedReview {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Internal feedback review is invalid')
  const source = value as Partial<PersistedReview> & { missing?: PersistedLabel }
  if (!Array.isArray(source.candidates))
    throw new Error('Internal feedback candidates are invalid')
  const base = normalizeReview({
    reviewId: requiredId(source.reviewId, 'reviewId'),
    queryHash: source.queryHash ?? '',
    queryIntent: source.queryIntent ?? 'unknown',
    calibrationVersion: source.calibrationVersion ?? 'unknown',
    bestEvidenceScore: source.bestEvidenceScore
      ?? Math.max(0, ...source.candidates.map(candidate => clamp01(candidate.score))),
    createdAt: source.createdAt ?? 0,
    candidates: source.candidates,
  })
  if (!source.labels || typeof source.labels !== 'object' || Array.isArray(source.labels))
    throw new Error('Internal feedback labels are invalid')
  const eligibleIds = new Set(base.candidates.map(candidate => candidate.factId))
  for (const [factId, raw] of Object.entries(source.labels)) {
    if (!eligibleIds.has(factId) || !raw || typeof raw !== 'object')
      continue
    const label = (raw as Partial<PersistedLabel>).label
    if (!isMemoryV4InternalFeedbackLabel(label) || label === 'missing' || label === 'no-memory')
      throw new Error('Internal feedback candidate label is invalid')
    base.labels[factId] = {
      label,
      recordedAt: timestamp((raw as Partial<PersistedLabel>).recordedAt, 'recordedAt'),
    }
  }
  const queryLabel = schemaVersion === 1 ? source.missing : source.queryLabel
  if (queryLabel !== undefined) {
    if (!queryLabel || (queryLabel.label !== 'missing' && queryLabel.label !== 'no-memory'))
      throw new Error('Internal feedback query label is invalid')
    base.queryLabel = {
      label: queryLabel.label,
      recordedAt: timestamp(queryLabel.recordedAt, 'recordedAt'),
    }
  }
  return base
}

function emptySnapshot(now: number): MemoryV4InternalFeedbackSnapshot {
  const createdAt = timestamp(now, 'createdAt')
  return {
    schemaVersion: MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION,
    createdAt,
    updatedAt: createdAt,
    droppedReviews: 0,
    reviews: [],
  }
}

function buildStatus(
  snapshot: MemoryV4InternalFeedbackSnapshot,
  storagePath: string | undefined,
  encrypted: boolean,
  pendingWrites: number,
): MemoryV4InternalFeedbackStatus {
  const byLabel = Object.fromEntries(MEMORY_V4_INTERNAL_FEEDBACK_LABELS.map(label => [label, 0])) as Record<MemoryV4InternalFeedbackLabel, number>
  let labeledCandidates = 0
  let queryFeedback = 0
  let missingFeedback = 0
  let noMemoryFeedback = 0
  for (const review of snapshot.reviews) {
    for (const feedback of Object.values(review.labels)) {
      byLabel[feedback.label] += 1
      labeledCandidates += 1
    }
    if (review.queryLabel) {
      byLabel[review.queryLabel.label] += 1
      queryFeedback += 1
      if (review.queryLabel.label === 'missing')
        missingFeedback += 1
      else
        noMemoryFeedback += 1
    }
  }
  const timestamps = snapshot.reviews.map(review => review.createdAt).sort((left, right) => left - right)
  return {
    version: MEMORY_V4_INTERNAL_FEEDBACK_VERSION,
    ...(storagePath ? { storagePath } : {}),
    encrypted,
    retainedReviews: snapshot.reviews.length,
    labeledCandidates,
    queryFeedback,
    missingFeedback,
    noMemoryFeedback,
    droppedReviews: snapshot.droppedReviews,
    pendingWrites,
    byLabel,
    ...(timestamps[0] === undefined ? {} : { firstReviewAt: timestamps[0] }),
    ...(timestamps.at(-1) === undefined ? {} : { lastReviewAt: timestamps.at(-1) }),
  }
}

export function isMemoryV4InternalFeedbackLabel(value: unknown): value is MemoryV4InternalFeedbackLabel {
  return MEMORY_V4_INTERNAL_FEEDBACK_LABELS.includes(value as MemoryV4InternalFeedbackLabel)
}

function requiredId(value: unknown, label: string): string {
  const normalized = optionalId(value)
  if (!normalized)
    throw new Error(`Internal feedback ${label} is invalid`)
  return normalized
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : undefined
}

function boundedString(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Internal feedback ${label} is invalid`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Internal feedback ${label} is invalid`)
  return value
}

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum
}
