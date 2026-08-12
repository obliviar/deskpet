import type {
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import OpenAI from 'openai'
import {
  createLocalEmbedding,
  localSemanticConcepts,
  LOCAL_EMBEDDING_MODEL,
  sharesLocalSemanticConcept,
} from './local-embedding'
import { planTemporalQuery } from './temporal-query'

export interface MemoryPersistence {
  load: () => string | undefined
  save: (payload: string) => void
  /** Append changed records without serializing and rewriting the complete index. */
  appendDelta?: (delta: MemoryPersistenceDelta) => void
  /** Preserve the current physical payload before an automatic schema upgrade. */
  backupBeforeMigration?: () => void
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
}

type MemoryCardinality = 'single' | 'multiple'

interface IndexedMemory extends MemoryFragment {
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

export function createVectorStore(options: VectorStoreOptions = {}) {
  const {
    apiKey,
    baseURL,
    embeddingModel = LOCAL_EMBEDDING_MODEL,
    storagePath,
    minScore = embeddingModel === LOCAL_EMBEDDING_MODEL ? 0.12 : 0.3,
    minSemanticScore = embeddingModel === LOCAL_EMBEDDING_MODEL ? 0.2 : 0.32,
    minLexicalScore = 0.08,
    maxMemories = 20_000,
    embedder,
  } = options

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

  return {
    async list(scope: MemoryScope, limit = 100): Promise<MemoryFragment[]> {
      const normalizedScope = normalizeScope(scope)
      const expired = markExpired(index, normalizedScope, secondary)
      persistChanges(persistence, index, expired)
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
      const normalizedScope = normalizeScope(scope)
      const changed = new Map(markExpired(index, normalizedScope, secondary).map(item => [item.id, item]))
      const now = Date.now()
      const temporalPlan = planTemporalQuery(query, recallOptions)
      const candidates = index.filter(item => matchesScope(item.scope, normalizedScope)
        && isTemporalCandidate(item, temporalPlan.mode, temporalPlan.asOf, now)
        && isRecallAllowed(item, recallOptions))
      if (candidates.length === 0 || !query.trim()) {
        persistChanges(persistence, index, [...changed.values()])
        return []
      }

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
      const queryStrongTokens = strongLexicalTokens(query)
      const lexicalScores = bm25Scores(query, candidates.map(item => item.content))
      const scored = candidates
        .map((item, itemIndex) => {
          const semantic = clampScore(cosineSimilarity(queryEmbedding, item.embedding))
          const lexical = lexicalScores[itemIndex] ?? 0
          const importance = clampScore(item.importance)
          const recency = recencyScore(item, now)
          const frequency = Math.min(1, Math.log1p(item.accessCount) / Math.log(21))
          const temporal = temporalAlignment(item, temporalPlan.mode)
          const score = clampScore(
            semantic * 0.4
            + lexical * 0.2
            + importance * 0.14
            + recency * 0.08
            + frequency * 0.04
            + temporal * 0.14,
          )
          const strongLexicalOverlap = hasStrongLexicalOverlap(queryStrongTokens, item.content)
          const sharedConcept = hasQueryConcepts
            ? sharesLocalSemanticConcept(item.content, queryConcepts!)
            : false
          const lexicalRelevant = lexical >= minLexicalScore
            && strongLexicalOverlap
            && (!hasQueryConcepts || sharedConcept)
          const semanticRelevant = semantic >= minSemanticScore
            && (embeddingModel !== LOCAL_EMBEDDING_MODEL
              || sharedConcept
              || (!hasQueryConcepts
                && (strongLexicalOverlap || semantic >= Math.max(0.34, minSemanticScore))))
          const relevant = lexicalRelevant || semanticRelevant
          return { item, score, relevant }
        })
        .filter(entry => entry.relevant && entry.score >= minScore)
        .sort((a, b) => b.score - a.score)

      const selected = selectDiverse(scored, clampInteger(topK, 1, 20))
      for (const { item } of selected) {
        item.accessCount += 1
        item.lastAccessedAt = now
        changed.set(item.id, item)
      }
      persistChanges(persistence, index, [...changed.values()])

      return selected.map(({ item, score }) => toMemoryFragment(item, score))
    },

    async remember(content: string, scope: MemoryScope, metadata?: Record<string, unknown>): Promise<void> {
      const normalizedContent = normalizeContent(content)
      if (!normalizedContent)
        return
      const normalizedScope = normalizeScope(scope)
      const now = Date.now()
      const memoryKey = optionalString(metadata?.memoryKey)
      const cardinality = metadata?.cardinality === 'single' ? 'single' : 'multiple'
      const confidence = clampNumber(metadata?.confidence, 0, 1, 0.7)
      const requestedValidFrom = optionalTimestamp(metadata?.validFrom)
      const effectiveValidFrom = requestedValidFrom ?? (memoryKey && cardinality === 'single' ? now : undefined)
      const requestedValidTo = optionalTimestamp(metadata?.validTo)
      const sourceMessageIds = stringArray(metadata?.sourceMessageIds)
      const sourceAttachmentIds = stringArray(metadata?.sourceAttachmentIds)
      let duplicate = findExactMemory(secondary, normalizedScope, normalizedContent)
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
      const conflicts = memoryKey && cardinality === 'single'
        ? findActiveByMemoryKey(secondary, normalizedScope, memoryKey)
          .filter(item => item.status === 'active'
          && item.id !== duplicate?.id
          && normalizeContent(item.content).toLocaleLowerCase() !== normalizedContent.toLocaleLowerCase())
        : []

      let status = normalizeStatus(metadata?.status) ?? 'active'
      let supersedes: string | undefined
      const changedConflicts: IndexedMemory[] = []
      if (conflicts.length > 0) {
        if (confidence >= 0.8) {
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
        removeActiveIndexes(secondary, duplicate)
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
        persistChanges(persistence, index, [...changedConflicts, duplicate])
        return
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
      persistChanges(persistence, index, [...changedConflicts, newItem], pruned.map(item => item.id))
    },

    async forget(id: string, scope: MemoryScope): Promise<void> {
      const normalizedScope = normalizeScope(scope)
      const itemIndex = index.findIndex(item => item.id === id && matchesScope(item.scope, normalizedScope))
      if (itemIndex >= 0) {
        removeMemoryIndexes(secondary, index[itemIndex]!)
        index.splice(itemIndex, 1)
        persistChanges(persistence, index, [], [id])
      }
    },

    async update(id: string, scope: MemoryScope, patch: MemoryUpdate): Promise<boolean> {
      const normalizedScope = normalizeScope(scope)
      const item = index.find(entry => entry.id === id && matchesScope(entry.scope, normalizedScope))
      if (!item)
        return false
      const now = Date.now()
      removeActiveIndexes(secondary, item)
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
      }
      item.updatedAt = now
      addActiveIndexes(secondary, item)
      persistChanges(persistence, index, [item])
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
      persistChanges(persistence, index, [...changedConflicts, item])
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
      persistChanges(persistence, index, changedItems)
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
      persistChanges(persistence, index, [], deletedIds)
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
      writeFileSync(temporaryPath, payload, 'utf-8')
      renameSync(temporaryPath, storagePath)
    },
  }
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

function selectDiverse(scored: Array<{ item: IndexedMemory; score: number }>, topK: number) {
  const selected: Array<{ item: IndexedMemory; score: number }> = []
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
): void {
  if (!persistence || (upserts.length === 0 && deletes.length === 0))
    return
  if (!persistence.appendDelta) {
    persistIndex(persistence, index)
    return
  }
  const deleteIds = new Set(deletes)
  const uniqueUpserts = new Map<string, IndexedMemory>()
  for (const item of upserts) {
    if (!deleteIds.has(item.id))
      uniqueUpserts.set(item.id, item)
  }
  persistence.appendDelta({
    indexVersion: 3,
    upserts: [...uniqueUpserts.values()],
    deletes: [...deleteIds],
  })
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
  return value === 'active' || value === 'superseded' || value === 'expired' || value === 'conflicted' || value === 'orphaned'
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
