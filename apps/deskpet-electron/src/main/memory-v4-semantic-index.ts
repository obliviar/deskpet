import type {
  MemoryEmbeddingIndex,
  MemoryV4SemanticIndexSnapshot,
  MemoryV4Snapshot,
} from '@deskpet/memory'
import { buildMemoryV4SemanticIndexSnapshot } from './memory-v4-semantic-bridge'

export const MEMORY_V4_SEMANTIC_BACKGROUND_INDEX_VERSION = 'memory-v4-semantic-background-index-v1'

export interface MemoryV4SemanticPreparationStatus {
  version: typeof MEMORY_V4_SEMANTIC_BACKGROUND_INDEX_VERSION
  model: string
  snapshotRevision: number
  semanticRevision: number
  total: number
  ready: number
  pending: number
  factsReady: number
  summariesReady: number
  processed: number
}

export interface MemoryV4SemanticBackgroundIndex {
  seed: (snapshot: MemoryV4Snapshot) => MemoryV4SemanticPreparationStatus
  prepare: (
    snapshot: MemoryV4Snapshot,
    options?: {
      batchSize?: number
      maxItems?: number
      shouldCancel?: () => boolean
      onProgress?: (status: MemoryV4SemanticPreparationStatus) => void
    },
  ) => Promise<MemoryV4SemanticPreparationStatus>
  semanticSnapshot: (snapshot: MemoryV4Snapshot) => MemoryV4SemanticIndexSnapshot
  status: (snapshot: MemoryV4Snapshot) => MemoryV4SemanticPreparationStatus
}

export function createMemoryV4SemanticBackgroundIndex(options: {
  index: MemoryEmbeddingIndex
  model: string
  dimension: number
  embed: (content: string) => Promise<number[]>
  seedFactVector?: (input: { sourceMemoryId: string; content: string }) => number[] | undefined
}): MemoryV4SemanticBackgroundIndex {
  if (!options.model.trim() || !Number.isSafeInteger(options.dimension) || options.dimension <= 0)
    throw new Error('V4 semantic background index requires a model and dimension')
  let semanticRevision = 1
  let cached: { snapshotRevision: number; semanticRevision: number; value: MemoryV4SemanticIndexSnapshot } | undefined
  let activePreparation: Promise<MemoryV4SemanticPreparationStatus> | undefined

  function items(snapshot: MemoryV4Snapshot) {
    const legacySourceIds = new Map(snapshot.legacyImports.map(item => [item.factId, item.sourceItemId]))
    const facts = snapshot.facts
      .filter(indexableFact)
      .map((fact) => {
        const metadataSource = fact.metadata?.v3SourceId
        const sourceMemoryId = typeof metadataSource === 'string' && metadataSource.trim()
          ? metadataSource
          : legacySourceIds.get(fact.id)
        return { id: fact.id, content: fact.canonicalText, kind: 'fact' as const, sourceMemoryId }
      })
    const summaries = snapshot.derivedArtifacts
      .filter(artifact => artifact.kind === 'summary' && artifact.status === 'current' && artifact.content)
      .map(artifact => ({ id: artifact.id, content: artifact.content!, kind: 'summary' as const, sourceMemoryId: undefined }))
    return [...facts, ...summaries]
  }

  function invalidate(): void {
    semanticRevision += 1
    cached = undefined
  }

  function seed(snapshot: MemoryV4Snapshot): MemoryV4SemanticPreparationStatus {
    const currentItems = items(snapshot)
    const removed = options.index.reconcileMemoryIds(new Set(currentItems.map(item => item.id)))
    const prepared = currentItems.flatMap((item) => {
      if (item.kind !== 'fact' || !item.sourceMemoryId || options.index.get(item.id, options.model, item.content))
        return []
      const vector = options.seedFactVector?.({ sourceMemoryId: item.sourceMemoryId, content: item.content })
      return validVector(vector, options.dimension)
        ? [{ memoryId: item.id, model: options.model, content: item.content, vector }]
        : []
    })
    if (prepared.length > 0)
      options.index.putBatch(prepared)
    if (removed > 0 || prepared.length > 0)
      invalidate()
    return buildStatus(snapshot, prepared.length)
  }

  function prepare(
    snapshot: MemoryV4Snapshot,
    prepareOptions: {
      batchSize?: number
      maxItems?: number
      shouldCancel?: () => boolean
      onProgress?: (status: MemoryV4SemanticPreparationStatus) => void
    } = {},
  ): Promise<MemoryV4SemanticPreparationStatus> {
    // Initial preparation and the idle consolidator can overlap. Coalesce them
    // so the same text is never embedded twice or written concurrently.
    if (activePreparation)
      return activePreparation
    activePreparation = runPreparation(snapshot, prepareOptions)
      .finally(() => {
        activePreparation = undefined
      })
    return activePreparation
  }

  async function runPreparation(
    snapshot: MemoryV4Snapshot,
    prepareOptions: {
      batchSize?: number
      maxItems?: number
      shouldCancel?: () => boolean
      onProgress?: (status: MemoryV4SemanticPreparationStatus) => void
    },
  ): Promise<MemoryV4SemanticPreparationStatus> {
    let processed = seed(snapshot).processed
    const batchSize = clampInteger(prepareOptions.batchSize, 1, 64, 8)
    const maxItems = clampInteger(prepareOptions.maxItems, 1, 10_000, 128)
    prepareOptions.onProgress?.(buildStatus(snapshot, processed))
    const pending = items(snapshot)
      .filter(item => !options.index.get(item.id, options.model, item.content))
      .slice(0, maxItems)
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (prepareOptions.shouldCancel?.())
        break
      const prepared = [] as Array<{ memoryId: string; model: string; content: string; vector: number[] }>
      for (const item of pending.slice(offset, offset + batchSize)) {
        if (prepareOptions.shouldCancel?.())
          break
        const vector = await options.embed(item.content)
        if (!validVector(vector, options.dimension))
          throw new Error(`V4 semantic embedding for ${item.id} is invalid`)
        prepared.push({ memoryId: item.id, model: options.model, content: item.content, vector })
      }
      if (prepared.length > 0) {
        options.index.putBatch(prepared)
        processed += prepared.length
        invalidate()
      }
      prepareOptions.onProgress?.(buildStatus(snapshot, processed))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return buildStatus(snapshot, processed)
  }

  function semanticSnapshot(snapshot: MemoryV4Snapshot): MemoryV4SemanticIndexSnapshot {
    if (cached?.snapshotRevision === snapshot.revision && cached.semanticRevision === semanticRevision)
      return cached.value
    const value = buildMemoryV4SemanticIndexSnapshot({
      snapshot,
      model: options.model,
      expectedDimension: options.dimension,
      semanticRevision,
      factVector: ({ factId, content }) => options.index.get(factId, options.model, content),
      summaryVector: ({ summaryId, content }) => options.index.get(summaryId, options.model, content),
    })
    cached = { snapshotRevision: snapshot.revision, semanticRevision, value }
    return value
  }

  function buildStatus(snapshot: MemoryV4Snapshot, processed: number): MemoryV4SemanticPreparationStatus {
    const currentItems = items(snapshot)
    let factsReady = 0
    let summariesReady = 0
    for (const item of currentItems) {
      if (!options.index.get(item.id, options.model, item.content))
        continue
      if (item.kind === 'fact')
        factsReady += 1
      else
        summariesReady += 1
    }
    const ready = factsReady + summariesReady
    return {
      version: MEMORY_V4_SEMANTIC_BACKGROUND_INDEX_VERSION,
      model: options.model,
      snapshotRevision: snapshot.revision,
      semanticRevision,
      total: currentItems.length,
      ready,
      pending: currentItems.length - ready,
      factsReady,
      summariesReady,
      processed,
    }
  }

  return {
    seed,
    prepare,
    semanticSnapshot,
    status: snapshot => buildStatus(snapshot, 0),
  }
}

function indexableFact(fact: MemoryV4Snapshot['facts'][number]): boolean {
  return fact.canonicalText !== '[purged]'
    && fact.verificationState !== 'rejected'
    && !['deleted', 'suppressed', 'quarantined', 'orphaned'].includes(fact.status)
}

function validVector(vector: number[] | undefined, dimension: number): vector is number[] {
  if (!vector || vector.length !== dimension || !vector.every(Number.isFinite))
    return false
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return Math.abs(norm - 1) <= 0.03
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}
