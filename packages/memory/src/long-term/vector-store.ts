import type { MemoryFragment, MemoryScope } from '@deskpet/contracts'
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import OpenAI from 'openai'
import { createLocalEmbedding, LOCAL_EMBEDDING_MODEL } from './local-embedding'

export interface VectorStoreOptions {
  apiKey?: string
  baseURL?: string
  embeddingModel?: string
  storagePath?: string
  minScore?: number
  maxMemories?: number
  embedder?: (text: string) => Promise<number[]>
}

interface IndexedMemory extends MemoryFragment {
  scope: Required<Pick<MemoryScope, 'ownerId' | 'agentId'>> & Pick<MemoryScope, 'sessionId'>
  embedding: number[]
  embeddingModel: string
  updatedAt: number
}

interface PersistedIndex {
  version: 1
  items: IndexedMemory[]
}

export function createVectorStore(options: VectorStoreOptions = {}) {
  const {
    apiKey,
    baseURL,
    embeddingModel = LOCAL_EMBEDDING_MODEL,
    storagePath,
    minScore = embeddingModel === LOCAL_EMBEDDING_MODEL ? 0.08 : 0.55,
    maxMemories = 1000,
    embedder,
  } = options

  const remoteClient = !embedder && embeddingModel !== LOCAL_EMBEDDING_MODEL
    ? new OpenAI({ apiKey: requireApiKey(apiKey), baseURL })
    : undefined
  const index: IndexedMemory[] = loadIndex(storagePath)
  if (storagePath && !existsSync(storagePath))
    persistIndex(storagePath, index)

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
    async recall(query: string, scope: MemoryScope, topK = 5): Promise<MemoryFragment[]> {
      const normalizedScope = normalizeScope(scope)
      const candidates = index.filter(item => matchesScope(item.scope, normalizedScope))
      if (candidates.length === 0 || !query.trim())
        return []

      let changed = false
      for (const item of candidates) {
        if (item.embeddingModel !== embeddingModel || item.embedding.length === 0) {
          item.embedding = await embed(item.content)
          item.embeddingModel = embeddingModel
          item.updatedAt = Date.now()
          changed = true
        }
      }
      if (changed)
        persistIndex(storagePath, index)

      const queryEmbedding = await embed(query)
      const scored = candidates
        .map(item => ({ item, score: clampScore(cosineSimilarity(queryEmbedding, item.embedding)) }))
        .filter(entry => entry.score >= minScore)
        .sort((a, b) => b.score - a.score)

      return scored.slice(0, clampInteger(topK, 1, 20)).map(({ item, score }) => ({
        id: item.id,
        content: item.content,
        metadata: item.metadata,
        createdAt: item.createdAt,
        score,
      }))
    },

    async remember(content: string, scope: MemoryScope, metadata?: Record<string, unknown>): Promise<void> {
      const normalizedContent = normalizeContent(content)
      if (!normalizedContent)
        return
      const normalizedScope = normalizeScope(scope)
      const duplicate = index.find(item => matchesExactScope(item.scope, normalizedScope)
        && normalizeContent(item.content).toLocaleLowerCase() === normalizedContent.toLocaleLowerCase())
      if (duplicate) {
        duplicate.metadata = mergeMetadata(duplicate.metadata, metadata)
        duplicate.updatedAt = Date.now()
        persistIndex(storagePath, index)
        return
      }

      const embedding = await embed(normalizedContent)
      const now = Date.now()
      index.push({
        id: crypto.randomUUID(),
        content: normalizedContent,
        metadata,
        scope: normalizedScope,
        embedding,
        embeddingModel,
        createdAt: now,
        updatedAt: now,
      })
      pruneScope(index, normalizedScope, maxMemories)
      persistIndex(storagePath, index)
    },

    async forget(id: string, scope: MemoryScope): Promise<void> {
      const normalizedScope = normalizeScope(scope)
      const itemIndex = index.findIndex(item => item.id === id && matchesScope(item.scope, normalizedScope))
      if (itemIndex >= 0) {
        index.splice(itemIndex, 1)
        persistIndex(storagePath, index)
      }
    },

    async clear(scope: MemoryScope): Promise<void> {
      const normalizedScope = normalizeScope(scope)
      for (let i = index.length - 1; i >= 0; i--) {
        if (matchesScope(index[i]!.scope, normalizedScope))
          index.splice(i, 1)
      }
      persistIndex(storagePath, index)
    },

    async count(scope: MemoryScope): Promise<number> {
      const normalizedScope = normalizeScope(scope)
      return index.filter(item => matchesScope(item.scope, normalizedScope)).length
    },
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0)
    return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
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
  return { ...current, ...incoming }
}

function pruneScope(index: IndexedMemory[], scope: IndexedMemory['scope'], maxMemories: number): void {
  const scoped = index.filter(item => matchesScope(item.scope, scope)).sort((a, b) => b.updatedAt - a.updatedAt)
  const excess = scoped.slice(Math.max(1, maxMemories))
  if (excess.length === 0)
    return
  const excessIds = new Set(excess.map(item => item.id))
  for (let i = index.length - 1; i >= 0; i--) {
    if (excessIds.has(index[i]!.id))
      index.splice(i, 1)
  }
}

function loadIndex(storagePath?: string): IndexedMemory[] {
  if (!storagePath || !existsSync(storagePath))
    return []
  try {
    const parsed = JSON.parse(readFileSync(storagePath, 'utf-8')) as Partial<PersistedIndex>
    if (parsed.version !== 1 || !Array.isArray(parsed.items))
      return []
    return parsed.items.filter(isIndexedMemory)
  }
  catch (error) {
    console.warn('[deskpet] unable to load long-term memory:', error)
    return []
  }
}

function persistIndex(storagePath: string | undefined, index: IndexedMemory[]): void {
  if (!storagePath)
    return
  mkdirSync(dirname(storagePath), { recursive: true })
  const temporaryPath = `${storagePath}.${process.pid}.tmp`
  const payload: PersistedIndex = { version: 1, items: index }
  writeFileSync(temporaryPath, JSON.stringify(payload), 'utf-8')
  renameSync(temporaryPath, storagePath)
}

function isIndexedMemory(value: unknown): value is IndexedMemory {
  if (!value || typeof value !== 'object')
    return false
  const item = value as Partial<IndexedMemory>
  return typeof item.id === 'string'
    && typeof item.content === 'string'
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number'
    && typeof item.embeddingModel === 'string'
    && Array.isArray(item.embedding)
    && !!item.scope
    && typeof item.scope.ownerId === 'string'
    && typeof item.scope.agentId === 'string'
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value))
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
