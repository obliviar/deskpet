import { createHash, randomUUID } from 'node:crypto'
import type {
  JsonValue,
  MemoryDomainEventTypeV4,
  MemoryFactStatusV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
  MemoryWriteActionV4,
} from '../domain/types'
import { normalizeMemoryV4Scope } from '../domain/validation'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export type MemoryV4DeleteMode = 'suppress' | 'delete' | 'purge'

export interface MemoryV4ContentEdit {
  canonicalText: string
  object?: JsonValue
  objectType?: MemoryFactV4['objectType']
  normalizedValue?: JsonValue
  subjectId?: string
  predicate?: string
  polarity?: MemoryFactV4['polarity']
  modality?: MemoryFactV4['modality']
  condition?: string | null
  validFrom?: number | null
  validTo?: number | null
  reason: string
  idempotencyKey: string
}

export interface MemoryV4LifecycleResult {
  changed: boolean
  factId: string
  version: number
  invalidatedEvidence: number
  invalidatedDerivedArtifacts: number
  purgedEpisodes: number
}

export interface MemoryV4LifecycleService {
  editFact: (factId: string, scope: MemoryV4Scope, edit: MemoryV4ContentEdit) => MemoryV4LifecycleResult
  deleteFact: (
    factId: string,
    scope: MemoryV4Scope,
    mode: MemoryV4DeleteMode,
    options: { reason: string; idempotencyKey: string },
  ) => MemoryV4LifecycleResult
  restoreFact: (
    factId: string,
    scope: MemoryV4Scope,
    options: { reason: string; idempotencyKey: string },
  ) => MemoryV4LifecycleResult
  archiveFact: (
    factId: string,
    scope: MemoryV4Scope,
    options: { reason: string; idempotencyKey: string },
  ) => MemoryV4LifecycleResult
  unlinkEpisodes: (
    episodeIds: string[],
    scope: MemoryV4Scope,
    options: { reason: string; idempotencyKey: string },
  ) => { changed: boolean; unlinkedEvidence: number; orphanedFacts: number; staleArtifacts: number }
}

export function createMemoryV4LifecycleService(
  repository: MemoryV4Repository,
  options: { now?: () => number } = {},
): MemoryV4LifecycleService {
  const now = options.now ?? Date.now

  return {
    editFact(factId, rawScope, edit) {
      const scope = normalizeMemoryV4Scope(rawScope)
      const canonicalText = edit.canonicalText.normalize('NFKC').replace(/\s+/gu, ' ').trim()
      if (!canonicalText)
        throw new Error('Memory V4 fact content cannot be empty')
      if (!edit.reason.trim() || !edit.idempotencyKey.trim())
        throw new Error('Memory V4 edit requires a reason and idempotency key')
      const existing = resultForDuplicate(repository.snapshot(), edit.idempotencyKey, factId)
      if (existing)
        return existing
      return repository.transaction((draft) => {
        const fact = requireFact(draft, factId, scope)
        const timestamp = monotonicNow(now(), fact.updatedAt)
        fact.subjectId = edit.subjectId?.trim() || fact.subjectId
        fact.predicate = edit.predicate?.trim() || fact.predicate
        fact.object = edit.object ?? canonicalText
        fact.objectType = edit.objectType ?? inferObjectType(fact.object)
        fact.normalizedValue = edit.normalizedValue ?? normalizedJsonValue(fact.object)
        fact.canonicalText = canonicalText
        fact.polarity = edit.polarity ?? fact.polarity
        fact.modality = edit.modality ?? fact.modality
        if (edit.condition === null)
          delete fact.condition
        else if (edit.condition !== undefined)
          fact.condition = edit.condition.trim()
        assignOptionalTimestamp(fact, 'validFrom', edit.validFrom)
        assignOptionalTimestamp(fact, 'validTo', edit.validTo)
        fact.updatedAt = timestamp
        const version = appendVersion(draft, fact, 'REFINE', timestamp, edit.reason)
        const stale = invalidateDerived(draft, fact.id, timestamp, edit.idempotencyKey)
        appendEvent(draft, {
          idempotencyKey: edit.idempotencyKey,
          type: 'FACT_VERSIONED', scope, factId, createdAt: timestamp, actor: 'user',
          payload: { operation: 'REFINE', version },
        })
        return result(fact.id, version, 0, stale, 0)
      })
    },

    deleteFact(factId, rawScope, mode, operation) {
      const scope = normalizeMemoryV4Scope(rawScope)
      if (!operation.reason.trim() || !operation.idempotencyKey.trim())
        throw new Error('Memory V4 deletion requires a reason and idempotency key')
      const existing = resultForDuplicate(repository.snapshot(), operation.idempotencyKey, factId)
      if (existing)
        return existing
      return repository.transaction((draft) => {
        const fact = requireFact(draft, factId, scope)
        const timestamp = monotonicNow(now(), fact.updatedAt)
        let invalidatedEvidence = 0
        let purgedEpisodes = 0
        if (mode !== 'suppress') {
          for (const link of draft.evidenceLinks) {
            if (link.factId !== fact.id || !link.active)
              continue
            link.active = false
            link.invalidatedAt = Math.max(link.createdAt, timestamp)
            invalidatedEvidence += 1
          }
          fact.status = 'deleted'
          fact.invalidatedAt = timestamp
        }
        else {
          fact.status = 'suppressed'
          fact.invalidatedAt = timestamp
        }
        if (mode === 'purge') {
          const episodeIds = new Set(draft.evidenceLinks.filter(link => link.factId === fact.id).map(link => link.episodeId))
          for (const episode of draft.episodes) {
            if (!episodeIds.has(episode.id) || !episodeIsExclusive(draft, episode.id, fact.id))
              continue
            episode.contentState = 'deleted'
            delete episode.content
            delete episode.contentHash
            delete episode.sourceMessageId
            episode.sourceAttachmentIds = []
            episode.deletedAt = Math.max(episode.recordedAt, timestamp)
            purgedEpisodes += 1
          }
          fact.object = '[purged]'
          fact.objectType = 'string'
          fact.normalizedValue = '[purged]'
          fact.canonicalText = '[purged]'
          const v3SourceId = typeof fact.metadata?.v3SourceId === 'string'
            ? fact.metadata.v3SourceId
            : draft.legacyImports.find(legacy => legacy.factId === fact.id)?.sourceItemId
          fact.metadata = {
            ...(v3SourceId ? { v3SourceId } : {}),
            purgeCompletedAt: timestamp,
          }
          for (const version of draft.factVersions) {
            if (version.factId !== fact.id)
              continue
            version.object = '[purged]'
            version.objectType = 'string'
            version.normalizedValue = '[purged]'
            version.canonicalText = '[purged]'
            delete version.condition
            version.reason = 'Historical content removed by an irreversible purge.'
          }
          for (const candidate of draft.candidates) {
            if (!candidate.evidenceEpisodeIds.some(id => episodeIds.has(id)))
              continue
            candidate.object = '[purged]'
            candidate.objectType = 'string'
            candidate.normalizedValue = '[purged]'
            candidate.canonicalText = '[purged]'
            candidate.status = 'rejected'
            candidate.ambiguityFlags = ['source-purged']
            delete candidate.condition
          }
          for (const legacy of draft.legacyImports) {
            if (legacy.factId === fact.id)
              legacy.raw = { id: legacy.sourceItemId, purgedAt: timestamp }
          }
        }
        fact.updatedAt = timestamp
        const writeAction: MemoryWriteActionV4 = mode === 'suppress' ? 'SUPPRESS' : mode === 'purge' ? 'PURGE' : 'DELETE'
        const version = appendVersion(draft, fact, writeAction, timestamp, operation.reason)
        const stale = invalidateDerived(draft, fact.id, timestamp, operation.idempotencyKey, mode === 'purge')
        const eventType: MemoryDomainEventTypeV4 = mode === 'suppress' ? 'FACT_SUPPRESSED'
          : mode === 'purge' ? 'FACT_PURGED' : 'FACT_DELETED'
        appendEvent(draft, {
          idempotencyKey: operation.idempotencyKey,
          type: eventType, scope, factId, createdAt: timestamp, actor: 'user',
          payload: { operation: writeAction, version, invalidatedEvidence, stale, purgedEpisodes },
        })
        return result(fact.id, version, invalidatedEvidence, stale, purgedEpisodes)
      })
    },

    restoreFact(factId, rawScope, operation) {
      const scope = normalizeMemoryV4Scope(rawScope)
      const existing = resultForDuplicate(repository.snapshot(), operation.idempotencyKey, factId)
      if (existing)
        return existing
      return repository.transaction((draft) => {
        const fact = requireFact(draft, factId, scope)
        if (fact.canonicalText === '[purged]')
          throw new Error('Purged Memory V4 content cannot be restored')
        const timestamp = monotonicNow(now(), fact.updatedAt)
        let reactivatedEvidence = 0
        for (const link of draft.evidenceLinks) {
          if (link.factId !== fact.id)
            continue
          const episode = draft.episodes.find(item => item.id === link.episodeId)
          if (!episode || episode.contentState === 'deleted')
            continue
          link.active = true
          delete link.invalidatedAt
          reactivatedEvidence += 1
        }
        if (reactivatedEvidence === 0)
          throw new Error('Memory V4 fact cannot be restored without evidence')
        fact.status = 'active'
        delete fact.invalidatedAt
        fact.updatedAt = timestamp
        const version = appendVersion(draft, fact, 'RESTORE', timestamp, operation.reason)
        const stale = invalidateDerived(draft, fact.id, timestamp, operation.idempotencyKey)
          + invalidateTierIndexes(draft, fact.scope, timestamp, operation.idempotencyKey)
        appendEvent(draft, {
          idempotencyKey: operation.idempotencyKey,
          type: 'FACT_RESTORED', scope, factId, createdAt: timestamp, actor: 'user',
          payload: { operation: 'RESTORE', version, reactivatedEvidence, stale },
        })
        return result(fact.id, version, 0, stale, 0)
      })
    },

    archiveFact(factId, rawScope, operation) {
      const scope = normalizeMemoryV4Scope(rawScope)
      if (!operation.reason.trim() || !operation.idempotencyKey.trim())
        throw new Error('Memory V4 archival requires a reason and idempotency key')
      const existing = resultForDuplicate(repository.snapshot(), operation.idempotencyKey, factId)
      if (existing)
        return existing
      return repository.transaction((draft) => {
        const fact = requireFact(draft, factId, scope)
        if (fact.status !== 'active')
          throw new Error(`Memory V4 fact ${factId} cannot be archived from status ${fact.status}`)
        if (fact.userConfirmed)
          throw new Error(`Memory V4 fact ${factId} is user-confirmed and cannot be auto-archived`)
        const timestamp = monotonicNow(now(), fact.updatedAt)
        // Archival keeps every evidence link active: the fact leaves the
        // retrieval surface without losing its auditable provenance, and
        // restoreFact re-enters it without evidence reactivation work.
        fact.status = 'archived'
        fact.invalidatedAt = timestamp
        fact.updatedAt = timestamp
        const version = appendVersion(draft, fact, 'ARCHIVE', timestamp, operation.reason)
        const stale = invalidateDerived(draft, fact.id, timestamp, operation.idempotencyKey)
        appendEvent(draft, {
          idempotencyKey: operation.idempotencyKey,
          type: 'FACT_ARCHIVED', scope, factId, createdAt: timestamp, actor: 'system',
          payload: { operation: 'ARCHIVE', version, stale },
        })
        return result(fact.id, version, 0, stale, 0)
      })
    },

    unlinkEpisodes(episodeIds, rawScope, operation) {
      const scope = normalizeMemoryV4Scope(rawScope)
      if (repository.snapshot().domainEvents.some(event => event.idempotencyKey === operation.idempotencyKey))
        return { changed: false, unlinkedEvidence: 0, orphanedFacts: 0, staleArtifacts: 0 }
      const requested = new Set(episodeIds.filter(Boolean))
      if (requested.size === 0)
        return { changed: false, unlinkedEvidence: 0, orphanedFacts: 0, staleArtifacts: 0 }
      return repository.transaction((draft) => {
        const timestamp = now()
        const ownedEpisodeIds = new Set(draft.episodes
          .filter(episode => requested.has(episode.id) && sameScope(scope, episode.scope))
          .map(episode => episode.id))
        let unlinkedEvidence = 0
        const affectedFacts = new Set<string>()
        for (const link of draft.evidenceLinks) {
          if (!ownedEpisodeIds.has(link.episodeId) || !link.active)
            continue
          link.active = false
          link.invalidatedAt = Math.max(link.createdAt, timestamp)
          unlinkedEvidence += 1
          affectedFacts.add(link.factId)
        }
        let orphanedFacts = 0
        let staleArtifacts = 0
        for (const factId of affectedFacts) {
          const fact = draft.facts.find(item => item.id === factId)!
          const hasActiveEvidence = draft.evidenceLinks.some(link => link.factId === factId && link.active)
          if (!hasActiveEvidence && fact.origin !== 'manual' && fact.status === 'active') {
            fact.status = 'orphaned'
            fact.updatedAt = monotonicNow(timestamp, fact.updatedAt)
            const version = appendVersion(draft, fact, 'NOOP', fact.updatedAt, operation.reason)
            orphanedFacts += 1
            appendEvent(draft, {
              idempotencyKey: `${operation.idempotencyKey}:orphan:${fact.id}`,
              type: 'EVIDENCE_UNLINKED', scope: fact.scope, factId: fact.id,
              createdAt: fact.updatedAt, actor: 'user', payload: { version },
            })
          }
          staleArtifacts += invalidateDerived(draft, fact.id, timestamp, `${operation.idempotencyKey}:${fact.id}`)
        }
        appendEvent(draft, {
          idempotencyKey: operation.idempotencyKey,
          type: 'EVIDENCE_UNLINKED', scope, createdAt: timestamp, actor: 'user',
          payload: { unlinkedEvidence, orphanedFacts, staleArtifacts },
        })
        return { changed: unlinkedEvidence > 0, unlinkedEvidence, orphanedFacts, staleArtifacts }
      })
    },
  }
}

function appendVersion(
  draft: MemoryV4Snapshot,
  fact: MemoryFactV4,
  operation: MemoryWriteActionV4,
  timestamp: number,
  reason: string,
): number {
  const versions = draft.factVersions.filter(item => item.factId === fact.id)
  const prior = versions.reduce((latest, item) => !latest || item.version > latest.version ? item : latest, versions[0])
  if (prior && prior.transactionClosedAt === undefined)
    prior.transactionClosedAt = Math.max(prior.recordedAt, timestamp)
  const version = (prior?.version ?? 0) + 1
  draft.factVersions.push({
    id: stableId('version', `${fact.id}\u0000${version}`), factId: fact.id, version, operation,
    subjectId: fact.subjectId, predicate: fact.predicate, object: fact.object,
    objectType: fact.objectType, normalizedValue: fact.normalizedValue,
    canonicalText: fact.canonicalText, polarity: fact.polarity, modality: fact.modality,
    ...(fact.condition ? { condition: fact.condition } : {}), status: fact.status,
    ...(fact.validFrom ? { validFrom: fact.validFrom } : {}), ...(fact.validTo ? { validTo: fact.validTo } : {}),
    evidenceLinkIds: [...fact.evidenceLinkIds], recordedAt: timestamp, reason,
  })
  return version
}

function appendEvent(draft: MemoryV4Snapshot, event: Omit<MemoryV4Snapshot['domainEvents'][number], 'id'>): void {
  if (draft.domainEvents.some(item => item.idempotencyKey === event.idempotencyKey))
    return
  draft.domainEvents.push({ id: stableId('event', event.idempotencyKey), ...event })
}

function invalidateDerived(
  draft: MemoryV4Snapshot,
  factId: string,
  timestamp: number,
  idempotencyKey: string,
  purge = false,
): number {
  let changed = 0
  for (const artifact of draft.derivedArtifacts) {
    if (!artifact.sourceFactIds.includes(factId) || artifact.status === 'deleted')
      continue
    artifact.status = purge ? 'deleted' : 'stale'
    artifact.updatedAt = Math.max(artifact.updatedAt, timestamp)
    artifact.invalidatedAt = artifact.updatedAt
    if (purge) {
      delete artifact.content
      delete artifact.contentHash
    }
    changed += 1
    appendEvent(draft, {
      idempotencyKey: `${idempotencyKey}:artifact:${artifact.id}`,
      type: 'DERIVED_ARTIFACT_STALE', scope: artifact.scope, factId,
      createdAt: timestamp, actor: 'system', payload: { artifactId: artifact.id, purge },
    })
  }
  return changed
}

function invalidateTierIndexes(
  draft: MemoryV4Snapshot,
  scope: MemoryV4Scope,
  timestamp: number,
  idempotencyKey: string,
): number {
  let changed = 0
  for (const artifact of draft.derivedArtifacts) {
    if (artifact.kind !== 'tier-index' || artifact.status !== 'current'
      || artifact.scope.ownerId !== scope.ownerId || artifact.scope.agentId !== scope.agentId)
      continue
    artifact.status = 'stale'
    artifact.updatedAt = Math.max(artifact.updatedAt, timestamp)
    artifact.invalidatedAt = artifact.updatedAt
    changed += 1
    appendEvent(draft, {
      idempotencyKey: `${idempotencyKey}:tier-index:${artifact.id}`,
      type: 'DERIVED_ARTIFACT_STALE', scope: artifact.scope,
      createdAt: timestamp, actor: 'system', payload: { artifactId: artifact.id, restore: true },
    })
  }
  return changed
}

function requireFact(draft: MemoryV4Snapshot, factId: string, scope: MemoryV4Scope): MemoryFactV4 {
  const fact = draft.facts.find(item => item.id === factId && sameScope(scope, item.scope))
  if (!fact)
    throw new Error('Memory V4 fact was not found in the requested scope')
  return fact
}

function resultForDuplicate(snapshot: MemoryV4Snapshot, key: string, factId: string): MemoryV4LifecycleResult | undefined {
  if (!snapshot.domainEvents.some(event => event.idempotencyKey === key))
    return undefined
  const version = snapshot.factVersions.filter(item => item.factId === factId)
    .reduce((maximum, item) => Math.max(maximum, item.version), 0)
  return { changed: false, factId, version, invalidatedEvidence: 0, invalidatedDerivedArtifacts: 0, purgedEpisodes: 0 }
}

function result(factId: string, version: number, evidence: number, artifacts: number, episodes: number): MemoryV4LifecycleResult {
  return { changed: true, factId, version, invalidatedEvidence: evidence, invalidatedDerivedArtifacts: artifacts, purgedEpisodes: episodes }
}

function episodeIsExclusive(snapshot: MemoryV4Snapshot, episodeId: string, factId: string): boolean {
  return !snapshot.evidenceLinks.some(link => link.episodeId === episodeId && link.factId !== factId && link.active)
}

function normalizedJsonValue(value: JsonValue): JsonValue {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : JSON.parse(JSON.stringify(value)) as JsonValue
}

function inferObjectType(value: JsonValue): MemoryFactV4['objectType'] {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'json'
}

function assignOptionalTimestamp<T extends object>(target: T, key: keyof T, value: number | null | undefined): void {
  if (value === null)
    delete target[key]
  else if (value !== undefined) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Memory V4 ${String(key)} must be a positive timestamp`)
    target[key] = value as T[keyof T]
  }
}

function monotonicNow(value: number, floor: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('Memory V4 lifecycle requires a positive timestamp')
  return Math.max(value, floor)
}

function sameScope(requested: MemoryV4Scope, actual: MemoryV4Scope): boolean {
  return requested.ownerId === actual.ownerId && requested.agentId === actual.agentId
    && (requested.sessionId === undefined || requested.sessionId === actual.sessionId)
}

function stableId(namespace: string, source: string): string {
  return `v4-${namespace}-${createHash('sha256').update(source).digest('hex').slice(0, 32)}`
}
