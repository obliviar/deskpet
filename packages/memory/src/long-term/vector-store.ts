import type { MemoryFragment } from '@deskpet/contracts'
import OpenAI from 'openai'

/**
 * Vector store backed by OpenAI embeddings + in-memory cosine similarity.
 *
 * Produces embedding vectors via OpenAI and stores them in an in-memory
 * index. For production use, replace with pgvector, Milvus, or Pinecone.
 */
export interface VectorStoreOptions {
  /** OpenAI API key. */
  apiKey: string
  /** Optional base URL for a compatible provider. */
  baseURL?: string
  /** Embedding model to use. */
  embeddingModel?: string
}

interface IndexedMemory extends MemoryFragment {
  embedding: number[]
}

export function createVectorStore(options: VectorStoreOptions) {
  const { apiKey, baseURL, embeddingModel = 'text-embedding-3-small' } = options
  const client = new OpenAI({ apiKey, baseURL })
  const index: IndexedMemory[] = []

  async function embed(text: string): Promise<number[]> {
    const res = await client.embeddings.create({ model: embeddingModel, input: text })
    return res.data[0]?.embedding ?? []
  }

  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0)
      return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!
      na += a[i]! * a[i]!
      nb += b[i]! * b[i]!
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
  }

  return {
    async recall(query: string, topK = 5): Promise<MemoryFragment[]> {
      if (index.length === 0)
        return []
      const queryEmbedding = await embed(query)
      const scored = index.map(item => ({
        ...item,
        score: cosineSimilarity(queryEmbedding, item.embedding),
      }))
      scored.sort((a, b) => b.score! - a.score!)
      return scored.slice(0, topK).map(({ embedding: _, ...rest }) => rest)
    },

    async remember(content: string, metadata?: Record<string, unknown>): Promise<void> {
      const embedding = await embed(content)
      index.push({
        id: crypto.randomUUID(),
        content,
        metadata,
        embedding,
        createdAt: Date.now(),
      })
    },

    async forget(id: string): Promise<void> {
      const i = index.findIndex(item => item.id === id)
      if (i >= 0)
        index.splice(i, 1)
    },

    /** Number of indexed memories. */
    size(): number {
      return index.length
    },

    /** Clear all indexed memories. */
    clear() {
      index.length = 0
    },
  }
}

export type VectorStore = ReturnType<typeof createVectorStore>