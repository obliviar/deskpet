import { describe, expect, it } from 'vitest'
import { evaluateMemoryConfidenceCalibrator, fitIsotonicMemoryConfidenceCalibrator } from './confidence-calibration'

describe('formal memory confidence calibration', () => {
  it('refuses to claim calibrated probabilities with insufficient labels', () => {
    const calibrator = fitIsotonicMemoryConfidenceCalibrator([
      { rawScore: 0.9, correct: true },
      { rawScore: 0.8, correct: false },
    ], { minimumSamples: 20 })
    expect(calibrator.calibrate(0.9)).toMatchObject({
      probability: 0.9, lowerBound: 0, upperBound: 1, status: 'insufficient-data',
    })
  })

  it('learns a monotonic empirical mapping and reports held-out proper scores', () => {
    const calibration = Array.from({ length: 200 }, (_, index) => ({
      rawScore: index < 100 ? 0.35 : 0.9,
      correct: index % 100 < (index < 100 ? 30 : 80),
      cohort: 'rules:preference',
    }))
    const calibrator = fitIsotonicMemoryConfidenceCalibrator(calibration, {
      minimumSamples: 100, minimumClassSamples: 10, versionLabel: 'test-v1',
    })
    const low = calibrator.calibrate(0.35, 'rules:preference')
    const high = calibrator.calibrate(0.9, 'rules:preference')
    expect(low.status).toBe('calibrated')
    expect(low.probability).toBeCloseTo(0.3)
    expect(high.probability).toBeCloseTo(0.8)
    expect(high.lowerBound).toBeLessThan(high.probability)
    expect(high.upperBound).toBeGreaterThan(high.probability)
    const heldOut = Array.from({ length: 200 }, (_, index) => ({
      rawScore: index < 100 ? 0.35 : 0.9,
      correct: index % 100 < (index < 100 ? 30 : 80),
      cohort: 'rules:preference',
    }))
    const metrics = evaluateMemoryConfidenceCalibrator(calibrator, heldOut)
    expect(metrics).toMatchObject({ sampleCount: 200, calibratedSampleCount: 200 })
    expect(metrics.brierScore).toBeLessThan(0.2)
    expect(metrics.expectedCalibrationError).toBeLessThan(0.001)
  })

  it('aggregates tied scores and produces a stable version independent of input order', () => {
    const examples = Array.from({ length: 100 }, (_, index) => ({
      rawScore: 0.8,
      correct: index < 70,
      cohort: 'rules:identity',
      weight: index === 0 ? 10 : 1,
    }))
    const first = fitIsotonicMemoryConfidenceCalibrator(examples, { minimumSamples: 50, minimumClassSamples: 10 })
    const second = fitIsotonicMemoryConfidenceCalibrator([...examples].reverse(), { minimumSamples: 50, minimumClassSamples: 10 })
    expect(first.version).toBe(second.version)
    const prediction = first.calibrate(0.8, 'rules:identity')
    expect(prediction.status).toBe('calibrated')
    expect(prediction.sampleCount).toBe(100)
    expect(prediction.lowerBound).toBeLessThan(prediction.probability)
  })
})
