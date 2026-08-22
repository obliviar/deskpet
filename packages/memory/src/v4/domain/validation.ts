import type {
  EvidenceLinkV4,
  JsonObject,
  MemoryEpisodeV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from './types'
import { MEMORY_V4_SCHEMA_VERSION } from './types'

const ACTORS = ['user', 'assistant', 'tool', 'image-observation', 'legacy-import'] as const
const EPISODE_KINDS = ['message', 'manual-declaration', 'image-observation', 'message-reference', 'attachment-reference', 'legacy-memory-record'] as const
const CONTENT_STATES = ['available', 'unavailable', 'deleted'] as const
const SHARE_POLICIES = ['allow-remote', 'local-only', 'ask'] as const
const SENSITIVITIES = ['normal', 'private', 'secret'] as const
const CARDINALITIES = ['single', 'multiple', 'set'] as const
const POLARITIES = ['positive', 'negative', 'unknown'] as const
const MODALITIES = ['asserted', 'planned', 'hypothetical', 'reported', 'inferred', 'unknown'] as const
const OBJECT_TYPES = ['string', 'number', 'boolean', 'date', 'entity', 'json'] as const
const WRITE_ACTIONS = ['ADD', 'MERGE_EVIDENCE', 'REFINE', 'SUPERSEDE', 'CONFLICT', 'NOOP', 'QUARANTINE', 'SUPPRESS', 'DELETE', 'PURGE', 'RESTORE', 'ARCHIVE'] as const
const CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected', 'quarantined'] as const
const FACT_STATUSES = ['active', 'superseded', 'conflicted', 'quarantined', 'expired', 'orphaned', 'archived', 'suppressed', 'deleted'] as const
const VERIFICATION_STATES = ['verified', 'pending', 'legacy-unverified', 'rejected'] as const
const FACT_ORIGINS = ['automatic', 'manual', 'image'] as const
const EVIDENCE_ROLES = ['supports', 'references', 'legacy-derived'] as const
const EVIDENCE_STRENGTHS = ['direct', 'reference-only', 'legacy-derived'] as const
const EPISODE_PROVENANCE = ['native-v4', 'v3-reference', 'v3-derived-record'] as const
const DERIVED_KINDS = ['summary', 'graph-edge', 'embedding', 'retrieval-cache', 'tier-index'] as const
const DERIVED_STATUSES = ['current', 'stale', 'deleted'] as const
const DOMAIN_EVENT_TYPES = ['EPISODE_RECORDED', 'FACT_CREATED', 'FACT_VERSIONED', 'EVIDENCE_LINKED', 'EVIDENCE_UNLINKED', 'FACT_SUPPRESSED', 'FACT_DELETED', 'FACT_PURGED', 'FACT_RESTORED', 'FACT_ARCHIVED', 'DERIVED_ARTIFACT_STALE', 'V3_RECONCILED', 'CANDIDATE_REVIEWED', 'CANDIDATE_REPROCESSED'] as const
const DOMAIN_EVENT_ACTORS = ['system', 'user', 'migration'] as const

export function assertMemoryV4Snapshot(value: unknown): asserts value is MemoryV4Snapshot {
  if (!isRecord(value))
    throw new Error('Memory V4 snapshot is not an object')
  if (value.schemaVersion !== MEMORY_V4_SCHEMA_VERSION)
    throw new Error(`Unsupported Memory V4 schema version: ${String(value.schemaVersion)}`)
  requireNonNegativeInteger(value.revision, 'revision')
  const createdAt = requireTimestamp(value.createdAt, 'createdAt')
  const updatedAt = requireTimestamp(value.updatedAt, 'updatedAt')
  if (updatedAt < createdAt)
    throw new Error('Memory V4 snapshot updatedAt precedes createdAt')

  const episodes = requireArray(value.episodes, 'episodes')
  const candidates = requireArray(value.candidates, 'candidates')
  const facts = requireArray(value.facts, 'facts')
  const evidenceLinks = requireArray(value.evidenceLinks, 'evidenceLinks')
  const factVersions = requireArray(value.factVersions, 'factVersions')
  const derivedArtifacts = requireArray(value.derivedArtifacts, 'derivedArtifacts')
  const domainEvents = requireArray(value.domainEvents, 'domainEvents')
  const retrievalEvents = requireArray(value.retrievalEvents, 'retrievalEvents')
  const manifests = requireArray(value.migrationManifests, 'migrationManifests')
  const legacyImports = requireArray(value.legacyImports, 'legacyImports')
  if (value.dualWriteState !== undefined) {
    const dualWrite = requireRecord(value.dualWriteState, 'dualWriteState')
    const sourceHash = requireString(dualWrite.sourcePayloadSha256, 'dualWriteState.sourcePayloadSha256')
    if (!/^[a-f0-9]{64}$/u.test(sourceHash))
      throw new Error('Memory V4 dual-write state has an invalid source hash')
    requireNonNegativeInteger(dualWrite.sourceItemCount, 'dualWriteState.sourceItemCount')
    requireTimestamp(dualWrite.reconciledAt, 'dualWriteState.reconciledAt')
    requireString(dualWrite.writerVersion, 'dualWriteState.writerVersion')
  }

  const episodeIds = uniqueIds(episodes, 'episode')
  uniqueIds(candidates, 'candidate')
  const factIds = uniqueIds(facts, 'fact')
  const evidenceIds = uniqueIds(evidenceLinks, 'evidence link')
  const factVersionIds = uniqueIds(factVersions, 'fact version')
  uniqueIds(retrievalEvents, 'retrieval event')
  uniqueIds(derivedArtifacts, 'derived artifact')
  uniqueIds(domainEvents, 'domain event')
  uniqueIds(manifests, 'migration manifest')

  const episodeScopes = new Map<string, MemoryV4Scope>()
  for (const [position, raw] of episodes.entries()) {
    validateEpisode(raw, position, episodeIds)
    const episode = raw as MemoryEpisodeV4
    episodeScopes.set(episode.id, episode.scope)
  }

  const factScopes = new Map<string, MemoryV4Scope>()
  for (const [position, raw] of facts.entries()) {
    const fact = requireRecord(raw, `fact ${position}`)
    factScopes.set(requireString(fact.id, `fact ${position}.id`), requireScope(fact.scope, `fact ${position}.scope`))
  }

  for (const [position, raw] of candidates.entries())
    validateCandidate(raw, position, episodeIds, episodeScopes)

  const evidenceOwners = new Map<string, string>()
  const evidenceActive = new Map<string, boolean>()
  for (const [position, raw] of evidenceLinks.entries()) {
    validateEvidenceLink(raw, position, factIds, episodeIds, factScopes, episodeScopes)
    const link = raw as EvidenceLinkV4
    evidenceOwners.set(link.id, link.factId)
    evidenceActive.set(link.id, link.active)
  }

  for (const [position, raw] of facts.entries())
    validateFact(raw, position, evidenceIds, evidenceOwners, evidenceActive, factIds, factScopes)
  validateSupersessionGraph(facts)

  const versionOwners = new Map<string, string>()
  const versionsByFact = new Map<string, Array<{ version: number; record: Record<string, unknown> }>>()
  for (const [position, raw] of factVersions.entries()) {
    const version = requireRecord(raw, `fact version ${position}`)
    const versionId = requireString(version.id, `fact version ${position}.id`)
    const factId = requireString(version.factId, `fact version ${position}.factId`)
    if (!factIds.has(factId))
      throw new Error(`Memory V4 fact version ${versionId} references a missing fact`)
    versionOwners.set(versionId, factId)
    requireNonNegativeInteger(version.version, `fact version ${position}.version`, 1)
    const factVersionsForOwner = versionsByFact.get(factId) ?? []
    if (factVersionsForOwner.some(item => item.version === version.version))
      throw new Error(`Memory V4 fact ${factId} has duplicate version number ${String(version.version)}`)
    factVersionsForOwner.push({ version: version.version as number, record: version })
    versionsByFact.set(factId, factVersionsForOwner)
    requireEnum(version.operation, [...WRITE_ACTIONS, 'MIGRATE_V3'] as const, `fact version ${position}.operation`)
    requireString(version.subjectId, `fact version ${position}.subjectId`)
    requireString(version.predicate, `fact version ${position}.predicate`)
    requireJsonValue(version.object, `fact version ${position}.object`)
    requireEnum(version.objectType, OBJECT_TYPES, `fact version ${position}.objectType`)
    requireJsonValue(version.normalizedValue, `fact version ${position}.normalizedValue`)
    requireString(version.canonicalText, `fact version ${position}.canonicalText`)
    requireEnum(version.polarity, POLARITIES, `fact version ${position}.polarity`)
    requireEnum(version.modality, MODALITIES, `fact version ${position}.modality`)
    if (version.condition !== undefined)
      requireString(version.condition, `fact version ${position}.condition`)
    requireEnum(version.status, FACT_STATUSES, `fact version ${position}.status`)
    requireOptionalChronology(version.validFrom, version.validTo, `fact version ${position}`)
    for (const evidenceId of requireUniqueStringArray(version.evidenceLinkIds, `fact version ${position}.evidenceLinkIds`)) {
      if (!evidenceIds.has(evidenceId))
        throw new Error(`Memory V4 fact version ${versionId} references missing evidence ${evidenceId}`)
      if (evidenceOwners.get(evidenceId) !== factId)
        throw new Error(`Memory V4 fact version ${versionId} references evidence owned by another fact`)
    }
    requireTimestamp(version.recordedAt, `fact version ${position}.recordedAt`)
    if (version.transactionClosedAt !== undefined) {
      const closedAt = requireTimestamp(version.transactionClosedAt, `fact version ${position}.transactionClosedAt`)
      if (closedAt < (version.recordedAt as number))
        throw new Error(`Memory V4 fact version ${versionId} closed before it was recorded`)
    }
    requireString(version.reason, `fact version ${position}.reason`)
  }
  for (const raw of facts) {
    const fact = raw as MemoryFactV4
    const versions = versionsByFact.get(fact.id)
    if (!versions || versions.length === 0)
      throw new Error(`Memory V4 fact ${fact.id} has no auditable version history`)
    const latest = versions.reduce((left, right) => right.version > left.version ? right : left).record
    if (latest.canonicalText !== fact.canonicalText || latest.status !== fact.status
      || latest.predicate !== fact.predicate || JSON.stringify(latest.object) !== JSON.stringify(fact.object))
      throw new Error(`Memory V4 fact ${fact.id} does not match its latest version`)
    for (const item of versions) {
      const isLatest = item.record === latest
      if (isLatest && item.record.transactionClosedAt !== undefined)
        throw new Error(`Memory V4 latest fact version for ${fact.id} is transaction-closed`)
      if (!isLatest && item.record.transactionClosedAt === undefined)
        throw new Error(`Memory V4 historical fact version for ${fact.id} has no transaction close time`)
    }
  }

  for (const [position, raw] of retrievalEvents.entries()) {
    const event = requireRecord(raw, `retrieval event ${position}`)
    const eventId = requireString(event.id, `retrieval event ${position}.id`)
    const eventScope = requireScope(event.scope, `retrieval event ${position}.scope`)
    requireString(event.queryHash, `retrieval event ${position}.queryHash`)
    requireString(event.queryType, `retrieval event ${position}.queryType`)
    for (const field of ['retrievedFactIds', 'injectedFactIds', 'adoptedFactIds', 'correctedFactIds', 'deniedFactIds']) {
      for (const factId of requireUniqueStringArray(event[field], `retrieval event ${position}.${field}`)) {
        if (!factIds.has(factId))
          throw new Error(`Memory V4 retrieval event ${eventId} references missing fact ${factId}`)
        if (!scopeCanContain(eventScope, factScopes.get(factId)!))
          throw new Error(`Memory V4 retrieval event ${eventId} references a fact outside its scope`)
      }
    }
    requireTimestamp(event.createdAt, `retrieval event ${position}.createdAt`)
    requireString(event.retrievalVersion, `retrieval event ${position}.retrievalVersion`)
    if (event.answerModel !== undefined)
      requireString(event.answerModel, `retrieval event ${position}.answerModel`)
  }

  for (const [position, raw] of derivedArtifacts.entries()) {
    const artifact = requireRecord(raw, `derived artifact ${position}`)
    const artifactId = requireString(artifact.id, `derived artifact ${position}.id`)
    const artifactScope = requireScope(artifact.scope, `derived artifact ${position}.scope`)
    requireEnum(artifact.kind, DERIVED_KINDS, `derived artifact ${position}.kind`)
    const artifactStatus = requireEnum(artifact.status, DERIVED_STATUSES, `derived artifact ${position}.status`)
    for (const episodeId of requireUniqueStringArray(artifact.sourceEpisodeIds, `derived artifact ${position}.sourceEpisodeIds`)) {
      if (!episodeIds.has(episodeId) || !scopeCanContain(artifactScope, episodeScopes.get(episodeId)!))
        throw new Error(`Memory V4 derived artifact ${artifactId} references a missing or out-of-scope episode`)
    }
    for (const factId of requireUniqueStringArray(artifact.sourceFactIds, `derived artifact ${position}.sourceFactIds`)) {
      if (!factIds.has(factId) || !scopeCanContain(artifactScope, factScopes.get(factId)!))
        throw new Error(`Memory V4 derived artifact ${artifactId} references a missing or out-of-scope fact`)
    }
    if (artifact.content !== undefined)
      requireString(artifact.content, `derived artifact ${position}.content`)
    if (artifact.contentHash !== undefined)
      requireString(artifact.contentHash, `derived artifact ${position}.contentHash`)
    const artifactCreatedAt = requireTimestamp(artifact.createdAt, `derived artifact ${position}.createdAt`)
    const artifactUpdatedAt = requireTimestamp(artifact.updatedAt, `derived artifact ${position}.updatedAt`)
    if (artifactUpdatedAt < artifactCreatedAt)
      throw new Error(`Memory V4 derived artifact ${artifactId} updated before creation`)
    if (artifact.invalidatedAt !== undefined)
      requireTimestamp(artifact.invalidatedAt, `derived artifact ${position}.invalidatedAt`)
    if (artifactStatus === 'current' && artifact.invalidatedAt !== undefined)
      throw new Error(`Memory V4 current derived artifact ${artifactId} is invalidated`)
    requireString(artifact.builderVersion, `derived artifact ${position}.builderVersion`)
  }

  const idempotencyKeys = new Set<string>()
  for (const [position, raw] of domainEvents.entries()) {
    const event = requireRecord(raw, `domain event ${position}`)
    const eventId = requireString(event.id, `domain event ${position}.id`)
    const key = requireString(event.idempotencyKey, `domain event ${position}.idempotencyKey`)
    if (idempotencyKeys.has(key))
      throw new Error(`Memory V4 domain events contain duplicate idempotency key ${key}`)
    idempotencyKeys.add(key)
    requireEnum(event.type, DOMAIN_EVENT_TYPES, `domain event ${position}.type`)
    const eventScope = requireScope(event.scope, `domain event ${position}.scope`)
    if (event.factId !== undefined) {
      const factId = requireString(event.factId, `domain event ${position}.factId`)
      if (!factIds.has(factId) || !scopeCanContain(eventScope, factScopes.get(factId)!))
        throw new Error(`Memory V4 domain event ${eventId} references a missing or out-of-scope fact`)
    }
    if (event.episodeId !== undefined) {
      const episodeId = requireString(event.episodeId, `domain event ${position}.episodeId`)
      if (!episodeIds.has(episodeId) || !scopeCanContain(eventScope, episodeScopes.get(episodeId)!))
        throw new Error(`Memory V4 domain event ${eventId} references a missing or out-of-scope episode`)
    }
    requireTimestamp(event.createdAt, `domain event ${position}.createdAt`)
    requireEnum(event.actor, DOMAIN_EVENT_ACTORS, `domain event ${position}.actor`)
    if (event.payload !== undefined)
      requireJsonValue(event.payload, `domain event ${position}.payload`)
  }

  const legacyBySourceId = validateLegacyImports(legacyImports, factIds)
  for (const [position, raw] of manifests.entries()) {
    const manifest = requireRecord(raw, `migration manifest ${position}`)
    const manifestId = requireString(manifest.id, `migration manifest ${position}.id`)
    if (manifest.sourceSchemaVersion !== 3 || manifest.targetSchemaVersion !== MEMORY_V4_SCHEMA_VERSION)
      throw new Error(`Memory V4 migration manifest ${manifestId} has invalid versions`)
    const sourceHash = requireString(manifest.sourcePayloadSha256, `migration manifest ${position}.sourcePayloadSha256`)
    if (!/^[a-f0-9]{64}$/u.test(sourceHash))
      throw new Error(`Memory V4 migration manifest ${manifestId} has an invalid source hash`)
    requireNonNegativeInteger(manifest.sourceItemCount, `migration manifest ${position}.sourceItemCount`)
    requireTimestamp(manifest.migratedAt, `migration manifest ${position}.migratedAt`)
    const mappings = requireArray(manifest.mappings, `migration manifest ${position}.mappings`)
    if (manifest.sourceItemCount !== mappings.length)
      throw new Error(`Memory V4 migration manifest ${manifestId} item count does not match mappings`)
    const sourceItemIds = new Set<string>()
    for (const [mappingPosition, rawMapping] of mappings.entries()) {
      const mapping = requireRecord(rawMapping, `migration manifest ${position}.mapping ${mappingPosition}`)
      const sourceItemId = requireString(mapping.sourceItemId, `migration manifest ${position}.mapping ${mappingPosition}.sourceItemId`)
      if (sourceItemIds.has(sourceItemId))
        throw new Error(`Memory V4 migration manifest ${manifestId} contains duplicate source item ${sourceItemId}`)
      sourceItemIds.add(sourceItemId)
      const factId = requireString(mapping.factId, `migration manifest ${position}.mapping ${mappingPosition}.factId`)
      if (!factIds.has(factId))
        throw new Error(`Memory V4 migration mapping references missing fact ${factId}`)
      const versionId = requireString(mapping.versionId, `migration manifest ${position}.mapping ${mappingPosition}.versionId`)
      if (!factVersionIds.has(versionId))
        throw new Error(`Memory V4 migration mapping references missing fact version ${versionId}`)
      if (versionOwners.get(versionId) !== factId)
        throw new Error(`Memory V4 migration mapping ${sourceItemId} links a version to the wrong fact`)
      const legacyEpisodeId = requireString(mapping.legacyEpisodeId, `migration manifest ${position}.mapping ${mappingPosition}.legacyEpisodeId`)
      if (!episodeIds.has(legacyEpisodeId))
        throw new Error(`Memory V4 migration mapping references missing legacy episode ${legacyEpisodeId}`)
      if (!scopeCanContain(factScopes.get(factId)!, episodeScopes.get(legacyEpisodeId)!))
        throw new Error(`Memory V4 migration mapping ${sourceItemId} links an episode outside the fact scope`)
      for (const episodeId of requireUniqueStringArray(mapping.sourceEpisodeIds, `migration manifest ${position}.mapping ${mappingPosition}.sourceEpisodeIds`)) {
        if (!episodeIds.has(episodeId))
          throw new Error(`Memory V4 migration mapping references missing source episode ${episodeId}`)
        if (!scopeCanContain(factScopes.get(factId)!, episodeScopes.get(episodeId)!))
          throw new Error(`Memory V4 migration mapping ${sourceItemId} links a source episode outside the fact scope`)
      }
      for (const evidenceId of requireUniqueStringArray(mapping.evidenceLinkIds, `migration manifest ${position}.mapping ${mappingPosition}.evidenceLinkIds`)) {
        if (!evidenceIds.has(evidenceId))
          throw new Error(`Memory V4 migration mapping references missing evidence ${evidenceId}`)
        if (evidenceOwners.get(evidenceId) !== factId)
          throw new Error(`Memory V4 migration mapping ${sourceItemId} links evidence to the wrong fact`)
      }
      const legacy = legacyBySourceId.get(sourceItemId)
      if (!legacy || legacy.factId !== factId)
        throw new Error(`Memory V4 migration mapping ${sourceItemId} has no matching lossless legacy import`)
    }
    requireStringArray(manifest.warnings, `migration manifest ${position}.warnings`)
  }
}

export function normalizeMemoryV4Scope(scope: MemoryV4Scope): MemoryV4Scope {
  const ownerId = scope.ownerId.trim()
  const agentId = scope.agentId.trim()
  if (!ownerId || !agentId)
    throw new Error('Memory V4 scope requires ownerId and agentId')
  return {
    ownerId,
    agentId,
    ...(scope.sessionId?.trim() ? { sessionId: scope.sessionId.trim() } : {}),
  }
}

export function jsonClone<T>(value: T): T {
  const encoded = JSON.stringify(value)
  if (encoded === undefined)
    throw new Error('Memory V4 value is not JSON serializable')
  return JSON.parse(encoded) as T
}

export function asJsonObject(value: unknown, label: string): JsonObject {
  const cloned = jsonClone(value)
  if (!isRecord(cloned))
    throw new Error(`${label} is not a JSON object`)
  return cloned as JsonObject
}

function validateEpisode(raw: unknown, position: number, episodeIds: ReadonlySet<string>): asserts raw is MemoryEpisodeV4 {
  const episode = requireRecord(raw, `episode ${position}`)
  const episodeId = requireString(episode.id, `episode ${position}.id`)
  requireScope(episode.scope, `episode ${position}.scope`)
  requireEnum(episode.actor, ACTORS, `episode ${position}.actor`)
  requireEnum(episode.kind, EPISODE_KINDS, `episode ${position}.kind`)
  const contentState = requireEnum(episode.contentState, CONTENT_STATES, `episode ${position}.contentState`)
  if (contentState === 'available')
    requireString(episode.content, `episode ${position}.content`)
  if (contentState !== 'available' && episode.content !== undefined)
    throw new Error(`Memory V4 unavailable or deleted episode ${episodeId} still contains plaintext content`)
  if (episode.content !== undefined && typeof episode.content !== 'string')
    throw new Error(`Memory V4 episode ${episodeId} has invalid content`)
  if (episode.contentHash !== undefined)
    requireString(episode.contentHash, `episode ${position}.contentHash`)
  requireTimestamp(episode.recordedAt, `episode ${position}.recordedAt`)
  if (episode.eventTime !== undefined)
    requireTimestamp(episode.eventTime, `episode ${position}.eventTime`)
  if (episode.sourceMessageId !== undefined)
    requireString(episode.sourceMessageId, `episode ${position}.sourceMessageId`)
  requireUniqueStringArray(episode.sourceAttachmentIds, `episode ${position}.sourceAttachmentIds`)
  if (episode.supersedesEpisodeId !== undefined) {
    const supersededId = requireString(episode.supersedesEpisodeId, `episode ${position}.supersedesEpisodeId`)
    if (!episodeIds.has(supersededId) || supersededId === episodeId)
      throw new Error(`Memory V4 episode ${episodeId} has an invalid superseded episode`)
  }
  if (contentState === 'deleted' && episode.deletedAt === undefined)
    throw new Error(`Memory V4 deleted episode ${episodeId} has no deletion timestamp`)
  if (contentState !== 'deleted' && episode.deletedAt !== undefined)
    throw new Error(`Memory V4 non-deleted episode ${episodeId} has a deletion timestamp`)
  if (episode.deletedAt !== undefined) {
    const deletedAt = requireTimestamp(episode.deletedAt, `episode ${position}.deletedAt`)
    if (deletedAt < (episode.recordedAt as number))
      throw new Error(`Memory V4 episode ${episodeId} was deleted before it was recorded`)
  }
  requireEnum(episode.sensitivity, SENSITIVITIES, `episode ${position}.sensitivity`)
  requireEnum(episode.sharePolicy, SHARE_POLICIES, `episode ${position}.sharePolicy`)
  requireEnum(episode.provenance, EPISODE_PROVENANCE, `episode ${position}.provenance`)
}

function validateCandidate(
  raw: unknown,
  position: number,
  episodeIds: ReadonlySet<string>,
  episodeScopes: ReadonlyMap<string, MemoryV4Scope>,
): void {
  const candidate = requireRecord(raw, `candidate ${position}`)
  const candidateId = requireString(candidate.id, `candidate ${position}.id`)
  const scope = requireScope(candidate.scope, `candidate ${position}.scope`)
  for (const episodeId of requireUniqueStringArray(candidate.evidenceEpisodeIds, `candidate ${position}.evidenceEpisodeIds`)) {
    if (!episodeIds.has(episodeId))
      throw new Error(`Memory V4 candidate ${candidateId} references missing episode ${episodeId}`)
    if (!scopeCanContain(scope, episodeScopes.get(episodeId)!))
      throw new Error(`Memory V4 candidate ${candidateId} references an episode outside its scope`)
  }
  requireString(candidate.subjectId, `candidate ${position}.subjectId`)
  requireString(candidate.predicate, `candidate ${position}.predicate`)
  requireJsonValue(candidate.object, `candidate ${position}.object`)
  requireEnum(candidate.objectType, OBJECT_TYPES, `candidate ${position}.objectType`)
  requireJsonValue(candidate.normalizedValue, `candidate ${position}.normalizedValue`)
  requireString(candidate.canonicalText, `candidate ${position}.canonicalText`)
  requireEnum(candidate.polarity, POLARITIES, `candidate ${position}.polarity`)
  requireEnum(candidate.modality, MODALITIES, `candidate ${position}.modality`)
  if (candidate.condition !== undefined)
    requireString(candidate.condition, `candidate ${position}.condition`)
  requireEnum(candidate.cardinality, CARDINALITIES, `candidate ${position}.cardinality`)
  requireOptionalChronology(candidate.validFrom, candidate.validTo, `candidate ${position}`)
  requireScore(candidate.extractionScore, `candidate ${position}.extractionScore`)
  requireScore(candidate.durabilityScore, `candidate ${position}.durabilityScore`)
  if (candidate.verificationScore !== undefined)
    requireScore(candidate.verificationScore, `candidate ${position}.verificationScore`)
  if (candidate.evidenceScore !== undefined)
    requireScore(candidate.evidenceScore, `candidate ${position}.evidenceScore`)
  for (const field of ['calibratedActiveProbability', 'calibrationLowerBound', 'calibrationUpperBound']) {
    if (candidate[field] !== undefined)
      requireScore(candidate[field], `candidate ${position}.${field}`)
  }
  if (candidate.calibrationStatus !== undefined)
    requireEnum(candidate.calibrationStatus, ['calibrated', 'insufficient-data', 'out-of-distribution'] as const, `candidate ${position}.calibrationStatus`)
  if (candidate.calibrationMethod !== undefined)
    requireEnum(candidate.calibrationMethod, ['isotonic-pav'] as const, `candidate ${position}.calibrationMethod`)
  if (candidate.calibratorVersion !== undefined)
    requireString(candidate.calibratorVersion, `candidate ${position}.calibratorVersion`)
  if (candidate.calibrationCohort !== undefined)
    requireString(candidate.calibrationCohort, `candidate ${position}.calibrationCohort`)
  requireStringArray(candidate.ambiguityFlags, `candidate ${position}.ambiguityFlags`)
  if (candidate.proposedAction !== undefined)
    requireEnum(candidate.proposedAction, WRITE_ACTIONS, `candidate ${position}.proposedAction`)
  requireEnum(candidate.status, CANDIDATE_STATUSES, `candidate ${position}.status`)
  requireString(candidate.extractorVersion, `candidate ${position}.extractorVersion`)
  if (candidate.verifierVersion !== undefined)
    requireString(candidate.verifierVersion, `candidate ${position}.verifierVersion`)
  if (candidate.policyVersion !== undefined)
    requireString(candidate.policyVersion, `candidate ${position}.policyVersion`)
  if (candidate.decisionReasonCodes !== undefined)
    requireStringArray(candidate.decisionReasonCodes, `candidate ${position}.decisionReasonCodes`)
  if (candidate.reviewOutcome !== undefined)
    requireEnum(candidate.reviewOutcome, ['approved', 'rejected'] as const, `candidate ${position}.reviewOutcome`)
  if (candidate.reviewedAt !== undefined)
    requireTimestamp(candidate.reviewedAt, `candidate ${position}.reviewedAt`)
  if (candidate.reviewNote !== undefined)
    requireString(candidate.reviewNote, `candidate ${position}.reviewNote`)
  if (candidate.policyRuns !== undefined) {
    for (const [runIndex, rawRun] of requireArray(candidate.policyRuns, `candidate ${position}.policyRuns`).entries()) {
      const run = requireRecord(rawRun, `candidate ${position}.policyRuns ${runIndex}`)
      requireString(run.id, `candidate ${position}.policyRuns ${runIndex}.id`)
      requireEnum(run.action, WRITE_ACTIONS, `candidate ${position}.policyRuns ${runIndex}.action`)
      requireEnum(run.status, CANDIDATE_STATUSES, `candidate ${position}.policyRuns ${runIndex}.status`)
      requireScore(run.extractionScore, `candidate ${position}.policyRuns ${runIndex}.extractionScore`)
      requireScore(run.verificationScore, `candidate ${position}.policyRuns ${runIndex}.verificationScore`)
      requireScore(run.evidenceScore, `candidate ${position}.policyRuns ${runIndex}.evidenceScore`)
      for (const key of ['calibratedActiveProbability', 'calibrationLowerBound', 'calibrationUpperBound'])
        requireScore(run[key], `candidate ${position}.policyRuns ${runIndex}.${key}`)
      requireEnum(run.calibrationStatus, ['calibrated', 'insufficient-data', 'out-of-distribution'] as const, `candidate ${position}.policyRuns ${runIndex}.calibrationStatus`)
      requireEnum(run.calibrationMethod, ['isotonic-pav'] as const, `candidate ${position}.policyRuns ${runIndex}.calibrationMethod`)
      requireString(run.calibratorVersion, `candidate ${position}.policyRuns ${runIndex}.calibratorVersion`)
      requireString(run.calibrationCohort, `candidate ${position}.policyRuns ${runIndex}.calibrationCohort`)
      requireScore(run.durabilityScore, `candidate ${position}.policyRuns ${runIndex}.durabilityScore`)
      requireStringArray(run.ambiguityFlags, `candidate ${position}.policyRuns ${runIndex}.ambiguityFlags`)
      requireStringArray(run.reasonCodes, `candidate ${position}.policyRuns ${runIndex}.reasonCodes`)
      for (const key of ['extractorVersion', 'normalizerVersion', 'verifierVersion', 'policyVersion'])
        requireString(run[key], `candidate ${position}.policyRuns ${runIndex}.${key}`)
      requireTimestamp(run.processedAt, `candidate ${position}.policyRuns ${runIndex}.processedAt`)
      if (typeof run.shadow !== 'boolean')
        throw new Error(`candidate ${position}.policyRuns ${runIndex}.shadow must be boolean`)
    }
  }
  const createdAt = requireTimestamp(candidate.createdAt, `candidate ${position}.createdAt`)
  const updatedAt = requireTimestamp(candidate.updatedAt, `candidate ${position}.updatedAt`)
  if (updatedAt < createdAt)
    throw new Error(`Memory V4 candidate ${candidateId} updatedAt precedes createdAt`)
}

function validateEvidenceLink(
  raw: unknown,
  position: number,
  factIds: ReadonlySet<string>,
  episodeIds: ReadonlySet<string>,
  factScopes: ReadonlyMap<string, MemoryV4Scope>,
  episodeScopes: ReadonlyMap<string, MemoryV4Scope>,
): asserts raw is EvidenceLinkV4 {
  const link = requireRecord(raw, `evidence link ${position}`)
  const linkId = requireString(link.id, `evidence link ${position}.id`)
  const factId = requireString(link.factId, `evidence link ${position}.factId`)
  const episodeId = requireString(link.episodeId, `evidence link ${position}.episodeId`)
  if (!factIds.has(factId))
    throw new Error(`Memory V4 evidence link ${linkId} references missing fact ${factId}`)
  if (!episodeIds.has(episodeId))
    throw new Error(`Memory V4 evidence link ${linkId} references missing episode ${episodeId}`)
  if (!scopeCanContain(factScopes.get(factId)!, episodeScopes.get(episodeId)!))
    throw new Error(`Memory V4 evidence link ${linkId} crosses owner, agent, or session scope`)
  requireEnum(link.role, EVIDENCE_ROLES, `evidence link ${position}.role`)
  requireEnum(link.strength, EVIDENCE_STRENGTHS, `evidence link ${position}.strength`)
  if (typeof link.active !== 'boolean')
    throw new Error(`Memory V4 evidence link ${linkId} has invalid active flag`)
  requireTimestamp(link.createdAt, `evidence link ${position}.createdAt`)
  if (link.invalidatedAt !== undefined) {
    const invalidatedAt = requireTimestamp(link.invalidatedAt, `evidence link ${position}.invalidatedAt`)
    if (invalidatedAt < (link.createdAt as number))
      throw new Error(`Memory V4 evidence link ${linkId} was invalidated before it was created`)
  }
  if (link.active && link.invalidatedAt !== undefined)
    throw new Error(`Memory V4 active evidence link ${linkId} has an invalidation timestamp`)
  if (link.note !== undefined)
    requireString(link.note, `evidence link ${position}.note`)
}

function validateFact(
  raw: unknown,
  position: number,
  evidenceIds: ReadonlySet<string>,
  evidenceOwners: ReadonlyMap<string, string>,
  evidenceActive: ReadonlyMap<string, boolean>,
  factIds: ReadonlySet<string>,
  factScopes: ReadonlyMap<string, MemoryV4Scope>,
): asserts raw is MemoryFactV4 {
  const fact = requireRecord(raw, `fact ${position}`)
  const factId = requireString(fact.id, `fact ${position}.id`)
  const scope = requireScope(fact.scope, `fact ${position}.scope`)
  requireString(fact.subjectId, `fact ${position}.subjectId`)
  requireString(fact.predicate, `fact ${position}.predicate`)
  requireJsonValue(fact.object, `fact ${position}.object`)
  requireEnum(fact.objectType, OBJECT_TYPES, `fact ${position}.objectType`)
  requireJsonValue(fact.normalizedValue, `fact ${position}.normalizedValue`)
  requireString(fact.canonicalText, `fact ${position}.canonicalText`)
  requireString(fact.memoryKey, `fact ${position}.memoryKey`)
  requireEnum(fact.cardinality, CARDINALITIES, `fact ${position}.cardinality`)
  requireEnum(fact.polarity, POLARITIES, `fact ${position}.polarity`)
  requireEnum(fact.modality, MODALITIES, `fact ${position}.modality`)
  if (fact.condition !== undefined)
    requireString(fact.condition, `fact ${position}.condition`)
  const status = requireEnum(fact.status, FACT_STATUSES, `fact ${position}.status`)
  requireOptionalChronology(fact.validFrom, fact.validTo, `fact ${position}`)
  const recordedAt = requireTimestamp(fact.recordedAt, `fact ${position}.recordedAt`)
  const factUpdatedAt = requireTimestamp(fact.updatedAt, `fact ${position}.updatedAt`)
  if (factUpdatedAt < recordedAt)
    throw new Error(`Memory V4 fact ${factId} updatedAt precedes recordedAt`)
  if (fact.invalidatedAt !== undefined) {
    const invalidatedAt = requireTimestamp(fact.invalidatedAt, `fact ${position}.invalidatedAt`)
    if (invalidatedAt < recordedAt)
      throw new Error(`Memory V4 fact ${factId} was invalidated before it was recorded`)
  }
  if (fact.expiresAt !== undefined)
    requireTimestamp(fact.expiresAt, `fact ${position}.expiresAt`)
  const linkedEvidence = requireUniqueStringArray(fact.evidenceLinkIds, `fact ${position}.evidenceLinkIds`)
  let activeEvidenceCount = 0
  for (const evidenceId of linkedEvidence) {
    if (!evidenceIds.has(evidenceId))
      throw new Error(`Memory V4 fact ${factId} references missing evidence ${evidenceId}`)
    if (evidenceOwners.get(evidenceId) !== factId)
      throw new Error(`Memory V4 fact ${factId} references evidence owned by another fact`)
    if (evidenceActive.get(evidenceId))
      activeEvidenceCount += 1
  }
  if (status === 'active' && activeEvidenceCount === 0)
    throw new Error(`Memory V4 active fact ${factId} has no active evidence`)
  for (const field of ['supersedesFactIds', 'conflictsWithFactIds']) {
    for (const relatedFactId of requireUniqueStringArray(fact[field], `fact ${position}.${field}`)) {
      if (!factIds.has(relatedFactId))
        throw new Error(`Memory V4 fact ${factId} references missing related fact ${relatedFactId}`)
      if (relatedFactId === factId)
        throw new Error(`Memory V4 fact ${factId} cannot relate to itself`)
      if (!sameOwnerAndAgent(scope, factScopes.get(relatedFactId)!))
        throw new Error(`Memory V4 fact ${factId} relates to a fact outside its owner or agent scope`)
    }
  }
  for (const field of ['extractionScore', 'verificationScore', 'evidenceScore', 'utilityScore', 'importance'])
    requireScore(fact[field], `fact ${position}.${field}`)
  requireNonNegativeInteger(fact.accessCount, `fact ${position}.accessCount`)
  if (fact.lastAccessedAt !== undefined)
    requireTimestamp(fact.lastAccessedAt, `fact ${position}.lastAccessedAt`)
  if (typeof fact.userConfirmed !== 'boolean')
    throw new Error(`Memory V4 fact ${factId} has invalid user confirmation state`)
  requireEnum(fact.verificationState, VERIFICATION_STATES, `fact ${position}.verificationState`)
  requireEnum(fact.sensitivity, SENSITIVITIES, `fact ${position}.sensitivity`)
  requireEnum(fact.sharePolicy, SHARE_POLICIES, `fact ${position}.sharePolicy`)
  requireEnum(fact.origin, FACT_ORIGINS, `fact ${position}.origin`)
  if (fact.metadata !== undefined)
    requireJsonValue(fact.metadata, `fact ${position}.metadata`)
  requireString(fact.extractorVersion, `fact ${position}.extractorVersion`)
  requireString(fact.verifierVersion, `fact ${position}.verifierVersion`)
}

function validateLegacyImports(items: unknown[], factIds: ReadonlySet<string>): Map<string, { factId: string }> {
  const bySourceId = new Map<string, { factId: string }>()
  for (const [position, raw] of items.entries()) {
    const legacy = requireRecord(raw, `legacy import ${position}`)
    if (legacy.sourceSchemaVersion !== 3)
      throw new Error(`Memory V4 legacy import ${position} has invalid source version`)
    const sourceItemId = requireString(legacy.sourceItemId, `legacy import ${position}.sourceItemId`)
    if (bySourceId.has(sourceItemId))
      throw new Error(`Memory V4 legacy imports contain duplicate source item ${sourceItemId}`)
    const factId = requireString(legacy.factId, `legacy import ${position}.factId`)
    if (!factIds.has(factId))
      throw new Error(`Memory V4 legacy import ${position} references a missing fact`)
    const original = requireRecord(legacy.raw, `legacy import ${position}.raw`)
    if (original.id !== sourceItemId)
      throw new Error(`Memory V4 legacy import ${sourceItemId} does not match its original record id`)
    bySourceId.set(sourceItemId, { factId })
  }
  return bySourceId
}

function validateSupersessionGraph(facts: unknown[]): void {
  const edges = new Map<string, string[]>()
  for (const [position, raw] of facts.entries()) {
    const fact = requireRecord(raw, `fact ${position}`)
    edges.set(requireString(fact.id, `fact ${position}.id`), requireStringArray(fact.supersedesFactIds, `fact ${position}.supersedesFactIds`))
  }
  // Iterative DFS avoids a call-stack overflow on year-scale supersession
  // histories while preserving exact cycle detection.
  const state = new Map<string, 1 | 2>()
  for (const start of edges.keys()) {
    if (state.has(start))
      continue
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }]
    state.set(start, 1)
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      const related = edges.get(frame.id) ?? []
      if (frame.next >= related.length) {
        state.set(frame.id, 2)
        stack.pop()
        continue
      }
      const nextId = related[frame.next++]!
      if (state.get(nextId) === 1)
        throw new Error(`Memory V4 supersession graph contains a cycle at fact ${nextId}`)
      if (state.get(nextId) !== 2) {
        state.set(nextId, 1)
        stack.push({ id: nextId, next: 0 })
      }
    }
  }
}

function uniqueIds(items: unknown[], label: string): Set<string> {
  const ids = new Set<string>()
  for (const [position, raw] of items.entries()) {
    const item = requireRecord(raw, `${label} ${position}`)
    const id = requireString(item.id, `${label} ${position}.id`)
    if (ids.has(id))
      throw new Error(`Memory V4 ${label} contains duplicate id: ${id}`)
    ids.add(id)
  }
  return ids
}

function requireScope(value: unknown, label: string): MemoryV4Scope {
  const scope = requireRecord(value, label)
  const ownerId = requireString(scope.ownerId, `${label}.ownerId`)
  const agentId = requireString(scope.agentId, `${label}.agentId`)
  const sessionId = scope.sessionId === undefined ? undefined : requireString(scope.sessionId, `${label}.sessionId`)
  return { ownerId, agentId, ...(sessionId ? { sessionId } : {}) }
}

function scopeCanContain(container: MemoryV4Scope, member: MemoryV4Scope): boolean {
  return sameOwnerAndAgent(container, member)
    && (container.sessionId === undefined || container.sessionId === member.sessionId)
}

function sameOwnerAndAgent(left: MemoryV4Scope, right: MemoryV4Scope): boolean {
  return left.ownerId === right.ownerId && left.agentId === right.agentId
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Memory V4 ${label} is not an array`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  const items = requireArray(value, label)
  if (!items.every(item => typeof item === 'string' && item.trim().length > 0))
    throw new Error(`Memory V4 ${label} contains an invalid string`)
  return items as string[]
}

function requireUniqueStringArray(value: unknown, label: string): string[] {
  const items = requireStringArray(value, label)
  if (new Set(items).size !== items.length)
    throw new Error(`Memory V4 ${label} contains a duplicate reference`)
  return items
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Memory V4 ${label} is not an object`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Memory V4 ${label} is not a non-empty string`)
  return value
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error(`Memory V4 ${label} has an unsupported value: ${String(value)}`)
  return value as T
}

function requireJsonValue(value: unknown, label: string): void {
  const visiting = new Set<object>()
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean')
      return true
    if (typeof current === 'number')
      return Number.isFinite(current)
    if (typeof current !== 'object')
      return false
    if (visiting.has(current))
      return false
    visiting.add(current)
    const valid = Array.isArray(current)
      ? current.every(visit)
      : Object.getPrototypeOf(current) === Object.prototype
        && Object.values(current as Record<string, unknown>).every(visit)
    visiting.delete(current)
    return valid
  }
  if (!visit(value))
    throw new Error(`Memory V4 ${label} is not a JSON value`)
}

function requireScore(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`Memory V4 ${label} is not a score in [0, 1]`)
}

function requireTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`Memory V4 ${label} is not a valid timestamp`)
  return value
}

function requireOptionalChronology(from: unknown, to: unknown, label: string): void {
  const fromTimestamp = from === undefined ? undefined : requireTimestamp(from, `${label}.validFrom`)
  const toTimestamp = to === undefined ? undefined : requireTimestamp(to, `${label}.validTo`)
  if (fromTimestamp !== undefined && toTimestamp !== undefined && toTimestamp < fromTimestamp)
    throw new Error(`Memory V4 ${label} validTo precedes validFrom`)
}

function requireNonNegativeInteger(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum)
    throw new Error(`Memory V4 ${label} is not an integer >= ${minimum}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
