export * from './domain/types'
export { asJsonObject, assertMemoryV4Snapshot, jsonClone, normalizeMemoryV4Scope } from './domain/validation'
export {
  createEmptyMemoryV4Snapshot,
  createMemoryV4Repository,
  parseMemoryV4Snapshot,
} from './repository/memory-v4-repository'
export type {
  MemoryV4Persistence,
  MemoryV4Repository,
  MemoryV4RepositoryOptions,
} from './repository/memory-v4-repository'
export { createEncryptedV4Persistence } from './repository/encrypted-v4-persistence'
export type {
  EncryptedV4CheckpointPersistence,
  EncryptedV4PersistenceOptions,
} from './repository/encrypted-v4-persistence'
export { createJournaledV4Persistence } from './repository/journaled-v4-persistence'
export type {
  JournaledV4Persistence,
  JournaledV4PersistenceOptions,
} from './repository/journaled-v4-persistence'
export { migrateV3PayloadToV4, migrateV3SourceIntoV4 } from './migration/v3-to-v4'
export type {
  ReadOnlyV3MemorySource,
  V3MigrationCommitResult,
  V3ToV4MigrationOptions,
} from './migration/v3-to-v4'
export {
  adaptiveResultToShadowRetrieval,
  createV4ShadowWriter,
} from './dual-write/v4-shadow-writer'
export { createMemoryV4LifecycleService } from './lifecycle/memory-v4-lifecycle'
export { createMemoryPurgeConfirmationGate } from './lifecycle/purge-confirmation'
export type {
  MemoryV4ContentEdit,
  MemoryV4DeleteMode,
  MemoryV4LifecycleResult,
  MemoryV4LifecycleService,
} from './lifecycle/memory-v4-lifecycle'
export type {
  MemoryPurgeChallenge,
  MemoryPurgeConfirmationGate,
} from './lifecycle/purge-confirmation'
export { auditV3V4Consistency } from './audit/v3-v4-diff-audit'
export type { MemoryV4AuditIssue, MemoryV4AuditReport } from './audit/v3-v4-diff-audit'
export type {
  V4CapturedMemory,
  V4ShadowCapture,
  V4ShadowReconciliationResult,
  V4ShadowRetrieval,
  V4ShadowWriter,
  V4ShadowWriterOptions,
} from './dual-write/v4-shadow-writer'
