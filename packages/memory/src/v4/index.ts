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
export { createMemoryCandidateReviewService } from './review/memory-candidate-review'
export type {
  CandidateApprovalTarget,
  CandidateCalibrationDataset,
  CandidateReprocessOptions,
  CandidateReprocessReport,
  CandidateReviewItem,
  MemoryCandidateReviewService,
} from './review/memory-candidate-review'
export type {
  V4CapturedMemory,
  V4ShadowCapture,
  V4ShadowReconciliationResult,
  V4ShadowRetrieval,
  V4ShadowRetrievalFeedback,
  V4ShadowWriter,
  V4ShadowWriterOptions,
} from './dual-write/v4-shadow-writer'
export {
  MEMORY_CONSOLIDATION_SERVICE_VERSION,
  MEMORY_DETERMINISTIC_SUMMARIZER_VERSION,
  createDeterministicSummarizer,
  createIdleConsolidationRunner,
  createMemoryConsolidationService,
} from './consolidation/memory-consolidation-service'
export type {
  ConsolidationBucket,
  ConsolidationGranularity,
  ConsolidationRunOptions,
  ConsolidationRunReport,
  ConsolidationScopeFilter,
  ConsolidationStopReason,
  ConsolidationSummarizer,
  ConsolidationSummaryOutput,
  IdleConsolidationRunner,
  IdleConsolidationRunnerOptions,
  MemoryConsolidationService,
  MemoryConsolidationServiceOptions,
} from './consolidation/memory-consolidation-service'
export { MEMORY_EPISODE_DEDUP_VERSION, findDuplicateEpisodeGroups, mergeDuplicateEpisodes } from './consolidation/episode-dedup'
export type {
  EpisodeDedupGroup,
  EpisodeDedupOptions,
  EpisodeDedupReport,
  EpisodeDedupScopeFilter,
} from './consolidation/episode-dedup'
export {
  MEMORY_TIERING_SERVICE_VERSION,
  assignTiers,
  computeFactUtility,
  createMemoryTieringService,
} from './consolidation/memory-tiering-service'
export {
  DEFAULT_MEMORY_V4_RECALL_ABSTENTION_CALIBRATION,
  MEMORY_V4_LOCAL_CALIBRATION_DATASET_FINGERPRINT,
  MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION,
  MEMORY_V4_SHADOW_RETRIEVER_VERSION,
  createMemoryV4ShadowRetriever,
  createV3V4ShadowComparator,
} from './retrieval/memory-v4-shadow-retriever'
export type {
  MemoryV4ShadowRecallHit,
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4ShadowRetriever,
  MemoryV4ShadowRetrieverOptions,
  V3V4ShadowComparator,
  V3V4ShadowComparison,
  V3V4ShadowComparisonSink,
  V3V4ShadowComparisonStatus,
  V3V4ShadowFailure,
} from './retrieval/memory-v4-shadow-retriever'
export {
  MEMORY_V4_SHADOW_EVALUATION_SCHEMA_VERSION,
  MEMORY_V4_SHADOW_EVALUATION_VERSION,
  MEMORY_V4_SHADOW_TASK_QUEUE_VERSION,
  createMemoryV4ShadowEvaluationStore,
  createMemoryV4ShadowTaskQueue,
} from './evaluation/memory-v4-shadow-evaluation'
export type {
  MemoryV4ShadowEvaluationPersistence,
  MemoryV4ShadowEvaluationStatus,
  MemoryV4ShadowEvaluationStore,
  MemoryV4ShadowMetricRollup,
  MemoryV4ShadowTaskQueue,
  MemoryV4ShadowTaskQueueStatus,
} from './evaluation/memory-v4-shadow-evaluation'
export {
  MEMORY_V4_ABSOLUTE_EVIDENCE_SCORE_VERSION,
  MEMORY_V4_LOCAL_CALIBRATION_VERSION,
  fitMemoryV4LocalCalibration,
} from './evaluation/memory-v4-local-calibration'
export type {
  MemoryV4CalibrationObservation,
  MemoryV4LocalCalibrationArtifact,
  MemoryV4LocalCalibrationOptions,
} from './evaluation/memory-v4-local-calibration'
export type {
  ArchiveColdFactsOptions,
  ArchiveColdFactsReport,
  FactUtilityBreakdown,
  FactUtilitySignals,
  MemoryTier,
  MemoryTieringService,
  MemoryTieringServiceOptions,
  TierAssignmentView,
  TierCapacityBudgets,
  TieringOptions,
  TieringRunReport,
} from './consolidation/memory-tiering-service'
