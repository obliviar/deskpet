import type {
  EvidenceLinkV4,
  JsonObject,
  MemoryEpisodeV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from './types'
import { MEMORY_V4_SCHEMA_VERSION } from './types'

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
  const retrievalEvents = requireArray(value.retrievalEvents, 'retrievalEvents')
  const manifests = requireArray(value.migrationManifests, 'migrationManifests')
  const legacyImports = requireArray(value.legacyImports, 'legacyImports')

  const episodeIds = uniqueIds(episodes, 'episode')
  const candidateIds = uniqueIds(candidates, 'candidate')
  const factIds = uniqueIds(facts, 'fact')
  const evidenceIds = uniqueIds(evidenceLinks, 'evidence link')
  const evidenceOwners = new Map<string, string>()
  const evidenceActive = new Map<string, boolean>()
  const factVersionIds = uniqueIds(factVersions, 'fact version')
  uniqueIds(retrievalEvents, 'retrieval event')
  uniqueIds(manifests, 'migration manifest')
  void candidateIds

  for (const [position, raw] of episodes.entries())
    validateEpisode(raw, position)
  for (const [position, raw] of candidates.entries()) {
    const candidate = requireRecord(raw, `candidate ${position}`)
    requireScope(candidate.scope, `candidate ${position}.scope`)
    for (const episodeId of requireStringArray(candidate.evidenceEpisodeIds, `candidate ${position}.evidenceEpisodeIds`)) {
      if (!episodeIds.has(episodeId))
        throw new Error(`Memory V4 candidate ${String(candidate.id)} references missing episode ${episodeId}`)
    }
    requireString(candidate.canonicalText, `candidate ${position}.canonicalText`)
    requireScore(candidate.extractionScore, `candidate ${position}.extractionScore`)
    requireScore(candidate.durabilityScore, `candidate ${position}.durabilityScore`)
    if (candidate.verificationScore !== undefined)
      requireScore(candidate.verificationScore, `candidate ${position}.verificationScore`)
    requireTimestamp(candidate.createdAt, `candidate ${position}.createdAt`)
    requireTimestamp(candidate.updatedAt, `candidate ${position}.updatedAt`)
  }
  for (const [position, raw] of evidenceLinks.entries()) {
    validateEvidenceLink(raw, position, factIds, episodeIds)
    const link = raw as EvidenceLinkV4
    evidenceOwners.set(link.id, link.factId)
    evidenceActive.set(link.id, link.active)
  }
  for (const [position, raw] of facts.entries())
    validateFact(raw, position, evidenceIds, evidenceOwners, evidenceActive, factIds)
  for (const [position, raw] of factVersions.entries()) {
    const version = requireRecord(raw, `fact version ${position}`)
    if (!factIds.has(requireString(version.factId, `fact version ${position}.factId`)))
      throw new Error(`Memory V4 fact version ${String(version.id)} references a missing fact`)
    requireNonNegativeInteger(version.version, `fact version ${position}.version`, 1)
    for (const evidenceId of requireStringArray(version.evidenceLinkIds, `fact version ${position}.evidenceLinkIds`)) {
      if (!evidenceIds.has(evidenceId))
        throw new Error(`Memory V4 fact version ${String(version.id)} references missing evidence ${evidenceId}`)
    }
  }
  for (const [position, raw] of retrievalEvents.entries()) {
    const event = requireRecord(raw, `retrieval event ${position}`)
    requireScope(event.scope, `retrieval event ${position}.scope`)
    for (const field of ['retrievedFactIds', 'injectedFactIds', 'adoptedFactIds', 'correctedFactIds', 'deniedFactIds']) {
      for (const factId of requireStringArray(event[field], `retrieval event ${position}.${field}`)) {
        if (!factIds.has(factId))
          throw new Error(`Memory V4 retrieval event ${String(event.id)} references missing fact ${factId}`)
      }
    }
  }
  for (const [position, raw] of manifests.entries()) {
    const manifest = requireRecord(raw, `migration manifest ${position}`)
    if (manifest.sourceSchemaVersion !== 3 || manifest.targetSchemaVersion !== MEMORY_V4_SCHEMA_VERSION)
      throw new Error(`Memory V4 migration manifest ${String(manifest.id)} has invalid versions`)
    requireString(manifest.sourcePayloadSha256, `migration manifest ${position}.sourcePayloadSha256`)
    requireNonNegativeInteger(manifest.sourceItemCount, `migration manifest ${position}.sourceItemCount`)
    const mappings = requireArray(manifest.mappings, `migration manifest ${position}.mappings`)
    if (manifest.sourceItemCount !== mappings.length)
      throw new Error(`Memory V4 migration manifest ${String(manifest.id)} item count does not match mappings`)
    const sourceItemIds = new Set<string>()
    for (const [mappingPosition, rawMapping] of mappings.entries()) {
      const mapping = requireRecord(rawMapping, `migration manifest ${position}.mapping ${mappingPosition}`)
      const sourceItemId = requireString(mapping.sourceItemId, `migration manifest ${position}.mapping ${mappingPosition}.sourceItemId`)
      if (sourceItemIds.has(sourceItemId))
        throw new Error(`Memory V4 migration manifest ${String(manifest.id)} contains duplicate source item ${sourceItemId}`)
      sourceItemIds.add(sourceItemId)
      const factId = requireString(mapping.factId, `migration manifest ${position}.mapping ${mappingPosition}.factId`)
      if (!factIds.has(factId))
        throw new Error(`Memory V4 migration mapping references missing fact ${factId}`)
      const versionId = requireString(mapping.versionId, `migration manifest ${position}.mapping ${mappingPosition}.versionId`)
      if (!factVersionIds.has(versionId))
        throw new Error(`Memory V4 migration mapping references missing fact version ${versionId}`)
      const legacyEpisodeId = requireString(mapping.legacyEpisodeId, `migration manifest ${position}.mapping ${mappingPosition}.legacyEpisodeId`)
      if (!episodeIds.has(legacyEpisodeId))
        throw new Error(`Memory V4 migration mapping references missing legacy episode ${legacyEpisodeId}`)
      for (const episodeId of requireStringArray(mapping.sourceEpisodeIds, `migration manifest ${position}.mapping ${mappingPosition}.sourceEpisodeIds`)) {
        if (!episodeIds.has(episodeId))
          throw new Error(`Memory V4 migration mapping references missing source episode ${episodeId}`)
      }
      for (const evidenceId of requireStringArray(mapping.evidenceLinkIds, `migration manifest ${position}.mapping ${mappingPosition}.evidenceLinkIds`)) {
        if (!evidenceIds.has(evidenceId))
          throw new Error(`Memory V4 migration mapping references missing evidence ${evidenceId}`)
      }
    }
    requireStringArray(manifest.warnings, `migration manifest ${position}.warnings`)
  }
  for (const [position, raw] of legacyImports.entries()) {
    const legacy = requireRecord(raw, `legacy import ${position}`)
    if (legacy.sourceSchemaVersion !== 3)
      throw new Error(`Memory V4 legacy import ${position} has invalid source version`)
    if (!factIds.has(requireString(legacy.factId, `legacy import ${position}.factId`)))
      throw new Error(`Memory V4 legacy import ${position} references a missing fact`)
    requireRecord(legacy.raw, `legacy import ${position}.raw`)
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
  if (!isRecord(cloned) || Array.isArray(cloned))
    throw new Error(`${label} is not a JSON object`)
  return cloned as JsonObject
}

function validateEpisode(raw: unknown, position: number): asserts raw is MemoryEpisodeV4 {
  const episode = requireRecord(raw, `episode ${position}`)
  requireScope(episode.scope, `episode ${position}.scope`)
  requireTimestamp(episode.recordedAt, `episode ${position}.recordedAt`)
  requireStringArray(episode.sourceAttachmentIds, `episode ${position}.sourceAttachmentIds`)
  if (episode.contentState === 'available' && typeof episode.content !== 'string')
    throw new Error(`Memory V4 episode ${String(episode.id)} is available without content`)
  if (episode.deletedAt !== undefined)
    requireTimestamp(episode.deletedAt, `episode ${position}.deletedAt`)
}

function validateEvidenceLink(
  raw: unknown,
  position: number,
  factIds: Set<string>,
  episodeIds: Set<string>,
): asserts raw is EvidenceLinkV4 {
  const link = requireRecord(raw, `evidence link ${position}`)
  const factId = requireString(link.factId, `evidence link ${position}.factId`)
  const episodeId = requireString(link.episodeId, `evidence link ${position}.episodeId`)
  if (!factIds.has(factId))
    throw new Error(`Memory V4 evidence link ${String(link.id)} references missing fact ${factId}`)
  if (!episodeIds.has(episodeId))
    throw new Error(`Memory V4 evidence link ${String(link.id)} references missing episode ${episodeId}`)
  if (typeof link.active !== 'boolean')
    throw new Error(`Memory V4 evidence link ${String(link.id)} has invalid active flag`)
}

function validateFact(
  raw: unknown,
  position: number,
  evidenceIds: Set<string>,
  evidenceOwners: ReadonlyMap<string, string>,
  evidenceActive: ReadonlyMap<string, boolean>,
  factIds: ReadonlySet<string>,
): asserts raw is MemoryFactV4 {
  const fact = requireRecord(raw, `fact ${position}`)
  requireScope(fact.scope, `fact ${position}.scope`)
  requireString(fact.canonicalText, `fact ${position}.canonicalText`)
  requireString(fact.memoryKey, `fact ${position}.memoryKey`)
  const linkedEvidence = requireStringArray(fact.evidenceLinkIds, `fact ${position}.evidenceLinkIds`)
  let activeEvidenceCount = 0
  for (const evidenceId of linkedEvidence) {
    if (!evidenceIds.has(evidenceId))
      throw new Error(`Memory V4 fact ${String(fact.id)} references missing evidence ${evidenceId}`)
    if (evidenceOwners.get(evidenceId) !== fact.id)
      throw new Error(`Memory V4 fact ${String(fact.id)} references evidence owned by another fact`)
    if (evidenceActive.get(evidenceId))
      activeEvidenceCount += 1
  }
  if (fact.status === 'active' && activeEvidenceCount === 0)
    throw new Error(`Memory V4 active fact ${String(fact.id)} has no active evidence`)
  for (const field of ['supersedesFactIds', 'conflictsWithFactIds']) {
    for (const relatedFactId of requireStringArray(fact[field], `fact ${position}.${field}`)) {
      if (!factIds.has(relatedFactId))
        throw new Error(`Memory V4 fact ${String(fact.id)} references missing related fact ${relatedFactId}`)
      if (relatedFactId === fact.id)
        throw new Error(`Memory V4 fact ${String(fact.id)} cannot relate to itself`)
    }
  }
  for (const field of ['extractionScore', 'verificationScore', 'evidenceScore', 'utilityScore', 'importance'])
    requireScore(fact[field], `fact ${position}.${field}`)
  requireNonNegativeInteger(fact.accessCount, `fact ${position}.accessCount`)
  requireTimestamp(fact.recordedAt, `fact ${position}.recordedAt`)
  requireTimestamp(fact.updatedAt, `fact ${position}.updatedAt`)
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

function requireScope(value: unknown, label: string): void {
  const scope = requireRecord(value, label)
  requireString(scope.ownerId, `${label}.ownerId`)
  requireString(scope.agentId, `${label}.agentId`)
  if (scope.sessionId !== undefined)
    requireString(scope.sessionId, `${label}.sessionId`)
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Memory V4 ${label} is not an array`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  const items = requireArray(value, label)
  if (!items.every(item => typeof item === 'string' && item.length > 0))
    throw new Error(`Memory V4 ${label} contains an invalid string`)
  return items as string[]
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

function requireScore(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`Memory V4 ${label} is not a score in [0, 1]`)
}

function requireTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`Memory V4 ${label} is not a valid timestamp`)
  return value
}

function requireNonNegativeInteger(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum)
    throw new Error(`Memory V4 ${label} is not an integer >= ${minimum}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
