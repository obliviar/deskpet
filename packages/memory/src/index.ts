export { createVectorStore } from './long-term/vector-store'
export type {
  MemoryPersistence,
  MemoryPersistenceDelta,
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
export type { MemoryExtractor, MemoryWriterOptions } from './long-term/memory-writer'
export { createSmartMemoryExtractor } from './long-term/smart-memory-extractor'
export type { SmartExtractorConfig, SmartMemoryExtractorOptions } from './long-term/smart-memory-extractor'
export type { MemoryCandidate } from './long-term/memory-extractor'
export { planTemporalQuery } from './long-term/temporal-query'
export type { TemporalQueryPlan } from './long-term/temporal-query'
