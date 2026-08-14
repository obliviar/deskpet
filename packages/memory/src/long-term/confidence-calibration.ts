import { createHash } from 'node:crypto'

export type MemoryCalibrationStatus = 'calibrated' | 'insufficient-data' | 'out-of-distribution'

export interface MemoryCalibrationExample {
  rawScore: number
  correct: boolean
  cohort?: string
  weight?: number
}

export interface MemoryCalibrationPrediction {
  probability: number
  lowerBound: number
  upperBound: number
  status: MemoryCalibrationStatus
  sampleCount: number
  method: 'isotonic-pav'
  calibratorVersion: string
  cohort: string
}

export interface MemoryConfidenceCalibrator {
  readonly version: string
  calibrate: (rawScore: number, cohort?: string) => MemoryCalibrationPrediction
}

export interface IsotonicMemoryCalibratorOptions {
  minimumSamples?: number
  minimumClassSamples?: number
  confidenceZ?: number
  versionLabel?: string
}

export interface MemoryCalibrationMetrics {
  sampleCount: number
  calibratedSampleCount: number
  insufficientDataSampleCount: number
  outOfDistributionSampleCount: number
  brierScore: number
  logLoss: number
  expectedCalibrationError: number
  maximumCalibrationError: number
}

interface CalibrationBlock {
  minimum: number
  maximum: number
  positiveWeight: number
  totalWeight: number
  squaredWeight: number
  sampleCount: number
}

/**
 * Fit a monotonic empirical probability map with pool-adjacent-violators.
 * The caller must use a calibration split that is independent from evaluation.
 */
export function fitIsotonicMemoryConfidenceCalibrator(
  examples: MemoryCalibrationExample[],
  options: IsotonicMemoryCalibratorOptions = {},
): MemoryConfidenceCalibrator {
  const minimumSamples = Math.max(20, Math.floor(options.minimumSamples ?? 200))
  const minimumClassSamples = Math.max(5, Math.floor(options.minimumClassSamples ?? 20))
  const confidenceZ = finite(options.confidenceZ, 1.96)
  const grouped = new Map<string, MemoryCalibrationExample[]>()
  for (const example of examples) {
    const cohort = normalizeCohort(example.cohort)
    grouped.set(cohort, [...(grouped.get(cohort) ?? []), normalizeExample(example)])
  }
  const global = examples.map(normalizeExample)
  if (global.length > 0)
    grouped.set('global', global)
  const profiles = new Map<string, { blocks: CalibrationBlock[]; eligible: boolean }>()
  for (const [cohort, values] of grouped) {
    const positives = values.filter(value => value.correct).length
    const negatives = values.length - positives
    profiles.set(cohort, {
      blocks: fitBlocks(values),
      eligible: values.length >= minimumSamples && positives >= minimumClassSamples && negatives >= minimumClassSamples,
    })
  }
  const versionExamples = [...global].sort((left, right) => left.rawScore - right.rawScore
    || Number(left.correct) - Number(right.correct)
    || normalizeCohort(left.cohort).localeCompare(normalizeCohort(right.cohort))
    || (left.weight ?? 1) - (right.weight ?? 1))
  const version = `isotonic-memory-${hash(JSON.stringify({ examples: versionExamples, minimumSamples, minimumClassSamples, label: options.versionLabel ?? '' })).slice(0, 16)}`
  return {
    version,
    calibrate(rawScore, requestedCohort) {
      const score = clamp(rawScore)
      const cohort = normalizeCohort(requestedCohort)
      const exact = profiles.get(cohort)
      const selected = exact?.eligible ? exact : profiles.get('global')
      if (!selected?.eligible || selected.blocks.length === 0) {
        return {
          probability: score,
          lowerBound: 0,
          upperBound: 1,
          status: 'insufficient-data',
          sampleCount: selected?.blocks.reduce((sum, block) => sum + block.sampleCount, 0) ?? 0,
          method: 'isotonic-pav',
          calibratorVersion: version,
          cohort: exact ? cohort : 'global',
        }
      }
      const block = nearestBlock(selected.blocks, score)
      const probability = block.positiveWeight / Math.max(Number.EPSILON, block.totalWeight)
      const interval = wilsonInterval(probability, effectiveSampleCount(block), confidenceZ)
      return {
        probability: round(probability),
        lowerBound: round(interval.lower),
        upperBound: round(interval.upper),
        status: exact?.eligible || cohort === 'global' ? 'calibrated' : 'out-of-distribution',
        sampleCount: block.sampleCount,
        method: 'isotonic-pav',
        calibratorVersion: version,
        cohort: exact?.eligible ? cohort : 'global',
      }
    },
  }
}

/** Evaluate on a held-out split; ECE is diagnostic and never the sole release gate. */
export function evaluateMemoryConfidenceCalibrator(
  calibrator: MemoryConfidenceCalibrator,
  heldOut: MemoryCalibrationExample[],
  binCount = 10,
): MemoryCalibrationMetrics {
  const predictions = heldOut.map((example) => {
    const prediction = calibrator.calibrate(example.rawScore, example.cohort)
    return { probability: prediction.probability, status: prediction.status, label: example.correct ? 1 : 0 }
  })
  if (predictions.length === 0)
    return {
      sampleCount: 0, calibratedSampleCount: 0, insufficientDataSampleCount: 0,
      outOfDistributionSampleCount: 0, brierScore: 0, logLoss: 0,
      expectedCalibrationError: 0, maximumCalibrationError: 0,
    }
  const bins = Array.from({ length: Math.max(2, Math.min(50, Math.floor(binCount))) }, () => ({ count: 0, probability: 0, labels: 0 }))
  let brier = 0
  let logLoss = 0
  for (const prediction of predictions) {
    const probability = Math.max(1e-12, Math.min(1 - 1e-12, prediction.probability))
    brier += (probability - prediction.label) ** 2
    logLoss -= prediction.label * Math.log(probability) + (1 - prediction.label) * Math.log(1 - probability)
    const index = Math.min(bins.length - 1, Math.floor(probability * bins.length))
    bins[index]!.count += 1
    bins[index]!.probability += probability
    bins[index]!.labels += prediction.label
  }
  let ece = 0
  let mce = 0
  for (const bin of bins) {
    if (bin.count === 0)
      continue
    const error = Math.abs(bin.probability / bin.count - bin.labels / bin.count)
    ece += bin.count / predictions.length * error
    mce = Math.max(mce, error)
  }
  return {
    sampleCount: predictions.length,
    calibratedSampleCount: predictions.filter(item => item.status === 'calibrated').length,
    insufficientDataSampleCount: predictions.filter(item => item.status === 'insufficient-data').length,
    outOfDistributionSampleCount: predictions.filter(item => item.status === 'out-of-distribution').length,
    brierScore: round(brier / predictions.length),
    logLoss: round(logLoss / predictions.length),
    expectedCalibrationError: round(ece),
    maximumCalibrationError: round(mce),
  }
}

function fitBlocks(examples: MemoryCalibrationExample[]): CalibrationBlock[] {
  const sorted = [...examples].sort((left, right) => left.rawScore - right.rawScore)
  const blocks: CalibrationBlock[] = []
  for (const example of sorted) {
    const weight = Math.max(0.001, finite(example.weight, 1))
    const tied = blocks.at(-1)
    if (tied?.maximum === example.rawScore) {
      tied.positiveWeight += example.correct ? weight : 0
      tied.totalWeight += weight
      tied.squaredWeight += weight ** 2
      tied.sampleCount += 1
    }
    else {
      blocks.push({
        minimum: example.rawScore,
        maximum: example.rawScore,
        positiveWeight: example.correct ? weight : 0,
        totalWeight: weight,
        squaredWeight: weight ** 2,
        sampleCount: 1,
      })
    }
    while (blocks.length >= 2) {
      const right = blocks.at(-1)!
      const left = blocks.at(-2)!
      if (left.positiveWeight / left.totalWeight <= right.positiveWeight / right.totalWeight)
        break
      blocks.splice(-2, 2, {
        minimum: left.minimum,
        maximum: right.maximum,
        positiveWeight: left.positiveWeight + right.positiveWeight,
        totalWeight: left.totalWeight + right.totalWeight,
        squaredWeight: left.squaredWeight + right.squaredWeight,
        sampleCount: left.sampleCount + right.sampleCount,
      })
    }
  }
  return blocks
}

function effectiveSampleCount(block: CalibrationBlock): number {
  return Math.max(1, Math.min(block.sampleCount, block.totalWeight ** 2 / Math.max(Number.EPSILON, block.squaredWeight)))
}

function nearestBlock(blocks: CalibrationBlock[], score: number): CalibrationBlock {
  return blocks.find(block => score <= block.maximum)
    ?? blocks.at(-1)!
}

function wilsonInterval(probability: number, count: number, z: number): { lower: number; upper: number } {
  const denominator = 1 + z ** 2 / count
  const centre = (probability + z ** 2 / (2 * count)) / denominator
  const margin = z * Math.sqrt((probability * (1 - probability) + z ** 2 / (4 * count)) / count) / denominator
  return { lower: clamp(centre - margin), upper: clamp(centre + margin) }
}

function normalizeExample(example: MemoryCalibrationExample): MemoryCalibrationExample {
  return { ...example, rawScore: clamp(example.rawScore), weight: Math.max(0.001, finite(example.weight, 1)) }
}

function normalizeCohort(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase().slice(0, 100) || 'global'
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, finite(value, 0)))
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}
