import { createHash, randomUUID } from 'node:crypto'
import type { MemoryCapture, MemoryScope } from '@deskpet/contracts'
import type { MemoryCandidate } from '../../long-term/memory-extractor'
import type { MemoryCalibrationExample } from '../../long-term/confidence-calibration'
import type { MemoryCandidateEvaluation, MemoryCandidateVerifier, MemoryWriteMatches } from '../../long-term/memory-write-policy'
import { MEMORY_NORMALIZER_VERSION, normalizeMemoryCandidate } from '../../long-term/memory-normalizer'
import type { MemoryCandidateV4, MemoryV4Scope } from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export interface CandidateReviewItem {
  candidate: MemoryCandidateV4
  evidence: Array<{ id: string; content?: string; contentState: string; recordedAt: number }>
}

export interface CandidateApprovalTarget {
  content: string
  scope: MemoryScope
  metadata: Record<string, unknown>
}

export interface CandidateReprocessOptions {
  scope: MemoryScope
  verifier: MemoryCandidateVerifier
  inspectMatches: (
    content: string,
    scope: MemoryScope,
    memoryKey?: string,
  ) => Promise<MemoryWriteMatches>
  batchSize?: number
  cursor?: string
  shadow?: boolean
}

export interface CandidateReprocessReport {
  processed: number
  changedDecisions: number
  accepted: number
  quarantined: number
  rejected: number
  nextCursor?: string
  extractorVersions: string[]
  verifierVersions: string[]
  policyVersions: string[]
}

export interface CandidateCalibrationDataset {
  /** Quarantine review is selected feedback, not a representative production sample. */
  source: 'quarantine-user-review'
  suitableForProductionCalibration: false
  reviewedCount: number
  approvedCount: number
  rejectedCount: number
  examples: MemoryCalibrationExample[]
}

export interface MemoryCandidateReviewService {
  list: (scope: MemoryScope, limit?: number) => CandidateReviewItem[]
  approve: (
    id: string,
    scope: MemoryScope,
    activate: (target: CandidateApprovalTarget) => Promise<void>,
    note?: string,
  ) => Promise<boolean>
  reject: (id: string, scope: MemoryScope, note?: string) => boolean
  calibrationDataset: (scope: MemoryScope) => CandidateCalibrationDataset
  reprocess: (options: CandidateReprocessOptions) => Promise<CandidateReprocessReport>
}

/** User review is the only path that promotes a quarantined V4 candidate into V3. */
export function createMemoryCandidateReviewService(repository: MemoryV4Repository): MemoryCandidateReviewService {
  const approvalsInFlight = new Set<string>()

  function list(scope: MemoryScope, limit = 200): CandidateReviewItem[] {
    const snapshot = repository.snapshot()
    return snapshot.candidates
      .filter(candidate => candidate.status === 'quarantined' && matchesScope(candidate.scope, scope))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(1000, Math.floor(limit))))
      .map(candidate => ({
        candidate,
        evidence: candidate.evidenceEpisodeIds.map(id => snapshot.episodes.find(episode => episode.id === id))
          .filter((episode): episode is NonNullable<typeof episode> => !!episode)
          .map(episode => ({
            id: episode.id,
            ...(episode.contentState === 'available' && episode.content ? { content: episode.content } : {}),
            contentState: episode.contentState,
            recordedAt: episode.recordedAt,
          })),
      }))
  }

  async function approve(
    id: string,
    scope: MemoryScope,
    activate: (target: CandidateApprovalTarget) => Promise<void>,
    note?: string,
  ): Promise<boolean> {
    const approvalKey = `${scope.ownerId}\u0000${scope.agentId ?? 'default'}\u0000${scope.sessionId ?? ''}\u0000${id}`
    if (approvalsInFlight.has(approvalKey))
      return false
    const snapshot = repository.snapshot()
    const candidate = snapshot.candidates.find(item => item.id === id && matchesScope(item.scope, scope))
    if (!candidate || candidate.status !== 'quarantined')
      return false
    approvalsInFlight.add(approvalKey)
    try {
      await activate({
        content: candidate.canonicalText,
        scope,
        metadata: {
          kind: candidate.predicate,
          memoryKey: candidate.predicate,
          predicate: candidate.predicate,
          subjectId: candidate.subjectId,
          normalizedValue: candidate.normalizedValue,
          polarity: candidate.polarity,
          modality: candidate.modality,
          ...(candidate.condition ? { condition: candidate.condition } : {}),
          cardinality: candidate.cardinality,
          ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
          ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
          origin: 'manual',
          userConfirmed: true,
          confidence: 1,
          importance: Math.max(0.8, candidate.durabilityScore),
          source: 'candidate-review',
          reviewedCandidateId: candidate.id,
        },
      })
      return review(id, scope, 'approved', note)
    }
    finally {
      approvalsInFlight.delete(approvalKey)
    }
  }

  function reject(id: string, scope: MemoryScope, note?: string): boolean {
    return review(id, scope, 'rejected', note)
  }

  function calibrationDataset(scope: MemoryScope): CandidateCalibrationDataset {
    const reviewed = repository.snapshot().candidates.filter(candidate =>
      matchesScope(candidate.scope, scope)
      && candidate.reviewOutcome !== undefined
      && typeof candidate.verificationScore === 'number')
    return {
      source: 'quarantine-user-review',
      suitableForProductionCalibration: false,
      reviewedCount: reviewed.length,
      approvedCount: reviewed.filter(candidate => candidate.reviewOutcome === 'approved').length,
      rejectedCount: reviewed.filter(candidate => candidate.reviewOutcome === 'rejected').length,
      examples: reviewed.map(candidate => ({
        rawScore: candidate.verificationScore!,
        correct: candidate.reviewOutcome === 'approved',
        cohort: candidate.calibrationCohort ?? `review:${candidate.predicate}`,
      })),
    }
  }

  function review(id: string, scope: MemoryScope, outcome: 'approved' | 'rejected', note?: string): boolean {
    return repository.transaction((draft) => {
      const candidate = draft.candidates.find(item => item.id === id && matchesScope(item.scope, scope))
      if (!candidate || candidate.status !== 'quarantined')
        return false
      const now = Date.now()
      candidate.status = outcome === 'approved' ? 'accepted' : 'rejected'
      candidate.reviewOutcome = outcome
      candidate.reviewedAt = now
      candidate.updatedAt = Math.max(candidate.updatedAt, now)
      if (note?.trim())
        candidate.reviewNote = note.trim().slice(0, 500)
      appendEvent(draft, candidate, 'CANDIDATE_REVIEWED', now, { outcome })
      return true
    })
  }

  async function reprocess(options: CandidateReprocessOptions): Promise<CandidateReprocessReport> {
    const batchSize = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? 100)))
    const snapshot = repository.snapshot()
    const candidates = snapshot.candidates
      .filter(candidate => matchesScope(candidate.scope, options.scope))
      .sort((left, right) => left.id.localeCompare(right.id))
      .filter(candidate => !options.cursor || candidate.id > options.cursor)
      .slice(0, batchSize)
    const results: Array<{ id: string; evaluation: MemoryCandidateEvaluation }> = []
    for (const candidate of candidates) {
      const episode = candidate.evidenceEpisodeIds
        .map(id => snapshot.episodes.find(item => item.id === id))
        .find(item => item?.contentState === 'available' && item.content)
      if (!episode?.content)
        continue
      const memoryCandidate = normalizeMemoryCandidate({
        content: candidate.canonicalText,
        metadata: {
          kind: candidate.predicate,
          memoryKey: candidate.predicate,
          predicate: candidate.predicate,
          subjectId: candidate.subjectId,
          normalizedValue: candidate.normalizedValue,
          polarity: candidate.polarity,
          modality: candidate.modality,
          ...(candidate.condition ? { condition: candidate.condition } : {}),
          cardinality: candidate.cardinality,
          confidence: candidate.extractionScore,
          importance: candidate.durabilityScore,
          extractionChannel: candidate.calibrationCohort?.split(':', 1)[0] || 'reprocess',
          extractorVersion: candidate.extractorVersion,
        },
      })
      const turn: MemoryCapture = {
        userMessage: episode.content,
        assistantMessage: '',
        metadata: { reprocessedCandidateId: candidate.id },
      }
      const matches = await options.inspectMatches(
        memoryCandidate.content,
        options.scope,
        String(memoryCandidate.metadata.memoryKey ?? ''),
      )
      results.push({ id: candidate.id, evaluation: await options.verifier(memoryCandidate, { turn, scope: options.scope, matches }) })
    }
    let changedDecisions = 0
    if (results.length > 0) {
      repository.transaction((draft) => {
        const now = Date.now()
        for (const result of results) {
          const candidate = draft.candidates.find(item => item.id === result.id)
          if (!candidate)
            continue
          if (candidate.proposedAction !== result.evaluation.action || candidate.status !== result.evaluation.status)
            changedDecisions += 1
          const runId = hash(`${candidate.id}\u0000${result.evaluation.verifierVersion}\u0000${result.evaluation.policyVersion}\u0000${result.evaluation.action}\u0000${result.evaluation.status}\u0000${result.evaluation.verificationScore}\u0000${result.evaluation.calibration.calibratorVersion}\u0000${result.evaluation.calibration.status}\u0000${result.evaluation.calibration.lowerBound}\u0000${JSON.stringify(result.evaluation.reasonCodes)}`)
          candidate.policyRuns ??= []
          if (!candidate.policyRuns.some(run => run.id === runId)) {
            candidate.policyRuns.push({
              id: runId,
              action: result.evaluation.action,
              status: result.evaluation.status,
              extractionScore: result.evaluation.extractionScore,
              verificationScore: result.evaluation.verificationScore,
              evidenceScore: result.evaluation.evidenceScore,
              calibratedActiveProbability: result.evaluation.calibration.probability,
              calibrationLowerBound: result.evaluation.calibration.lowerBound,
              calibrationUpperBound: result.evaluation.calibration.upperBound,
              calibrationStatus: result.evaluation.calibration.status,
              calibrationMethod: result.evaluation.calibration.method,
              calibratorVersion: result.evaluation.calibration.calibratorVersion,
              calibrationCohort: result.evaluation.calibration.cohort,
              durabilityScore: result.evaluation.durabilityScore,
              ambiguityFlags: result.evaluation.ambiguityFlags,
              reasonCodes: result.evaluation.reasonCodes,
              extractorVersion: candidate.extractorVersion,
              normalizerVersion: MEMORY_NORMALIZER_VERSION,
              verifierVersion: result.evaluation.verifierVersion,
              policyVersion: result.evaluation.policyVersion,
              processedAt: now,
              shadow: options.shadow !== false,
            })
            appendEvent(draft, candidate, 'CANDIDATE_REPROCESSED', now, {
              runId, action: result.evaluation.action, status: result.evaluation.status, shadow: options.shadow !== false,
            }, 'system')
          }
          if (options.shadow === false && !candidate.reviewOutcome) {
            candidate.proposedAction = result.evaluation.action
            candidate.status = result.evaluation.status
            candidate.verificationScore = result.evaluation.verificationScore
            candidate.evidenceScore = result.evaluation.evidenceScore
            candidate.calibratedActiveProbability = result.evaluation.calibration.probability
            candidate.calibrationLowerBound = result.evaluation.calibration.lowerBound
            candidate.calibrationUpperBound = result.evaluation.calibration.upperBound
            candidate.calibrationStatus = result.evaluation.calibration.status
            candidate.calibrationMethod = result.evaluation.calibration.method
            candidate.calibratorVersion = result.evaluation.calibration.calibratorVersion
            candidate.calibrationCohort = result.evaluation.calibration.cohort
            candidate.durabilityScore = result.evaluation.durabilityScore
            candidate.ambiguityFlags = result.evaluation.ambiguityFlags
            candidate.decisionReasonCodes = result.evaluation.reasonCodes
            candidate.verifierVersion = result.evaluation.verifierVersion
            candidate.policyVersion = result.evaluation.policyVersion
            candidate.updatedAt = Math.max(candidate.updatedAt, now)
          }
        }
      })
    }
    const evaluations = results.map(result => result.evaluation)
    const last = candidates.at(-1)?.id
    const hasMore = last ? snapshot.candidates.some(item => matchesScope(item.scope, options.scope) && item.id > last) : false
    return {
      processed: results.length,
      changedDecisions,
      accepted: evaluations.filter(item => item.status === 'accepted').length,
      quarantined: evaluations.filter(item => item.status === 'quarantined').length,
      rejected: evaluations.filter(item => item.status === 'rejected').length,
      ...(hasMore && last ? { nextCursor: last } : {}),
      extractorVersions: [...new Set(candidates.map(item => item.extractorVersion))],
      verifierVersions: [...new Set(evaluations.map(item => item.verifierVersion))],
      policyVersions: [...new Set(evaluations.map(item => item.policyVersion))],
    }
  }

  return { list, approve, reject, calibrationDataset, reprocess }
}

function appendEvent(
  draft: ReturnType<MemoryV4Repository['snapshot']>,
  candidate: MemoryCandidateV4,
  type: 'CANDIDATE_REVIEWED' | 'CANDIDATE_REPROCESSED',
  createdAt: number,
  payload: Record<string, string | boolean>,
  actor: 'user' | 'system' = 'user',
): void {
  const idempotencyKey = `${type.toLocaleLowerCase()}:${candidate.id}:${hash(JSON.stringify(payload))}`
  if (draft.domainEvents.some(event => event.idempotencyKey === idempotencyKey))
    return
  draft.domainEvents.push({
    id: `v4-review-event-${randomUUID()}`,
    idempotencyKey,
    type,
    scope: candidate.scope,
    createdAt,
    actor,
    payload,
  })
}

function matchesScope(candidate: MemoryV4Scope, scope: MemoryScope): boolean {
  return candidate.ownerId === scope.ownerId
    && candidate.agentId === (scope.agentId ?? 'default')
    && (scope.sessionId === undefined || candidate.sessionId === scope.sessionId)
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}
