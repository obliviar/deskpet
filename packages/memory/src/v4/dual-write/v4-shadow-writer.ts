import { createHash, randomUUID } from 'node:crypto'
import type {
  AdaptiveMemoryRecallResult,
  MemoryCapture,
  MemoryScope,
} from '@deskpet/contracts'
import type { MemoryCandidate } from '../../long-term/memory-extractor'
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
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
  MemoryWriteActionV4,
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
  flush: () => void
  reconcileV3Payload: (payload: string) => V4ShadowReconciliationResult
  pendingCount: () => number
}

type ShadowOperation =
  | { type: 'commit'; value: V3MemoryCommit }
  | { type: 'capture'; value: V4ShadowCapture }
  | { type: 'retrieval'; value: V4ShadowRetrieval }

interface ShadowIndexes {
  factByV3Id: Map<string, MemoryFactV4>
  episodeById: Map<string, MemoryEpisodeV4>
  evidenceByFactEpisode: Map<string, EvidenceLinkV4>
  candidateById: Map<string, MemoryV4Snapshot['candidates'][number]>
  maximumVersionByFact: Map<string, number>
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
      deleteMirroredFact(draft, indexes, sourceId, committedAt)
    for (const record of operation.value.upserts)
      upsertRecord(draft, indexes, record, operation.value.reason, committedAt, false)
    return
  }
  if (operation.type === 'capture') {
    recordCapture(draft, indexes, operation.value, fallbackNow)
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
    canonicalText: record.content,
    memoryKey: record.memoryKey ?? `v3.fact.${record.id}`,
    cardinality: cardinalityFor(record),
    polarity: polarityFor(record.content),
    status,
    recordedAt: positiveTimestamp(record.createdAt, committedAt),
    updatedAt: positiveTimestamp(record.updatedAt, committedAt),
    evidenceLinkIds: [],
    extractionScore: score(record.confidence, 0.7),
    verificationScore: record.origin === 'manual' ? 1 : 0,
    evidenceScore: directEvidence ? 1 : evidenceLinks.length > 0 ? 0.4 : 0,
    utilityScore: utilityFor(record),
    importance: score(record.importance, 0.6),
    accessCount: nonNegativeInteger(record.accessCount),
    userConfirmed: record.origin === 'manual',
    verificationState: record.origin === 'manual' ? 'verified' : 'pending',
    supersedesFactIds: [],
    conflictsWithFactIds: [],
    sensitivity: normalizeSensitivity(record.sensitivity),
    sharePolicy: normalizeSharePolicy(record.sharePolicy),
    origin: normalizeOrigin(record.origin),
    extractorVersion: 'v3-dual-write',
    verifierVersion: record.origin === 'manual' ? 'manual-confirmed' : 'stage2-pending',
  }

  fact.scope = scope
  fact.subjectId = `owner:${scope.ownerId}`
  fact.predicate = predicateFor(record)
  fact.object = record.content
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
  fact.verificationState = record.origin === 'manual' ? 'verified' : fact.verificationState === 'legacy-unverified'
    ? 'legacy-unverified'
    : 'pending'
  fact.verificationScore = record.origin === 'manual' ? 1 : fact.verificationScore
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
    episodes.push(ensureEpisode(draft, indexes, {
      id: stableId('episode-record', sourceKey(factScope, record.id)),
      scope: factScope,
      actor: manual ? 'user' : 'legacy-import',
      kind: manual ? 'manual-declaration' : 'legacy-memory-record',
      contentState: 'available',
      content: record.content,
      contentHash: sha256(record.content),
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
  if (capture.memories.length === 0 || !isSafeMemoryContent(capture.turn.userMessage))
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
    : stableId('episode-message', `${sourceKey(factScope, sha256(capture.turn.userMessage))}\u0000${recordedAt}`)
  const episodePrivacy = inferMemoryPrivacy(capture.turn.userMessage)
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
    content: capture.turn.userMessage,
    contentHash: sha256(capture.turn.userMessage),
    recordedAt,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    sourceAttachmentIds: attachmentIds,
    sensitivity,
    sharePolicy,
    provenance: 'native-v4',
  })

  for (const { candidate, record } of capture.memories) {
    const fact = indexes.factByV3Id.get(record.id)
    if (!fact)
      continue
    const candidateId = stableId('candidate', `${fact.id}\u0000${episode.id}\u0000${candidate.content}`)
    let memoryCandidate = indexes.candidateById.get(candidateId)
    const link = ensureDirectEvidence(draft, indexes, fact, episode, recordedAt)
    const previous = factVersionState(fact)
    if (!memoryCandidate) {
      memoryCandidate = {
        id: candidateId,
        scope: fact.scope,
        evidenceEpisodeIds: [episode.id],
        subjectId: fact.subjectId,
        predicate: predicateFor(record),
        object: candidate.content,
        canonicalText: candidate.content,
        polarity: polarityFor(candidate.content),
        cardinality: cardinalityFor(record),
        ...(optionalTimestamp(record.validFrom) ? { validFrom: optionalTimestamp(record.validFrom) } : {}),
        ...(optionalTimestamp(record.validTo) ? { validTo: optionalTimestamp(record.validTo) } : {}),
        extractionScore: score(record.confidence, 0.7),
        ...(record.origin === 'manual' ? { verificationScore: 1 } : {}),
        durabilityScore: score(record.importance, 0.6),
        ambiguityFlags: [],
        proposedAction: previous.status === 'quarantined' ? 'ADD' : 'MERGE_EVIDENCE',
        status: 'accepted',
        extractorVersion: 'v3-capture-dual-write',
        ...(record.origin === 'manual' ? { verifierVersion: 'manual-confirmed' } : {}),
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
    fact.verificationState = record.origin === 'manual' ? 'verified' : 'pending'
    fact.verificationScore = record.origin === 'manual' ? 1 : fact.verificationScore
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
  draft.factVersions.push({
    id: stableId('version', `${fact.id}\u0000${nextVersion}`),
    factId: fact.id,
    version: nextVersion,
    operation,
    canonicalText: fact.canonicalText,
    status: fact.status,
    ...(fact.validFrom ? { validFrom: fact.validFrom } : {}),
    ...(fact.validTo ? { validTo: fact.validTo } : {}),
    evidenceLinkIds: [...fact.evidenceLinkIds],
    recordedAt,
    reason,
  })
  indexes.maximumVersionByFact.set(fact.id, nextVersion)
}

function deleteMirroredFact(
  draft: MemoryV4Snapshot,
  indexes: ShadowIndexes,
  sourceId: string,
  deletedAt: number,
): boolean {
  const fact = indexes.factByV3Id.get(sourceId)
  if (!fact || fact.status === 'deleted')
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
  appendFactVersion(
    draft,
    indexes,
    fact,
    'DELETE',
    deletedAt,
    'The source V3 fact was explicitly forgotten or removed during reconciliation.',
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
  for (const version of draft.factVersions) {
    maximumVersionByFact.set(
      version.factId,
      Math.max(maximumVersionByFact.get(version.factId) ?? 0, version.version),
    )
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
  }
}

function factEpisodeKey(factId: string, episodeId: string): string {
  return `${factId}\u0000${episodeId}`
}

interface FactVersionState {
  canonicalText: string
  status: MemoryFactStatusV4
  validFrom?: number
  validTo?: number
  evidenceLinkIds: string[]
}

function factVersionState(fact: MemoryFactV4): FactVersionState {
  return {
    canonicalText: fact.canonicalText,
    status: fact.status,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    evidenceLinkIds: [...fact.evidenceLinkIds].sort(),
  }
}

function sameVersionState(left: FactVersionState, right: FactVersionState): boolean {
  return left.canonicalText === right.canonicalText
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

function normalizeFactStatus(value: string): MemoryFactStatusV4 {
  return value === 'superseded' || value === 'conflicted' || value === 'expired' || value === 'orphaned'
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
