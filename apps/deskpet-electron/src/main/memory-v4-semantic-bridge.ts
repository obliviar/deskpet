import { createHash } from 'node:crypto'
import {
  MEMORY_V4_SEMANTIC_INDEX_VERSION,
  type MemoryV4SemanticIndexSnapshot,
  type MemoryV4Snapshot,
} from '@deskpet/memory'

export const MEMORY_V4_SEMANTIC_BRIDGE_VERSION = 'memory-v4-semantic-bridge-v1'

export interface MemoryV4SemanticBridgeOptions {
  snapshot: MemoryV4Snapshot
  model: string
  expectedDimension: number
  semanticRevision?: number
  factVector: (input: { factId: string; sourceMemoryId: string; content: string }) => number[] | undefined
  summaryVector?: (input: { summaryId: string; content: string }) => number[] | undefined
}

/**
 * Build a detached, versioned Worker payload from already verified local
 * embeddings. Stale hashes never reach this bridge because the host lookup is
 * content-addressed; dimensions and normalization are checked again here.
 */
export function buildMemoryV4SemanticIndexSnapshot(
  options: MemoryV4SemanticBridgeOptions,
): MemoryV4SemanticIndexSnapshot {
  if (!options.model.trim() || !Number.isSafeInteger(options.expectedDimension) || options.expectedDimension <= 0)
    throw new Error('V4 semantic bridge requires a valid model identity and dimension')
  const legacySourceIds = new Map(options.snapshot.legacyImports.map(item => [item.factId, item.sourceItemId]))
  const factVectors: MemoryV4SemanticIndexSnapshot['factVectors'] = []
  for (const fact of options.snapshot.facts) {
    if (!indexableFact(fact))
      continue
    const metadataSource = fact.metadata?.v3SourceId
    const sourceMemoryId = typeof metadataSource === 'string' && metadataSource.trim()
      ? metadataSource
      : legacySourceIds.get(fact.id)
    if (!sourceMemoryId)
      continue
    const vector = options.factVector({ factId: fact.id, sourceMemoryId, content: fact.canonicalText })
    if (!validSemanticVector(vector, options.expectedDimension))
      continue
    factVectors.push({ id: fact.id, contentHash: contentHash(fact.canonicalText), vector: [...vector] })
  }

  const summaryVectors: MemoryV4SemanticIndexSnapshot['summaryVectors'] = []
  if (options.summaryVector) {
    for (const artifact of options.snapshot.derivedArtifacts) {
      if (artifact.kind !== 'summary' || artifact.status !== 'current' || !artifact.content)
        continue
      const vector = options.summaryVector({ summaryId: artifact.id, content: artifact.content })
      if (!validSemanticVector(vector, options.expectedDimension))
        continue
      summaryVectors.push({ id: artifact.id, contentHash: contentHash(artifact.content), vector: [...vector] })
    }
  }

  return {
    version: MEMORY_V4_SEMANTIC_INDEX_VERSION,
    snapshotRevision: options.snapshot.revision,
    semanticRevision: Math.max(0, Math.floor(options.semanticRevision ?? options.snapshot.revision)),
    model: options.model,
    dimension: options.expectedDimension,
    factVectors,
    summaryVectors,
  }
}

function indexableFact(fact: MemoryV4Snapshot['facts'][number]): boolean {
  return fact.canonicalText !== '[purged]'
    && fact.verificationState !== 'rejected'
    && !['deleted', 'suppressed', 'quarantined', 'orphaned'].includes(fact.status)
}

function validSemanticVector(vector: number[] | undefined, dimension: number): vector is number[] {
  if (!vector || vector.length !== dimension || !vector.every(Number.isFinite))
    return false
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return Math.abs(norm - 1) <= 0.03
}

function contentHash(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC')).digest('hex')
}
