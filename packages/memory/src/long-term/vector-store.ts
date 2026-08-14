import type {
  AdaptiveMemoryRecallOptions,
  AdaptiveMemoryRecallResult,
  MemoryFragment,
  MemoryOrigin,
  MemoryRecallOptions,
  MemoryScope,
  MemorySensitivity,
  MemorySharePolicy,
  MemoryStatus,
  MemoryTemporalMode,
  MemoryUpdate,
} from '@deskpet/contracts'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import OpenAI from 'openai'
import {
  createLocalEmbedding,
  LEGACY_LOCAL_EMBEDDING_MODELS,
  localSemanticConcepts,
  LOCAL_EMBEDDING_MODEL,
} from './local-embedding'
import { isBroadPersonalMemoryQuery, selectAdaptiveRecall } from './adaptive-recall'
import {
  planMemoryQuery,
  type MemoryQueryPlan,
  type MemoryRetrievalRoute,
} from './memory-query-planner'
import { MEMORY_RRF_VERSION, reciprocalRankFusion } from './reciprocal-rank-fusion'

export interface MemoryPersistence {
  load: () => string | undefined
  save: (payload: string) => void
  /** Append changed records without serializing and rewriting the complete index. */
  appendDelta?: (delta: MemoryPersistenceDelta) => void
  /** Preserve the current physical payload before an automatic schema upgrade. */
  backupBeforeMigration?: () => void
  /** Fold the journal into the current encrypted snapshot. */
  compact?: () => void
  /** Replace managed backups with the current effective payload after purge. */
  scrubBackups?: () => void
  storagePath?: string
}

export interface MemoryPersistenceDelta {
  indexVersion: 3
  upserts: unknown[]
  deletes: string[]
}

export interface VectorStoreOptions {
  apiKey?: string
  baseURL?: string
  embeddingModel?: string
  storagePath?: string
  persistence?: MemoryPersistence
  minScore?: number
  minSemanticScore?: number
  minLexicalScore?: number
  maxMemories?: number
  embedder?: (text: string) => Promise<number[]>
  /** RRF is the default stage-three strategy; legacy linear scoring remains available for rollback/evaluation. */
  retrievalFusion?: 'rrf-v1' | 'weighted-linear-v1'
  /**
   * Optional post-commit observer used by additive shadow stores. It runs only
   * after the V3 persistence operation succeeds. Observer failures are
   * isolated and never roll back or reject the working V3 operation.
   */
  onCommittedChange?: (commit: V3MemoryCommit) => void
  onCommitObserverError?: (error: unknown, commit: V3MemoryCommit) => void
}

type MemoryCardinality = 'single' | 'multiple'

export type V3MemoryCommitReason = 'recall' | 'expiry' | 'remember' | 'forget'
  | 'update' | 'restore' | 'unlink-sources' | 'clear' | 'purge'

export interface V3MemoryRecord extends MemoryFragment {
  status: MemoryStatus
  origin: MemoryOrigin
  importance: number
  confidence: number
  accessCount: number
  validFrom?: number
  validTo?: number
  invalidatedAt?: number
  expiresAt?: number
  memoryKey?: string
  sourceMessageIds: string[]
  sourceAttachmentIds: string[]
  sharePolicy: MemorySharePolicy
  sensitivity: MemorySensitivity
  scope: Required<Pick<MemoryScope, 'ownerId' | 'agentId'>> & Pick<MemoryScope, 'sessionId'>
  embedding: number[]
  embeddingModel: string
  createdAt: number
  updatedAt: number
}

export interface V3MemoryCommit {
  reason: V3MemoryCommitReason
  /** Detached JSON copies matching the records durably written to V3. */
  upserts: V3MemoryRecord[]
  deletedIds: string[]
  committedAt: number
}

type IndexedMemory = V3MemoryRecord

interface PersistedIndexV3 {
  version: 3
  items: IndexedMemory[]
}

interface LoadResult {
  exists: boolean
  migrated: boolean
  items: IndexedMemory[]
}

interface SecondaryIndexes {
  byId: Map<string, IndexedMemory>
  exact: Map<string, Set<string>>
  activeByMemoryKey: Map<string, Set<string>>
  activeByToken: Map<string, Set<string>>
}

interface RankedMemoryEntry {
  item: IndexedMemory
  score: number
  semanticScore: number
  lexicalScore: number
  temporalScore: number
  retrievalRoutes: MemoryRetrievalRoute[]
  routeRanks: Record<string, number>
}

interface RankedMemoryPool {
  entries: RankedMemoryEntry[]
  changed: Map<string, IndexedMemory>
  now: number
  queryPlan: MemoryQueryPlan
  routeCandidateCounts: Record<string, number>
}

interface MemoryCandidateFeatures {
  item: IndexedMemory
  semanticScore: number
  lexicalScore: number
  temporalScore: number
  structuredScore: number
  importanceScore: number
  confidenceScore: number
  recencyScore: number
  frequencyScore: number
  lexicalRelevant: boolean
  semanticRelevant: boolean
  structuredRelevant: boolean
  broadRelevant: boolean
  relevant: boolean
}

export function createVectorStore(options: VectorStoreOptions = {}) {
  const configuredEmbeddingModel = options.embeddingModel ?? LOCAL_EMBEDDING_MODEL
  // Treat old local-hash configuration values as aliases for the current local
  // model. This rebuilds persisted vectors lazily and prevents a legacy config
  // from being mistaken for a remote OpenAI-compatible embedding model.
  const embeddingModel = LEGACY_LOCAL_EMBEDDING_MODELS.has(configuredEmbeddingModel)
    ? LOCAL_EMBEDDING_MODEL
    : configuredEmbeddingModel
  const {
    apiKey,
    baseURL,
    storagePath,
    maxMemories = 20_000,
    embedder,
    retrievalFusion = 'rrf-v1',
    onCommittedChange,
    onCommitObserverError,
  } = options
  const minScore = options.minScore ?? (embeddingModel === LOCAL_EMBEDDING_MODEL ? 0.12 : 0.3)
  const minSemanticScore = options.minSemanticScore ?? (embeddingModel === LOCAL_EMBEDDING_MODEL ? 0.2 : 0.32)
  const minLexicalScore = options.minLexicalScore ?? 0.08

  const persistence = options.persistence ?? createFilePersistence(storagePath)
  const remoteClient = !embedder && embeddingModel !== LOCAL_EMBEDDING_MODEL
    ? new OpenAI({ apiKey: requireApiKey(apiKey), baseURL })
    : undefined
  const loaded = loadIndex(persistence)
  const index = loaded.items
  const secondary = createSecondaryIndexes(index)
  if (persistence && loaded.migrated)
    persistence.backupBeforeMigration?.()
  if (persistence && (!loaded.exists || loaded.migrated))
    persistIndex(persistence, index)

  async function embed(text: string): Promise<number[]> {
    if (embedder)
      return embedder(text)
    if (embeddingModel === LOCAL_EMBEDDING_MODEL)
      return createLocalEmbedding(text)
    const res = await remoteClient!.embeddings.create({ model: embeddingModel, input: text })
    const result = res.data[0]?.embedding ?? []
    if (result.length === 0)
      throw new Error('Embedding provider returned an empty vector')
    return result
  }

  async function rankMemoryCandidates(
    query: string,
    scope: MemoryScope,
    candidateLimit: number,
    recallOptions?: MemoryRecallOptions,
  ): Promise<RankedMemoryPool> {
    const normalizedScope = normalizeScope(scope)
    const changed = new Map(markExpired(index, normalizedScope, secondary).map(item => [item.id, item]))
    const now = Date.now()
    const queryPlan = planMemoryQuery(query, recallOptions)
    const temporalPlan = { mode: queryPlan.temporalMode, asOf: queryPlan.asOf }
    if (!queryPlan.requiresMemory)
      return { entries: [], changed, now, queryPlan, routeCandidateCounts: {} }
    const candidates = index.filter(item => matchesScope(item.scope, normalizedScope)
      && isTemporalCandidate(item, temporalPlan.mode, temporalPlan.asOf, now)
      && isRecallAllowed(item, recallOptions))
    if (candidates.length === 0 || !query.trim())
      return { entries: [], changed, now, queryPlan, routeCandidateCounts: {} }

    for (const item of candidates) {
      if (item.embeddingModel !== embeddingModel || item.embedding.length === 0) {
        item.embedding = await embed(item.content)
        item.embeddingModel = embeddingModel
        item.updatedAt = Date.now()
        changed.set(item.id, item)
      }
    }

    const queryEmbedding = await embed(query)
    const queryConcepts = embeddingModel === LOCAL_EMBEDDING_MODEL
      ? new Set(localSemanticConcepts(query))
      : undefined
    const hasQueryConcepts = (queryConcepts?.size ?? 0) > 0
    const broadPersonalQuery = isBroadPersonalMemoryQuery(query)
    const queryStrongTokens = strongLexicalTokens(query)
    const lexicalScores = bm25Scores(query, candidates.map(item => item.content))
    const features: MemoryCandidateFeatures[] = candidates
      .map((item, itemIndex) => {
        const semantic = clampScore(cosineSimilarity(queryEmbedding, item.embedding))
        const lexical = lexicalScores[itemIndex] ?? 0
        const importance = clampScore(item.importance)
        const confidence = clampScore(item.confidence)
        const recency = recencyScore(item, now)
        const frequency = Math.min(1, Math.log1p(item.accessCount) / Math.log(21))
        const temporal = temporalAlignment(item, temporalPlan.mode)
        const strongLexicalOverlap = hasStrongLexicalOverlap(queryStrongTokens, item.content)
        // Avoid scanning every stored fact through the concept rules for broad
        // queries that have no requested field. On a 20k profile this was the
        // dominant avoidable part of the online path.
        const itemConcepts = hasQueryConcepts
          ? new Set(localSemanticConcepts(item.content))
          : undefined
        const sharedConcept = itemConcepts
          ? intersectionSize(queryConcepts!, itemConcepts) > 0
          : false
        const structured = hasQueryConcepts
          ? weightedConceptCoverage(queryConcepts!, itemConcepts!)
          : broadPersonalQuery
            ? importance * 0.6 + confidence * 0.4
            : 0
        const lexicalRelevant = lexical >= minLexicalScore
          && strongLexicalOverlap
          && (!hasQueryConcepts || sharedConcept)
        const semanticRelevant = semantic >= minSemanticScore
          && (embeddingModel !== LOCAL_EMBEDDING_MODEL
            || sharedConcept
            || (!hasQueryConcepts
              && (strongLexicalOverlap || semantic >= Math.max(0.34, minSemanticScore))))
        // A user can explicitly ask for a broad account of what the agent
        // remembers without naming any one semantic field. Only this tightly
        // scoped personal-memory intent may enter on quality priors alone.
        const broadRelevant = broadPersonalQuery && !hasQueryConcepts
        const structuredRelevant = hasQueryConcepts ? structured > 0 : broadRelevant
        const relevant = lexicalRelevant || semanticRelevant || structuredRelevant || broadRelevant
        return {
          item,
          semanticScore: semantic,
          lexicalScore: lexical,
          temporalScore: temporal,
          structuredScore: structured,
          importanceScore: importance,
          confidenceScore: confidence,
          recencyScore: recency,
          frequencyScore: frequency,
          lexicalRelevant,
          semanticRelevant,
          structuredRelevant,
          broadRelevant,
          relevant,
        }
      })

    const ranked = retrievalFusion === 'weighted-linear-v1'
      ? rankWithLegacyLinear(features, minScore)
      : rankWithRrf(features, queryPlan, minScore)

    return {
      entries: selectDiverse(ranked.entries, clampInteger(candidateLimit, 1, 100)),
      changed,
      now,
      queryPlan,
      routeCandidateCounts: ranked.routeCandidateCounts,
    }
  }

  function commitRecallUsage(pool: RankedMemoryPool, selectedIds: ReadonlySet<string>): void {
    for (const entry of pool.entries) {
      if (!selectedIds.has(entry.item.id))
        continue
      entry.item.accessCount += 1
      entry.item.lastAccessedAt = pool.now
      pool.changed.set(entry.item.id, entry.item)
    }
    persistChanges(
      persistence,
      index,
      [...pool.changed.values()],
      [],
      'recall',
      onCommittedChange,
      onCommitObserverError,
    )
  }

  return {
    async inspectWriteMatches(
      content: string,
      scope: MemoryScope,
      memoryKey?: string,
    ): Promise<{ exact?: V3MemoryRecord; activeByMemoryKey: V3MemoryRecord[] }> {
      const normalizedScope = normalizeScope(scope)
      const exact = findExactMemory(secondary, normalizedScope, normalizeContent(content))
      const activeByMemoryKey = memoryKey
        ? findActiveByMemoryKey(secondary, normalizedScope, memoryKey)
        : []
      return {
        ...(exact ? { exact: cloneCommittedRecords([exact])[0] } : {}),
        activeByMemoryKey: cloneCommittedRecords(activeByMemoryKey),
      }
    },
    async list(scope: MemoryScope, limit = 100): Promise<MemoryFragment[]> {
      const normalizedScope = normalizeScope(scope)
      const expired = markExpired(index, normalizedScope, secondary)
      persistChanges(
        persistence,
        index,
        expired,
        [],
        'expiry',
        onCommittedChange,
        onCommitObserverError,
      )
      return index
        .filter(item => matchesScope(item.scope, normalizedScope))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, clampInteger(limit, 1, 1000))
        .map(item => toMemoryFragment(item))
    },

    async recall(
      query: string,
      scope: MemoryScope,
      topK = 5,
      recallOptions?: MemoryRecallOptions,
    ): Promise<MemoryFragment[]> {
      const requestedTopK = clampInteger(topK, 1, 20)
      const planned = planMemoryQuery(query, recallOptions)
      const pool = await rankMemoryCandidates(query, scope, Math.max(requestedTopK, Math.min(100, planned.candidateBudget)), recallOptions)
      const entries = pool.entries.slice(0, requestedTopK)
      const selectedIds = new Set(entries.map(entry => entry.item.id))
      commitRecallUsage(pool, selectedIds)
      return entries.map(({ item, score }) => toMemoryFragment(item, score))
    },

    async recallAdaptive(
      query: string,
      scope: MemoryScope,
      recallOptions: AdaptiveMemoryRecallOptions = {},
    ): Promise<AdaptiveMemoryRecallResult> {
      const planned = planMemoryQuery(query, recallOptions)
      const candidateLimit = recallOptions.candidateLimit === undefined
        ? planned.candidateBudget
        : clampInteger(recallOptions.candidateLimit, 1, 100)
      const pool = await rankMemoryCandidates(query, scope, candidateLimit, recallOptions)
      if (!pool.queryPlan.requiresMemory) {
        persistChanges(persistence, index, [...pool.changed.values()], [], 'recall', onCommittedChange, onCommitObserverError)
        return {
          memories: [], retrievedMemoryIds: [], injectedMemoryIds: [], candidateCount: 0,
          evaluatedCount: 0, batchesEvaluated: 0, stopReason: 'memory-not-needed',
          queryIntent: pool.queryPlan.intent,
          candidateBudget: pool.queryPlan.candidateBudget,
          retrievalRoutes: pool.queryPlan.routes,
          routeCandidateCounts: pool.routeCandidateCounts,
          queryPlanVersion: pool.queryPlan.version,
          fusionMethod: retrievalFusion === 'rrf-v1' ? MEMORY_RRF_VERSION : 'weighted-linear-v1',
        }
      }
      const selectionOptions: AdaptiveMemoryRecallOptions = {
        ...recallOptions,
        initialBatchSize: recallOptions.initialBatchSize ?? pool.queryPlan.selection.initialBatchSize,
        continuationBatchSize: recallOptions.continuationBatchSize ?? pool.queryPlan.selection.continuationBatchSize,
        maxBatches: recallOptions.maxBatches ?? pool.queryPlan.selection.maxBatches,
        maxInjected: recallOptions.maxInjected ?? pool.queryPlan.selection.maxInjected,
        maxCharacters: recallOptions.maxCharacters ?? pool.queryPlan.selection.maxCharacters,
      }
      const selection = selectAdaptiveRecall(
        query,
        pool.entries.map(entry => ({
          memory: toMemoryFragment(entry.item, entry.score),
          score: entry.score,
          semanticScore: entry.semanticScore,
          lexicalScore: entry.lexicalScore,
        })),
        selectionOptions,
      )
      const selectedIds = new Set(selection.selectedMemoryIds)
      commitRecallUsage(pool, selectedIds)
      return {
        memories: pool.entries
          .filter(entry => selectedIds.has(entry.item.id))
          .map(entry => toMemoryFragment(entry.item, entry.score)),
        retrievedMemoryIds: selection.evaluatedMemoryIds,
        injectedMemoryIds: selection.selectedMemoryIds,
        candidateCount: pool.entries.length,
        evaluatedCount: selection.evaluatedMemoryIds.length,
        batchesEvaluated: selection.batchesEvaluated,
        stopReason: selection.stopReason,
        queryIntent: pool.queryPlan.intent,
        candidateBudget: pool.queryPlan.candidateBudget,
        retrievalRoutes: pool.queryPlan.routes,
        routeCandidateCounts: pool.routeCandidateCounts,
        queryPlanVersion: pool.queryPlan.version,
        fusionMethod: retrievalFusion === 'rrf-v1' ? MEMORY_RRF_VERSION : 'weighted-linear-v1',
      }
    },

    async remember(
      content: string,
      scope: MemoryScope,
      metadata?: Record<string, unknown>,
    ): Promise<V3MemoryRecord | undefined> {
      const normalizedContent = normalizeContent(content)
      if (!normalizedContent)
        return undefined
      const normalizedScope = normalizeScope(scope)
      const now = Date.now()
      const memoryKey = optionalString(metadata?.memoryKey)
      const cardinality = metadata?.cardinality === 'single' ? 'single' : 'multiple'
      const confidence = clampNumber(metadata?.confidence, 0, 1, 0.7)
      const requestedValidFrom = optionalTimestamp(metadata?.validFrom)
      const effectiveValidFrom = requestedValidFrom ?? (memoryKey && cardinality === 'single' ? now : undefined)
      const requestedValidTo = optionalTimestamp(metadata?.validTo)
      const closedHistoricalInterval = requestedValidTo !== undefined && requestedValidTo <= now
      const sourceMessageIds = stringArray(metadata?.sourceMessageIds)
      const sourceAttachmentIds = stringArray(metadata?.sourceAttachmentIds)
      const matchedMemoryId = optionalString(metadata?.memoryMatchedId)
      const matchedRefinement = metadata?.memoryWriteAction === 'REFINE' && matchedMemoryId
        ? secondary.byId.get(matchedMemoryId)
        : undefined
      let duplicate = matchedRefinement && matchesExactScope(matchedRefinement.scope, normalizedScope)
        ? matchedRefinement
        : findExactMemory(secondary, normalizedScope, normalizedContent)
      let embedding: number[] | undefined
      if (!duplicate) {
        embedding = await embed(normalizedContent)
        duplicate = findSemanticDuplicate(
          secondary,
          normalizedScope,
          normalizedContent,
          embedding,
          memoryKey,
          metadata,
        )
      }
      const conflicts = memoryKey && cardinality === 'single' && !closedHistoricalInterval
        ? findActiveByMemoryKey(secondary, normalizedScope, memoryKey)
          .filter(item => item.status === 'active'
          && item.id !== duplicate?.id
          && normalizeContent(item.content).toLocaleLowerCase() !== normalizedContent.toLocaleLowerCase())
        : []

      let status = normalizeStatus(metadata?.status) ?? (closedHistoricalInterval ? 'superseded' : 'active')
      let supersedes: string | undefined
      const changedConflicts: IndexedMemory[] = []
      if (conflicts.length > 0) {
        const writeAction = optionalString(metadata?.memoryWriteAction)
        const replacementAuthorized = writeAction === 'SUPERSEDE'
          || (writeAction === undefined && confidence >= 0.8)
        if (replacementAuthorized) {
          supersedes = [...conflicts].sort(compareMemoryRecency)[0]?.id
          for (const conflict of conflicts) {
            removeActiveIndexes(secondary, conflict)
            conflict.status = 'superseded'
            conflict.validTo = temporalCloseBoundary(conflict, effectiveValidFrom ?? now)
            conflict.invalidatedAt = now
            conflict.updatedAt = now
            changedConflicts.push(conflict)
          }
        }
        else {
          status = 'conflicted'
        }
      }

      if (duplicate) {
        const refineContent = metadata?.memoryWriteAction === 'REFINE'
          && normalizeContent(duplicate.content).toLocaleLowerCase() !== normalizedContent.toLocaleLowerCase()
        removeActiveIndexes(secondary, duplicate)
        if (refineContent) {
          removeSetValue(secondary.exact, exactContentKey(duplicate.scope, duplicate.content), duplicate.id)
          duplicate.content = normalizedContent
          duplicate.embedding = embedding ?? await embed(normalizedContent)
          duplicate.embeddingModel = embeddingModel
          addSetValue(secondary.exact, exactContentKey(duplicate.scope, duplicate.content), duplicate.id)
        }
        duplicate.metadata = mergeMetadata(duplicate.metadata, metadata)
        duplicate.sourceMessageIds = unionStrings(duplicate.sourceMessageIds, sourceMessageIds)
        duplicate.sourceAttachmentIds = unionStrings(duplicate.sourceAttachmentIds, sourceAttachmentIds)
        duplicate.importance = clampNumber(metadata?.importance, 0, 1, duplicate.importance)
        duplicate.confidence = Math.max(duplicate.confidence, confidence)
        if (metadata?.origin !== undefined)
          duplicate.origin = normalizeOrigin(metadata.origin)
        if (metadata?.sharePolicy !== undefined)
          duplicate.sharePolicy = normalizeSharePolicy(metadata.sharePolicy)
        if (metadata?.sensitivity !== undefined)
          duplicate.sensitivity = normalizeSensitivity(metadata.sensitivity)
        if (effectiveValidFrom !== undefined)
          duplicate.validFrom = effectiveValidFrom
        if (metadata?.validTo !== undefined)
          duplicate.validTo = requestedValidTo
        if (metadata?.expiresAt !== undefined)
          duplicate.expiresAt = optionalTimestamp(metadata.expiresAt)
        duplicate.memoryKey = memoryKey ?? duplicate.memoryKey
        duplicate.status = status
        duplicate.supersedes = supersedes ?? duplicate.supersedes
        if (status === 'active') {
          if (metadata?.validTo === undefined)
            delete duplicate.validTo
          delete duplicate.invalidatedAt
        }
        duplicate.updatedAt = now
        addActiveIndexes(secondary, duplicate)
        persistChanges(
          persistence,
          index,
          [...changedConflicts, duplicate],
          [],
          'remember',
          onCommittedChange,
          onCommitObserverError,
        )
        return cloneCommittedRecords([duplicate])[0]
      }

      embedding ??= await embed(normalizedContent)
      const newItem: IndexedMemory = {
        id: crypto.randomUUID(),
        content: normalizedContent,
        metadata,
        status,
        origin: normalizeOrigin(metadata?.origin),
        importance: clampNumber(metadata?.importance, 0, 1, 0.6),
        confidence,
        accessCount: 0,
        validFrom: effectiveValidFrom,
        validTo: requestedValidTo,
        expiresAt: optionalTimestamp(metadata?.expiresAt),
        supersedes,
        memoryKey,
        sourceMessageIds,
        sourceAttachmentIds,
        sharePolicy: normalizeSharePolicy(metadata?.sharePolicy),
        sensitivity: normalizeSensitivity(metadata?.sensitivity),
        scope: normalizedScope,
        embedding,
        embeddingModel,
        createdAt: now,
        updatedAt: now,
      }
      index.push(newItem)
      addMemoryIndexes(secondary, newItem)
      const pruned = pruneScope(index, normalizedScope, maxMemories)
      for (const item of pruned)
        removeMemoryIndexes(secondary, item)
      persistChanges(
        persistence,
        index,
        [...changedConflicts, newItem],
        pruned.map(item => item.id),
        'remember',
        onCommittedChange,
        onCommitObserverError,
      )
      return cloneCommittedRecords([newItem])[0]
    },

    async forget(id: string, scope: MemoryScope): Promise<void> {
      const normalizedScope = normalizeScope(scope)
      const itemIndex = index.findIndex(item => item.id === id && matchesScope(item.scope, normalizedScope))
      if (itemIndex >= 0) {
        removeMemoryIndexes(secondary, index[itemIndex]!)
        index.splice(itemIndex, 1)
        persistChanges(
          persistence,
          index,
          [],
          [id],
          'forget',
          onCommittedChange,
          onCommitObserverError,
        )
      }
    },

    async purge(id: string, scope: MemoryScope): Promise<boolean> {
      const normalizedScope = normalizeScope(scope)
      const itemIndex = index.findIndex(item => item.id === id && matchesScope(item.scope, normalizedScope))
      if (itemIndex < 0) {
        persistence?.compact?.()
        persistence?.scrubBackups?.()
        return false
      }
      removeMemoryIndexes(secondary, index[itemIndex]!)
      index.splice(itemIndex, 1)
      persistChanges(persistence, index, [], [id], 'purge', onCommittedChange, onCommitObserverError)
      persistence?.compact?.()
      persistence?.scrubBackups?.()
      return true
    },

    async update(id: string, scope: MemoryScope, patch: MemoryUpdate): Promise<boolean> {
      const normalizedScope = normalizeScope(scope)
      const item = index.find(entry => entry.id === id && matchesScope(entry.scope, normalizedScope))
      if (!item)
        return false
      const updatedContent = patch.content === undefined ? undefined : normalizeContent(patch.content)
      if (patch.content !== undefined && !updatedContent)
        return false
      const updatedEmbedding = updatedContent !== undefined && updatedContent !== item.content
        ? await embed(updatedContent)
        : undefined
      const now = Date.now()
      removeActiveIndexes(secondary, item)
      if (updatedContent !== undefined && updatedEmbedding) {
        item.content = updatedContent
        item.embedding = updatedEmbedding
        item.embeddingModel = embeddingModel
      }
      if (patch.importance !== undefined)
        item.importance = clampNumber(patch.importance, 0, 1, item.importance)
      if (patch.expiresAt === null)
        delete item.expiresAt
      else if (patch.expiresAt !== undefined)
        item.expiresAt = optionalTimestamp(patch.expiresAt)
      if (patch.sharePolicy)
        item.sharePolicy = normalizeSharePolicy(patch.sharePolicy)
      if (patch.sensitivity)
        item.sensitivity = normalizeSensitivity(patch.sensitivity)
      if (patch.status && isMemoryStatus(patch.status)) {
        item.status = patch.status
        if (patch.status === 'active') {
          delete item.validTo
          delete item.invalidatedAt
        }
        else if (patch.status === 'superseded') {
          item.validTo = temporalCloseBoundary(item, now)
          item.invalidatedAt = now
        }
        else if (patch.status === 'suppressed' || patch.status === 'deleted') {
          item.invalidatedAt = now
        }
      }
      item.updatedAt = now
      addActiveIndexes(secondary, item)
      persistChanges(
        persistence,
        index,
        [item],
        [],
        'update',
        onCommittedChange,
        onCommitObserverError,
      )
      return true
    },

    async restore(id: string, scope: MemoryScope): Promise<boolean> {
      const normalizedScope = normalizeScope(scope)
      const item = index.find(entry => entry.id === id && matchesScope(entry.scope, normalizedScope))
      if (!item)
        return false
      const now = Date.now()
      const changedConflicts: IndexedMemory[] = []
      removeActiveIndexes(secondary, item)
      if (item.expiresAt && item.expiresAt <= now)
        delete item.expiresAt
      if (item.memoryKey && item.metadata?.cardinality === 'single') {
        const conflicts = findActiveByMemoryKey(secondary, item.scope, item.memoryKey)
          .filter(entry => entry.id !== item.id && entry.status === 'active')
        item.supersedes = [...conflicts].sort(compareMemoryRecency)[0]?.id ?? item.supersedes
        for (const conflict of conflicts) {
          removeActiveIndexes(secondary, conflict)
          conflict.status = 'superseded'
          conflict.validTo = temporalCloseBoundary(conflict, now)
          conflict.invalidatedAt = now
          conflict.updatedAt = now
          changedConflicts.push(conflict)
        }
      }
      item.status = 'active'
      delete item.validTo
      delete item.invalidatedAt
      item.updatedAt = now
      addActiveIndexes(secondary, item)
      persistChanges(
        persistence,
        index,
        [...changedConflicts, item],
        [],
        'restore',
        onCommittedChange,
        onCommitObserverError,
      )
      return true
    },

    async unlinkSources(messageIds: string[], scope: MemoryScope) {
      const normalizedScope = normalizeScope(scope)
      const removed = new Set(messageIds.filter(Boolean))
      let updated = 0
      let orphaned = 0
      const changedItems: IndexedMemory[] = []
      if (removed.size === 0)
        return { updated, orphaned }
      for (const item of index) {
        if (!matchesScope(item.scope, normalizedScope))
          continue
        const before = item.sourceMessageIds.length
        if (before === 0)
          continue
        item.sourceMessageIds = item.sourceMessageIds.filter(id => !removed.has(id))
        if (item.sourceMessageIds.length === before)
          continue
        removeActiveIndexes(secondary, item)
        updated += 1
        item.updatedAt = Date.now()
        if (item.origin !== 'manual' && item.sourceMessageIds.length === 0 && item.status === 'active') {
          item.status = 'orphaned'
          orphaned += 1
        }
        addActiveIndexes(secondary, item)
        changedItems.push(item)
      }
      persistChanges(
        persistence,
        index,
        changedItems,
        [],
        'unlink-sources',
        onCommittedChange,
        onCommitObserverError,
      )
      return { updated, orphaned }
    },

    async clear(scope: MemoryScope): Promise<void> {
      const normalizedScope = normalizeScope(scope)
      const deletedIds: string[] = []
      for (let i = index.length - 1; i >= 0; i--) {
        if (matchesScope(index[i]!.scope, normalizedScope)) {
          deletedIds.push(index[i]!.id)
          removeMemoryIndexes(secondary, index[i]!)
          index.splice(i, 1)
        }
      }
      persistChanges(
        persistence,
        index,
        [],
        deletedIds,
        'clear',
        onCommittedChange,
        onCommitObserverError,
      )
    },

    async count(scope: MemoryScope): Promise<number> {
      const normalizedScope = normalizeScope(scope)
      return index.filter(item => matchesScope(item.scope, normalizedScope)).length
    },
  }
}

export function createFilePersistence(storagePath?: string): MemoryPersistence | undefined {
  if (!storagePath)
    return undefined
  return {
    storagePath,
    load: () => existsSync(storagePath) ? readFileSync(storagePath, 'utf-8') : undefined,
    save(payload) {
      mkdirSync(dirname(storagePath), { recursive: true })
      const temporaryPath = `${storagePath}.${process.pid}.tmp`
      try {
        writeFileSync(temporaryPath, payload, 'utf-8')
        replaceFileWithRetry(temporaryPath, storagePath)
      }
      catch (error) {
        rmSync(temporaryPath, { force: true })
        throw error
      }
    },
  }
}

function replaceFileWithRetry(temporaryPath: string, targetPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporaryPath, targetPath)
      return
    }
    catch (error) {
      if (attempt >= 5 || !isTransientWindowsFileError(error))
        throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 2 ** attempt)
    }
  }
}

function isTransientWindowsFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function toMemoryFragment(item: IndexedMemory, score?: number): MemoryFragment {
  return {
    id: item.id,
    content: item.content,
    metadata: item.metadata,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: item.status,
    origin: item.origin,
    importance: item.importance,
    confidence: item.confidence,
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
    validFrom: item.validFrom,
    validTo: item.validTo,
    invalidatedAt: item.invalidatedAt,
    expiresAt: item.expiresAt,
    supersedes: item.supersedes,
    memoryKey: item.memoryKey,
    sourceMessageIds: [...item.sourceMessageIds],
    sourceAttachmentIds: [...item.sourceAttachmentIds],
    sharePolicy: item.sharePolicy,
    sensitivity: item.sensitivity,
    ...(score === undefined ? {} : { score }),
  }
}

function rankWithLegacyLinear(
  features: readonly MemoryCandidateFeatures[],
  minScore: number,
): { entries: RankedMemoryEntry[]; routeCandidateCounts: Record<string, number> } {
  const entries = features
    .filter(entry => entry.relevant)
    .map((entry) => {
      const score = clampScore(
        entry.semanticScore * 0.4
        + entry.lexicalScore * 0.2
        + entry.importanceScore * 0.14
        + entry.recencyScore * 0.08
        + entry.frequencyScore * 0.04
        + entry.temporalScore * 0.14,
      )
      const retrievalRoutes = featureRoutes(entry)
      return {
        item: entry.item,
        score,
        semanticScore: entry.semanticScore,
        lexicalScore: entry.lexicalScore,
        temporalScore: entry.temporalScore,
        retrievalRoutes,
        routeRanks: { 'weighted-linear': 1 },
      }
    })
    .filter(entry => entry.score >= minScore)
    .sort((left, right) => right.score - left.score
      || left.item.content.localeCompare(right.item.content)
      || left.item.id.localeCompare(right.item.id))
  return { entries, routeCandidateCounts: { 'weighted-linear': entries.length } }
}

function rankWithRrf(
  features: readonly MemoryCandidateFeatures[],
  plan: MemoryQueryPlan,
  minScore: number,
): { entries: RankedMemoryEntry[]; routeCandidateCounts: Record<string, number> } {
  const relevant = features.filter(entry => entry.relevant)
  const routeEntries = plan.routes.map((route) => {
    const items = relevant
      .filter(entry => routeIncludes(route, entry))
      .sort((left, right) => routeScore(route, right, plan) - routeScore(route, left, plan)
        || (route === 'temporal' ? memoryStart(right.item) - memoryStart(left.item) : 0)
        || left.item.content.localeCompare(right.item.content)
        || left.item.id.localeCompare(right.item.id))
      .slice(0, plan.rankWindowSize)
      .map(entry => ({ id: entry.item.id, item: entry }))
    return { name: route, items }
  }).filter(route => route.items.length > 0)
  const routeCandidateCounts = Object.fromEntries(routeEntries.map(route => [route.name, route.items.length]))
  const activeRouteCount = Math.max(1, routeEntries.length)
  const entries = reciprocalRankFusion(routeEntries, { rankConstant: 60, windowSize: plan.rankWindowSize })
    .map((entry): RankedMemoryEntry => {
      const feature = entry.item
      const agreement = entry.routes.length / activeRouteCount
      const quality = feature.importanceScore * 0.45 + feature.confidenceScore * 0.55
      const score = clampScore(
        entry.normalizedScore * 0.78
        + agreement * 0.09
        + quality * 0.06
        + feature.temporalScore * 0.05
        + Math.round(feature.recencyScore * 100) / 100 * 0.02,
      )
      return {
        item: feature.item,
        score,
        semanticScore: feature.semanticScore,
        lexicalScore: feature.lexicalScore,
        temporalScore: feature.temporalScore,
        retrievalRoutes: entry.routes as MemoryRetrievalRoute[],
        routeRanks: entry.routeRanks,
      }
    })
    .filter(entry => entry.score >= minScore)
    .sort((left, right) => right.score - left.score
      || right.retrievalRoutes.length - left.retrievalRoutes.length
      || left.item.content.localeCompare(right.item.content)
      || left.item.id.localeCompare(right.item.id))
  return { entries, routeCandidateCounts }
}

function featureRoutes(entry: MemoryCandidateFeatures): MemoryRetrievalRoute[] {
  return [
    ...(entry.lexicalRelevant ? ['lexical' as const] : []),
    ...(entry.semanticRelevant ? ['semantic' as const] : []),
    ...(entry.structuredRelevant ? ['structured' as const] : []),
  ]
}

function routeIncludes(route: MemoryRetrievalRoute, entry: MemoryCandidateFeatures): boolean {
  switch (route) {
    case 'lexical': return entry.lexicalRelevant
    case 'semantic': return entry.semanticRelevant
    case 'structured': return entry.structuredRelevant
    case 'temporal': return entry.relevant && entry.temporalScore > 0
  }
}

function routeScore(route: MemoryRetrievalRoute, entry: MemoryCandidateFeatures, plan: MemoryQueryPlan): number {
  switch (route) {
    case 'lexical': return entry.lexicalScore
    case 'semantic': return entry.semanticScore
    case 'structured': return entry.structuredScore
    case 'temporal': {
      if (plan.asOf !== undefined) {
        const start = entry.item.validFrom ?? entry.item.createdAt
        const distanceDays = Math.abs(plan.asOf - start) / 86_400_000
        return entry.temporalScore * 0.7 + (1 / (1 + distanceDays / 365)) * 0.3
      }
      return entry.temporalScore
    }
  }
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let size = 0
  for (const value of left) {
    if (right.has(value))
      size += 1
  }
  return size
}

function weightedConceptCoverage(query: ReadonlySet<string>, item: ReadonlySet<string>): number {
  let matched = 0
  let total = 0
  for (const concept of query) {
    // Generic preference intent is useful as a fallback, but must not outrank
    // an exact field such as allergy, exercise or work time in multi-fact queries.
    const weight = concept === 'preference.any' ? 0.2 : 1
    total += weight
    if (item.has(concept))
      matched += weight
  }
  return total > 0 ? matched / total : 0
}

function selectDiverse<T extends { item: IndexedMemory; score: number }>(scored: T[], topK: number): T[] {
  const selected: T[] = []
  for (const entry of scored) {
    if (selected.some(current => jaccard(tokenize(entry.item.content), tokenize(current.item.content)) > 0.9))
      continue
    selected.push(entry)
    if (selected.length >= topK)
      break
  }
  return selected
}

function bm25Scores(query: string, documents: string[]): number[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0)
    return documents.map(() => 0)
  const tokenized = documents.map(tokenize)
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, tokenized.length)
  const documentFrequency = new Map<string, number>()
  for (const tokens of tokenized) {
    for (const token of new Set(tokens))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  const k1 = 1.2
  const b = 0.75
  return tokenized.map((tokens) => {
    const frequency = new Map<string, number>()
    for (const token of tokens)
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const tf = frequency.get(token) ?? 0
      if (tf === 0)
        continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * tokens.length / Math.max(1, averageLength))))
    }
    return clampScore(1 - Math.exp(-score))
  })
}

function tokenize(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens = normalized.match(/[a-z0-9]+/g)?.map(token => `w:${token}`) ?? []
  const han = normalized.match(/[\u3400-\u9fff]/g) ?? []
  for (let index = 0; index < han.length; index++) {
    tokens.push(`c:${han[index]}`)
    if (index + 1 < han.length)
      tokens.push(`b:${han[index]}${han[index + 1]}`)
  }
  return tokens
}

function strongLexicalTokens(value: string): Set<string> {
  return new Set(tokenize(value).filter(token => token.startsWith('b:') || token.startsWith('w:')))
}

function hasStrongLexicalOverlap(firstTokens: ReadonlySet<string>, second: string): boolean {
  return tokenize(second).some(token => firstTokens.has(token))
}

function createSecondaryIndexes(items: IndexedMemory[]): SecondaryIndexes {
  const secondary: SecondaryIndexes = {
    byId: new Map(),
    exact: new Map(),
    activeByMemoryKey: new Map(),
    activeByToken: new Map(),
  }
  for (const item of items)
    addMemoryIndexes(secondary, item)
  return secondary
}

function addMemoryIndexes(secondary: SecondaryIndexes, item: IndexedMemory): void {
  secondary.byId.set(item.id, item)
  addSetValue(secondary.exact, exactContentKey(item.scope, item.content), item.id)
  addActiveIndexes(secondary, item)
}

function removeMemoryIndexes(secondary: SecondaryIndexes, item: IndexedMemory): void {
  removeActiveIndexes(secondary, item)
  removeSetValue(secondary.exact, exactContentKey(item.scope, item.content), item.id)
  secondary.byId.delete(item.id)
}

function addActiveIndexes(secondary: SecondaryIndexes, item: IndexedMemory): void {
  if (item.status !== 'active')
    return
  if (item.memoryKey)
    addSetValue(secondary.activeByMemoryKey, memoryKeyIndexKey(item.scope, item.memoryKey), item.id)
  const kind = optionalString(item.metadata?.kind)
  for (const token of new Set(tokenize(item.content))) {
    addSetValue(secondary.activeByToken, tokenIndexKey(item.scope, token), item.id)
    if (kind)
      addSetValue(secondary.activeByToken, tokenIndexKey(item.scope, token, kind), item.id)
  }
}

function removeActiveIndexes(secondary: SecondaryIndexes, item: IndexedMemory): void {
  if (item.memoryKey)
    removeSetValue(secondary.activeByMemoryKey, memoryKeyIndexKey(item.scope, item.memoryKey), item.id)
  const kind = optionalString(item.metadata?.kind)
  for (const token of new Set(tokenize(item.content))) {
    removeSetValue(secondary.activeByToken, tokenIndexKey(item.scope, token), item.id)
    if (kind)
      removeSetValue(secondary.activeByToken, tokenIndexKey(item.scope, token, kind), item.id)
  }
}

function findExactMemory(
  secondary: SecondaryIndexes,
  scope: IndexedMemory['scope'],
  content: string,
): IndexedMemory | undefined {
  const ids = secondary.exact.get(exactContentKey(scope, content))
  if (!ids)
    return undefined
  for (const id of ids) {
    const item = secondary.byId.get(id)
    if (item)
      return item
  }
  return undefined
}

function findActiveByMemoryKey(
  secondary: SecondaryIndexes,
  scope: IndexedMemory['scope'],
  memoryKey: string,
): IndexedMemory[] {
  const ids = secondary.activeByMemoryKey.get(memoryKeyIndexKey(scope, memoryKey))
  if (!ids)
    return []
  return [...ids].map(id => secondary.byId.get(id)).filter((item): item is IndexedMemory => !!item)
}

function findSemanticDuplicate(
  secondary: SecondaryIndexes,
  scope: IndexedMemory['scope'],
  content: string,
  embedding: number[],
  memoryKey: string | undefined,
  metadata: Record<string, unknown> | undefined,
): IndexedMemory | undefined {
  const candidateIds = new Set<string>()
  if (memoryKey) {
    for (const item of findActiveByMemoryKey(secondary, scope, memoryKey))
      candidateIds.add(item.id)
  }
  else {
    const kind = optionalString(metadata?.kind)
    const postings = [...new Set(tokenize(content))]
      .map(token => secondary.activeByToken.get(tokenIndexKey(scope, token, kind)))
      .filter((ids): ids is Set<string> => !!ids)
      .sort((first, second) => first.size - second.size)
      .slice(0, 3)
    for (const ids of postings) {
      for (const id of ids)
        candidateIds.add(id)
    }
  }
  for (const id of candidateIds) {
    const item = secondary.byId.get(id)
    if (item?.status === 'active'
      && matchesExactScope(item.scope, scope)
      && isSemanticDuplicate(item, content, embedding, memoryKey, metadata))
      return item
  }
  return undefined
}

function exactContentKey(scope: IndexedMemory['scope'], content: string): string {
  return `${scopeIndexKey(scope)}\u0000${normalizeContent(content).toLocaleLowerCase()}`
}

function memoryKeyIndexKey(scope: IndexedMemory['scope'], memoryKey: string): string {
  return `${scopeIndexKey(scope)}\u0000${memoryKey}`
}

function tokenIndexKey(scope: IndexedMemory['scope'], token: string, kind?: string): string {
  return `${scopeIndexKey(scope)}\u0000${kind ?? '*'}\u0000${token}`
}

function scopeIndexKey(scope: IndexedMemory['scope']): string {
  return JSON.stringify([scope.ownerId, scope.agentId, scope.sessionId ?? ''])
}

function addSetValue(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>()
  values.add(value)
  index.set(key, values)
}

function removeSetValue(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key)
  if (!values)
    return
  values.delete(value)
  if (values.size === 0)
    index.delete(key)
}

function jaccard(a: string[], b: string[]): number {
  const first = new Set(a)
  const second = new Set(b)
  if (first.size === 0 && second.size === 0)
    return 1
  let intersection = 0
  for (const item of first) {
    if (second.has(item))
      intersection += 1
  }
  return intersection / Math.max(1, first.size + second.size - intersection)
}

function isRecallAllowed(item: IndexedMemory, options?: MemoryRecallOptions): boolean {
  if (options?.sharePolicies && !options.sharePolicies.includes(item.sharePolicy))
    return false
  if (options?.sensitivities && !options.sensitivities.includes(item.sensitivity))
    return false
  return true
}

function isTemporalCandidate(
  item: IndexedMemory,
  mode: MemoryTemporalMode,
  asOf: number | undefined,
  now: number,
): boolean {
  if (item.status !== 'active' && item.status !== 'superseded')
    return false
  const referenceTime = asOf ?? now
  if (mode === 'current')
    return item.status === 'active' && isValidAt(item, referenceTime)
  if (asOf !== undefined)
    return isValidAt(item, referenceTime)
  return true
}

function isValidAt(item: IndexedMemory, timestamp: number): boolean {
  return (!item.validFrom || item.validFrom <= timestamp)
    && (!item.validTo || timestamp < item.validTo)
}

function temporalAlignment(item: IndexedMemory, mode: MemoryTemporalMode): number {
  if (mode === 'historical')
    return item.status === 'superseded' ? 1 : 0.2
  if (mode === 'current')
    return item.status === 'active' ? 1 : 0
  return 0.7
}

function isSemanticDuplicate(
  item: IndexedMemory,
  content: string,
  embedding: number[],
  memoryKey: string | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const incomingKind = optionalString(metadata?.kind)
  const existingKind = optionalString(item.metadata?.kind)
  if (incomingKind && existingKind && incomingKind !== existingKind)
    return false

  const semantic = clampScore(cosineSimilarity(embedding, item.embedding))
  const lexical = jaccard(tokenize(content), tokenize(item.content))
  const sameKey = !!memoryKey && item.memoryKey === memoryKey
  const valueLexical = jaccard(tokenize(factValue(content)), tokenize(factValue(item.content)))
  const samePolarity = factPolarity(content) === factPolarity(item.content)
  return sameKey
    ? semantic >= 0.95 && valueLexical >= 0.6
    : samePolarity && ((semantic >= 0.94 && lexical >= 0.2) || valueLexical >= 0.5)
}

function factValue(content: string): string {
  const separatorIndex = Math.max(content.lastIndexOf('：'), content.lastIndexOf(':'))
  if (separatorIndex >= 0)
    return content.slice(separatorIndex + 1).trim()
  const predicateValue = /(?:不喜欢|讨厌|喜欢|偏爱|偏好|姓名|名字|所在地|职业)\s*(.+)$/u.exec(content)?.[1]?.trim()
  return predicateValue || content
}

function factPolarity(content: string): -1 | 0 | 1 {
  if (/(?:不喜欢|讨厌|\bdislike\b|\bhate\b)/iu.test(content))
    return -1
  if (/(?:喜欢|偏爱|偏好|\bprefer\b|\blike\b)/iu.test(content))
    return 1
  return 0
}

function recencyScore(item: IndexedMemory, now: number): number {
  const kind = optionalString(item.metadata?.kind)
  const halfLifeDays = kind === 'identity' ? 730 : kind === 'project' ? 120 : kind === 'explicit' ? 365 : 240
  const ageDays = Math.max(0, now - item.updatedAt) / 86_400_000
  return Math.pow(0.5, ageDays / halfLifeDays)
}

function compareMemoryRecency(first: IndexedMemory, second: IndexedMemory): number {
  return memoryStart(second) - memoryStart(first)
    || second.createdAt - first.createdAt
    || second.updatedAt - first.updatedAt
}

function memoryStart(item: IndexedMemory): number {
  return item.validFrom ?? item.createdAt
}

function temporalCloseBoundary(item: IndexedMemory, requestedBoundary: number): number {
  return Math.max(requestedBoundary, memoryStart(item) + 1)
}

function markExpired(
  index: IndexedMemory[],
  scope: IndexedMemory['scope'],
  secondary: SecondaryIndexes,
): IndexedMemory[] {
  const now = Date.now()
  const changed: IndexedMemory[] = []
  for (const item of index) {
    if (matchesScope(item.scope, scope) && item.status === 'active' && item.expiresAt && item.expiresAt <= now) {
      removeActiveIndexes(secondary, item)
      item.status = 'expired'
      item.updatedAt = now
      changed.push(item)
    }
  }
  return changed
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0)
    return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!
    normA += a[index]! * a[index]!
    normB += b[index]! * b[index]!
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

function normalizeScope(scope: MemoryScope): IndexedMemory['scope'] {
  const ownerId = scope.ownerId.trim()
  if (!ownerId)
    throw new Error('Memory scope ownerId is required')
  const result: IndexedMemory['scope'] = { ownerId, agentId: scope.agentId?.trim() || 'default' }
  if (scope.sessionId?.trim())
    result.sessionId = scope.sessionId.trim()
  return result
}

function matchesScope(item: IndexedMemory['scope'], query: IndexedMemory['scope']): boolean {
  return item.ownerId === query.ownerId
    && item.agentId === query.agentId
    && (!query.sessionId || item.sessionId === query.sessionId)
}

function matchesExactScope(item: IndexedMemory['scope'], query: IndexedMemory['scope']): boolean {
  return item.ownerId === query.ownerId
    && item.agentId === query.agentId
    && item.sessionId === query.sessionId
}

function normalizeContent(content: string): string {
  return content.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
}

function mergeMetadata(
  current?: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!current && !incoming)
    return undefined
  const merged = { ...current, ...incoming }
  if (current?.sourceMessageIds || incoming?.sourceMessageIds)
    merged.sourceMessageIds = unionStrings(stringArray(current?.sourceMessageIds), stringArray(incoming?.sourceMessageIds))
  if (current?.sourceAttachmentIds || incoming?.sourceAttachmentIds)
    merged.sourceAttachmentIds = unionStrings(stringArray(current?.sourceAttachmentIds), stringArray(incoming?.sourceAttachmentIds))
  return merged
}

function pruneScope(index: IndexedMemory[], scope: IndexedMemory['scope'], maxMemories: number): IndexedMemory[] {
  const insertionOrder = new Map(index.map((item, position) => [item.id, position]))
  const scoped = index.filter(item => matchesExactScope(item.scope, scope)).sort((a, b) =>
    b.updatedAt - a.updatedAt
    || b.createdAt - a.createdAt
    || (insertionOrder.get(b.id) ?? 0) - (insertionOrder.get(a.id) ?? 0))
  const inactive = scoped.filter(item => item.status !== 'active')
  const active = scoped.filter(item => item.status === 'active')
  // Keep active memories first. When the scope is full, old inactive records
  // are pruned before active records; each group is already newest-first.
  const ordered = [...active, ...inactive]
  const excess = ordered.slice(Math.max(1, maxMemories))
  if (excess.length === 0)
    return []
  const excessIds = new Set(excess.map(item => item.id))
  for (let indexPosition = index.length - 1; indexPosition >= 0; indexPosition--) {
    if (excessIds.has(index[indexPosition]!.id))
      index.splice(indexPosition, 1)
  }
  return excess
}

function loadIndex(persistence?: MemoryPersistence): LoadResult {
  if (!persistence)
    return { exists: false, migrated: false, items: [] }
  const payload = persistence.load()
  if (payload === undefined)
    return { exists: false, migrated: false, items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse long-term memory index: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Long-term memory index is not an object')
  const record = parsed as { version?: unknown; items?: unknown }
  if (!Array.isArray(record.items))
    throw new Error('Long-term memory index has no items array')
  if (record.version === 3) {
    const invalidIndex = record.items.findIndex(item => !isIndexedMemory(item))
    if (invalidIndex >= 0)
      throw new Error(`Long-term memory index contains an invalid version 3 item at position ${invalidIndex}`)
    return { exists: true, migrated: false, items: record.items as IndexedMemory[] }
  }
  if (record.version === 2) {
    const invalidIndex = record.items.findIndex(item => !isIndexedMemory(item))
    if (invalidIndex >= 0)
      throw new Error(`Long-term memory index contains an invalid version 2 item at position ${invalidIndex}`)
    return { exists: true, migrated: true, items: migrateTemporalItems(record.items as IndexedMemory[]) }
  }
  if (record.version === 1) {
    const items = record.items.map((item, itemIndex) => {
      const migrated = migrateLegacyItem(item)
      if (!migrated)
        throw new Error(`Long-term memory index contains an invalid version 1 item at position ${itemIndex}`)
      return migrated
    })
    return { exists: true, migrated: true, items: migrateTemporalItems(items) }
  }
  throw new Error(`Unsupported long-term memory version: ${String(record.version)}`)
}

function persistIndex(persistence: MemoryPersistence | undefined, index: IndexedMemory[]): void {
  if (!persistence)
    return
  const payload: PersistedIndexV3 = { version: 3, items: index }
  persistence.save(JSON.stringify(payload))
}

function persistChanges(
  persistence: MemoryPersistence | undefined,
  index: IndexedMemory[],
  upserts: IndexedMemory[],
  deletes: string[] = [],
  reason?: V3MemoryCommitReason,
  onCommittedChange?: (commit: V3MemoryCommit) => void,
  onCommitObserverError?: (error: unknown, commit: V3MemoryCommit) => void,
): void {
  if (upserts.length === 0 && deletes.length === 0)
    return
  const deleteIds = new Set(deletes)
  const uniqueUpserts = new Map<string, IndexedMemory>()
  for (const item of upserts) {
    if (!deleteIds.has(item.id))
      uniqueUpserts.set(item.id, item)
  }
  if (persistence) {
    if (!persistence.appendDelta)
      persistIndex(persistence, index)
    else {
      persistence.appendDelta({
        indexVersion: 3,
        upserts: [...uniqueUpserts.values()],
        deletes: [...deleteIds],
      })
    }
  }
  if (!reason || !onCommittedChange)
    return
  const commit: V3MemoryCommit = {
    reason,
    upserts: cloneCommittedRecords([...uniqueUpserts.values()]),
    deletedIds: [...deleteIds],
    committedAt: Date.now(),
  }
  try {
    onCommittedChange(commit)
  }
  catch (error) {
    try {
      onCommitObserverError?.(error, commit)
    }
    catch {
      // A diagnostic hook is part of the shadow path and must not escape either.
    }
  }
}

function cloneCommittedRecords(items: IndexedMemory[]): V3MemoryRecord[] {
  return JSON.parse(JSON.stringify(items)) as V3MemoryRecord[]
}

function migrateLegacyItem(value: unknown): IndexedMemory | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const item = value as Record<string, unknown>
  const scope = item.scope as Record<string, unknown> | undefined
  if (typeof item.id !== 'string' || typeof item.content !== 'string' || !scope
    || typeof scope.ownerId !== 'string' || typeof scope.agentId !== 'string')
    return undefined
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : undefined
  const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now()
  return {
    id: item.id,
    content: item.content,
    metadata,
    status: 'active',
    origin: normalizeOrigin(metadata?.origin),
    importance: clampNumber(metadata?.importance, 0, 1, 0.6),
    confidence: clampNumber(metadata?.confidence, 0, 1, 0.7),
    accessCount: 0,
    validFrom: optionalTimestamp(metadata?.validFrom),
    validTo: optionalTimestamp(metadata?.validTo),
    memoryKey: optionalString(metadata?.memoryKey),
    sourceMessageIds: stringArray(metadata?.sourceMessageIds),
    sourceAttachmentIds: stringArray(metadata?.sourceAttachmentIds),
    sharePolicy: normalizeSharePolicy(metadata?.sharePolicy),
    sensitivity: normalizeSensitivity(metadata?.sensitivity),
    scope: {
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      ...(typeof scope.sessionId === 'string' ? { sessionId: scope.sessionId } : {}),
    },
    embedding: Array.isArray(item.embedding) ? item.embedding.filter(entry => typeof entry === 'number') as number[] : [],
    embeddingModel: typeof item.embeddingModel === 'string' ? item.embeddingModel : '',
    createdAt,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : createdAt,
  }
}

function migrateTemporalItems(source: IndexedMemory[]): IndexedMemory[] {
  const items = source.map(item => ({ ...item }))
  const groups = new Map<string, IndexedMemory[]>()
  for (const item of items) {
    if (!item.memoryKey || item.metadata?.cardinality !== 'single')
      continue
    item.validFrom ??= item.createdAt
    const key = JSON.stringify([item.scope.ownerId, item.scope.agentId, item.scope.sessionId ?? '', item.memoryKey])
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((first, second) => memoryStart(first) - memoryStart(second) || first.createdAt - second.createdAt)
    for (let position = 0; position < group.length; position++) {
      const item = group[position]!
      if (item.status !== 'superseded')
        continue
      const next = group[position + 1]
      item.validTo ??= temporalCloseBoundary(item, next ? memoryStart(next) : item.updatedAt)
      item.invalidatedAt ??= item.updatedAt
    }
  }
  return items
}

function isIndexedMemory(value: unknown): value is IndexedMemory {
  if (!value || typeof value !== 'object')
    return false
  const item = value as Partial<IndexedMemory>
  return typeof item.id === 'string'
    && typeof item.content === 'string'
    && isMemoryStatus(item.status)
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number'
    && typeof item.embeddingModel === 'string'
    && Array.isArray(item.embedding)
    && Array.isArray(item.sourceMessageIds)
    && Array.isArray(item.sourceAttachmentIds)
    && !!item.scope
    && typeof item.scope.ownerId === 'string'
    && typeof item.scope.agentId === 'string'
}

function normalizeStatus(value: unknown): MemoryStatus | undefined {
  return isMemoryStatus(value) ? value : undefined
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return value === 'active' || value === 'superseded' || value === 'expired' || value === 'conflicted'
    || value === 'orphaned' || value === 'suppressed' || value === 'deleted'
}

function normalizeOrigin(value: unknown): MemoryOrigin {
  return value === 'manual' || value === 'image' ? value : 'automatic'
}

function normalizeSharePolicy(value: unknown): MemorySharePolicy {
  return value === 'local-only' || value === 'ask' ? value : 'allow-remote'
}

function normalizeSensitivity(value: unknown): MemorySensitivity {
  return value === 'private' || value === 'secret' ? value : 'normal'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
}

function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => String(item).trim()))]
    : []
}

function unionStrings(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])]
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return fallback
  return Math.max(minimum, Math.min(maximum, value))
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function requireApiKey(apiKey?: string): string {
  if (!apiKey)
    throw new Error('apiKey is required for remote embeddings')
  return apiKey
}

export type VectorStore = ReturnType<typeof createVectorStore>
