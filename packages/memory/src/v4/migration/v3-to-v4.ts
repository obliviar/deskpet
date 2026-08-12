import { createHash } from 'node:crypto'
import type {
  EvidenceLinkV4,
  JsonObject,
  MemoryEpisodeV4,
  MemoryFactStatusV4,
  MemoryFactV4,
  MemoryMigrationManifestV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
  V3MigrationMapping,
} from '../domain/types'
import { asJsonObject, assertMemoryV4Snapshot, normalizeMemoryV4Scope } from '../domain/validation'
import { createEmptyMemoryV4Snapshot } from '../repository/memory-v4-repository'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

interface V3Snapshot {
  version: 3
  items: V3MemoryItem[]
}

interface V3MemoryItem {
  id: string
  content: string
  status: string
  scope: { ownerId: string; agentId: string; sessionId?: string }
  createdAt: number
  updatedAt: number
  metadata?: JsonObject
  origin?: string
  importance?: number
  confidence?: number
  accessCount?: number
  lastAccessedAt?: number
  validFrom?: number
  validTo?: number
  invalidatedAt?: number
  expiresAt?: number
  supersedes?: string
  memoryKey?: string
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
  sharePolicy?: string
  sensitivity?: string
}

export interface V3ToV4MigrationOptions {
  now?: () => number
  /** Replace a target that contains only an earlier V3 shadow migration. */
  refreshMigrationOnlyTarget?: boolean
}

export interface ReadOnlyV3MemorySource {
  load: () => string | undefined
  storagePath?: string
}

export interface V3MigrationCommitResult {
  migrated: boolean
  sourcePayloadSha256: string
  sourceItemCount: number
  factCount: number
  warningCount: number
}

/**
 * Read V3 through its load-only surface and atomically replace an empty V4
 * repository. The source is never saved, appended to or deleted. Re-running
 * the same migration is idempotent; a different non-empty V4 target is refused.
 */
export function migrateV3SourceIntoV4(
  source: ReadOnlyV3MemorySource,
  target: MemoryV4Repository,
  options: V3ToV4MigrationOptions = {},
): V3MigrationCommitResult {
  const payload = source.load()
  if (payload === undefined)
    throw new Error('Cannot migrate Memory V3 because the source snapshot does not exist')
  const migrated = migrateV3PayloadToV4(payload, options)
  const manifest = migrated.migrationManifests[0]!
  const current = target.snapshot()
  const existing = current.migrationManifests.find(item => item.sourcePayloadSha256 === manifest.sourcePayloadSha256)
  if (existing) {
    return {
      migrated: false,
      sourcePayloadSha256: existing.sourcePayloadSha256,
      sourceItemCount: existing.sourceItemCount,
      factCount: current.facts.length,
      warningCount: existing.warnings.length,
    }
  }
  if (!isEmptyV4Target(current)
    && !(options.refreshMigrationOnlyTarget && isMigrationOnlyV4Target(current)))
    throw new Error('Memory V4 target is not empty and was not created from this V3 snapshot')
  migrated.revision = isEmptyV4Target(current) ? current.revision : current.revision + 1
  migrated.createdAt = current.createdAt
  migrated.updatedAt = Math.max(migrated.updatedAt, current.updatedAt)
  target.replace(migrated)
  return {
    migrated: true,
    sourcePayloadSha256: manifest.sourcePayloadSha256,
    sourceItemCount: manifest.sourceItemCount,
    factCount: migrated.facts.length,
    warningCount: manifest.warnings.length,
  }
}

/**
 * Pure, deterministic V3 conversion. It never writes to or mutates the V3
 * persistence. The complete original V3 record is retained in legacyImports.
 */
export function migrateV3PayloadToV4(
  payload: string,
  options: V3ToV4MigrationOptions = {},
): MemoryV4Snapshot {
  const source = parseV3Snapshot(payload)
  const sourcePayloadSha256 = sha256(payload)
  const migratedAt = options.now?.() ?? Date.now()
  const target = createEmptyMemoryV4Snapshot(migratedAt)
  const episodes = new Map<string, MemoryEpisodeV4>()
  const mappings: V3MigrationMapping[] = []
  const warnings: string[] = []
  const sourceIds = new Set(source.items.map(item => item.id))

  for (const item of source.items) {
    const scope = normalizeMemoryV4Scope({
      ownerId: item.scope.ownerId,
      agentId: item.scope.agentId,
      ...(item.scope.sessionId ? { sessionId: item.scope.sessionId } : {}),
    })
    const factId = migratedId('fact', item.id)
    const legacyEpisodeId = migratedId('episode:legacy-record', item.id)
    const versionId = migratedId('version', item.id)
    const sourceEpisodeIds: string[] = []
    const evidenceLinks: EvidenceLinkV4[] = []

    if (item.sharePolicy !== 'allow-remote' && item.sharePolicy !== 'local-only' && item.sharePolicy !== 'ask')
      warnings.push(`V3 memory ${item.id} had no valid share policy and was restricted to local-only.`)
    if (item.sensitivity !== 'normal' && item.sensitivity !== 'private' && item.sensitivity !== 'secret')
      warnings.push(`V3 memory ${item.id} had no valid sensitivity and was classified as private.`)

    const legacyEpisode: MemoryEpisodeV4 = {
      id: legacyEpisodeId,
      scope,
      actor: item.origin === 'manual' ? 'user' : 'legacy-import',
      kind: item.origin === 'manual' ? 'manual-declaration' : 'legacy-memory-record',
      contentState: 'available',
      content: item.content,
      contentHash: sha256(item.content),
      recordedAt: positiveTimestamp(item.createdAt, migratedAt),
      sourceAttachmentIds: uniqueStrings(item.sourceAttachmentIds),
      sensitivity: normalizeSensitivity(item.sensitivity),
      sharePolicy: normalizeSharePolicy(item.sharePolicy),
      provenance: 'v3-derived-record',
    }
    episodes.set(legacyEpisode.id, legacyEpisode)
    const legacyEvidenceId = migratedId('evidence', `${item.id}:${legacyEpisode.id}`)
    evidenceLinks.push({
      id: legacyEvidenceId,
      factId,
      episodeId: legacyEpisode.id,
      role: item.origin === 'manual' ? 'supports' : 'legacy-derived',
      strength: item.origin === 'manual' ? 'direct' : 'legacy-derived',
      active: item.status !== 'orphaned',
      createdAt: migratedAt,
      note: item.origin === 'manual'
        ? 'Migrated from a user-managed V3 memory.'
        : 'Migrated V3 fact text; original source content was not embedded in the V3 index.',
    })

    for (const sourceMessageId of uniqueStrings(item.sourceMessageIds)) {
      const episodeId = migratedId('episode:message-reference', scopeKey(scope, sourceMessageId))
      sourceEpisodeIds.push(episodeId)
      if (!episodes.has(episodeId)) {
        episodes.set(episodeId, {
          id: episodeId,
          scope,
          actor: 'user',
          kind: 'message-reference',
          contentState: 'unavailable',
          recordedAt: positiveTimestamp(item.createdAt, migratedAt),
          sourceMessageId,
          sourceAttachmentIds: [],
          sensitivity: normalizeSensitivity(item.sensitivity),
          sharePolicy: normalizeSharePolicy(item.sharePolicy),
          provenance: 'v3-reference',
        })
      }
      evidenceLinks.push({
        id: migratedId('evidence', `${item.id}:${episodeId}`),
        factId,
        episodeId,
        role: 'references',
        strength: 'reference-only',
        active: item.status !== 'orphaned',
        createdAt: migratedAt,
        note: 'V3 retained only the source message ID, not the source message content.',
      })
    }

    for (const sourceAttachmentId of uniqueStrings(item.sourceAttachmentIds)) {
      const episodeId = migratedId('episode:attachment-reference', scopeKey(scope, sourceAttachmentId))
      sourceEpisodeIds.push(episodeId)
      if (!episodes.has(episodeId)) {
        episodes.set(episodeId, {
          id: episodeId,
          scope,
          actor: 'image-observation',
          kind: 'attachment-reference',
          contentState: 'unavailable',
          recordedAt: positiveTimestamp(item.createdAt, migratedAt),
          sourceAttachmentIds: [sourceAttachmentId],
          sensitivity: normalizeSensitivity(item.sensitivity),
          sharePolicy: normalizeSharePolicy(item.sharePolicy),
          provenance: 'v3-reference',
        })
      }
      evidenceLinks.push({
        id: migratedId('evidence', `${item.id}:${episodeId}`),
        factId,
        episodeId,
        role: 'references',
        strength: 'reference-only',
        active: item.status !== 'orphaned',
        createdAt: migratedAt,
        note: 'V3 retained only the attachment ID/hash, not the original attachment.',
      })
    }

    const memoryKey = normalizedString(item.memoryKey)
      ?? normalizedString(item.metadata?.memoryKey)
      ?? `legacy.fact.${item.id}`
    const predicate = memoryKey.startsWith('legacy.fact.')
      ? normalizedString(item.metadata?.kind) ?? 'legacy.fact'
      : memoryKey
    const migratedStatus = normalizeStatus(item.status)
    const factStatus: MemoryFactStatusV4 = item.origin !== 'manual' && migratedStatus === 'active'
      ? 'quarantined'
      : migratedStatus
    const supersededSourceId = normalizedString(item.supersedes)
    const supersedesFactIds = supersededSourceId && sourceIds.has(supersededSourceId)
      ? [migratedId('fact', supersededSourceId)]
      : []
    if (supersededSourceId && !sourceIds.has(supersededSourceId))
      warnings.push(`V3 memory ${item.id} references missing superseded memory ${supersededSourceId}.`)
    const fact: MemoryFactV4 = {
      id: factId,
      scope,
      subjectId: `owner:${scope.ownerId}`,
      predicate,
      object: item.content,
      canonicalText: item.content,
      memoryKey,
      cardinality: normalizeCardinality(item.metadata?.cardinality),
      polarity: inferPolarity(item.content),
      status: factStatus,
      ...(optionalTimestamp(item.validFrom) ? { validFrom: optionalTimestamp(item.validFrom) } : {}),
      ...(optionalTimestamp(item.validTo) ? { validTo: optionalTimestamp(item.validTo) } : {}),
      recordedAt: positiveTimestamp(item.createdAt, migratedAt),
      updatedAt: positiveTimestamp(item.updatedAt, migratedAt),
      ...(optionalTimestamp(item.invalidatedAt) ? { invalidatedAt: optionalTimestamp(item.invalidatedAt) } : {}),
      ...(optionalTimestamp(item.expiresAt) ? { expiresAt: optionalTimestamp(item.expiresAt) } : {}),
      evidenceLinkIds: evidenceLinks.map(link => link.id),
      extractionScore: score(item.confidence, 0.7),
      verificationScore: item.origin === 'manual' ? 1 : 0,
      evidenceScore: item.origin === 'manual' ? 1 : sourceEpisodeIds.length > 0 ? 0.4 : 0.2,
      utilityScore: 0.5,
      importance: score(item.importance, 0.6),
      accessCount: nonNegativeInteger(item.accessCount),
      ...(optionalTimestamp(item.lastAccessedAt) ? { lastAccessedAt: optionalTimestamp(item.lastAccessedAt) } : {}),
      userConfirmed: item.origin === 'manual',
      verificationState: item.origin === 'manual' ? 'verified' : 'legacy-unverified',
      supersedesFactIds,
      conflictsWithFactIds: [],
      sensitivity: normalizeSensitivity(item.sensitivity),
      sharePolicy: normalizeSharePolicy(item.sharePolicy),
      origin: normalizeOrigin(item.origin),
      ...(item.metadata ? { metadata: asJsonObject(item.metadata, `V3 memory ${item.id} metadata`) } : {}),
      extractorVersion: 'v3-import',
      verifierVersion: item.origin === 'manual' ? 'manual-v3' : 'unverified-v3',
    }

    target.facts.push(fact)
    target.evidenceLinks.push(...evidenceLinks)
    target.factVersions.push({
      id: versionId,
      factId,
      version: 1,
      operation: 'MIGRATE_V3',
      canonicalText: fact.canonicalText,
      status: fact.status,
      ...(fact.validFrom ? { validFrom: fact.validFrom } : {}),
      ...(fact.validTo ? { validTo: fact.validTo } : {}),
      evidenceLinkIds: [...fact.evidenceLinkIds],
      recordedAt: migratedAt,
      reason: 'Lossless structural migration from the V3 memory index.',
    })
    target.legacyImports.push({
      sourceSchemaVersion: 3,
      sourceItemId: item.id,
      factId,
      raw: asJsonObject(item, `V3 memory ${item.id}`),
    })
    mappings.push({
      sourceItemId: item.id,
      factId,
      versionId,
      legacyEpisodeId,
      sourceEpisodeIds: [...new Set(sourceEpisodeIds)],
      evidenceLinkIds: evidenceLinks.map(link => link.id),
    })
    if (item.origin !== 'manual')
      warnings.push(`V3 memory ${item.id} requires evidence re-verification because source content was not stored in V3.`)
  }

  target.episodes = [...episodes.values()]
  target.migrationManifests.push({
    id: migratedId('migration', sourcePayloadSha256),
    sourceSchemaVersion: 3,
    targetSchemaVersion: 4,
    sourcePayloadSha256,
    sourceItemCount: source.items.length,
    migratedAt,
    mappings,
    warnings,
  } satisfies MemoryMigrationManifestV4)
  assertMemoryV4Snapshot(target)
  return target
}

function parseV3Snapshot(payload: string): V3Snapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse V3 memory snapshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('V3 memory snapshot is not an object')
  const snapshot = parsed as { version?: unknown; items?: unknown }
  if (snapshot.version !== 3 || !Array.isArray(snapshot.items))
    throw new Error('V3 to V4 migration requires a version 3 snapshot')
  const ids = new Set<string>()
  const items = snapshot.items.map((raw, position) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`V3 memory item ${position} is not an object`)
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id || typeof item.content !== 'string' || !item.content)
      throw new Error(`V3 memory item ${position} has no valid id or content`)
    if (ids.has(item.id))
      throw new Error(`V3 memory snapshot contains duplicate id: ${item.id}`)
    ids.add(item.id)
    const scope = item.scope
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || typeof (scope as Record<string, unknown>).ownerId !== 'string'
      || typeof (scope as Record<string, unknown>).agentId !== 'string')
      throw new Error(`V3 memory item ${item.id} has no valid scope`)
    if (typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number')
      throw new Error(`V3 memory item ${item.id} has invalid timestamps`)
    if (typeof item.status !== 'string'
      || !['active', 'superseded', 'expired', 'conflicted', 'orphaned'].includes(item.status))
      throw new Error(`V3 memory item ${item.id} has an invalid status`)
    return asJsonObject(item, `V3 memory item ${item.id}`) as unknown as V3MemoryItem
  })
  return { version: 3, items }
}

function isEmptyV4Target(snapshot: MemoryV4Snapshot): boolean {
  return snapshot.episodes.length === 0
    && snapshot.candidates.length === 0
    && snapshot.facts.length === 0
    && snapshot.evidenceLinks.length === 0
    && snapshot.factVersions.length === 0
    && snapshot.retrievalEvents.length === 0
    && snapshot.migrationManifests.length === 0
    && snapshot.legacyImports.length === 0
}

function isMigrationOnlyV4Target(snapshot: MemoryV4Snapshot): boolean {
  return snapshot.candidates.length === 0
    && snapshot.retrievalEvents.length === 0
    && snapshot.migrationManifests.length === 1
    && snapshot.facts.length === snapshot.legacyImports.length
    && snapshot.facts.every(item => item.extractorVersion === 'v3-import')
    && snapshot.episodes.every(item => item.provenance !== 'native-v4')
}

function migratedId(namespace: string, source: string): string {
  return `v4-${namespace.replace(/[^a-z0-9:-]/gi, '-')}-${sha256(source).slice(0, 32)}`
}

function scopeKey(scope: MemoryV4Scope, sourceId: string): string {
  return JSON.stringify([scope.ownerId, scope.agentId, scope.sessionId ?? '', sourceId])
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function normalizeStatus(value: string): MemoryFactStatusV4 {
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

function normalizeCardinality(value: unknown): MemoryFactV4['cardinality'] {
  return value === 'single' ? 'single' : value === 'set' ? 'set' : 'multiple'
}

function inferPolarity(content: string): MemoryFactV4['polarity'] {
  if (/(?:不喜欢|讨厌|不能|不要|dislike|hate)/iu.test(content))
    return 'negative'
  if (/(?:喜欢|偏爱|偏好|prefer|like)/iu.test(content))
    return 'positive'
  return 'unknown'
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => String(item).trim()))]
    : []
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function score(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveTimestamp(value: unknown, fallback: number): number {
  return optionalTimestamp(value) ?? fallback
}
