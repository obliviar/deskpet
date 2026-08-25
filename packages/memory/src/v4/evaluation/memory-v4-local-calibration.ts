import { createHash } from 'node:crypto'
import {
  evaluateRecallAbstentionCalibration,
  fitRecallAbstentionCalibration,
  type RecallAbstentionCalibrationMetrics,
  type RecallAbstentionCalibrationModel,
} from '../../long-term/abstention-calibration'

export const MEMORY_V4_LOCAL_CALIBRATION_VERSION = 'memory-v4-local-calibration-v1'
export const MEMORY_V4_ABSOLUTE_EVIDENCE_SCORE_VERSION = 'memory-v4-absolute-evidence-v1'

export interface MemoryV4CalibrationObservation {
  id: string
  intent: string
  bestScore: number
  /** True when at least one eligible V4 fact genuinely answers the query. */
  relevant: boolean
}

export interface MemoryV4LocalCalibrationOptions {
  datasetVersion: string
  createdAt?: number
  minimumCalibrationSamples?: number
  minimumValidationSamples?: number
  minimumIntentSamples?: number
  falsePositiveCost?: number
  falseNegativeCost?: number
}

export interface MemoryV4LocalCalibrationArtifact {
  version: typeof MEMORY_V4_LOCAL_CALIBRATION_VERSION
  scoreVersion: typeof MEMORY_V4_ABSOLUTE_EVIDENCE_SCORE_VERSION
  datasetVersion: string
  datasetFingerprint: string
  createdAt: number
  calibrationSamples: number
  validationSamples: number
  model: RecallAbstentionCalibrationModel
  calibrationMetrics: RecallAbstentionCalibrationMetrics
  validationMetrics: RecallAbstentionCalibrationMetrics
}

/**
 * Fit only on the calibration split and evaluate once on an ID-disjoint local
 * validation split. This provides a reproducible offline model without
 * presenting synthetic evidence as an external-blind or production result.
 */
export function fitMemoryV4LocalCalibration(
  calibration: readonly MemoryV4CalibrationObservation[],
  validation: readonly MemoryV4CalibrationObservation[],
  options: MemoryV4LocalCalibrationOptions,
): MemoryV4LocalCalibrationArtifact {
  const datasetVersion = options.datasetVersion.trim()
  if (!datasetVersion)
    throw new Error('V4 local calibration requires a dataset version')
  const minimumCalibrationSamples = positiveInteger(options.minimumCalibrationSamples ?? 500)
  const minimumValidationSamples = positiveInteger(options.minimumValidationSamples ?? 1_000)
  if (calibration.length < minimumCalibrationSamples)
    throw new Error(`V4 calibration split requires at least ${minimumCalibrationSamples} samples`)
  if (validation.length < minimumValidationSamples)
    throw new Error(`V4 validation split requires at least ${minimumValidationSamples} samples`)

  const calibrationIds = validateSplit(calibration, 'calibration')
  const validationIds = validateSplit(validation, 'validation')
  const overlap = [...calibrationIds].find(id => validationIds.has(id))
  if (overlap)
    throw new Error(`V4 calibration and validation splits overlap: ${overlap}`)

  const minimumIntentSamples = positiveInteger(options.minimumIntentSamples ?? 30)
  const fitted = fitRecallAbstentionCalibration(calibration, {
    datasetVersion,
    falsePositiveCost: options.falsePositiveCost ?? 3,
    falseNegativeCost: options.falseNegativeCost ?? 1,
    minimumIntentSamples,
  })
  const model: RecallAbstentionCalibrationModel = {
    ...fitted,
    version: `${MEMORY_V4_LOCAL_CALIBRATION_VERSION}:${datasetVersion}`,
    defaultThreshold: maximumMarginThreshold(calibration, fitted.defaultThreshold),
    thresholds: maximumMarginIntentThresholds(calibration, fitted.thresholds, minimumIntentSamples),
  }
  return {
    version: MEMORY_V4_LOCAL_CALIBRATION_VERSION,
    scoreVersion: MEMORY_V4_ABSOLUTE_EVIDENCE_SCORE_VERSION,
    datasetVersion,
    datasetFingerprint: fingerprintSplits(calibration, validation),
    createdAt: normalizeTimestamp(options.createdAt ?? Date.now()),
    calibrationSamples: calibration.length,
    validationSamples: validation.length,
    model,
    calibrationMetrics: evaluateRecallAbstentionCalibration(calibration, model),
    validationMetrics: evaluateRecallAbstentionCalibration(validation, model),
  }
}

/** Use the middle of a clean positive/negative gap instead of hugging either class. */
function maximumMarginThreshold(
  samples: readonly MemoryV4CalibrationObservation[],
  fallback: number,
): number {
  const positives = samples.filter(sample => sample.relevant).map(sample => sample.bestScore)
  const negatives = samples.filter(sample => !sample.relevant).map(sample => sample.bestScore)
  const minimumPositive = Math.min(...positives)
  const maximumNegative = Math.max(...negatives)
  return maximumNegative < minimumPositive
    ? (maximumNegative + minimumPositive) / 2
    : fallback
}

function maximumMarginIntentThresholds(
  samples: readonly MemoryV4CalibrationObservation[],
  fallbacks: Readonly<Record<string, number>>,
  minimumIntentSamples: number,
): Record<string, number> {
  const grouped = new Map<string, MemoryV4CalibrationObservation[]>()
  for (const sample of samples)
    grouped.set(sample.intent, [...(grouped.get(sample.intent) ?? []), sample])
  const thresholds: Record<string, number> = {}
  for (const [intent, cohort] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    if (cohort.length < minimumIntentSamples
      || !cohort.some(sample => sample.relevant)
      || !cohort.some(sample => !sample.relevant))
      continue
    thresholds[intent] = maximumMarginThreshold(cohort, fallbacks[intent] ?? 0)
  }
  return thresholds
}

function validateSplit(
  samples: readonly MemoryV4CalibrationObservation[],
  split: string,
): Set<string> {
  if (!samples.some(sample => sample.relevant) || !samples.some(sample => !sample.relevant))
    throw new Error(`V4 ${split} split requires positive and negative samples`)
  const ids = new Set<string>()
  for (const sample of samples) {
    if (!sample.id.trim() || !sample.intent.trim())
      throw new Error(`V4 ${split} sample is missing an identity field`)
    if (!Number.isFinite(sample.bestScore) || sample.bestScore < 0 || sample.bestScore > 1)
      throw new Error(`V4 ${split} sample has an invalid absolute evidence score`)
    if (ids.has(sample.id))
      throw new Error(`Duplicate V4 ${split} sample id: ${sample.id}`)
    ids.add(sample.id)
  }
  return ids
}

function fingerprintSplits(
  calibration: readonly MemoryV4CalibrationObservation[],
  validation: readonly MemoryV4CalibrationObservation[],
): string {
  const normalized = (samples: readonly MemoryV4CalibrationObservation[]) => [...samples]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(sample => [sample.id, sample.intent, sample.bestScore, sample.relevant])
  return createHash('sha256')
    .update(JSON.stringify({ calibration: normalized(calibration), validation: normalized(validation) }))
    .digest('hex')
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value) || value < 1)
    throw new Error('V4 calibration sample minimums must be positive integers')
  return Math.floor(value)
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('V4 local calibration requires a positive createdAt timestamp')
  return Math.floor(value)
}
