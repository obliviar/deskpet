import { createHash } from 'node:crypto'
import {
  fitMemoryV4LocalCalibration,
  type MemoryV4CalibrationObservation,
  type MemoryV4LocalCalibrationArtifact,
} from './memory-v4-local-calibration'
import type { MemoryV4InternalFeedbackCalibrationReview } from './memory-v4-internal-feedback'

export const MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION = 'memory-v4-feedback-calibration-dataset-v1'
export const MEMORY_V4_FEEDBACK_CALIBRATION_GATE_VERSION = 'memory-v4-feedback-calibration-gate-v1'
const DEFAULT_SPLIT_SALT = 'deskpet-v4-feedback-query-group-split-v1'

export interface MemoryV4FeedbackCalibrationPolicy {
  calibrationPermille: number
  minimumCalibrationSamples: number
  minimumValidationSamples: number
  minimumCalibrationPositives: number
  minimumCalibrationNegatives: number
  minimumValidationPositives: number
  minimumValidationNegatives: number
  minimumValidationRankingCases: number
  minimumValidationTop1Lower95: number
  maximumValidationMissingUpper95: number
  maximumConflictRate: number
  maximumUnknownIntentRate: number
  maximumPrivacyRiskReviews: number
}

export const DEFAULT_MEMORY_V4_FEEDBACK_CALIBRATION_POLICY: Readonly<MemoryV4FeedbackCalibrationPolicy> = Object.freeze({
  calibrationPermille: 350,
  minimumCalibrationSamples: 500,
  minimumValidationSamples: 1_000,
  minimumCalibrationPositives: 100,
  minimumCalibrationNegatives: 100,
  minimumValidationPositives: 200,
  minimumValidationNegatives: 200,
  minimumValidationRankingCases: 200,
  minimumValidationTop1Lower95: 0.85,
  maximumValidationMissingUpper95: 0.10,
  maximumConflictRate: 0.01,
  maximumUnknownIntentRate: 0.05,
  maximumPrivacyRiskReviews: 0,
})

export interface MemoryV4FeedbackSplitStats {
  samples: number
  positives: number
  negatives: number
  uniqueQueries: number
  unknownIntent: number
}

export interface MemoryV4FeedbackCalibrationAudit {
  sourceReviews: number
  selectedVersionReviews: number
  confirmedReviews: number
  unconfirmedReviews: number
  excludedOtherVersionReviews: number
  adjudicatedQueries: number
  incompleteQueries: number
  conflictingQueries: number
  duplicateReviews: number
  privacyRiskReviews: number
  missingQueries: number
  noMemoryQueries: number
  unknownIntentQueries: number
}

export interface MemoryV4FeedbackRankingValidation {
  cases: number
  top1Correct: number
  top1Accuracy: number
  top1Confidence95: ProportionInterval
  answerableCases: number
  missingCases: number
  missingRate: number
  missingConfidence95: ProportionInterval
}

export interface MemoryV4FeedbackCalibrationDataset {
  version: typeof MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION
  datasetVersion: string
  datasetFingerprint: string
  createdAt: number
  calibrationVersion: string
  splitSalt: string
  policy: MemoryV4FeedbackCalibrationPolicy
  calibration: MemoryV4CalibrationObservation[]
  validation: MemoryV4CalibrationObservation[]
  calibrationStats: MemoryV4FeedbackSplitStats
  validationStats: MemoryV4FeedbackSplitStats
  rankingValidation: MemoryV4FeedbackRankingValidation
  audit: MemoryV4FeedbackCalibrationAudit
}

export type MemoryV4FeedbackCalibrationGateDecision = 'insufficient-data' | 'blocked' | 'eligible-for-offline-fit'

export interface MemoryV4FeedbackCalibrationGateCheck {
  id: string
  kind: 'evidence' | 'quality' | 'redline'
  passed: boolean
  observed: number | string
  required: number | string
}

export interface MemoryV4FeedbackCalibrationGateReport {
  version: typeof MEMORY_V4_FEEDBACK_CALIBRATION_GATE_VERSION
  decision: MemoryV4FeedbackCalibrationGateDecision
  automaticPromotion: false
  authoritativeAnswerSource: 'v3'
  datasetVersion: string
  datasetFingerprint: string
  calibrationVersion: string
  checks: MemoryV4FeedbackCalibrationGateCheck[]
  failedCheckIds: string[]
  reason: string
}

interface ProportionInterval {
  successes: number
  total: number
  estimate: number
  lower: number
  upper: number
}

interface AssessedReview {
  review: MemoryV4InternalFeedbackCalibrationReview
  relevant?: boolean
  conflict: boolean
  privacyRisk: boolean
  rankingCorrect?: boolean
  missing: boolean
  noMemory: boolean
  latestAt: number
}

/**
 * Produces an immutable, fingerprinted snapshot without query or memory
 * plaintext. Query hashes and shared fact identities are grouped before the
 * deterministic split so correlated examples cannot cross train/validation.
 */
export function freezeMemoryV4InternalFeedbackDataset(
  reviews: readonly MemoryV4InternalFeedbackCalibrationReview[],
  options: {
    datasetVersion?: string
    calibrationVersion?: string
    splitSalt?: string
    createdAt?: number
    policy?: Partial<MemoryV4FeedbackCalibrationPolicy>
  } = {},
): MemoryV4FeedbackCalibrationDataset {
  const policy = normalizePolicy(options.policy)
  const splitSalt = boundedString(options.splitSalt, 160, DEFAULT_SPLIT_SALT)
  const calibrationVersion = selectCalibrationVersion(reviews, options.calibrationVersion)
  const selected = reviews.filter(review => review.calibrationVersion === calibrationVersion)
  const confirmed = selected.filter(review => review.confirmedAt !== undefined)
  const assessed = confirmed.map(assessReview)
  const groups = new Map<string, AssessedReview[]>()
  for (const review of assessed)
    groups.set(review.review.queryHash, [...(groups.get(review.review.queryHash) ?? []), review])

  let incompleteQueries = 0
  let conflictingQueries = 0
  let duplicateReviews = 0
  let privacyRiskReviews = 0
  let missingQueries = 0
  let noMemoryQueries = 0
  const chosen: AssessedReview[] = []
  for (const group of groups.values()) {
    duplicateReviews += Math.max(0, group.length - 1)
    privacyRiskReviews += group.filter(review => review.privacyRisk).length
    const determinate = group.filter(review => review.relevant !== undefined)
    if (group.some(review => review.conflict)
      || new Set(determinate.map(review => review.relevant)).size > 1) {
      conflictingQueries += 1
      continue
    }
    if (determinate.length === 0) {
      incompleteQueries += 1
      continue
    }
    const latest = [...determinate].sort((left, right) => right.latestAt - left.latestAt
      || right.review.reviewId.localeCompare(left.review.reviewId))[0]!
    if (latest.privacyRisk)
      continue
    if (latest.missing)
      missingQueries += 1
    if (latest.noMemory)
      noMemoryQueries += 1
    chosen.push(latest)
  }

  const splitByQuery = assignLeakageSafeSplits(chosen, splitSalt, policy.calibrationPermille)
  const calibration: MemoryV4CalibrationObservation[] = []
  const validation: MemoryV4CalibrationObservation[] = []
  const validationReviews: AssessedReview[] = []
  for (const item of chosen) {
    const observation = {
      id: sha256(`observation\0${item.review.queryHash}`),
      intent: boundedString(item.review.queryIntent, 64, 'unknown'),
      bestScore: clamp01(item.review.bestEvidenceScore),
      relevant: item.relevant!,
    }
    if (splitByQuery.get(item.review.queryHash) === 'calibration')
      calibration.push(observation)
    else {
      validation.push(observation)
      validationReviews.push(item)
    }
  }
  sortObservations(calibration)
  sortObservations(validation)

  const fingerprint = fingerprintDatasetSource(selected, splitSalt, policy)
  const datasetVersion = boundedString(
    options.datasetVersion,
    200,
    `${MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION}:${calibrationVersion}:${fingerprint.slice(0, 12)}`,
  )
  const audit: MemoryV4FeedbackCalibrationAudit = {
    sourceReviews: reviews.length,
    selectedVersionReviews: selected.length,
    confirmedReviews: confirmed.length,
    unconfirmedReviews: selected.length - confirmed.length,
    excludedOtherVersionReviews: reviews.length - selected.length,
    adjudicatedQueries: chosen.length,
    incompleteQueries,
    conflictingQueries,
    duplicateReviews,
    privacyRiskReviews,
    missingQueries,
    noMemoryQueries,
    unknownIntentQueries: chosen.filter(review => normalizeIntent(review.review.queryIntent) === 'unknown').length,
  }
  return {
    version: MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION,
    datasetVersion,
    datasetFingerprint: fingerprint,
    createdAt: normalizeTimestamp(options.createdAt ?? Date.now()),
    calibrationVersion,
    splitSalt,
    policy,
    calibration,
    validation,
    calibrationStats: splitStats(calibration),
    validationStats: splitStats(validation),
    rankingValidation: rankingStats(validationReviews),
    audit,
  }
}

/** A separate fail-closed pre-gate; passing does not unlock any rollout stage. */
export function evaluateMemoryV4FeedbackCalibrationGate(
  dataset: MemoryV4FeedbackCalibrationDataset,
): MemoryV4FeedbackCalibrationGateReport {
  const { policy } = dataset
  const checks: MemoryV4FeedbackCalibrationGateCheck[] = []
  const add = (
    id: string,
    kind: MemoryV4FeedbackCalibrationGateCheck['kind'],
    observed: number | string,
    required: number | string,
    passed: boolean,
  ) => checks.push({ id, kind, observed, required, passed })

  add('known-calibration-version', 'evidence', dataset.calibrationVersion, 'non-empty and not unknown', dataset.calibrationVersion !== 'none' && dataset.calibrationVersion !== 'unknown')
  add('minimum-calibration-samples', 'evidence', dataset.calibrationStats.samples, policy.minimumCalibrationSamples, dataset.calibrationStats.samples >= policy.minimumCalibrationSamples)
  add('minimum-validation-samples', 'evidence', dataset.validationStats.samples, policy.minimumValidationSamples, dataset.validationStats.samples >= policy.minimumValidationSamples)
  add('minimum-calibration-positives', 'evidence', dataset.calibrationStats.positives, policy.minimumCalibrationPositives, dataset.calibrationStats.positives >= policy.minimumCalibrationPositives)
  add('minimum-calibration-negatives', 'evidence', dataset.calibrationStats.negatives, policy.minimumCalibrationNegatives, dataset.calibrationStats.negatives >= policy.minimumCalibrationNegatives)
  add('minimum-validation-positives', 'evidence', dataset.validationStats.positives, policy.minimumValidationPositives, dataset.validationStats.positives >= policy.minimumValidationPositives)
  add('minimum-validation-negatives', 'evidence', dataset.validationStats.negatives, policy.minimumValidationNegatives, dataset.validationStats.negatives >= policy.minimumValidationNegatives)
  add('minimum-ranking-cases', 'evidence', dataset.rankingValidation.cases, policy.minimumValidationRankingCases, dataset.rankingValidation.cases >= policy.minimumValidationRankingCases)

  const conflictRate = dataset.audit.confirmedReviews === 0
    ? 0
    : dataset.audit.conflictingQueries / dataset.audit.confirmedReviews
  const unknownIntentRate = dataset.audit.adjudicatedQueries === 0
    ? 1
    : dataset.audit.unknownIntentQueries / dataset.audit.adjudicatedQueries
  add('maximum-conflict-rate', 'quality', round6(conflictRate), policy.maximumConflictRate, conflictRate <= policy.maximumConflictRate)
  add('maximum-unknown-intent-rate', 'quality', round6(unknownIntentRate), policy.maximumUnknownIntentRate, unknownIntentRate <= policy.maximumUnknownIntentRate)
  add('validation-top1-lower95', 'quality', dataset.rankingValidation.top1Confidence95.lower, policy.minimumValidationTop1Lower95, dataset.rankingValidation.top1Confidence95.lower >= policy.minimumValidationTop1Lower95)
  add('validation-missing-upper95', 'quality', dataset.rankingValidation.missingConfidence95.upper, policy.maximumValidationMissingUpper95, dataset.rankingValidation.missingConfidence95.upper <= policy.maximumValidationMissingUpper95)
  add('zero-privacy-risk-reviews', 'redline', dataset.audit.privacyRiskReviews, policy.maximumPrivacyRiskReviews, dataset.audit.privacyRiskReviews <= policy.maximumPrivacyRiskReviews)

  const failed = checks.filter(check => !check.passed)
  const decision: MemoryV4FeedbackCalibrationGateDecision = failed.some(check => check.kind === 'redline')
    ? 'blocked'
    : failed.some(check => check.kind === 'evidence')
      ? 'insufficient-data'
      : failed.length > 0
        ? 'blocked'
        : 'eligible-for-offline-fit'
  return {
    version: MEMORY_V4_FEEDBACK_CALIBRATION_GATE_VERSION,
    decision,
    automaticPromotion: false,
    authoritativeAnswerSource: 'v3',
    datasetVersion: dataset.datasetVersion,
    datasetFingerprint: dataset.datasetFingerprint,
    calibrationVersion: dataset.calibrationVersion,
    checks,
    failedCheckIds: failed.map(check => check.id),
    reason: decision === 'eligible-for-offline-fit'
      ? 'Internal feedback is sufficient for an offline fit; rollout remains separately gated and manual.'
      : decision === 'insufficient-data'
        ? 'The feedback snapshot is not large or balanced enough; V3 remains authoritative.'
        : 'Feedback consistency, ranking quality or privacy redlines failed; the snapshot cannot be fitted.',
  }
}

export function fitMemoryV4InternalFeedbackCalibration(
  dataset: MemoryV4FeedbackCalibrationDataset,
  gate: MemoryV4FeedbackCalibrationGateReport,
): MemoryV4LocalCalibrationArtifact {
  if (gate.datasetFingerprint !== dataset.datasetFingerprint || gate.datasetVersion !== dataset.datasetVersion)
    throw new Error('V4 feedback calibration gate does not match the frozen dataset')
  if (gate.decision !== 'eligible-for-offline-fit')
    throw new Error(`V4 feedback calibration dataset is not eligible: ${gate.decision}`)
  return fitMemoryV4LocalCalibration(dataset.calibration, dataset.validation, {
    datasetVersion: dataset.datasetVersion,
    createdAt: dataset.createdAt,
    minimumCalibrationSamples: dataset.policy.minimumCalibrationSamples,
    minimumValidationSamples: dataset.policy.minimumValidationSamples,
  })
}

function assessReview(review: MemoryV4InternalFeedbackCalibrationReview): AssessedReview {
  const labels = review.candidates.map(candidate => candidate.label).filter(Boolean)
  const correct = labels.includes('correct')
  const missing = review.queryLabel === 'missing'
  const noMemory = review.queryLabel === 'no-memory'
  const privacyRisk = labels.includes('privacy')
  const conflict = noMemory && correct
  const top = [...review.candidates].sort((left, right) => right.score - left.score || left.factId.localeCompare(right.factId))[0]
  const relevant = conflict
    ? undefined
    : noMemory
      ? false
      : missing || correct
        ? true
        : undefined
  const rankingCorrect = relevant !== true
    ? undefined
    : missing && !correct
      ? false
      : top?.label === undefined
        ? undefined
        : top.label === 'correct'
  const latestAt = Math.max(
    review.createdAt,
    review.queryLabelRecordedAt ?? 0,
    ...review.candidates.map(candidate => candidate.recordedAt ?? 0),
  )
  return { review, relevant, conflict, privacyRisk, rankingCorrect, missing, noMemory, latestAt }
}

function assignLeakageSafeSplits(
  reviews: readonly AssessedReview[],
  splitSalt: string,
  calibrationPermille: number,
): Map<string, 'calibration' | 'validation'> {
  const parents = new Map(reviews.map(review => [review.review.queryHash, review.review.queryHash]))
  const find = (queryHash: string): string => {
    const parent = parents.get(queryHash) ?? queryHash
    if (parent === queryHash)
      return queryHash
    const root = find(parent)
    parents.set(queryHash, root)
    return root
  }
  const union = (left: string, right: string) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot === rightRoot)
      return
    const [parent, child] = [leftRoot, rightRoot].sort()
    parents.set(child!, parent!)
  }
  const firstQueryByTarget = new Map<string, string>()
  for (const item of reviews) {
    for (const candidate of item.review.candidates) {
      const target = candidate.sourceMemoryId || candidate.factId
      const first = firstQueryByTarget.get(target)
      if (first)
        union(item.review.queryHash, first)
      else
        firstQueryByTarget.set(target, item.review.queryHash)
    }
  }
  const members = new Map<string, string[]>()
  for (const queryHash of parents.keys()) {
    const root = find(queryHash)
    members.set(root, [...(members.get(root) ?? []), queryHash])
  }
  const result = new Map<string, 'calibration' | 'validation'>()
  for (const queries of members.values()) {
    const component = queries.sort().join(':')
    const bucket = Number.parseInt(sha256(`${splitSalt}\0${component}`).slice(0, 8), 16) % 1_000
    const split = bucket < calibrationPermille ? 'calibration' : 'validation'
    for (const queryHash of queries)
      result.set(queryHash, split)
  }
  return result
}

function rankingStats(reviews: readonly AssessedReview[]): MemoryV4FeedbackRankingValidation {
  const ranked = reviews.filter(review => review.relevant === true && review.rankingCorrect !== undefined)
  const top1Correct = ranked.filter(review => review.rankingCorrect).length
  const answerable = reviews.filter(review => review.relevant === true)
  const missing = answerable.filter(review => review.missing).length
  return {
    cases: ranked.length,
    top1Correct,
    top1Accuracy: ratio(top1Correct, ranked.length),
    top1Confidence95: wilson(top1Correct, ranked.length),
    answerableCases: answerable.length,
    missingCases: missing,
    missingRate: ratio(missing, answerable.length),
    missingConfidence95: wilson(missing, answerable.length),
  }
}

function splitStats(samples: readonly MemoryV4CalibrationObservation[]): MemoryV4FeedbackSplitStats {
  return {
    samples: samples.length,
    positives: samples.filter(sample => sample.relevant).length,
    negatives: samples.filter(sample => !sample.relevant).length,
    uniqueQueries: new Set(samples.map(sample => sample.id)).size,
    unknownIntent: samples.filter(sample => normalizeIntent(sample.intent) === 'unknown').length,
  }
}

function fingerprintDatasetSource(
  reviews: readonly MemoryV4InternalFeedbackCalibrationReview[],
  splitSalt: string,
  policy: MemoryV4FeedbackCalibrationPolicy,
): string {
  const normalized = reviews.map(review => ({
    reviewKey: sha256(review.reviewId),
    queryHash: review.queryHash,
    queryIntent: normalizeIntent(review.queryIntent),
    calibrationVersion: review.calibrationVersion,
    bestEvidenceScore: round6(review.bestEvidenceScore),
    createdAt: review.createdAt,
    candidates: review.candidates.map(candidate => ({
      targetHash: sha256(candidate.sourceMemoryId || candidate.factId),
      candidateHash: sha256(`${candidate.sourceMemoryId ?? ''}\0${candidate.factId}`),
      score: round6(candidate.score),
      label: candidate.label,
      recordedAt: candidate.recordedAt,
    })).sort((left, right) => left.targetHash.localeCompare(right.targetHash)
      || left.candidateHash.localeCompare(right.candidateHash)),
    queryLabel: review.queryLabel,
    queryLabelRecordedAt: review.queryLabelRecordedAt,
    confirmedAt: review.confirmedAt,
  })).sort((left, right) => left.queryHash.localeCompare(right.queryHash)
    || left.createdAt - right.createdAt
    || left.reviewKey.localeCompare(right.reviewKey))
  return sha256(JSON.stringify({ version: MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION, splitSalt, policy, reviews: normalized }))
}

function selectCalibrationVersion(
  reviews: readonly MemoryV4InternalFeedbackCalibrationReview[],
  requested: string | undefined,
): string {
  const normalized = requested?.trim()
  if (normalized)
    return normalized
  const latest = [...reviews].sort((left, right) => right.createdAt - left.createdAt
    || right.calibrationVersion.localeCompare(left.calibrationVersion))[0]
  return latest?.calibrationVersion || 'none'
}

function normalizePolicy(overrides: Partial<MemoryV4FeedbackCalibrationPolicy> | undefined): MemoryV4FeedbackCalibrationPolicy {
  const policy = { ...DEFAULT_MEMORY_V4_FEEDBACK_CALIBRATION_POLICY, ...overrides }
  policy.calibrationPermille = boundedInteger(policy.calibrationPermille, 100, 900)
  for (const key of [
    'minimumCalibrationSamples', 'minimumValidationSamples', 'minimumCalibrationPositives',
    'minimumCalibrationNegatives', 'minimumValidationPositives', 'minimumValidationNegatives',
    'minimumValidationRankingCases',
  ] as const)
    policy[key] = boundedInteger(policy[key], 1, 1_000_000)
  policy.minimumValidationTop1Lower95 = clamp01(policy.minimumValidationTop1Lower95)
  policy.maximumValidationMissingUpper95 = clamp01(policy.maximumValidationMissingUpper95)
  policy.maximumConflictRate = clamp01(policy.maximumConflictRate)
  policy.maximumUnknownIntentRate = clamp01(policy.maximumUnknownIntentRate)
  policy.maximumPrivacyRiskReviews = boundedInteger(policy.maximumPrivacyRiskReviews, 0, 1_000_000)
  return policy
}

function wilson(successes: number, total: number): ProportionInterval {
  if (total <= 0)
    return { successes: 0, total: 0, estimate: 0, lower: 0, upper: 1 }
  const estimate = successes / total
  const z = 1.959963984540054
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = estimate + z2 / (2 * total)
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z2 / (4 * total)) / total)
  return {
    successes,
    total,
    estimate: round6(estimate),
    lower: round6(Math.max(0, (centre - margin) / denominator)),
    upper: round6(Math.min(1, (centre + margin) / denominator)),
  }
}

function sortObservations(samples: MemoryV4CalibrationObservation[]): void {
  samples.sort((left, right) => left.id.localeCompare(right.id))
}

function normalizeIntent(value: unknown): string {
  return boundedString(value, 64, 'unknown').toLowerCase()
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round6(numerator / denominator) : 0
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function boundedString(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('V4 feedback calibration requires a positive timestamp')
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : minimum
}

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}
