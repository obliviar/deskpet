export const MEMORY_V4_SCHEMA_VERSION = 4 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface MemoryV4Scope {
  ownerId: string
  agentId: string
  sessionId?: string
}

export type MemoryV4Actor = 'user' | 'assistant' | 'tool' | 'image-observation' | 'legacy-import'
export type EpisodeKind = 'message' | 'manual-declaration' | 'image-observation'
  | 'message-reference' | 'attachment-reference' | 'legacy-memory-record'
export type EpisodeContentState = 'available' | 'unavailable' | 'deleted'

export type MemoryV4SharePolicy = 'allow-remote' | 'local-only' | 'ask'
export type MemoryV4Sensitivity = 'normal' | 'private' | 'secret'

export interface MemoryEpisodeV4 {
  id: string
  scope: MemoryV4Scope
  actor: MemoryV4Actor
  kind: EpisodeKind
  contentState: EpisodeContentState
  content?: string
  contentHash?: string
  recordedAt: number
  eventTime?: number
  sourceMessageId?: string
  sourceAttachmentIds: string[]
  supersedesEpisodeId?: string
  deletedAt?: number
  sensitivity: MemoryV4Sensitivity
  sharePolicy: MemoryV4SharePolicy
  provenance: 'native-v4' | 'v3-reference' | 'v3-derived-record'
}

export type CandidateStatus = 'pending' | 'accepted' | 'rejected' | 'quarantined'
export type CandidateReviewOutcomeV4 = 'approved' | 'rejected'
export type MemoryCardinalityV4 = 'single' | 'multiple' | 'set'
export type MemoryPolarityV4 = 'positive' | 'negative' | 'unknown'
export type MemoryModalityV4 = 'asserted' | 'planned' | 'hypothetical' | 'reported' | 'inferred' | 'unknown'
export type MemoryObjectTypeV4 = 'string' | 'number' | 'boolean' | 'date' | 'entity' | 'json'
export type MemoryWriteActionV4 = 'ADD' | 'MERGE_EVIDENCE' | 'REFINE' | 'SUPERSEDE'
  | 'CONFLICT' | 'NOOP' | 'QUARANTINE' | 'SUPPRESS' | 'DELETE' | 'PURGE' | 'RESTORE'

export interface MemoryCandidateV4 {
  id: string
  scope: MemoryV4Scope
  evidenceEpisodeIds: string[]
  subjectId: string
  predicate: string
  object: JsonValue
  objectType: MemoryObjectTypeV4
  normalizedValue: JsonValue
  canonicalText: string
  polarity: MemoryPolarityV4
  modality: MemoryModalityV4
  condition?: string
  cardinality: MemoryCardinalityV4
  validFrom?: number
  validTo?: number
  extractionScore: number
  verificationScore?: number
  evidenceScore?: number
  calibratedActiveProbability?: number
  calibrationLowerBound?: number
  calibrationUpperBound?: number
  calibrationStatus?: 'calibrated' | 'insufficient-data' | 'out-of-distribution'
  calibrationMethod?: 'isotonic-pav'
  calibratorVersion?: string
  calibrationCohort?: string
  durabilityScore: number
  ambiguityFlags: string[]
  proposedAction?: MemoryWriteActionV4
  status: CandidateStatus
  extractorVersion: string
  verifierVersion?: string
  policyVersion?: string
  decisionReasonCodes?: string[]
  reviewOutcome?: CandidateReviewOutcomeV4
  reviewedAt?: number
  reviewNote?: string
  policyRuns?: MemoryCandidatePolicyRunV4[]
  createdAt: number
  updatedAt: number
}

export interface MemoryCandidatePolicyRunV4 {
  id: string
  action: MemoryWriteActionV4
  status: CandidateStatus
  extractionScore: number
  verificationScore: number
  evidenceScore: number
  calibratedActiveProbability: number
  calibrationLowerBound: number
  calibrationUpperBound: number
  calibrationStatus: 'calibrated' | 'insufficient-data' | 'out-of-distribution'
  calibrationMethod: 'isotonic-pav'
  calibratorVersion: string
  calibrationCohort: string
  durabilityScore: number
  ambiguityFlags: string[]
  reasonCodes: string[]
  extractorVersion: string
  normalizerVersion: string
  verifierVersion: string
  policyVersion: string
  processedAt: number
  shadow: boolean
}

export type MemoryFactStatusV4 = 'active' | 'superseded' | 'conflicted' | 'quarantined'
  | 'expired' | 'orphaned' | 'archived' | 'suppressed' | 'deleted'
export type MemoryVerificationStateV4 = 'verified' | 'pending' | 'legacy-unverified' | 'rejected'

export interface MemoryFactV4 {
  id: string
  scope: MemoryV4Scope
  subjectId: string
  predicate: string
  object: JsonValue
  objectType: MemoryObjectTypeV4
  normalizedValue: JsonValue
  canonicalText: string
  memoryKey: string
  cardinality: MemoryCardinalityV4
  polarity: MemoryPolarityV4
  modality: MemoryModalityV4
  condition?: string
  status: MemoryFactStatusV4
  validFrom?: number
  validTo?: number
  recordedAt: number
  updatedAt: number
  invalidatedAt?: number
  expiresAt?: number
  evidenceLinkIds: string[]
  extractionScore: number
  verificationScore: number
  evidenceScore: number
  utilityScore: number
  importance: number
  accessCount: number
  lastAccessedAt?: number
  userConfirmed: boolean
  verificationState: MemoryVerificationStateV4
  supersedesFactIds: string[]
  conflictsWithFactIds: string[]
  sensitivity: MemoryV4Sensitivity
  sharePolicy: MemoryV4SharePolicy
  origin: 'automatic' | 'manual' | 'image'
  metadata?: JsonObject
  extractorVersion: string
  verifierVersion: string
}

export type EvidenceRoleV4 = 'supports' | 'references' | 'legacy-derived'
export type EvidenceStrengthV4 = 'direct' | 'reference-only' | 'legacy-derived'

export interface EvidenceLinkV4 {
  id: string
  factId: string
  episodeId: string
  role: EvidenceRoleV4
  strength: EvidenceStrengthV4
  active: boolean
  createdAt: number
  invalidatedAt?: number
  note?: string
}

export interface MemoryFactVersionV4 {
  id: string
  factId: string
  version: number
  operation: MemoryWriteActionV4 | 'MIGRATE_V3'
  subjectId: string
  predicate: string
  object: JsonValue
  objectType: MemoryObjectTypeV4
  normalizedValue: JsonValue
  canonicalText: string
  polarity: MemoryPolarityV4
  modality: MemoryModalityV4
  condition?: string
  status: MemoryFactStatusV4
  validFrom?: number
  validTo?: number
  evidenceLinkIds: string[]
  recordedAt: number
  /** Transaction time at which this version stopped being the latest version. */
  transactionClosedAt?: number
  reason: string
}

export type MemoryDerivedArtifactKindV4 = 'summary' | 'graph-edge' | 'embedding' | 'retrieval-cache'
export type MemoryDerivedArtifactStatusV4 = 'current' | 'stale' | 'deleted'

/** Rebuildable data derived from facts/episodes. It is never the source of truth. */
export interface MemoryDerivedArtifactV4 {
  id: string
  scope: MemoryV4Scope
  kind: MemoryDerivedArtifactKindV4
  status: MemoryDerivedArtifactStatusV4
  sourceEpisodeIds: string[]
  sourceFactIds: string[]
  content?: string
  contentHash?: string
  createdAt: number
  updatedAt: number
  invalidatedAt?: number
  builderVersion: string
}

export type MemoryDomainEventTypeV4 = 'EPISODE_RECORDED' | 'FACT_CREATED' | 'FACT_VERSIONED'
  | 'EVIDENCE_LINKED' | 'EVIDENCE_UNLINKED' | 'FACT_SUPPRESSED' | 'FACT_DELETED'
  | 'FACT_PURGED' | 'FACT_RESTORED' | 'DERIVED_ARTIFACT_STALE' | 'V3_RECONCILED'
  | 'CANDIDATE_REVIEWED' | 'CANDIDATE_REPROCESSED'

/** Append-only, idempotent lifecycle ledger. Payload contains identifiers, not plaintext evidence. */
export interface MemoryDomainEventV4 {
  id: string
  idempotencyKey: string
  type: MemoryDomainEventTypeV4
  scope: MemoryV4Scope
  factId?: string
  episodeId?: string
  createdAt: number
  actor: 'system' | 'user' | 'migration'
  payload?: JsonObject
}

export interface RetrievalEventV4 {
  id: string
  scope: MemoryV4Scope
  queryHash: string
  queryType: string
  retrievedFactIds: string[]
  injectedFactIds: string[]
  adoptedFactIds: string[]
  correctedFactIds: string[]
  deniedFactIds: string[]
  createdAt: number
  retrievalVersion: string
  answerModel?: string
}

export interface LegacyV3ImportRecord {
  sourceSchemaVersion: 3
  sourceItemId: string
  factId: string
  raw: JsonObject
}

export interface V3MigrationMapping {
  sourceItemId: string
  factId: string
  versionId: string
  legacyEpisodeId: string
  sourceEpisodeIds: string[]
  evidenceLinkIds: string[]
}

export interface MemoryMigrationManifestV4 {
  id: string
  sourceSchemaVersion: 3
  targetSchemaVersion: typeof MEMORY_V4_SCHEMA_VERSION
  sourcePayloadSha256: string
  sourceItemCount: number
  migratedAt: number
  mappings: V3MigrationMapping[]
  warnings: string[]
}

export interface MemoryV4DualWriteState {
  sourcePayloadSha256: string
  sourceItemCount: number
  reconciledAt: number
  writerVersion: string
}

export interface MemoryV4Snapshot {
  schemaVersion: typeof MEMORY_V4_SCHEMA_VERSION
  revision: number
  createdAt: number
  updatedAt: number
  episodes: MemoryEpisodeV4[]
  candidates: MemoryCandidateV4[]
  facts: MemoryFactV4[]
  evidenceLinks: EvidenceLinkV4[]
  factVersions: MemoryFactVersionV4[]
  derivedArtifacts: MemoryDerivedArtifactV4[]
  domainEvents: MemoryDomainEventV4[]
  retrievalEvents: RetrievalEventV4[]
  migrationManifests: MemoryMigrationManifestV4[]
  legacyImports: LegacyV3ImportRecord[]
  /** Last complete V3 source view reconciled into the stage-two shadow. */
  dualWriteState?: MemoryV4DualWriteState
}
