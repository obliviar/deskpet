import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  evaluateMemoryV4FeedbackCalibrationGate,
  fitMemoryV4InternalFeedbackCalibration,
  freezeMemoryV4InternalFeedbackDataset,
} from './memory-v4-feedback-calibration'
import type { MemoryV4InternalFeedbackCalibrationReview } from './memory-v4-internal-feedback'

const NOW = Date.UTC(2026, 7, 26)

describe('Memory V4 Internal feedback calibration', () => {
  it('freezes deterministic, query-disjoint splits and fits only after the pre-gate passes', () => {
    const reviews = Array.from({ length: 240 }, (_, index) => review(index, index % 2 === 0))
    const options = {
      createdAt: NOW,
      policy: permissivePolicy(),
    }
    const dataset = freezeMemoryV4InternalFeedbackDataset(reviews, options)
    const reversed = freezeMemoryV4InternalFeedbackDataset([...reviews].reverse(), options)

    expect(dataset.datasetFingerprint).toBe(reversed.datasetFingerprint)
    expect(dataset.calibration).toEqual(reversed.calibration)
    expect(dataset.validation).toEqual(reversed.validation)
    expect(dataset.calibrationStats.samples + dataset.validationStats.samples).toBe(240)
    const calibrationIds = new Set(dataset.calibration.map(item => item.id))
    expect(dataset.validation.some(item => calibrationIds.has(item.id))).toBe(false)

    const gate = evaluateMemoryV4FeedbackCalibrationGate(dataset)
    expect(gate).toMatchObject({
      decision: 'eligible-for-offline-fit',
      automaticPromotion: false,
      authoritativeAnswerSource: 'v3',
      failedCheckIds: [],
    })
    const artifact = fitMemoryV4InternalFeedbackCalibration(dataset, gate)
    expect(artifact).toMatchObject({
      datasetVersion: dataset.datasetVersion,
      datasetFingerprint: expect.any(String),
      calibrationSamples: dataset.calibrationStats.samples,
      validationSamples: dataset.validationStats.samples,
    })
  })

  it('keeps queries sharing a fact identity in the same split', () => {
    const shared = [review(1, true, 'shared-memory'), review(2, true, 'shared-memory')]
    const dataset = freezeMemoryV4InternalFeedbackDataset(shared, {
      createdAt: NOW,
      policy: { ...permissivePolicy(), minimumCalibrationSamples: 1, minimumValidationSamples: 1 },
    })
    expect([dataset.calibration.length, dataset.validation.length].sort()).toEqual([0, 2])
  })

  it('excludes contradictory repeated judgments and blocks privacy redlines', () => {
    const positive = review(1, true)
    const contradictory = {
      ...review(1, false),
      reviewId: 'review-conflict',
      createdAt: NOW + 10,
    }
    const privacy = review(3, true)
    privacy.candidates[0]!.label = 'privacy'
    const dataset = freezeMemoryV4InternalFeedbackDataset([positive, contradictory, privacy], {
      createdAt: NOW,
      policy: permissivePolicy(),
    })
    expect(dataset.audit).toMatchObject({ conflictingQueries: 1, privacyRiskReviews: 1 })
    expect(evaluateMemoryV4FeedbackCalibrationGate(dataset)).toMatchObject({
      decision: 'blocked',
      failedCheckIds: expect.arrayContaining(['zero-privacy-risk-reviews']),
    })
  })

  it('fails closed with real production minimums when feedback is absent', () => {
    const dataset = freezeMemoryV4InternalFeedbackDataset([], { createdAt: NOW })
    const gate = evaluateMemoryV4FeedbackCalibrationGate(dataset)
    expect(gate).toMatchObject({
      decision: 'insufficient-data',
      authoritativeAnswerSource: 'v3',
      failedCheckIds: expect.arrayContaining([
        'known-calibration-version',
        'minimum-calibration-samples',
        'minimum-validation-samples',
      ]),
    })
    expect(() => fitMemoryV4InternalFeedbackCalibration(dataset, gate)).toThrow(/not eligible/u)
  })

  it('excludes unconfirmed reviews from every calibration split', () => {
    const confirmed = review(1, true)
    const unconfirmed = { ...review(2, false), confirmedAt: undefined }
    const dataset = freezeMemoryV4InternalFeedbackDataset([confirmed, unconfirmed], {
      createdAt: NOW,
      policy: permissivePolicy(),
    })

    expect(dataset.audit).toMatchObject({
      selectedVersionReviews: 2,
      confirmedReviews: 1,
      unconfirmedReviews: 1,
      adjudicatedQueries: 1,
    })
    expect(dataset.calibrationStats.samples + dataset.validationStats.samples).toBe(1)
  })
})

function review(index: number, relevant: boolean, sourceMemoryId = `memory-${index}`): MemoryV4InternalFeedbackCalibrationReview {
  const queryHash = createHash('sha256').update(`query-${index}`).digest('hex')
  return {
    reviewId: `review-${index}`,
    queryHash,
    queryIntent: index % 3 === 0 ? 'temporal' : 'specific',
    calibrationVersion: 'calibration-production-candidate-v1',
    bestEvidenceScore: relevant ? 0.9 : 0.1,
    createdAt: NOW + index,
    confirmedAt: NOW + index + 1,
    candidates: [{
      factId: `fact-${index}`,
      sourceMemoryId,
      score: relevant ? 0.9 : 0.1,
      ...(relevant ? { label: 'correct' as const, recordedAt: NOW + index } : {}),
    }],
    ...(!relevant ? { queryLabel: 'no-memory' as const, queryLabelRecordedAt: NOW + index } : {}),
  }
}

function permissivePolicy() {
  return {
    calibrationPermille: 400,
    minimumCalibrationSamples: 30,
    minimumValidationSamples: 30,
    minimumCalibrationPositives: 10,
    minimumCalibrationNegatives: 10,
    minimumValidationPositives: 10,
    minimumValidationNegatives: 10,
    minimumValidationRankingCases: 10,
    minimumValidationTop1Lower95: 0.70,
    maximumValidationMissingUpper95: 0.20,
    maximumConflictRate: 0,
    maximumUnknownIntentRate: 0,
    maximumPrivacyRiskReviews: 0,
  }
}
