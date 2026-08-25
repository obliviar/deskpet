export const MEMORY_SPARSE_VECTOR_CANDIDATE_INDEX_VERSION = 'memory-sparse-vector-candidate-index-v1'

export interface SparseVectorSearchHit {
  id: string
  score: number
}

export interface SparseVectorCandidateIndex {
  upsert: (id: string, vector: readonly number[]) => void
  remove: (id: string) => boolean
  search: (
    query: readonly number[],
    options?: { limit?: number; minScore?: number; allow?: (id: string) => boolean },
  ) => SparseVectorSearchHit[]
  clear: () => void
  size: () => number
}

/**
 * Exact sparse dot-product candidate index for normalized local embeddings.
 * Only dimensions present in the query are visited; documents with no shared
 * feature can never have a positive cosine and are skipped completely.
 */
export function createSparseVectorCandidateIndex(): SparseVectorCandidateIndex {
  const postings = new Map<number, Map<string, number>>()
  const dimensionsById = new Map<string, number[]>()

  function remove(id: string): boolean {
    const dimensions = dimensionsById.get(id)
    if (!dimensions)
      return false
    for (const dimension of dimensions) {
      const posting = postings.get(dimension)
      posting?.delete(id)
      if (posting?.size === 0)
        postings.delete(dimension)
    }
    dimensionsById.delete(id)
    return true
  }

  function upsert(id: string, vector: readonly number[]): void {
    if (!id.trim() || vector.length === 0 || !vector.every(Number.isFinite))
      throw new Error('Sparse vector candidate index received an invalid entry')
    remove(id)
    const dimensions: number[] = []
    for (const [dimension, value] of vector.entries()) {
      if (value === 0)
        continue
      dimensions.push(dimension)
      const posting = postings.get(dimension) ?? new Map<string, number>()
      posting.set(id, value)
      postings.set(dimension, posting)
    }
    dimensionsById.set(id, dimensions)
  }

  function search(
    query: readonly number[],
    options: { limit?: number; minScore?: number; allow?: (id: string) => boolean } = {},
  ): SparseVectorSearchHit[] {
    if (query.length === 0 || !query.every(Number.isFinite))
      return []
    const scores = new Map<string, number>()
    const allowed = new Map<string, boolean>()
    for (const [dimension, queryValue] of query.entries()) {
      if (queryValue === 0)
        continue
      for (const [id, documentValue] of postings.get(dimension) ?? []) {
        if (options.allow) {
          let accepted = allowed.get(id)
          if (accepted === undefined) {
            accepted = options.allow(id)
            allowed.set(id, accepted)
          }
          if (!accepted)
            continue
        }
        scores.set(id, (scores.get(id) ?? 0) + queryValue * documentValue)
      }
    }
    const minimum = clampNumber(options.minScore, 0, 1, 0)
    const limit = clampInteger(options.limit, 1, 100_000, 100)
    return [...scores]
      .map(([id, score]) => ({ id, score: clamp01(score) }))
      .filter(hit => hit.score > 0 && hit.score >= minimum)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
  }

  return {
    upsert,
    remove,
    search,
    clear() {
      postings.clear()
      dimensionsById.clear()
    },
    size: () => dimensionsById.size,
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
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
