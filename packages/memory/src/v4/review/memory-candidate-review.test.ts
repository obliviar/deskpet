import { describe, expect, it } from 'vitest'
import { createLocalMemoryCandidateVerifier } from '../../long-term/memory-write-policy'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createMemoryCandidateReviewService } from './memory-candidate-review'

describe('memory candidate review and reprocessing', () => {
  it('promotes only an explicitly approved quarantined candidate', async () => {
    const repository = createMemoryV4Repository({ now: () => 100 })
    seedCandidate(repository)
    const service = createMemoryCandidateReviewService(repository)
    const activations: string[] = []
    expect(service.list(scope)).toHaveLength(1)
    expect(await service.approve('candidate-1', scope, async target => {
      activations.push(target.content)
      expect(target.metadata).toMatchObject({ origin: 'manual', userConfirmed: true, confidence: 1 })
    })).toBe(true)
    expect(activations).toEqual(['用户联系电话：13800138000'])
    expect(service.list(scope)).toHaveLength(0)
    expect(repository.snapshot().candidates[0]).toMatchObject({ status: 'accepted', reviewOutcome: 'approved' })
    expect(service.calibrationDataset(scope)).toMatchObject({
      source: 'quarantine-user-review', suitableForProductionCalibration: false,
      reviewedCount: 1, approvedCount: 1, rejectedCount: 0,
      examples: [{ rawScore: 0.9, correct: true }],
    })
  })

  it('reprocesses in idempotent shadow batches without changing the live decision', async () => {
    const repository = createMemoryV4Repository({ now: () => 100 })
    seedCandidate(repository)
    const service = createMemoryCandidateReviewService(repository)
    const options = {
      scope,
      verifier: createLocalMemoryCandidateVerifier(),
      inspectMatches: async () => ({ activeByMemoryKey: [] }),
      batchSize: 1,
      shadow: true,
    }
    expect((await service.reprocess(options)).processed).toBe(1)
    expect((await service.reprocess(options)).processed).toBe(1)
    const candidate = repository.snapshot().candidates[0]!
    expect(candidate.status).toBe('quarantined')
    expect(candidate.policyRuns).toHaveLength(1)
    expect(candidate.policyRuns?.[0]).toMatchObject({
      shadow: true,
      normalizerVersion: 'structured-normalizer-v1',
      calibrationStatus: 'insufficient-data',
      calibratorVersion: 'none',
    })
    expect(repository.snapshot().domainEvents.find(event => event.type === 'CANDIDATE_REPROCESSED')?.actor).toBe('system')
  })

  it('prevents two concurrent approvals from activating the same candidate twice', async () => {
    const repository = createMemoryV4Repository({ now: () => 100 })
    seedCandidate(repository)
    const service = createMemoryCandidateReviewService(repository)
    let activations = 0
    const activate = async () => {
      activations += 1
      await Promise.resolve()
    }
    const outcomes = await Promise.all([
      service.approve('candidate-1', scope, activate),
      service.approve('candidate-1', scope, activate),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(activations).toBe(1)
  })

  it('keeps rejection feedback as a non-production negative calibration example', () => {
    const repository = createMemoryV4Repository({ now: () => 100 })
    seedCandidate(repository)
    const service = createMemoryCandidateReviewService(repository)
    expect(service.reject('candidate-1', scope)).toBe(true)
    expect(service.calibrationDataset(scope)).toMatchObject({
      suitableForProductionCalibration: false,
      reviewedCount: 1, approvedCount: 0, rejectedCount: 1,
      examples: [{ rawScore: 0.9, correct: false }],
    })
  })
})

const scope = { ownerId: 'review-user', agentId: 'deskpet' }

function seedCandidate(repository: ReturnType<typeof createMemoryV4Repository>) {
  repository.transaction((draft) => {
    draft.episodes.push({
      id: 'episode-1', scope, actor: 'user', kind: 'message', contentState: 'available',
      content: '我的手机号是13800138000', contentHash: 'hash', recordedAt: 100,
      sourceAttachmentIds: [], sensitivity: 'private', sharePolicy: 'local-only', provenance: 'native-v4',
    })
    draft.candidates.push({
      id: 'candidate-1', scope, evidenceEpisodeIds: ['episode-1'], subjectId: 'owner:self',
      predicate: 'profile.phone', object: '用户联系电话：13800138000', objectType: 'string',
      normalizedValue: '13800138000', canonicalText: '用户联系电话：13800138000', polarity: 'unknown',
      modality: 'asserted', cardinality: 'single', extractionScore: 0.95, verificationScore: 0.9,
      evidenceScore: 1, durabilityScore: 0.85, ambiguityFlags: ['high-risk-review-required'],
      proposedAction: 'QUARANTINE', status: 'quarantined', extractorVersion: 'test-extractor',
      verifierVersion: 'test-verifier', policyVersion: 'test-policy',
      decisionReasonCodes: ['high-risk-field-requires-confirmation'], createdAt: 100, updatedAt: 100,
    })
  })
}
