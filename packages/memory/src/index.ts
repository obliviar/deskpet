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
  MemoryExtractor,
  MemoryWriterOptions,
} from './long-term/memory-writer'
export { createSmartMemoryExtractor } from './long-term/smart-memory-extractor'
export type { SmartExtractorConfig, SmartMemoryExtractorOptions } from './long-term/smart-memory-extractor'
export type { MemoryCandidate } from './long-term/memory-extractor'
export { planTemporalQuery } from './long-term/temporal-query'
export type { TemporalQueryPlan } from './long-term/temporal-query'
export { isBroadPersonalMemoryQuery, selectAdaptiveRecall } from './long-term/adaptive-recall'
export type { AdaptiveRankedMemory, AdaptiveRecallSelection } from './long-term/adaptive-recall'

// V4 is additive during stage two. The desktop runtime continues using the
// stable V3 port until migration, rollback and quality gates pass.
export * from './v4'
