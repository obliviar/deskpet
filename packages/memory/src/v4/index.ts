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
  MEMORY_V4_LEARNED_SEMANTIC_EVIDENCE_VERSION,
  MEMORY_V4_LOCAL_CALIBRATION_DATASET_FINGERPRINT,
  MEMORY_V4_SEMANTIC_INDEX_VERSION,
  MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION,
  MEMORY_V4_SHADOW_RETRIEVER_VERSION,
  createMemoryV4ShadowRetriever,
  createV3V4ShadowComparator,
} from './retrieval/memory-v4-shadow-retriever'
export {
  MEMORY_V4_TIER_ROUTER_VERSION,
  memoryV4TierSearchIds,
  routeMemoryV4Tiers,
} from './retrieval/memory-v4-tier-router'
export type {
  MemoryV4ColdPolicy,
  MemoryV4SearchTier,
  MemoryV4TierRoutingOptions,
  MemoryV4TierRoutingPlan,
} from './retrieval/memory-v4-tier-router'
export {
  MEMORY_V4_EVIDENCE_SELECTOR_VERSION,
  selectMemoryV4Evidence,
} from './retrieval/memory-v4-evidence-selector'
export type {
  MemoryV4EvidenceCandidate,
  MemoryV4EvidenceSelection,
  MemoryV4EvidenceSelectionOptions,
  MemoryV4EvidenceSelectionStopReason,
} from './retrieval/memory-v4-evidence-selector'
export type {
  MemoryV4EvidenceSelectionTelemetry,
  MemoryV4ShadowRecallHit,
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4ShadowRetriever,
  MemoryV4ShadowRetrieverOptions,
  MemoryV4SemanticIndexSnapshot,
  MemoryV4SemanticQueryEmbedding,
  MemoryV4SemanticVectorEntry,
  MemoryV4TierRoutingTelemetry,
  V3V4ShadowComparator,
  V3V4ShadowComparison,
  V3V4ShadowComparisonSink,
  V3V4ShadowComparisonStatus,
  V3V4ShadowFailure,
} from './retrieval/memory-v4-shadow-retriever'
export {
  BASELINE_MEMORY_V4_RETRIEVAL_POLICY,
  DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
  MEMORY_V4_POLICY_INTENTS,
  MEMORY_V4_RETRIEVAL_POLICY_SCHEMA_VERSION,
  MEMORY_V4_RETRIEVAL_POLICY_VERSION,
  createMemoryV4RetrievalPolicy,
  deriveMemoryV4RetrievalPolicy,
  fingerprintMemoryV4RetrievalPolicy,
  memoryV4RetrievalPolicyIdentity,
  parseMemoryV4RetrievalPolicy,
} from './policy/memory-v4-retrieval-policy'
export type {
  MemoryV4RetrievalPolicy,
  MemoryV4RetrievalPolicyIdentity,
  MemoryV4RetrievalPolicyOverrides,
} from './policy/memory-v4-retrieval-policy'
export {
  MEMORY_V4_POLICY_ARTIFACT_SCHEMA_VERSION,
  MEMORY_V4_POLICY_ARTIFACT_VERSION,
  createMemoryV4PolicyArtifact,
  parseMemoryV4PolicyArtifact,
  serializeMemoryV4PolicyArtifact,
} from './policy/memory-v4-policy-artifact'
export type {
  MemoryV4PolicyArtifact,
  MemoryV4PolicyArtifactSource,
} from './policy/memory-v4-policy-artifact'
export {
  MEMORY_V4_POLICY_SEARCH_VERSION,
  defaultMemoryV4PolicyCandidates,
  runMemoryV4PolicySearch,
} from './policy/memory-v4-policy-search'
export type {
  MemoryV4PolicySearchEvaluation,
  MemoryV4PolicySearchMetrics,
  MemoryV4PolicySearchReport,
} from './policy/memory-v4-policy-search'
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
export {
  MEMORY_V4_INTERNAL_FEEDBACK_LABELS,
  MEMORY_V4_INTERNAL_FEEDBACK_SCHEMA_VERSION,
  MEMORY_V4_INTERNAL_FEEDBACK_VERSION,
  createMemoryV4InternalFeedbackStore,
  isMemoryV4InternalFeedbackLabel,
} from './evaluation/memory-v4-internal-feedback'
export {
  DEFAULT_MEMORY_V4_FEEDBACK_CALIBRATION_POLICY,
  MEMORY_V4_FEEDBACK_CALIBRATION_DATASET_VERSION,
  MEMORY_V4_FEEDBACK_CALIBRATION_GATE_VERSION,
  evaluateMemoryV4FeedbackCalibrationGate,
  fitMemoryV4InternalFeedbackCalibration,
  freezeMemoryV4InternalFeedbackDataset,
} from './evaluation/memory-v4-feedback-calibration'
export {
  MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION,
  MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION,
  MEMORY_V4_FEEDBACK_ARTIFACT_VERSION,
  createMemoryV4FeedbackArtifactStore,
} from './evaluation/memory-v4-feedback-artifact'
export {
  MEMORY_V4_YEAR_SCENARIO_GENERATOR_VERSION,
  MEMORY_V4_YEAR_SCENARIO_SCHEMA_VERSION,
  fingerprintMemoryV4YearScenario,
  generateMemoryV4YearScenario,
  memoryV4YearQueriesForDay,
  parseMemoryV4YearScenario,
} from './evaluation/memory-v4-year-scenario'
export type {
  MemoryV4YearFactDefinition,
  MemoryV4YearGeneratedEvent,
  MemoryV4YearGeneratedScenario,
  MemoryV4YearOperationKind,
  MemoryV4YearQueryDefinition,
  MemoryV4YearQueryTruth,
  MemoryV4YearScenarioDefinition,
  MemoryV4YearScheduledOperation,
  MemoryV4YearTransformation,
} from './evaluation/memory-v4-year-scenario'
export {
  MEMORY_V4_YEAR_GATE_VERSION,
  MEMORY_V4_YEAR_SIMULATOR_VERSION,
  runMemoryV4YearSimulation,
} from './evaluation/memory-v4-year-simulator'
export type {
  MemoryV4YearCheckpointReport,
  MemoryV4YearFailureLocator,
  MemoryV4YearGateCheck,
  MemoryV4YearOperationTrace,
  MemoryV4YearQueryTrace,
  MemoryV4YearScaleReport,
  MemoryV4YearSimulationReport,
  MemoryV4YearSimulationOptions,
  MemoryV4YearStrategy,
  MemoryV4YearStrategyMetrics,
} from './evaluation/memory-v4-year-simulator'
export {
  MEMORY_V4_YEAR_REPORT_VERSION,
  renderMemoryV4YearMarkdown,
  serializeMemoryV4YearReport,
} from './evaluation/memory-v4-year-report'
export type {
  MemoryV4FeedbackArtifact,
  MemoryV4FeedbackArtifactApproval,
  MemoryV4FeedbackArtifactApprovalResult,
  MemoryV4FeedbackArtifactChecklist,
  MemoryV4FeedbackArtifactPersistence,
  MemoryV4FeedbackArtifactRevocationResult,
  MemoryV4FeedbackArtifactState,
  MemoryV4FeedbackArtifactStatus,
  MemoryV4FeedbackArtifactStore,
  MemoryV4FeedbackArtifactSummary,
} from './evaluation/memory-v4-feedback-artifact'
export type {
  MemoryV4FeedbackCalibrationAudit,
  MemoryV4FeedbackCalibrationDataset,
  MemoryV4FeedbackCalibrationGateCheck,
  MemoryV4FeedbackCalibrationGateDecision,
  MemoryV4FeedbackCalibrationGateReport,
  MemoryV4FeedbackCalibrationPolicy,
  MemoryV4FeedbackRankingValidation,
  MemoryV4FeedbackSplitStats,
} from './evaluation/memory-v4-feedback-calibration'
export type {
  MemoryV4InternalFeedbackCandidate,
  MemoryV4InternalFeedbackCalibrationCandidate,
  MemoryV4InternalFeedbackCalibrationReview,
  MemoryV4InternalFeedbackConfirmationResult,
  MemoryV4InternalFeedbackLabel,
  MemoryV4InternalFeedbackPersistence,
  MemoryV4InternalFeedbackResult,
  MemoryV4InternalFeedbackReviewInput,
  MemoryV4InternalFeedbackStatus,
  MemoryV4InternalFeedbackStore,
} from './evaluation/memory-v4-internal-feedback'
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
export {
  MEMORY_V4_EVIDENCE_BUNDLE_VERSION,
  buildMemoryV4EvidenceBundle,
  memoryV4EvidenceBundleToAdaptiveResult,
} from './read/memory-v4-evidence-bundle'
export type {
  MemoryV4EvidenceBundle,
  MemoryV4EvidenceBundleEntry,
} from './read/memory-v4-evidence-bundle'
export {
  MEMORY_V4_READ_ROUTER_VERSION,
  createMemoryV4ReadRouter,
  normalizeMemoryV4ReadMode,
} from './read/memory-v4-read-router'
export type {
  MemoryV4ReadDecision,
  MemoryV4ReadDecisionContext,
  MemoryV4ReadFallbackReason,
  MemoryV4ReadMode,
  MemoryV4ReadRouter,
  MemoryV4ReadRouterOptions,
  MemoryV4ReadSource,
} from './read/memory-v4-read-router'
