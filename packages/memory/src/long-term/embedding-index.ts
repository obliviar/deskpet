import { createHash } from 'node:crypto'
import type { MemoryPersistence } from './vector-store'

export const MEMORY_EMBEDDING_INDEX_VERSION = 3

export interface MemoryEmbeddingVectorInput {
  memoryId: string
  model: string
  content: string
  vector: number[]
}

export interface MemoryEmbeddingIndexStatus {
  model: string
  total: number
  ready: number
  pending: number
}

interface MemoryEmbeddingVectorRecord {
  id: string
  memoryId: string
  model: string
  contentHash: string
  vector: number[]
  updatedAt: number
}

interface PersistedEmbeddingIndex {
  version: typeof MEMORY_EMBEDDING_INDEX_VERSION
  items: MemoryEmbeddingVectorRecord[]
}

export interface MemoryEmbeddingIndex {
  get: (memoryId: string, model: string, content: string) => number[] | undefined
  hasMemory: (memoryId: string) => boolean
  putBatch: (entries: readonly MemoryEmbeddingVectorInput[]) => void
  removeMemoryIds: (memoryIds: readonly string[]) => number
  reconcileMemoryIds: (memoryIds: ReadonlySet<string>) => number
  compact: () => void
  scrubBackups: () => void
}

/**
 * Encrypted/rebuildable side index for alternate embedding models.
 *
 * V3 remains the fact authority and continues carrying its active vector. This
 * side index lets another model be prepared without mixing vector spaces or
 * replacing the rollback vector. Records contain only a content hash, never a
 * second plaintext copy of the memory.
 */
export function createMemoryEmbeddingIndex(options: { persistence?: MemoryPersistence } = {}): MemoryEmbeddingIndex {
  const persistence = options.persistence
  const payload = persistence?.load()
  const records = loadRecords(payload)
  const byMemoryId = buildMemoryLookup(records)
  if (persistence && payload === undefined)
    persistAll(persistence, records)

  function get(memoryId: string, model: string, content: string): number[] | undefined {
    const record = records.get(recordId(memoryId, model))
    if (!record || record.contentHash !== contentHash(content))
      return undefined
    return [...record.vector]
  }

  function putBatch(entries: readonly MemoryEmbeddingVectorInput[]): void {
    if (entries.length === 0)
      return
    const now = Date.now()
    const upserts = new Map<string, MemoryEmbeddingVectorRecord>()
    for (const entry of entries) {
      assertEmbeddingInput(entry)
      const id = recordId(entry.memoryId, entry.model)
      const record: MemoryEmbeddingVectorRecord = {
        id,
        memoryId: entry.memoryId,
        model: entry.model,
        contentHash: contentHash(entry.content),
        vector: [...entry.vector],
        updatedAt: now,
      }
      upserts.set(id, record)
    }
    persistDelta(persistence, records, [...upserts.values()], [])
    for (const record of upserts.values()) {
      records.set(record.id, record)
      addLookup(byMemoryId, record)
    }
  }

  function removeMemoryIds(memoryIds: readonly string[]): number {
    const deletes = new Set<string>()
    const affectedMemoryIds = new Set(memoryIds.filter(Boolean))
    for (const memoryId of affectedMemoryIds) {
      for (const id of byMemoryId.get(memoryId) ?? []) {
        deletes.add(id)
      }
    }
    persistDelta(persistence, records, [], [...deletes])
    for (const id of deletes)
      records.delete(id)
    for (const memoryId of affectedMemoryIds)
      byMemoryId.delete(memoryId)
    return deletes.size
  }

  function reconcileMemoryIds(memoryIds: ReadonlySet<string>): number {
    return removeMemoryIds([...byMemoryId.keys()].filter(memoryId => !memoryIds.has(memoryId)))
  }

  return {
    get,
    hasMemory: memoryId => (byMemoryId.get(memoryId)?.size ?? 0) > 0,
    putBatch,
    removeMemoryIds,
    reconcileMemoryIds,
    compact: () => persistence?.compact?.(),
    scrubBackups: () => persistence?.scrubBackups?.(),
  }
}

function loadRecords(payload: string | undefined): Map<string, MemoryEmbeddingVectorRecord> {
  if (payload === undefined)
    return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse memory embedding index: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Memory embedding index is not an object')
  const index = parsed as Partial<PersistedEmbeddingIndex>
  if (index.version !== MEMORY_EMBEDDING_INDEX_VERSION || !Array.isArray(index.items))
    throw new Error('Unsupported or invalid memory embedding index')
  const records = new Map<string, MemoryEmbeddingVectorRecord>()
  for (const [position, item] of index.items.entries()) {
    if (!isEmbeddingRecord(item))
      throw new Error(`Memory embedding index contains an invalid item at position ${position}`)
    if (records.has(item.id))
      throw new Error(`Memory embedding index contains duplicate id: ${item.id}`)
    records.set(item.id, { ...item, vector: [...item.vector] })
  }
  return records
}

function buildMemoryLookup(records: ReadonlyMap<string, MemoryEmbeddingVectorRecord>): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>()
  for (const record of records.values())
    addLookup(lookup, record)
  return lookup
}

function addLookup(lookup: Map<string, Set<string>>, record: MemoryEmbeddingVectorRecord): void {
  const ids = lookup.get(record.memoryId) ?? new Set<string>()
  ids.add(record.id)
  lookup.set(record.memoryId, ids)
}

function persistDelta(
  persistence: MemoryPersistence | undefined,
  records: ReadonlyMap<string, MemoryEmbeddingVectorRecord>,
  upserts: readonly MemoryEmbeddingVectorRecord[],
  deletes: readonly string[],
): void {
  if (!persistence || (upserts.length === 0 && deletes.length === 0))
    return
  if (persistence.appendDelta) {
    persistence.appendDelta({
      indexVersion: MEMORY_EMBEDDING_INDEX_VERSION,
      upserts: [...upserts],
      deletes: [...deletes],
    })
  }
  else {
    const next = new Map(records)
    for (const id of deletes)
      next.delete(id)
    for (const record of upserts)
      next.set(record.id, record)
    persistAll(persistence, next)
  }
}

function persistAll(
  persistence: MemoryPersistence,
  records: ReadonlyMap<string, MemoryEmbeddingVectorRecord>,
): void {
  persistence.save(JSON.stringify({
    version: MEMORY_EMBEDDING_INDEX_VERSION,
    items: [...records.values()],
  } satisfies PersistedEmbeddingIndex))
}

function recordId(memoryId: string, model: string): string {
  return createHash('sha256').update(model).update('\0').update(memoryId).digest('hex')
}

function contentHash(content: string): string {
  return createHash('sha256').update(content.normalize('NFKC')).digest('hex')
}

function assertEmbeddingInput(input: MemoryEmbeddingVectorInput): void {
  if (!input.memoryId || !input.model || !input.content)
    throw new Error('Memory embedding index input is missing an identity field')
  if (!Array.isArray(input.vector) || input.vector.length === 0 || !input.vector.every(Number.isFinite))
    throw new Error('Memory embedding index input contains an invalid vector')
}

function isEmbeddingRecord(value: unknown): value is MemoryEmbeddingVectorRecord {
  if (!value || typeof value !== 'object')
    return false
  const record = value as Partial<MemoryEmbeddingVectorRecord>
  return typeof record.id === 'string'
    && typeof record.memoryId === 'string'
    && typeof record.model === 'string'
    && typeof record.contentHash === 'string'
    && Array.isArray(record.vector)
    && record.vector.length > 0
    && record.vector.every(Number.isFinite)
    && typeof record.updatedAt === 'number'
}
