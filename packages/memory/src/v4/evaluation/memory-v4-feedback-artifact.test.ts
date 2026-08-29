import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { freezeMemoryV4InternalFeedbackDataset } from './memory-v4-feedback-calibration'
import {
  MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION,
  createMemoryV4FeedbackArtifactStore,
} from './memory-v4-feedback-artifact'
import type { MemoryV4InternalFeedbackCalibrationReview } from './memory-v4-internal-feedback'

const NOW = Date.UTC(2026, 7, 26)

describe('Memory V4 feedback calibration artifact store', () => {
  it('fits a draft, requires a complete human checklist and restores encrypted approval', () => {
    let payload: string | undefined
    let tick = NOW + 10_000
    const persistence = {
      storagePath: 'memory-v4-feedback-artifacts.enc',
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    const store = createMemoryV4FeedbackArtifactStore({
      persistence,
      encrypted: true,
      flushDelayMs: 0,
      now: () => tick++,
    })
    const draft = store.create(dataset())

    expect(draft).toMatchObject({
      state: 'draft',
      automaticActivation: false,
      authoritativeAnswerSource: 'v3',
      artifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(store.approve(draft.id, {
      reviewer: 'local-user',
      checklist: { ...completeChecklist(), metricsAccepted: false },
    })).toEqual({ ok: false, reason: 'incomplete-checklist' })

    const approved = store.approve(draft.id, {
      reviewer: 'local-user',
      checklist: completeChecklist(),
      note: '仅允许离线验证，不启用在线排序。',
    })
    expect(approved).toMatchObject({
      ok: true,
      artifact: { state: 'approved', automaticActivation: false },
    })
    expect(payload).not.toContain('仅允许离线验证')
    expect(payload).toContain(MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION)

    const restored = createMemoryV4FeedbackArtifactStore({
      persistence,
      encrypted: true,
      flushDelayMs: 0,
      now: () => tick++,
    })
    expect(restored.status()).toMatchObject({
      encrypted: true,
      retainedArtifacts: 1,
      approved: 1,
      current: { id: draft.id, state: 'approved', automaticActivation: false },
    })
  })

  it('fails closed when persisted fitted content no longer matches its fingerprint', () => {
    let payload: string | undefined
    const persistence = {
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    const store = createMemoryV4FeedbackArtifactStore({
      persistence,
      flushDelayMs: 0,
      now: () => NOW + 20_000,
    })
    store.create(dataset())
    const tampered = JSON.parse(payload!)
    tampered.artifacts[0].calibration.model.defaultThreshold = 0.001
    payload = JSON.stringify(tampered)

    expect(() => createMemoryV4FeedbackArtifactStore({ persistence }))
      .toThrow(/integrity check failed/u)
  })

  it('revokes without retaining a plaintext reason and clears all derived artifacts', () => {
    let payload: string | undefined
    const persistence = {
      load: () => payload,
      save: (next: string) => { payload = next },
    }
    const store = createMemoryV4FeedbackArtifactStore({
      persistence,
      flushDelayMs: 0,
      now: () => NOW + 30_000,
    })
    const draft = store.create(dataset())
    expect(store.revoke(draft.id, '发现标注污染，立即停用')).toMatchObject({
      ok: true,
      artifact: { state: 'revoked' },
    })
    expect(payload).not.toContain('发现标注污染')
    const revokedStatus = store.status()
    expect(revokedStatus).toMatchObject({ retainedArtifacts: 1, revoked: 1 })
    expect(revokedStatus).not.toHaveProperty('current')
    store.clear()
    expect(store.status()).toMatchObject({ retainedArtifacts: 0, approved: 0, revoked: 0 })
  })

  it('refuses to fit an artifact before the feedback evidence gate passes', () => {
    const store = createMemoryV4FeedbackArtifactStore({ now: () => NOW })
    const insufficient = freezeMemoryV4InternalFeedbackDataset([], { createdAt: NOW })
    expect(() => store.create(insufficient)).toThrow(/not eligible: insufficient-data/u)
  })
})

function dataset() {
  return freezeMemoryV4InternalFeedbackDataset(
    Array.from({ length: 240 }, (_, index) => review(index, index % 2 === 0)),
    {
      createdAt: NOW,
      policy: {
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
      },
    },
  )
}

function review(index: number, relevant: boolean): MemoryV4InternalFeedbackCalibrationReview {
  return {
    reviewId: `review-${index}`,
    queryHash: createHash('sha256').update(`query-${index}`).digest('hex'),
    queryIntent: index % 3 === 0 ? 'temporal' : 'specific',
    calibrationVersion: 'calibration-production-candidate-v1',
    bestEvidenceScore: relevant ? 0.9 : 0.1,
    createdAt: NOW + index,
    confirmedAt: NOW + index + 1,
    candidates: [{
      factId: `fact-${index}`,
      sourceMemoryId: `memory-${index}`,
      score: relevant ? 0.9 : 0.1,
      label: relevant ? 'correct' : 'incorrect',
      recordedAt: NOW + index,
    }],
    ...(!relevant ? { queryLabel: 'no-memory' as const, queryLabelRecordedAt: NOW + index } : {}),
  }
}

function completeChecklist() {
  return {
    labelsReviewed: true,
    privacyReviewed: true,
    splitLocked: true,
    metricsAccepted: true,
  }
}
