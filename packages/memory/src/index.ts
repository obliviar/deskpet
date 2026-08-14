export { createVectorStore } from './long-term/vector-store'
export type {
  MemoryPersistence,
  MemoryPersistenceDelta,
  V3MemoryCommit,
  V3MemoryCommitReason,
  V3MemoryRecord,
  VectorStore,
  VectorStoreOptions,
} from './long-term/vector-store'
export { createEncryptedFilePersistence } from './long-term/encrypted-persistence'
export type { EncryptedFilePersistenceOptions, EncryptedMemoryPersistence } from './long-term/encrypted-persistence'
export { createLocalEmbedding, LOCAL_EMBEDDING_MODEL } from './long-term/local-embedding'

export {
  createMemoryWriter,
  extractMemoryCandidates,
  inferMemoryPrivacy,
  isSafeMemoryContent,
} from './long-term/memory-writer'
export type {
  MemoryCaptureCommit,
  MemorySourceUnlinkCommit,
  MemoryExtractor,
  MemoryWriterOptions,
} from './long-term/memory-writer'
export {
  createLocalMemoryCandidateVerifier,
  LOCAL_MEMORY_VERIFIER_VERSION,
  MEMORY_WRITE_POLICY_VERSION,
  quarantinedVerifierFailure,
} from './long-term/memory-write-policy'
export type {
  LocalMemoryCandidateVerifierOptions,
  MemoryCandidateDecisionAction,
  MemoryCandidateDecisionStatus,
  MemoryCandidateEvaluation,
  MemoryCandidateVerifier,
  MemoryCandidateVerificationContext,
  MemoryWriteMatches,
} from './long-term/memory-write-policy'
export { createSmartMemoryExtractor } from './long-term/smart-memory-extractor'
export type { SmartExtractorConfig, SmartMemoryExtractorOptions } from './long-term/smart-memory-extractor'
export type { MemoryCandidate } from './long-term/memory-extractor'
export { MEMORY_NORMALIZER_VERSION, normalizeMemoryCandidate, normalizedMemoryFields } from './long-term/memory-normalizer'
export type { NormalizedMemoryFields, NormalizedMemoryModality, NormalizedMemoryPolarity } from './long-term/memory-normalizer'
export { DEFAULT_MEMORY_SEGMENT_CHARACTERS, MEMORY_CAPTURE_PLANNER_VERSION, planMemoryCapture } from './long-term/memory-capture-planner'
export type { PlannedMemoryCapture } from './long-term/memory-capture-planner'
export { evaluateMemoryConfidenceCalibrator, fitIsotonicMemoryConfidenceCalibrator } from './long-term/confidence-calibration'
export type {
  IsotonicMemoryCalibratorOptions,
  MemoryCalibrationExample,
  MemoryCalibrationMetrics,
  MemoryCalibrationPrediction,
  MemoryCalibrationStatus,
  MemoryConfidenceCalibrator,
} from './long-term/confidence-calibration'
export { planTemporalQuery } from './long-term/temporal-query'
export type { TemporalQueryPlan } from './long-term/temporal-query'
export { isBroadPersonalMemoryQuery, selectAdaptiveRecall } from './long-term/adaptive-recall'
export type { AdaptiveRankedMemory, AdaptiveRecallSelection } from './long-term/adaptive-recall'
export { MEMORY_QUERY_PLANNER_VERSION, planMemoryQuery } from './long-term/memory-query-planner'
export type { MemoryQueryIntent, MemoryQueryPlan, MemoryRetrievalRoute } from './long-term/memory-query-planner'
export { MEMORY_RRF_VERSION, reciprocalRankFusion } from './long-term/reciprocal-rank-fusion'
export type { MemoryRankedRoute, MemoryRankedRouteItem, MemoryRrfResult } from './long-term/reciprocal-rank-fusion'
export { MEMORY_STAGE2_EVAL_VERSION, runMemoryStage2WriteEval } from './eval/stage2-write-eval'
export type {
  MemoryStage2EvalCase,
  MemoryStage2EvalError,
  MemoryStage2EvalExpectedFact,
  MemoryStage2EvalReport,
  MemoryProportionInterval,
  RunMemoryStage2EvalOptions,
} from './eval/stage2-write-eval'
export {
  MEMORY_STAGE2_BLIND_SCHEMA_VERSION,
  assembleMemoryStage2BlindCases,
  fingerprintMemoryStage2BlindCasePack,
} from './eval/stage2-blind-eval'
export { MEMORY_STAGE3_RETRIEVAL_EVAL_VERSION, runMemoryStage3RetrievalEval } from './eval/stage3-retrieval-eval'
export type {
  MemoryStage3RetrievalEvalCase,
  MemoryStage3RetrievalEvalReport,
  MemoryStage3RetrievalMetrics,
} from './eval/stage3-retrieval-eval'
export type {
  MemoryStage2BlindCase,
  MemoryStage2BlindCasePack,
  MemoryStage2BlindLabel,
  MemoryStage2BlindLabelPack,
} from './eval/stage2-blind-eval'

// V4 is additive during stage two. The desktop runtime continues using the
// stable V3 port until migration, rollback and quality gates pass.
export * from './v4'
