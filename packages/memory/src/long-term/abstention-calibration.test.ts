import { describe, expect, it } from 'vitest'
import {
  MEMORY_ABSTENTION_CALIBRATION_VERSION,
  calibrateRecallAbstention,
  evaluateRecallAbstentionCalibration,
  fitRecallAbstentionCalibration,
} from './abstention-calibration'

describe('recall abstention calibration', () => {
  it('abstains when the best fused score stays below the intent threshold', () => {
    const result = calibrateRecallAbstention('specific', 0.3)
    expect(result).toEqual({
      abstained: true,
      threshold: 0.42,
      bestScore: 0.3,
      version: `${MEMORY_ABSTENTION_CALIBRATION_VERSION}:policy-fallback`,
    })
  })

  it('keeps broad intents on a lower threshold so broad answers are not withheld', () => {
    expect(calibrateRecallAbstention('enumerative', 0.22).abstained).toBe(false)
    expect(calibrateRecallAbstention('timeline', 0.22).abstained).toBe(true)
  })

  it('falls back to the default threshold for unknown intents', () => {
    expect(calibrateRecallAbstention(undefined, 0.35)).toMatchObject({
      abstained: true,
      threshold: 0.36,
    })
    expect(calibrateRecallAbstention('unknown-intent', 0.37).abstained).toBe(false)
  })

  it('fits a versioned cost-sensitive threshold and evaluates a disjoint split', () => {
    const calibration = [
      { intent: 'specific', bestScore: 0.08, relevant: false },
      { intent: 'specific', bestScore: 0.15, relevant: false },
      { intent: 'specific', bestScore: 0.28, relevant: false },
      { intent: 'specific', bestScore: 0.61, relevant: true },
      { intent: 'specific', bestScore: 0.72, relevant: true },
      { intent: 'specific', bestScore: 0.84, relevant: true },
    ]
    const model = fitRecallAbstentionCalibration(calibration, {
      datasetVersion: 'calibration-split-v1',
      minimumIntentSamples: 4,
      falsePositiveCost: 3,
    })
    expect(model.version).toBe(`${MEMORY_ABSTENTION_CALIBRATION_VERSION}:calibration-split-v1`)
    expect(model.thresholds.specific).toBeGreaterThan(0.28)
    expect(model.thresholds.specific).toBeLessThanOrEqual(0.61)

    const metrics = evaluateRecallAbstentionCalibration([
      { intent: 'specific', bestScore: 0.2, relevant: false },
      { intent: 'specific', bestScore: 0.65, relevant: true },
      { intent: 'specific', bestScore: 0.75, relevant: true },
    ], model)
    expect(metrics).toMatchObject({ falsePositive: 0, falseNegative: 0, accuracy: 1 })
  })

  it('rejects calibration data without both relevant and irrelevant examples', () => {
    expect(() => fitRecallAbstentionCalibration([
      { bestScore: 0.8, relevant: true },
      { bestScore: 0.9, relevant: true },
    ], { datasetVersion: 'invalid' })).toThrow(/positive and negative/iu)
  })
})
