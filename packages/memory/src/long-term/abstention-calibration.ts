import type { MemoryRecallAbstention } from '@deskpet/contracts'

export const MEMORY_ABSTENTION_CALIBRATION_VERSION = 'abstention-threshold-calibration-v2'

export interface RecallAbstentionCalibrationSample {
  intent?: string
  bestScore: number
  /** True when at least one retrieved personal memory is genuinely relevant. */
  relevant: boolean
}

export interface RecallAbstentionCalibrationModel {
  version: string
  defaultThreshold: number
  thresholds: Record<string, number>
  datasetVersion?: string
  sampleCount?: number
}

export interface RecallAbstentionCalibrationMetrics {
  sampleCount: number
  truePositive: number
  trueNegative: number
  falsePositive: number
  falseNegative: number
  precision: number
  recall: number
  specificity: number
  falsePositiveRate: number
  accuracy: number
  balancedAccuracy: number
  coverage: number
}

export interface FitRecallAbstentionCalibrationOptions {
  datasetVersion: string
  /** False retrieval is more damaging than a conservative abstention. */
  falsePositiveCost?: number
  falseNegativeCost?: number
  /** Small cohorts inherit the global threshold rather than overfit. */
  minimumIntentSamples?: number
}

/**
 * Conservative checked-in fallback. It is explicitly a policy fallback, not
 * evidence that external calibration passed. Product/release evaluation can
 * fit and inject a versioned model with fitRecallAbstentionCalibration.
 */
export const DEFAULT_RECALL_ABSTENTION_CALIBRATION: RecallAbstentionCalibrationModel = {
  version: `${MEMORY_ABSTENTION_CALIBRATION_VERSION}:policy-fallback`,
  defaultThreshold: 0.36,
  thresholds: {
    specific: 0.42,
    'multi-fact': 0.34,
    temporal: 0.30,
    timeline: 0.24,
    enumerative: 0.20,
  },
}

/** Apply a versioned threshold model and retain its identity in the audit result. */
export function calibrateRecallAbstention(
  intent: string | undefined,
  bestScore: number,
  model: RecallAbstentionCalibrationModel = DEFAULT_RECALL_ABSTENTION_CALIBRATION,
): MemoryRecallAbstention {
  assertCalibrationModel(model)
  const threshold = intent === undefined
    ? model.defaultThreshold
    : model.thresholds[intent] ?? model.defaultThreshold
  const finiteScore = Number.isFinite(bestScore) ? bestScore : 0
  return {
    abstained: finiteScore < threshold,
    threshold,
    bestScore: finiteScore,
    version: model.version,
  }
}

/**
 * Fit cost-sensitive thresholds on a dedicated calibration split. Candidate
 * thresholds are evaluated exactly; ties prefer the more conservative larger
 * threshold. Small intent cohorts inherit the global threshold.
 */
export function fitRecallAbstentionCalibration(
  samples: readonly RecallAbstentionCalibrationSample[],
  options: FitRecallAbstentionCalibrationOptions,
): RecallAbstentionCalibrationModel {
  if (!options.datasetVersion.trim())
    throw new Error('Recall abstention calibration requires a dataset version')
  if (samples.length < 2 || !samples.some(sample => sample.relevant) || !samples.some(sample => !sample.relevant))
    throw new Error('Recall abstention calibration requires positive and negative samples')
  for (const sample of samples) {
    if (!Number.isFinite(sample.bestScore))
      throw new Error('Recall abstention calibration scores must be finite')
  }
  const falsePositiveCost = positiveCost(options.falsePositiveCost ?? 2, 'falsePositiveCost')
  const falseNegativeCost = positiveCost(options.falseNegativeCost ?? 1, 'falseNegativeCost')
  const minimumIntentSamples = Math.max(2, Math.floor(options.minimumIntentSamples ?? 20))
  const fitOptions = { falsePositiveCost, falseNegativeCost }
  const defaultThreshold = fitThreshold(samples, fitOptions)
  const groups = new Map<string, RecallAbstentionCalibrationSample[]>()
  for (const sample of samples) {
    if (!sample.intent)
      continue
    groups.set(sample.intent, [...(groups.get(sample.intent) ?? []), sample])
  }
  const thresholds: Record<string, number> = {}
  for (const [intent, cohort] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (cohort.length < minimumIntentSamples || !cohort.some(sample => sample.relevant) || !cohort.some(sample => !sample.relevant))
      continue
    thresholds[intent] = fitThreshold(cohort, fitOptions)
  }
  return {
    version: `${MEMORY_ABSTENTION_CALIBRATION_VERSION}:${options.datasetVersion}`,
    defaultThreshold,
    thresholds,
    datasetVersion: options.datasetVersion,
    sampleCount: samples.length,
  }
}

/** Evaluate a fitted model on a disjoint validation/blind split. */
export function evaluateRecallAbstentionCalibration(
  samples: readonly RecallAbstentionCalibrationSample[],
  model: RecallAbstentionCalibrationModel,
): RecallAbstentionCalibrationMetrics {
  assertCalibrationModel(model)
  let truePositive = 0
  let trueNegative = 0
  let falsePositive = 0
  let falseNegative = 0
  for (const sample of samples) {
    const retrieved = !calibrateRecallAbstention(sample.intent, sample.bestScore, model).abstained
    if (retrieved && sample.relevant) truePositive += 1
    else if (!retrieved && !sample.relevant) trueNegative += 1
    else if (retrieved) falsePositive += 1
    else falseNegative += 1
  }
  const sampleCount = samples.length
  const predictedPositive = truePositive + falsePositive
  const actualPositive = truePositive + falseNegative
  const actualNegative = trueNegative + falsePositive
  return {
    sampleCount,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, predictedPositive),
    recall: ratio(truePositive, actualPositive),
    specificity: ratio(trueNegative, actualNegative),
    falsePositiveRate: ratio(falsePositive, actualNegative),
    accuracy: ratio(truePositive + trueNegative, sampleCount),
    balancedAccuracy: (ratio(truePositive, actualPositive) + ratio(trueNegative, actualNegative)) / 2,
    coverage: ratio(predictedPositive, sampleCount),
  }
}

function fitThreshold(
  samples: readonly RecallAbstentionCalibrationSample[],
  costs: { falsePositiveCost: number; falseNegativeCost: number },
): number {
  const scores = [...new Set(samples.map(sample => sample.bestScore))].sort((left, right) => left - right)
  const epsilon = 1e-9
  const candidates = [scores[0]! - epsilon, ...scores, scores[scores.length - 1]! + epsilon]
  let best = candidates[0]!
  let bestCost = Number.POSITIVE_INFINITY
  let bestBalancedAccuracy = Number.NEGATIVE_INFINITY
  for (const threshold of candidates) {
    const model: RecallAbstentionCalibrationModel = { version: 'fit-candidate', defaultThreshold: threshold, thresholds: {} }
    const metrics = evaluateRecallAbstentionCalibration(samples, model)
    const cost = metrics.falsePositive * costs.falsePositiveCost + metrics.falseNegative * costs.falseNegativeCost
    if (cost < bestCost
      || (cost === bestCost && metrics.balancedAccuracy > bestBalancedAccuracy)
      || (cost === bestCost && metrics.balancedAccuracy === bestBalancedAccuracy && threshold > best)) {
      best = threshold
      bestCost = cost
      bestBalancedAccuracy = metrics.balancedAccuracy
    }
  }
  return best
}

function assertCalibrationModel(model: RecallAbstentionCalibrationModel): void {
  if (!model.version.trim() || !Number.isFinite(model.defaultThreshold))
    throw new Error('Invalid recall abstention calibration model')
  for (const threshold of Object.values(model.thresholds)) {
    if (!Number.isFinite(threshold))
      throw new Error('Invalid recall abstention calibration threshold')
  }
}

function positiveCost(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be positive`)
  return value
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}
