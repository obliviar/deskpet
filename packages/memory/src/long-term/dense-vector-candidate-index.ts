export const MEMORY_DENSE_VECTOR_CANDIDATE_INDEX_VERSION = 'memory-dense-vector-candidate-index-v1'

export interface DenseVectorSearchHit {
  id: string
  score: number
}

export interface DenseVectorSearchOptions {
  limit?: number
  minScore?: number
  allow?: (id: string) => boolean
}

export interface DenseVectorCandidateIndex {
  readonly version: typeof MEMORY_DENSE_VECTOR_CANDIDATE_INDEX_VERSION
  upsert: (id: string, vector: readonly number[]) => void
  remove: (id: string) => boolean
  search: (query: readonly number[], options?: DenseVectorSearchOptions) => DenseVectorSearchHit[]
  clear: () => void
  size: () => number
  dimension: () => number | undefined
}

/**
 * Exact flat index for normalized learned embeddings.
 *
 * Learned embeddings such as BGE are dense, so an inverted sparse index would
 * visit nearly every posting while using much more object overhead. Storing
 * Float32Array rows keeps the current 20k scale compact and deterministic. The
 * interface deliberately permits a future HNSW implementation without
 * changing the V4 retriever contract.
 */
export function createDenseVectorCandidateIndex(): DenseVectorCandidateIndex {
  const vectors = new Map<string, Float32Array>()
  let vectorDimension: number | undefined

  function upsert(id: string, vector: readonly number[]): void {
    if (!id.trim())
      throw new Error('Dense vector index id is required')
    assertNormalizedVector(vector, vectorDimension)
    vectorDimension ??= vector.length
    vectors.set(id, Float32Array.from(vector))
  }

  function remove(id: string): boolean {
    const removed = vectors.delete(id)
    if (vectors.size === 0)
      vectorDimension = undefined
    return removed
  }

  function search(
    query: readonly number[],
    options: DenseVectorSearchOptions = {},
  ): DenseVectorSearchHit[] {
    if (vectors.size === 0)
      return []
    assertNormalizedVector(query, vectorDimension)
    const limit = clampInteger(options.limit, 1, 10_000, 20)
    const minimum = clampNumber(options.minScore, -1, 1, -1)
    const hits: DenseVectorSearchHit[] = []
    for (const [id, vector] of vectors) {
      if (options.allow && !options.allow(id))
        continue
      let score = 0
      for (let index = 0; index < vector.length; index++)
        score += query[index]! * vector[index]!
      if (score >= minimum)
        hits.push({ id, score: Math.max(-1, Math.min(1, score)) })
    }
    return hits
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
  }

  return {
    version: MEMORY_DENSE_VECTOR_CANDIDATE_INDEX_VERSION,
    upsert,
    remove,
    search,
    clear() {
      vectors.clear()
      vectorDimension = undefined
    },
    size: () => vectors.size,
    dimension: () => vectorDimension,
  }
}

function assertNormalizedVector(vector: readonly number[], expectedDimension?: number): void {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector))
    throw new Error('Dense vector index requires an array-like vector')
  if (vector.length === 0 || (expectedDimension !== undefined && vector.length !== expectedDimension))
    throw new Error(`Dense vector index dimension mismatch: expected ${expectedDimension ?? 'non-zero'}, received ${vector.length}`)
  let squaredNorm = 0
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Dense vector index contains a non-finite component')
    squaredNorm += value * value
  }
  const norm = Math.sqrt(squaredNorm)
  if (Math.abs(norm - 1) > 0.03)
    throw new Error(`Dense vector index requires normalized vectors; received norm ${norm.toFixed(6)}`)
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
