export const MEMORY_BM25_INDEX_VERSION = 'memory-bm25-cjk-v1'

export interface Bm25MemoryScope {
  ownerId: string
  agentId: string
  sessionId?: string
}

export type Bm25DocumentState = 'active' | 'historical'

export interface Bm25DocumentInput {
  id: string
  content: string
  scope: Bm25MemoryScope
  /** Active documents participate in both current and historical recall. */
  state: Bm25DocumentState
}

export interface Bm25SearchOptions {
  scope: Bm25MemoryScope
  mode?: 'current' | 'historical'
  limit?: number
  minScore?: number
  allow?: (memoryId: string) => boolean
}

export interface Bm25SearchHit {
  id: string
  score: number
  rank: number
}

export interface Bm25IndexStats {
  version: typeof MEMORY_BM25_INDEX_VERSION
  documents: number
  shards: number
  terms: number
}

export interface Bm25IndexOptions {
  tokenizer?: (value: string) => string[]
}

export interface MemoryBm25Index {
  upsert: (document: Bm25DocumentInput) => void
  remove: (memoryId: string) => boolean
  search: (query: string, options: Bm25SearchOptions) => Bm25SearchHit[]
  rebuild: (documents: readonly Bm25DocumentInput[]) => void
  clear: () => void
  stats: () => Bm25IndexStats
}

interface IndexedBm25Document {
  id: string
  state: Bm25DocumentState
  length: number
  frequencies: Map<string, number>
  shardKeys: string[]
}

interface Bm25Posting {
  frequencies: Map<string, number>
  activeDocumentCount: number
}

interface Bm25Shard {
  documentCount: number
  activeDocumentCount: number
  totalDocumentLength: number
  activeDocumentLength: number
  postings: Map<string, Bm25Posting>
}

const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * Rebuildable in-memory BM25 candidate index.
 *
 * The encrypted fact store remains authoritative. This derived index owns its
 * corpus statistics and inverted postings, so a query never tokenizes every
 * stored document or recomputes document frequency from the full corpus.
 */
export function createMemoryBm25Index(options: Bm25IndexOptions = {}): MemoryBm25Index {
  const tokenize = options.tokenizer ?? tokenizeBm25
  const documents = new Map<string, IndexedBm25Document>()
  const shards = new Map<string, Bm25Shard>()

  function upsert(input: Bm25DocumentInput): void {
    assertDocument(input)
    remove(input.id)
    const frequencies = termFrequencies(tokenize(input.content))
    if (frequencies.size === 0)
      return
    const length = [...frequencies.values()].reduce((sum, value) => sum + value, 0)
    const shardKeys = documentShardKeys(input.scope)
    const document: IndexedBm25Document = {
      id: input.id,
      state: input.state,
      length,
      frequencies,
      shardKeys,
    }
    documents.set(input.id, document)
    for (const key of shardKeys)
      addToShard(shards, key, document)
  }

  function remove(memoryId: string): boolean {
    const document = documents.get(memoryId)
    if (!document)
      return false
    for (const key of document.shardKeys)
      removeFromShard(shards, key, document)
    documents.delete(memoryId)
    return true
  }

  function search(query: string, searchOptions: Bm25SearchOptions): Bm25SearchHit[] {
    const queryTokens = [...new Set(tokenize(query))]
    if (queryTokens.length === 0)
      return []
    const shard = shards.get(queryShardKey(searchOptions.scope))
    if (!shard)
      return []
    const mode = searchOptions.mode ?? 'current'
    const documentCount = mode === 'current' ? shard.activeDocumentCount : shard.documentCount
    const totalLength = mode === 'current' ? shard.activeDocumentLength : shard.totalDocumentLength
    if (documentCount === 0)
      return []
    const averageLength = totalLength / documentCount
    const rawScores = new Map<string, number>()

    for (const token of queryTokens) {
      const posting = shard.postings.get(token)
      if (!posting)
        continue
      const documentFrequency = mode === 'current'
        ? posting.activeDocumentCount
        : posting.frequencies.size
      if (documentFrequency === 0)
        continue
      const inverseDocumentFrequency = Math.log(
        1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
      )
      for (const [id, frequency] of posting.frequencies) {
        const document = documents.get(id)
        if (!document || (mode === 'current' && document.state !== 'active'))
          continue
        if (searchOptions.allow && !searchOptions.allow(id))
          continue
        const denominator = frequency + BM25_K1 * (
          1 - BM25_B + BM25_B * document.length / Math.max(1, averageLength)
        )
        const contribution = inverseDocumentFrequency * (frequency * (BM25_K1 + 1) / denominator)
        rawScores.set(id, (rawScores.get(id) ?? 0) + contribution)
      }
    }

    const minimum = clampNumber(searchOptions.minScore, 0, 1, 0)
    const limit = clampInteger(searchOptions.limit, 1, 10_000, 100)
    return [...rawScores]
      .map(([id, score]) => ({ id, score: clampScore(1 - Math.exp(-score)) }))
      .filter(hit => hit.score >= minimum)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }))
  }

  function clear(): void {
    documents.clear()
    shards.clear()
  }

  function rebuild(inputs: readonly Bm25DocumentInput[]): void {
    clear()
    for (const input of inputs)
      upsert(input)
  }

  return {
    upsert,
    remove,
    search,
    rebuild,
    clear,
    stats: () => ({
      version: MEMORY_BM25_INDEX_VERSION,
      documents: documents.size,
      shards: shards.size,
      terms: [...shards.values()].reduce((sum, shard) => sum + shard.postings.size, 0),
    }),
  }
}

/** Keep token semantics compatible with the former full-corpus BM25 path. */
export function tokenizeBm25(value: string): string[] {
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

function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const token of tokens)
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  return frequencies
}

function documentShardKeys(scope: Bm25MemoryScope): string[] {
  const keys = [aggregateShardKey(scope)]
  if (scope.sessionId)
    keys.push(exactShardKey(scope))
  return keys
}

function queryShardKey(scope: Bm25MemoryScope): string {
  return scope.sessionId ? exactShardKey(scope) : aggregateShardKey(scope)
}

function aggregateShardKey(scope: Bm25MemoryScope): string {
  return `aggregate\u0000${JSON.stringify([scope.ownerId, scope.agentId])}`
}

function exactShardKey(scope: Bm25MemoryScope): string {
  return `exact\u0000${JSON.stringify([scope.ownerId, scope.agentId, scope.sessionId ?? ''])}`
}

function addToShard(shards: Map<string, Bm25Shard>, key: string, document: IndexedBm25Document): void {
  const shard = shards.get(key) ?? emptyShard()
  shard.documentCount += 1
  shard.totalDocumentLength += document.length
  if (document.state === 'active') {
    shard.activeDocumentCount += 1
    shard.activeDocumentLength += document.length
  }
  for (const [token, frequency] of document.frequencies) {
    const posting = shard.postings.get(token) ?? { frequencies: new Map(), activeDocumentCount: 0 }
    posting.frequencies.set(document.id, frequency)
    if (document.state === 'active')
      posting.activeDocumentCount += 1
    shard.postings.set(token, posting)
  }
  shards.set(key, shard)
}

function removeFromShard(shards: Map<string, Bm25Shard>, key: string, document: IndexedBm25Document): void {
  const shard = shards.get(key)
  if (!shard)
    return
  shard.documentCount -= 1
  shard.totalDocumentLength -= document.length
  if (document.state === 'active') {
    shard.activeDocumentCount -= 1
    shard.activeDocumentLength -= document.length
  }
  for (const token of document.frequencies.keys()) {
    const posting = shard.postings.get(token)
    if (!posting)
      continue
    posting.frequencies.delete(document.id)
    if (document.state === 'active')
      posting.activeDocumentCount -= 1
    if (posting.frequencies.size === 0)
      shard.postings.delete(token)
  }
  if (shard.documentCount === 0)
    shards.delete(key)
}

function emptyShard(): Bm25Shard {
  return {
    documentCount: 0,
    activeDocumentCount: 0,
    totalDocumentLength: 0,
    activeDocumentLength: 0,
    postings: new Map(),
  }
}

function assertDocument(document: Bm25DocumentInput): void {
  if (!document.id || !document.content || !document.scope.ownerId || !document.scope.agentId)
    throw new Error('BM25 document is missing an identity field')
}

function clampScore(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.max(0, Math.min(1, value))
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}
