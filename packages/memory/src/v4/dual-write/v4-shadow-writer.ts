import { createHash, randomUUID } from 'node:crypto'
import type {
  AdaptiveMemoryRecallResult,
  MemoryCapture,
  MemoryScope,
} from '@deskpet/contracts'
import type { MemoryCandidate } from '../../long-term/memory-extractor'
import type { MemoryCandidateEvaluation } from '../../long-term/memory-write-policy'
import type { MemorySourceUnlinkCommit } from '../../long-term/memory-writer'
import { inferMemoryPrivacy, isSafeMemoryContent } from '../../long-term/memory-extractor'
import type {
  V3MemoryCommit,
  V3MemoryCommitReason,
  V3MemoryRecord,
} from '../../long-term/vector-store'
import type {
  EvidenceLinkV4,
  JsonObject,
  MemoryEpisodeV4,
  MemoryFactStatusV4,
  MemoryFactVersionV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
  MemoryWriteActionV4,
  JsonValue,
  RetrievalEventV4,
} from '../domain/types'
import { normalizeMemoryV4Scope } from '../domain/validation'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export interface V4CapturedMemory {
  candidate: MemoryCandidate
  record: V3MemoryRecord
}

export interface V4ShadowCapture {
  turn: MemoryCapture
  scope: MemoryScope
  memories: V4CapturedMemory[]
  evaluations?: MemoryCandidateEvaluation[]
  capturedAt?: number
}

export interface V4ShadowRetrieval {
  query: string
  scope: MemoryScope
  retrievedMemoryIds: string[]
  injectedMemoryIds: string[]
  queryType: 'adaptive' | 'fixed'
  answerModel?: string
  createdAt?: number
}

export interface V4ShadowWriterOptions {
  repository: MemoryV4Repository
  now?: () => number
  flushDelayMs?: number
  onError?: (error: unknown) => void
}

export interface V4ShadowReconciliationResult {
  changed: boolean
  sourceCount: number
  mirroredCount: number
  deletedCount: number
}

export interface V4ShadowWriter {
  enqueueCommit: (commit: V3MemoryCommit) => void
  enqueueCapture: (capture: V4ShadowCapture) => void
  enqueueRetrieval: (retrieval: V4ShadowRetrieval) => void
  enqueueSourceUnlink: (commit: MemorySourceUnlinkCommit) => void
  flush: () => void
  reconcileV3Payload: (payload: string) => V4ShadowReconciliationResult
  pendingCount: () => number
}

type ShadowOperation =
  | { type: 'commit'; value: V3MemoryCommit }
  | { type: 'capture'; value: V4ShadowCapture }
  | { type: 'retrieval'; value: V4ShadowRetrieval }
  | { type: 'source-unlink'; value: MemorySourceUnlinkCommit }

interface ShadowIndexes {
  factByV3Id: Map<string, MemoryFactV4>
  episodeById: Map<string, MemoryEpisodeV4>
  evidenceByFactEpisode: Map<string, EvidenceLinkV4>
  candidateById: Map<string, MemoryV4Snapshot['candidates'][number]>
  maximumVersionByFact: Map<string, number>
  latestVersionByFact: Map<string, MemoryFactVersionV4>
  domainEventKeys: Set<string>
}

/**
 * Additive V3 -> V4 shadow writer.
 *
 * The caller acknowledges a V3 write before enqueueing it here. Operations are
 * batched into one V4 transaction and a failed batch remains queued for a
 * later retry. V4 is deliberately not a read dependency during this stage.
 */
export function createV4ShadowWriter(options: V4ShadowWriterOptions): V4ShadowWriter {
  const now = options.now ?? Date.now
  const flushDelayMs = clampInteger(options.flushDelayMs ?? 25, 0, 10_000)
  let pending: ShadowOperation[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false

  function schedule(): void {
    if (timer || flushing)
      return
    timer = setTimeout(() => {
      timer = undefined
      try {
        flush()
      }
      catch (error) {
        options.onError?.(error)
      }
    }, flushDelayMs)
    timer.unref?.()
  }

  function enqueue(operation: ShadowOperation): void {
    pending.push(jsonClone(operation))
    schedule()
  }

  function flush(): void {
    if (flushing || pending.length === 0)
      return
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const batch = pending
    pending = []
    flushing = true
    try {
      options.repository.transaction((draft) => {
        const indexes = buildShadowIndexes(draft)
        for (const operation of batch)
          applyOperation(draft, indexes, operation, now())
      })
    }
    catch (error) {
      pending = [...batch, ...pending]
      throw error
    }
    finally {
      flushing = false
    }
  }

  function reconcileV3Payload(payload: string): V4ShadowReconciliationResult {
    flush()
    const records = parseV3Records(payload)
    const sourcePayloadSha256 = sha256(payload)
    const current = options.repository.snapshot()
    if (current.dualWriteState?.sourcePayloadSha256 === sourcePayloadSha256
      && current.dualWriteState.sourceItemCount === records.length) {
      return {
        changed: false,
        sourceCount: records.length,
        mirroredCount: records.length,
        deletedCount: 0,
      }
    }
    let deletedCount = 0
    options.repository.transaction((draft) => {
      const indexes = buildShadowIndexes(draft)
      const sourceIds = new Set(records.map(record => record.id))
      for (const sourceId of allMirroredSourceIds(indexes)) {
        if (!sourceIds.has(sourceId) && deleteMirroredFact(draft, indexes, sourceId, now())) {
          deletedCount += 1
        }
      }
      const committedAt = now()
      for (const record of records)
        upsertRecord(draft, indexes, record, 'remember', committedAt, true)
      draft.dualWriteState = {
        sourcePayloadSha256,
        sourceItemCount: records.length,
        reconciledAt: committedAt,
        writerVersion: 'v4-shadow-stage2-v1',
      }
      appendDomainEvent(draft, {
        idempotencyKey: `v3-reconcile:${sourcePayloadSha256}`,
        type: 'V3_RECONCILED',
        scope: records[0] ? v4Scope(records[0].scope) : { ownerId: 'system', agentId: 'deskpet' },
        createdAt: committedAt,
        actor: 'system',
        payload: { sourcePayloadSha256, sourceItemCount: records.length },
      }, indexes.domainEventKeys)
    })
    return {
      changed: true,
      sourceCount: records.length,
      mirroredCount: records.length,
      deletedCount,
    }
  }

  return {
    enqueueCommit: commit => enqueue({ type: 'commit', value: commit }),
    enqueueCapture: capture => enqueue({ type: 'capture', value: capture }),
    enqueueRetrieval: retrieval => enqueue({ type: 'retrieval', value: retrieval }),
    enqueueSourceUnlink: commit => enqueue({ type: 'source-unlink', value: commit }),
    flush,
    reconcileV3Payload,
    pendingCount: () => pending.length,
  }
}

export function adaptiveResultToShadowRetrieval(
  query: string,
  scope: MemoryScope,
  result: AdaptiveMemoryRecallResult,
  answerModel?: string,
): V4ShadowRetrieval {
  return {
    query,
    scope,
    retrievedMemoryIds: result.retrievedMemoryIds,
    injectedMemoryIds: result.injectedMemoryIds,
    queryType: 'adaptive',
    ...(answerModel ? { answerModel } : {}),
  }
}

function applyOperation(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  operation: ShadowOperation,
  fallbackNow: number,
): void {
  if (operation.type === 'commit') {
    const committedAt = positiveTimestamp(operation.value.committedAt, fallbackNow)
    for (const sourceId of operation.value.deletedIds)
      deleteMirroredFact(draft, indexes, sourceId, committedAt, operation.value.reason === 'purge')
    for (const record of operation.value.upserts)
      upsertRecord(draft, indexes, record, operation.value.reason, committedAt, false)
    return
  }
  if (operation.type === 'capture') {
    recordCapture(draft, indexes, operation.value, fallbackNow)
    return
  }
  if (operation.type === 'source-unlink') {
    recordSourceUnlink(draft, indexes, operation.value, fallbackNow)
    return
  }
  recordRetrieval(draft, indexes, operation.value, fallbackNow)
}

function upsertRecord(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  record: V3MemoryRecord,
  reason: V3MemoryCommitReason,
  committedAt: number,
  reconciliation: boolean,
): void {
  const scope = v4Scope(record.scope)
  const existing = indexes.factByV3Id.get(record.id)
  const factId = existing?.id ?? stableId('fact', sourceKey(scope, record.id))
  // A completed privacy purge is irreversible. A stale V3 snapshot that
  // reappears after a partial disk failure must be reported by reconciliation,
  // never allowed to resurrect plaintext in V4.
  if (existing?.canonicalText === '[purged]' || existing?.metadata?.purgeCompletedAt !== undefined)
    return
  const previous = existing ? factVersionState(existing) : undefined
  const evidenceLinks = ensureRecordEvidence(draft, indexes, factId, scope, record, committedAt)
  const currentEvidenceIds = new Set(evidenceLinks.map(link => link.id))
  for (const link of draft.evidenceLinks) {
    if (link.factId !== factId || currentEvidenceIds.has(link.id) || !link.active)
      continue
    link.active = false
    link.invalidatedAt = Math.max(link.createdAt, committedAt)
  }
  const directEvidence = evidenceLinks.some(link => link.strength === 'direct' && link.active)
  const policyVerified = score(record.metadata?.memoryVerificationScore, 0) >= 0.72
    && typeof record.metadata?.memoryVerifierVersion === 'string'
  const incomingStatus = normalizeFactStatus(record.status)
  const status = record.origin !== 'manual' && incomingStatus === 'active' && !directEvidence
    ? 'quarantined'
    : incomingStatus
  const relatedFactId = record.supersedes ? indexes.factByV3Id.get(record.supersedes)?.id : undefined
  const metadata = mergeFactMetadata(existing?.metadata, {
    v3SourceId: record.id,
    ...(typeof record.metadata?.kind === 'string' ? { v3Kind: record.metadata.kind } : {}),
  })
  const fact: MemoryFactV4 = existing ?? {
    id: factId,
    scope,
    subjectId: `owner:${scope.ownerId}`,
    predicate: predicateFor(record),
    object: record.content,
    objectType: 'string',
    normalizedValue: normalizedFactValue(record.content),
    canonicalText: record.content,
    memoryKey: record.memoryKey ?? `v3.fact.${record.id}`,
    cardinality: cardinalityFor(record),
    polarity: polarityFor(record.content),
    modality: 'asserted',
    status,
    recordedAt: positiveTimestamp(record.createdAt, committedAt),
    updatedAt: positiveTimestamp(record.updatedAt, committedAt),
    evidenceLinkIds: [],
    extractionScore: score(record.confidence, 0.7),
    verificationScore: record.origin === 'manual' ? 1 : score(record.metadata?.memoryVerificationScore, 0),
    evidenceScore: directEvidence ? 1 : evidenceLinks.length > 0 ? 0.4 : 0,
    utilityScore: utilityFor(record),
    importance: score(record.importance, 0.6),
    accessCount: nonNegativeInteger(record.accessCount),
    userConfirmed: record.origin === 'manual',
    verificationState: record.origin === 'manual' || policyVerified ? 'verified' : 'pending',
    supersedesFactIds: [],
    conflictsWithFactIds: [],
    sensitivity: normalizeSensitivity(record.sensitivity),
    sharePolicy: normalizeSharePolicy(record.sharePolicy),
    origin: normalizeOrigin(record.origin),
    extractorVersion: 'v3-dual-write',
    verifierVersion: record.origin === 'manual'
      ? 'manual-confirmed'
      : stringMetadata(record.metadata?.memoryVerifierVersion) ?? 'stage2-pending',
  }

  fact.scope = scope
  fact.subjectId = `owner:${scope.ownerId}`
  fact.predicate = predicateFor(record)
  fact.object = record.content
  fact.objectType = 'string'
  fact.normalizedValue = normalizedFactValue(record.content)
  fact.canonicalText = record.content
  fact.memoryKey = record.memoryKey ?? fact.memoryKey ?? `v3.fact.${record.id}`
  fact.cardinality = cardinalityFor(record)
  fact.polarity = polarityFor(record.content)
  fact.status = status
  assignOptionalTimestamp(fact, 'validFrom', record.validFrom)
  assignOptionalTimestamp(fact, 'validTo', record.validTo)
  assignOptionalTimestamp(fact, 'invalidatedAt', record.invalidatedAt)
  assignOptionalTimestamp(fact, 'expiresAt', record.expiresAt)
  fact.updatedAt = Math.max(fact.recordedAt, positiveTimestamp(record.updatedAt, committedAt))
  fact.evidenceLinkIds = uniqueStrings([...fact.evidenceLinkIds, ...evidenceLinks.map(link => link.id)])
  fact.extractionScore = score(record.confidence, fact.extractionScore)
  fact.evidenceScore = directEvidence ? 1 : evidenceLinks.length > 0 ? Math.max(fact.evidenceScore, 0.4) : fact.evidenceScore
  fact.utilityScore = utilityFor(record)
  fact.importance = score(record.importance, fact.importance)
  fact.accessCount = nonNegativeInteger(record.accessCount)
  assignOptionalTimestamp(fact, 'lastAccessedAt', record.lastAccessedAt)
  fact.userConfirmed = record.origin === 'manual' || fact.userConfirmed
  fact.verificationState = record.origin === 'manual' || policyVerified
    ? 'verified'
    : fact.verificationState === 'legacy-unverified' ? 'legacy-unverified' : 'pending'
  fact.verificationScore = record.origin === 'manual'
    ? 1
    : score(record.metadata?.memoryVerificationScore, fact.verificationScore)
  fact.verifierVersion = record.origin === 'manual'
    ? 'manual-confirmed'
    : stringMetadata(record.metadata?.memoryVerifierVersion) ?? fact.verifierVersion
  fact.supersedesFactIds = relatedFactId ? [relatedFactId] : fact.supersedesFactIds.filter(id => id !== fact.id)
  fact.sensitivity = normalizeSensitivity(record.sensitivity)
  fact.sharePolicy = normalizeSharePolicy(record.sharePolicy)
  fact.origin = normalizeOrigin(record.origin)
  fact.extractorVersion = 'v3-dual-write'
  fact.metadata = metadata
  if (fact.status !== 'deleted' && fact.metadata.v3DeletedAt !== undefined)
    delete fact.metadata.v3DeletedAt
  if (!existing) {
    draft.facts.push(fact)
    indexes.factByV3Id.set(record.id, fact)
  }

  const current = factVersionState(fact)
  if (!previous || !sameVersionState(previous, current)) {
    appendFactVersion(
      draft,
      indexes,
      fact,
      previous ? operationFor(fact, previous) : 'ADD',
      committedAt,
      reconciliation ? 'Reconciled from the durable V3 index at startup.' : `Mirrored committed V3 ${reason} change.`,
    )
  }
}

function ensureRecordEvidence(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  factId: string,
  factScope: MemoryV4Scope,
  record: V3MemoryRecord,
  now: number,
): EvidenceLinkV4[] {
  const episodes: MemoryEpisodeV4[] = []
  for (const sourceMessageId of uniqueStrings(record.sourceMessageIds)) {
    const episodeId = stableId('episode-message', sourceKey(factScope, sourceMessageId))
    episodes.push(ensureEpisode(draft, indexes, {
      id: episodeId,
      scope: factScope,
      actor: 'user',
      kind: 'message-reference',
      contentState: 'unavailable',
      recordedAt: positiveTimestamp(record.createdAt, now),
      sourceMessageId,
      sourceAttachmentIds: [],
      sensitivity: normalizeSensitivity(record.sensitivity),
      sharePolicy: normalizeSharePolicy(record.sharePolicy),
      provenance: 'v3-reference',
    }))
  }
  for (const sourceAttachmentId of uniqueStrings(record.sourceAttachmentIds)) {
    const episodeId = stableId('episode-attachment', sourceKey(factScope, sourceAttachmentId))
    episodes.push(ensureEpisode(draft, indexes, {
      id: episodeId,
      scope: factScope,
      actor: 'image-observation',
      kind: 'attachment-reference',
      contentState: 'unavailable',
      recordedAt: positiveTimestamp(record.createdAt, now),
      sourceAttachmentIds: [sourceAttachmentId],
      sensitivity: normalizeSensitivity(record.sensitivity),
      sharePolicy: normalizeSharePolicy(record.sharePolicy),
      provenance: 'v3-reference',
    }))
  }
  if (episodes.length === 0) {
    const manual = record.origin === 'manual'
    // A body edit is new evidence. Include the immutable content digest in the
    // synthetic episode identity so an update cannot overwrite its predecessor.
    const contentHash = sha256(record.content)
    episodes.push(ensureEpisode(draft, indexes, {
      id: stableId('episode-record', `${sourceKey(factScope, record.id)}\0${contentHash}`),
      scope: factScope,
      actor: manual ? 'user' : 'legacy-import',
      kind: manual ? 'manual-declaration' : 'legacy-memory-record',
      contentState: 'available',
      content: record.content,
      contentHash,
      recordedAt: positiveTimestamp(record.createdAt, now),
      sourceAttachmentIds: uniqueStrings(record.sourceAttachmentIds),
      sensitivity: normalizeSensitivity(record.sensitivity),
      sharePolicy: normalizeSharePolicy(record.sharePolicy),
      provenance: manual ? 'native-v4' : 'v3-derived-record',
    }))
  }

  return episodes.map((episode) => {
    const evidenceKey = factEpisodeKey(factId, episode.id)
    const existing = indexes.evidenceByFactEpisode.get(evidenceKey)
    if (existing) {
      existing.active = record.status !== 'orphaned'
      if (existing.active)
        delete existing.invalidatedAt
      else
        existing.invalidatedAt = Math.max(existing.createdAt, now)
      return existing
    }
    const direct = record.origin === 'manual' && episode.contentState === 'available'
    const link: EvidenceLinkV4 = {
      id: stableId('evidence', `${factId}\u0000${episode.id}`),
      factId,
      episodeId: episode.id,
      role: direct ? 'supports' : episode.contentState === 'available' ? 'legacy-derived' : 'references',
      strength: direct ? 'direct' : episode.contentState === 'available' ? 'legacy-derived' : 'reference-only',
      active: record.status !== 'orphaned',
      createdAt: now,
      ...(record.status === 'orphaned' ? { invalidatedAt: now } : {}),
      note: direct
        ? 'Native V4 evidence captured from a user-managed V3 write.'
        : episode.contentState === 'available'
          ? 'V3 fact text retained for audit; it is not treated as original user evidence.'
        : 'V3 retained the source identifier; native content may be attached by capture enrichment.',
    }
    draft.evidenceLinks.push(link)
    indexes.evidenceByFactEpisode.set(evidenceKey, link)
    return link
  })
}

function recordCapture(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  capture: V4ShadowCapture,
  fallbackNow: number,
): void {
  const evaluations = capture.evaluations ?? []
  const originalUserMessage = capture.turn.originalUserMessage?.slice(0, 100_000)
  const episodeContent = originalUserMessage && isSafeMemoryContent(originalUserMessage)
    ? originalUserMessage
    : capture.turn.userMessage
  if ((capture.memories.length === 0 && evaluations.length === 0) || !isSafeMemoryContent(episodeContent))
    return
  const recordedAt = positiveTimestamp(capture.capturedAt, fallbackNow)
  const factScope = v4Scope(capture.scope)
  const episodeScope = v4Scope({
    ...capture.scope,
    ...(typeof capture.turn.metadata?.sessionId === 'string'
      ? { sessionId: capture.turn.metadata.sessionId }
      : {}),
  })
  const sourceMessageId = firstString(capture.turn.metadata?.sourceMessageIds)
  const attachmentIds = uniqueStrings([
    ...arrayStrings(capture.turn.metadata?.sourceAttachmentIds),
    ...(capture.turn.attachments ?? []).map(attachment => attachment.id).filter((id): id is string => !!id),
  ])
  const episodeId = sourceMessageId
    ? stableId('episode-message', sourceKey(factScope, sourceMessageId))
    : stableId('episode-message', `${sourceKey(factScope, sha256(episodeContent))}\u0000${recordedAt}`)
  const episodePrivacy = inferMemoryPrivacy(episodeContent)
  const sensitivity = mostSensitive([
    episodePrivacy.sensitivity,
    ...capture.memories.map(item => item.record.sensitivity),
  ])
  const sharePolicy = mostRestrictiveShare([
    episodePrivacy.sharePolicy,
    ...capture.memories.map(item => item.record.sharePolicy),
  ])
  const episode = ensureEpisode(draft, indexes, {
    id: episodeId,
    scope: episodeScope,
    actor: 'user',
    kind: 'message',
    contentState: 'available',
    content: episodeContent,
    contentHash: sha256(episodeContent),
    recordedAt,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    sourceAttachmentIds: attachmentIds,
    sensitivity,
    sharePolicy,
    provenance: 'native-v4',
  })

  for (const evaluation of evaluations) {
    const record = capture.memories.find(item => item.candidate === evaluation.candidate)?.record
      ?? capture.memories.find(item => item.candidate.content === evaluation.candidate.content)?.record
    upsertEvaluatedCandidate(draft, indexes, evaluation, record, factScope, episode, recordedAt)
  }

  for (const { candidate, record } of capture.memories) {
    const fact = indexes.factByV3Id.get(record.id)
    if (!fact)
      continue
    const candidateId = evaluatedCandidateId(fact.scope, episode.id, candidate.content)
    let memoryCandidate = indexes.candidateById.get(candidateId)
    const link = ensureDirectEvidence(draft, indexes, fact, episode, recordedAt)
    const previous = factVersionState(fact)
    if (!memoryCandidate) {
      const evaluation = evaluations.find(item => item.candidate === candidate)
        ?? evaluations.find(item => item.candidate.content === candidate.content)
      memoryCandidate = {
        id: candidateId,
        scope: fact.scope,
        evidenceEpisodeIds: [episode.id],
        subjectId: stringMetadata(candidate.metadata.subjectId) ?? fact.subjectId,
        predicate: stringMetadata(candidate.metadata.predicate) ?? predicateFor(record),
        object: candidate.content,
        objectType: 'string',
        normalizedValue: stringMetadata(candidate.metadata.normalizedValue) ?? normalizedFactValue(candidate.content),
        canonicalText: candidate.content,
        polarity: candidatePolarity(candidate),
        modality: candidateModalityFromMetadata(candidate),
        ...(stringMetadata(candidate.metadata.condition) ? { condition: stringMetadata(candidate.metadata.condition) } : {}),
        cardinality: candidateCardinality(candidate, record),
        ...(optionalTimestamp(record.validFrom) ? { validFrom: optionalTimestamp(record.validFrom) } : {}),
        ...(optionalTimestamp(record.validTo) ? { validTo: optionalTimestamp(record.validTo) } : {}),
        extractionScore: score(evaluation?.extractionScore, score(record.confidence, 0.7)),
        verificationScore: score(evaluation?.verificationScore, record.origin === 'manual' ? 1 : 0),
        evidenceScore: score(evaluation?.evidenceScore, record.origin === 'manual' ? 1 : 0),
        ...(evaluation ? calibrationFields(evaluation) : {}),
        durabilityScore: score(evaluation?.durabilityScore, score(record.importance, 0.6)),
        ambiguityFlags: evaluation?.ambiguityFlags ?? [],
        proposedAction: evaluation?.action ?? (previous.status === 'quarantined' ? 'ADD' : 'MERGE_EVIDENCE'),
        status: 'accepted',
        extractorVersion: stringMetadata(candidate.metadata.extractorVersion) ?? 'v3-capture-dual-write',
        verifierVersion: evaluation?.verifierVersion ?? (record.origin === 'manual' ? 'manual-confirmed' : 'stage2-pending'),
        ...(evaluation ? {
          policyVersion: evaluation.policyVersion,
          decisionReasonCodes: uniqueStrings(evaluation.reasonCodes),
        } : {}),
        createdAt: recordedAt,
        updatedAt: recordedAt,
      }
      draft.candidates.push(memoryCandidate)
      indexes.candidateById.set(candidateId, memoryCandidate)
    }
    else {
      memoryCandidate.evidenceEpisodeIds = uniqueStrings([...memoryCandidate.evidenceEpisodeIds, episode.id])
      memoryCandidate.updatedAt = Math.max(memoryCandidate.updatedAt, recordedAt)
    }
    fact.evidenceLinkIds = uniqueStrings([...fact.evidenceLinkIds, link.id])
    fact.evidenceScore = 1
    fact.status = normalizeFactStatus(record.status)
    const evaluation = evaluations.find(item => item.candidate === candidate)
      ?? evaluations.find(item => item.candidate.content === candidate.content)
    fact.verificationState = record.origin === 'manual' || evaluation?.status === 'accepted' ? 'verified' : 'pending'
    fact.verificationScore = record.origin === 'manual' ? 1 : score(evaluation?.verificationScore, fact.verificationScore)
    fact.verifierVersion = evaluation?.verifierVersion ?? fact.verifierVersion
    fact.updatedAt = Math.max(fact.updatedAt, recordedAt)
    fact.metadata = mergeFactMetadata(fact.metadata, {
      v3SourceId: record.id,
      v4CandidateIds: uniqueStrings([
        ...jsonStringArray(fact.metadata?.v4CandidateIds),
        candidateId,
      ]),
    })
    const current = factVersionState(fact)
    if (!sameVersionState(previous, current)) {
      appendFactVersion(
        draft,
        indexes,
        fact,
        'MERGE_EVIDENCE',
        recordedAt,
        'Attached the original user episode to the accepted V3 fact.',
      )
    }
  }
}

function upsertEvaluatedCandidate(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  evaluation: MemoryCandidateEvaluation,
  record: V3MemoryRecord | undefined,
  scope: MemoryV4Scope,
  episode: MemoryEpisodeV4,
  recordedAt: number,
): void {
  const candidate = evaluation.candidate
  const candidateId = evaluatedCandidateId(scope, episode.id, candidate.content)
  const existing = indexes.candidateById.get(candidateId)
  const fact = record ? indexes.factByV3Id.get(record.id) : undefined
  const incoming: MemoryV4Snapshot['candidates'][number] = {
    id: candidateId,
    scope,
    evidenceEpisodeIds: [episode.id],
    subjectId: stringMetadata(candidate.metadata.subjectId) ?? `owner:${scope.ownerId}`,
    predicate: stringMetadata(candidate.metadata.predicate) ?? (record ? predicateFor(record) : candidatePredicate(candidate)),
    object: candidate.content,
    objectType: 'string',
    normalizedValue: stringMetadata(candidate.metadata.normalizedValue) ?? normalizedFactValue(candidate.content),
    canonicalText: candidate.content,
    polarity: candidatePolarity(candidate),
    modality: candidateModality(evaluation),
    ...(stringMetadata(candidate.metadata.condition) ? { condition: stringMetadata(candidate.metadata.condition) } : {}),
    cardinality: candidate.metadata.cardinality === 'single' || candidate.metadata.cardinality === 'set'
      ? candidate.metadata.cardinality : 'multiple',
    ...(optionalTimestamp(candidate.metadata.validFrom) ? { validFrom: optionalTimestamp(candidate.metadata.validFrom) } : {}),
    ...(optionalTimestamp(candidate.metadata.validTo) ? { validTo: optionalTimestamp(candidate.metadata.validTo) } : {}),
    extractionScore: score(evaluation.extractionScore, 0),
    verificationScore: score(evaluation.verificationScore, 0),
    evidenceScore: score(evaluation.evidenceScore, 0),
    ...calibrationFields(evaluation),
    durabilityScore: score(evaluation.durabilityScore, 0),
    ambiguityFlags: uniqueStrings(evaluation.ambiguityFlags),
    proposedAction: evaluation.action,
    status: evaluation.status,
    extractorVersion: stringMetadata(candidate.metadata.extractorVersion) ?? 'unknown-extractor',
    verifierVersion: evaluation.verifierVersion,
    policyVersion: evaluation.policyVersion,
    decisionReasonCodes: uniqueStrings(evaluation.reasonCodes),
    createdAt: existing?.createdAt ?? recordedAt,
    updatedAt: Math.max(existing?.updatedAt ?? recordedAt, recordedAt),
  }
  if (existing) {
    Object.assign(existing, incoming, {
      evidenceEpisodeIds: uniqueStrings([...existing.evidenceEpisodeIds, episode.id]),
      createdAt: existing.createdAt,
    })
  }
  else {
    draft.candidates.push(incoming)
    indexes.candidateById.set(candidateId, incoming)
  }
  if (fact) {
    fact.metadata = mergeFactMetadata(fact.metadata, {
      v4CandidateIds: uniqueStrings([
        ...jsonStringArray(fact.metadata?.v4CandidateIds),
        candidateId,
      ]),
      memoryPolicyVersion: evaluation.policyVersion,
    })
  }
}

function calibrationFields(evaluation: MemoryCandidateEvaluation) {
  return {
    calibratedActiveProbability: score(evaluation.calibration.probability, 0),
    calibrationLowerBound: score(evaluation.calibration.lowerBound, 0),
    calibrationUpperBound: score(evaluation.calibration.upperBound, 1),
    calibrationStatus: evaluation.calibration.status,
    calibrationMethod: evaluation.calibration.method,
    calibratorVersion: evaluation.calibration.calibratorVersion,
    calibrationCohort: evaluation.calibration.cohort,
  }
}

function candidatePredicate(candidate: MemoryCandidate): string {
  return stringMetadata(candidate.metadata.memoryKey)
    ?? stringMetadata(candidate.metadata.kind)
    ?? 'memory.fact'
}

function evaluatedCandidateId(scope: MemoryV4Scope, episodeId: string, content: string): string {
  return stableId('candidate-evaluation', `${sourceKey(scope, episodeId)}\u0000${content}`)
}

function candidateModality(evaluation: MemoryCandidateEvaluation): MemoryFactV4['modality'] {
  const normalized = candidateModalityFromMetadata(evaluation.candidate)
  if (normalized !== 'unknown' && normalized !== 'asserted')
    return normalized
  if (evaluation.ambiguityFlags.includes('non-asserted:hypothetical'))
    return 'hypothetical'
  if (evaluation.ambiguityFlags.includes('non-asserted:reported-speech'))
    return 'reported'
  return 'asserted'
}

function candidatePolarity(candidate: MemoryCandidate): MemoryFactV4['polarity'] {
  const value = candidate.metadata.polarity
  return value === 'positive' || value === 'negative' || value === 'unknown'
    ? value
    : polarityFor(candidate.content)
}

function candidateModalityFromMetadata(candidate: MemoryCandidate): MemoryFactV4['modality'] {
  const value = candidate.metadata.modality
  return value === 'asserted' || value === 'planned' || value === 'hypothetical'
    || value === 'reported' || value === 'inferred' || value === 'unknown'
    ? value
    : 'asserted'
}

function candidateCardinality(candidate: MemoryCandidate, record: V3MemoryRecord): MemoryFactV4['cardinality'] {
  return candidate.metadata.cardinality === 'single' || candidate.metadata.cardinality === 'set'
    ? candidate.metadata.cardinality
    : cardinalityFor(record)
}

function recordRetrieval(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  retrieval: V4ShadowRetrieval,
  fallbackNow: number,
): void {
  const retrievedFactIds = memoryIdsToFactIds(indexes, retrieval.retrievedMemoryIds)
  const injectedFactIds = memoryIdsToFactIds(indexes, retrieval.injectedMemoryIds)
  const event: RetrievalEventV4 = {
    id: `v4-retrieval-${randomUUID()}`,
    scope: v4Scope(retrieval.scope),
    queryHash: sha256(retrieval.query),
    queryType: retrieval.queryType,
    retrievedFactIds,
    injectedFactIds,
    adoptedFactIds: [],
    correctedFactIds: [],
    deniedFactIds: [],
    createdAt: positiveTimestamp(retrieval.createdAt, fallbackNow),
    retrievalVersion: 'adaptive-batched-v1',
    ...(retrieval.answerModel ? { answerModel: retrieval.answerModel } : {}),
  }
  draft.retrievalEvents.push(event)
}

function recordSourceUnlink(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  commit: MemorySourceUnlinkCommit,
  fallbackNow: number,
): void {
  const requested = new Set(uniqueStrings(commit.messageIds))
  if (requested.size === 0)
    return
  const scope = v4Scope(commit.scope)
  const episodeIds = new Set(draft.episodes
    .filter(episode => episode.sourceMessageId && requested.has(episode.sourceMessageId)
      && sameV4Scope(scope, episode.scope))
    .map(episode => episode.id))
  if (episodeIds.size === 0)
    return
  const timestamp = positiveTimestamp(commit.unlinkedAt, fallbackNow)
  let unlinkedEvidence = 0
  let scrubbedCandidates = 0
  let staleArtifacts = 0
  const affectedFacts = new Set<string>()

  for (const episode of draft.episodes) {
    if (!episodeIds.has(episode.id))
      continue
    episode.contentState = 'deleted'
    delete episode.content
    delete episode.contentHash
    episode.deletedAt = Math.max(episode.recordedAt, timestamp)
  }
  for (const link of draft.evidenceLinks) {
    if (!episodeIds.has(link.episodeId) || !link.active)
      continue
    link.active = false
    link.invalidatedAt = Math.max(link.createdAt, timestamp)
    affectedFacts.add(link.factId)
    unlinkedEvidence += 1
  }
  const factCandidateIds = new Set(draft.facts.flatMap(fact => jsonStringArray(fact.metadata?.v4CandidateIds)))
  for (const candidate of draft.candidates) {
    if (!candidate.evidenceEpisodeIds.some(id => episodeIds.has(id)))
      continue
    const hasAvailableEvidence = candidate.evidenceEpisodeIds.some(id => indexes.episodeById.get(id)?.contentState === 'available')
    if (!hasAvailableEvidence && !factCandidateIds.has(candidate.id)) {
      candidate.object = '[source-deleted]'
      candidate.objectType = 'string'
      candidate.normalizedValue = '[source-deleted]'
      candidate.canonicalText = '[source-deleted]'
      candidate.status = 'rejected'
      candidate.proposedAction = 'NOOP'
      candidate.ambiguityFlags = uniqueStrings([...candidate.ambiguityFlags, 'source-deleted'])
      candidate.decisionReasonCodes = uniqueStrings([...(candidate.decisionReasonCodes ?? []), 'source-deleted'])
      candidate.updatedAt = Math.max(candidate.updatedAt, timestamp)
      scrubbedCandidates += 1
    }
  }
  for (const factId of affectedFacts) {
    const fact = draft.facts.find(item => item.id === factId)
    if (!fact)
      continue
    const hasActiveEvidence = draft.evidenceLinks.some(link => link.factId === factId && link.active)
    if (!hasActiveEvidence && fact.origin !== 'manual' && fact.status === 'active') {
      fact.status = 'orphaned'
      fact.updatedAt = Math.max(fact.updatedAt, timestamp)
      appendFactVersion(draft, indexes, fact, 'NOOP', fact.updatedAt, 'Source chat message was deleted.')
    }
  }
  for (const artifact of draft.derivedArtifacts) {
    if (artifact.status !== 'current' || !artifact.sourceEpisodeIds.some(id => episodeIds.has(id)))
      continue
    artifact.status = 'stale'
    artifact.invalidatedAt = Math.max(artifact.createdAt, timestamp)
    artifact.updatedAt = Math.max(artifact.updatedAt, timestamp)
    staleArtifacts += 1
  }
  appendDomainEvent(draft, {
    idempotencyKey: `source-unlink:${sha256(`${sourceKey(scope, [...requested].sort().join('\u0000'))}`)}`,
    type: 'EVIDENCE_UNLINKED',
    scope,
    createdAt: timestamp,
    actor: 'user',
    payload: { unlinkedEvidence, scrubbedCandidates, staleArtifacts },
  }, indexes.domainEventKeys)
}

function ensureEpisode(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  incoming: MemoryEpisodeV4,
): MemoryEpisodeV4 {
  const existing = indexes.episodeById.get(incoming.id)
  if (!existing) {
    draft.episodes.push(incoming)
    indexes.episodeById.set(incoming.id, incoming)
    return incoming
  }
  existing.scope = incoming.scope
  existing.sensitivity = moreSensitive(existing.sensitivity, incoming.sensitivity)
  existing.sharePolicy = moreRestrictiveShare(existing.sharePolicy, incoming.sharePolicy)
  existing.sourceAttachmentIds = uniqueStrings([...existing.sourceAttachmentIds, ...incoming.sourceAttachmentIds])
  if (incoming.contentState === 'available') {
    existing.actor = incoming.actor
    existing.kind = incoming.kind
    existing.contentState = 'available'
    existing.content = incoming.content
    existing.contentHash = incoming.contentHash
    existing.provenance = incoming.provenance
    delete existing.deletedAt
  }
  if (incoming.sourceMessageId)
    existing.sourceMessageId = incoming.sourceMessageId
  return existing
}

function ensureDirectEvidence(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  fact: MemoryFactV4,
  episode: MemoryEpisodeV4,
  now: number,
): EvidenceLinkV4 {
  const evidenceKey = factEpisodeKey(fact.id, episode.id)
  const existing = indexes.evidenceByFactEpisode.get(evidenceKey)
  if (existing) {
    existing.role = 'supports'
    existing.strength = 'direct'
    existing.active = true
    delete existing.invalidatedAt
    existing.note = 'Original user episode captured by native V4 dual-write.'
    return existing
  }
  const link: EvidenceLinkV4 = {
    id: stableId('evidence', `${fact.id}\u0000${episode.id}`),
    factId: fact.id,
    episodeId: episode.id,
    role: 'supports',
    strength: 'direct',
    active: true,
    createdAt: now,
    note: 'Original user episode captured by native V4 dual-write.',
  }
  draft.evidenceLinks.push(link)
  indexes.evidenceByFactEpisode.set(evidenceKey, link)
  return link
}

function appendFactVersion(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  fact: MemoryFactV4,
  operation: MemoryWriteActionV4,
  recordedAt: number,
  reason: string,
): void {
  const nextVersion = (indexes.maximumVersionByFact.get(fact.id) ?? 0) + 1
  const prior = indexes.latestVersionByFact.get(fact.id)
  if (prior && prior.transactionClosedAt === undefined)
    prior.transactionClosedAt = Math.max(prior.recordedAt, recordedAt)
  const versionId = stableId('version', `${fact.id}\u0000${nextVersion}`)
  const appendedVersion: MemoryFactVersionV4 = {
    id: versionId,
    factId: fact.id,
    version: nextVersion,
    operation,
    subjectId: fact.subjectId,
    predicate: fact.predicate,
    object: fact.object,
    objectType: fact.objectType,
    normalizedValue: fact.normalizedValue,
    canonicalText: fact.canonicalText,
    polarity: fact.polarity,
    modality: fact.modality,
    ...(fact.condition ? { condition: fact.condition } : {}),
    status: fact.status,
    ...(fact.validFrom ? { validFrom: fact.validFrom } : {}),
    ...(fact.validTo ? { validTo: fact.validTo } : {}),
    evidenceLinkIds: [...fact.evidenceLinkIds],
    recordedAt,
    reason,
  }
  draft.factVersions.push(appendedVersion)
  indexes.latestVersionByFact.set(fact.id, appendedVersion)
  appendDomainEvent(draft, {
    idempotencyKey: `fact-version:${versionId}`,
      type: nextVersion === 1 ? 'FACT_CREATED' : operation === 'DELETE' ? 'FACT_DELETED'
      : operation === 'PURGE' ? 'FACT_PURGED' : operation === 'SUPPRESS' ? 'FACT_SUPPRESSED'
        : operation === 'RESTORE' ? 'FACT_RESTORED' : 'FACT_VERSIONED',
    scope: fact.scope,
    factId: fact.id,
    createdAt: recordedAt,
    actor: 'system',
    payload: { operation, version: nextVersion },
  }, indexes.domainEventKeys)
  indexes.maximumVersionByFact.set(fact.id, nextVersion)
}

function appendDomainEvent(
  draft: MemoryV4Snapshot,
  event: Omit<MemoryV4Snapshot['domainEvents'][number], 'id'>,
  knownKeys?: Set<string>,
): void {
  if (knownKeys?.has(event.idempotencyKey)
    || (!knownKeys && draft.domainEvents.some(existing => existing.idempotencyKey === event.idempotencyKey)))
    return
  draft.domainEvents.push({
    id: stableId('domain-event', event.idempotencyKey),
    ...event,
  })
  knownKeys?.add(event.idempotencyKey)
}

function deleteMirroredFact(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  sourceId: string,
  deletedAt: number,
  purge = false,
): boolean {
  const fact = indexes.factByV3Id.get(sourceId)
  if (!fact)
    return false
  const alreadyPurged = fact.canonicalText === '[purged]' || fact.metadata?.purgeCompletedAt !== undefined
  if (alreadyPurged) {
    fact.status = 'deleted'
    fact.invalidatedAt ??= Math.max(fact.recordedAt, deletedAt)
    fact.updatedAt = Math.max(fact.updatedAt, deletedAt)
    return false
  }
  if (fact.status === 'deleted')
    return false
  for (const link of draft.evidenceLinks) {
    if (link.factId !== fact.id || !link.active)
      continue
    link.active = false
    link.invalidatedAt = Math.max(link.createdAt, deletedAt)
  }
  fact.status = 'deleted'
  fact.invalidatedAt = Math.max(fact.recordedAt, deletedAt)
  fact.updatedAt = Math.max(fact.updatedAt, deletedAt)
  fact.metadata = mergeFactMetadata(fact.metadata, { v3SourceId: sourceId, v3DeletedAt: deletedAt })
  if (purge) {
    const episodeIds = new Set(draft.evidenceLinks.filter(link => link.factId === fact.id).map(link => link.episodeId))
    for (const episode of draft.episodes) {
      if (!episodeIds.has(episode.id))
        continue
      const shared = draft.evidenceLinks.some(link => link.episodeId === episode.id && link.factId !== fact.id && link.active)
      if (shared)
        continue
      episode.contentState = 'deleted'
      delete episode.content
      delete episode.contentHash
      delete episode.sourceMessageId
      episode.sourceAttachmentIds = []
      episode.deletedAt = Math.max(episode.recordedAt, deletedAt)
    }
    fact.object = '[purged]'
    fact.objectType = 'string'
    fact.normalizedValue = '[purged]'
    fact.canonicalText = '[purged]'
    fact.metadata = { v3SourceId: sourceId, purgeCompletedAt: deletedAt }
    for (const version of draft.factVersions) {
      if (version.factId !== fact.id)
        continue
      version.object = '[purged]'
      version.objectType = 'string'
      version.normalizedValue = '[purged]'
      version.canonicalText = '[purged]'
      version.reason = 'Historical content removed by an irreversible purge.'
      delete version.condition
    }
    for (const legacy of draft.legacyImports) {
      if (legacy.factId === fact.id)
        legacy.raw = { id: legacy.sourceItemId, purgedAt: deletedAt }
    }
  }
  appendFactVersion(
    draft,
    indexes,
    fact,
    purge ? 'PURGE' : 'DELETE',
    deletedAt,
    purge ? 'The source V3 fact and its recoverable V4 content were irreversibly purged.'
      : 'The source V3 fact was explicitly forgotten or removed during reconciliation.',
  )
  return true
}

function allMirroredSourceIds(indexes: ShadowIndexes): Set<string> {
  return new Set(indexes.factByV3Id.keys())
}

function memoryIdsToFactIds(indexes: ShadowIndexes, memoryIds: string[]): string[] {
  return uniqueStrings(memoryIds.map(id => indexes.factByV3Id.get(id)?.id).filter((id): id is string => !!id))
}

function buildShadowIndexes(draft: MemoryV4Snapshot): ShadowIndexes {
  const factById = new Map(draft.facts.map(fact => [fact.id, fact]))
  const factByV3Id = new Map<string, MemoryFactV4>()
  for (const legacy of draft.legacyImports) {
    const fact = factById.get(legacy.factId)
    if (fact)
      factByV3Id.set(legacy.sourceItemId, fact)
  }
  for (const fact of draft.facts) {
    if (typeof fact.metadata?.v3SourceId === 'string')
      factByV3Id.set(fact.metadata.v3SourceId, fact)
  }
  const maximumVersionByFact = new Map<string, number>()
  const latestVersionByFact = new Map<string, MemoryFactVersionV4>()
  for (const version of draft.factVersions) {
    const maximum = maximumVersionByFact.get(version.factId) ?? 0
    if (version.version >= maximum) {
      maximumVersionByFact.set(version.factId, version.version)
      latestVersionByFact.set(version.factId, version)
    }
  }
  return {
    factByV3Id,
    episodeById: new Map(draft.episodes.map(episode => [episode.id, episode])),
    evidenceByFactEpisode: new Map(draft.evidenceLinks.map(link => [
      factEpisodeKey(link.factId, link.episodeId),
      link,
    ])),
    candidateById: new Map(draft.candidates.map(candidate => [candidate.id, candidate])),
    maximumVersionByFact,
    latestVersionByFact,
    domainEventKeys: new Set(draft.domainEvents.map(event => event.idempotencyKey)),
  }
}

function factEpisodeKey(factId: string, episodeId: string): string {
  return `${factId}\u0000${episodeId}`
}

interface FactVersionState {
  subjectId: string
  predicate: string
  object: JsonValue
  objectType: MemoryFactV4['objectType']
  normalizedValue: JsonValue
  canonicalText: string
  polarity: MemoryFactV4['polarity']
  modality: MemoryFactV4['modality']
  condition?: string
  status: MemoryFactStatusV4
  validFrom?: number
  validTo?: number
  evidenceLinkIds: string[]
}

function factVersionState(fact: MemoryFactV4): FactVersionState {
  return {
    subjectId: fact.subjectId,
    predicate: fact.predicate,
    object: fact.object,
    objectType: fact.objectType,
    normalizedValue: fact.normalizedValue,
    canonicalText: fact.canonicalText,
    polarity: fact.polarity,
    modality: fact.modality,
    condition: fact.condition,
    status: fact.status,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    evidenceLinkIds: [...fact.evidenceLinkIds].sort(),
  }
}

function sameVersionState(left: FactVersionState, right: FactVersionState): boolean {
  return left.canonicalText === right.canonicalText
    && left.subjectId === right.subjectId
    && left.predicate === right.predicate
    && JSON.stringify(left.object) === JSON.stringify(right.object)
    && left.objectType === right.objectType
    && JSON.stringify(left.normalizedValue) === JSON.stringify(right.normalizedValue)
    && left.polarity === right.polarity
    && left.modality === right.modality
    && left.condition === right.condition
    && left.status === right.status
    && left.validFrom === right.validFrom
    && left.validTo === right.validTo
    && left.evidenceLinkIds.join('\u0000') === right.evidenceLinkIds.join('\u0000')
}

function operationFor(fact: MemoryFactV4, previous: FactVersionState): MemoryWriteActionV4 {
  if (previous.status === 'deleted' && fact.status !== 'deleted')
    return 'RESTORE'
  if (fact.status === 'conflicted')
    return 'CONFLICT'
  if (fact.status === 'suppressed')
    return 'SUPPRESS'
  if (fact.status === 'deleted')
    return 'DELETE'
  if (fact.supersedesFactIds.length > 0 || fact.status === 'superseded')
    return 'SUPERSEDE'
  if (previous.canonicalText !== fact.canonicalText)
    return 'REFINE'
  if (previous.evidenceLinkIds.join('\u0000') !== [...fact.evidenceLinkIds].sort().join('\u0000'))
    return 'MERGE_EVIDENCE'
  return 'NOOP'
}

function parseV3Records(payload: string): V3MemoryRecord[] {
  let value: unknown
  try {
    value = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse V3 shadow source: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('V3 shadow source is not an object')
  const snapshot = value as { version?: unknown; items?: unknown }
  if (snapshot.version !== 3 || !Array.isArray(snapshot.items))
    throw new Error('V4 dual-write reconciliation requires a V3 snapshot')
  const ids = new Set<string>()
  return snapshot.items.map((raw, position) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`V3 shadow record ${position} is invalid`)
    const record = raw as Partial<V3MemoryRecord>
    if (typeof record.id !== 'string' || !record.id || typeof record.content !== 'string' || !record.content
      || !record.scope || typeof record.scope.ownerId !== 'string' || typeof record.scope.agentId !== 'string'
      || typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number'
      || typeof record.status !== 'string')
      throw new Error(`V3 shadow record ${position} is incomplete`)
    if (ids.has(record.id))
      throw new Error(`V3 shadow source contains duplicate id: ${record.id}`)
    ids.add(record.id)
    return jsonClone(record as V3MemoryRecord)
  })
}

function predicateFor(record: V3MemoryRecord): string {
  if (record.memoryKey?.trim())
    return record.memoryKey.trim()
  if (typeof record.metadata?.kind === 'string' && record.metadata.kind.trim())
    return record.metadata.kind.trim()
  return 'memory.fact'
}

function cardinalityFor(record: V3MemoryRecord): MemoryFactV4['cardinality'] {
  return record.metadata?.cardinality === 'single' ? 'single' : record.metadata?.cardinality === 'set' ? 'set' : 'multiple'
}

function polarityFor(content: string): MemoryFactV4['polarity'] {
  if (/(?:不喜欢|讨厌|不能|不要|\bdislike\b|\bhate\b)/iu.test(content))
    return 'negative'
  if (/(?:喜欢|偏爱|偏好|\bprefer\b|\blike\b)/iu.test(content))
    return 'positive'
  return 'unknown'
}

function normalizedFactValue(content: string): string {
  return content.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function normalizeFactStatus(value: string): MemoryFactStatusV4 {
  return value === 'superseded' || value === 'conflicted' || value === 'expired' || value === 'orphaned'
    || value === 'suppressed' || value === 'deleted'
    ? value
    : 'active'
}

function normalizeOrigin(value: unknown): MemoryFactV4['origin'] {
  return value === 'manual' || value === 'image' ? value : 'automatic'
}

function normalizeSharePolicy(value: unknown): MemoryFactV4['sharePolicy'] {
  return value === 'allow-remote' || value === 'ask' ? value : 'local-only'
}

function normalizeSensitivity(value: unknown): MemoryFactV4['sensitivity'] {
  return value === 'normal' || value === 'secret' ? value : 'private'
}

function utilityFor(record: V3MemoryRecord): number {
  const accessSignal = 1 - Math.exp(-nonNegativeInteger(record.accessCount) / 5)
  return score(0.65 * score(record.importance, 0.6) + 0.35 * accessSignal, 0.5)
}

function mergeFactMetadata(current: JsonObject | undefined, incoming: JsonObject): JsonObject {
  return { ...(current ?? {}), ...incoming }
}

function v4Scope(scope: MemoryScope): MemoryV4Scope {
  return normalizeMemoryV4Scope({
    ownerId: scope.ownerId,
    agentId: scope.agentId ?? 'default',
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
  })
}

function sameV4Scope(left: MemoryV4Scope, right: MemoryV4Scope): boolean {
  return left.ownerId === right.ownerId
    && left.agentId === right.agentId
    && (left.sessionId === undefined || left.sessionId === right.sessionId)
}

function sourceKey(scope: MemoryV4Scope, sourceId: string): string {
  return JSON.stringify([scope.ownerId, scope.agentId, sourceId])
}

function stableId(kind: string, source: string): string {
  return `v4-live-${kind.replace(/[^a-z0-9-]/giu, '-')}-${sha256(source).slice(0, 32)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assignOptionalTimestamp<K extends 'validFrom' | 'validTo' | 'invalidatedAt' | 'expiresAt' | 'lastAccessedAt'>(
  target: MemoryFactV4,
  key: K,
  value: unknown,
): void {
  const normalized = optionalTimestamp(value)
  if (normalized === undefined)
    delete target[key]
  else
    target[key] = normalized
}

function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveTimestamp(value: unknown, fallback: number): number {
  return optionalTimestamp(value) ?? fallback
}

function score(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => String(value).trim()))]
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : []
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : []
}

function firstString(value: unknown): string | undefined {
  return arrayStrings(value)[0]
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
}

function mostSensitive(values: unknown[]): MemoryFactV4['sensitivity'] {
  return values.reduce<MemoryFactV4['sensitivity']>(
    (current, value) => moreSensitive(current, normalizeSensitivity(value)),
    'normal',
  )
}

function moreSensitive(
  left: MemoryFactV4['sensitivity'],
  right: MemoryFactV4['sensitivity'],
): MemoryFactV4['sensitivity'] {
  const rank = { normal: 0, private: 1, secret: 2 }
  return rank[right] > rank[left] ? right : left
}

function mostRestrictiveShare(values: unknown[]): MemoryFactV4['sharePolicy'] {
  return values.reduce<MemoryFactV4['sharePolicy']>(
    (current, value) => moreRestrictiveShare(current, normalizeSharePolicy(value)),
    'allow-remote',
  )
}

function moreRestrictiveShare(
  left: MemoryFactV4['sharePolicy'],
  right: MemoryFactV4['sharePolicy'],
): MemoryFactV4['sharePolicy'] {
  const rank = { 'allow-remote': 0, ask: 1, 'local-only': 2 }
  return rank[right] > rank[left] ? right : left
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}
