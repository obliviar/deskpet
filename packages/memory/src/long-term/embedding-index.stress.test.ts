import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryEmbeddingIndex } from './embedding-index'
import { createLocalEmbedding, LOCAL_EMBEDDING_MODEL } from './local-embedding'
import { createVectorStore } from './vector-store'

const temporaryDirectories: string[] = []
const RECORD_COUNT = Math.max(1_000, Number(process.env.DESKPET_EMBEDDING_STRESS_COUNT) || 2_000)
const INTERRUPT_AFTER = 256

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('background embedding preparation scale', () => {
  it('resumes a cancelled large-record build and keeps model switching off the foreground path', async () => {
    const storagePath = fixtureWithRecords(RECORD_COUNT)
    const scope = { ownerId: 'embedding-stress', agentId: 'deskpet' }
    const sideIndex = createMemoryEmbeddingIndex()
    const hashStore = createVectorStore({ storagePath, embeddingIndex: sideIndex })
    let embeddingCalls = 0
    const targetEmbedder = async (text: string) => {
      embeddingCalls += 1
      return [1, (text.length % 17) / 17]
    }

    const interrupted = await hashStore.prepareEmbeddings('stress-bge-v1', targetEmbedder, scope, {
      batchSize: 128,
      shouldCancel: () => embeddingCalls >= INTERRUPT_AFTER,
    })
    expect(interrupted.ready).toBe(INTERRUPT_AFTER)
    expect(interrupted.pending).toBe(RECORD_COUNT - INTERRUPT_AFTER)

    const resumed = await hashStore.prepareEmbeddings('stress-bge-v1', targetEmbedder, scope, { batchSize: 128 })
    expect(resumed).toMatchObject({ total: RECORD_COUNT, ready: RECORD_COUNT, pending: 0 })
    expect(embeddingCalls).toBe(RECORD_COUNT)

    embeddingCalls = 0
    const semanticStore = createVectorStore({
      storagePath,
      embeddingModel: 'stress-bge-v1',
      embedder: targetEmbedder,
      embeddingIndex: sideIndex,
      foregroundEmbeddingUpgrade: false,
      minScore: 0,
      minSemanticScore: 0,
    })
    expect(await semanticStore.recall(`归档记忆 ${RECORD_COUNT - 1}`, scope, 1)).toHaveLength(1)
    expect(embeddingCalls).toBe(1)
  }, 30_000)
})

function fixtureWithRecords(count: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-embedding-stress-'))
  temporaryDirectories.push(directory)
  const storagePath = join(directory, 'memories.json')
  const items = Array.from({ length: count }, (_, index) => {
    const content = `归档记忆 ${index}：稳定事实 value-${index}`
    return {
      id: `memory-${index}`,
      content,
      metadata: { kind: 'archive' },
      status: 'active',
      origin: 'automatic',
      importance: 0.5,
      confidence: 0.9,
      accessCount: 0,
      sourceMessageIds: [`message-${index}`],
      sourceAttachmentIds: [],
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
      scope: { ownerId: 'embedding-stress', agentId: 'deskpet' },
      embedding: createLocalEmbedding(content),
      embeddingModel: LOCAL_EMBEDDING_MODEL,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
    }
  })
  writeFileSync(storagePath, JSON.stringify({ version: 3, items }), 'utf-8')
  return storagePath
}
