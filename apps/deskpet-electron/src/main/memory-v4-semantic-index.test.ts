import { describe, expect, it, vi } from 'vitest'
import { createMemoryEmbeddingIndex, migrateV3PayloadToV4 } from '@deskpet/memory'
import { createMemoryV4SemanticBackgroundIndex } from './memory-v4-semantic-index'

const NOW = Date.UTC(2026, 7, 26)

describe('Memory V4 semantic background index', () => {
  it('seeds mirrored facts, incrementally embeds summaries and exposes independent revisions', async () => {
    const snapshot = migratedSnapshot()
    snapshot.derivedArtifacts.push({
      id: 'summary-1', scope: { ownerId: 'owner', agentId: 'deskpet' }, kind: 'summary', status: 'current',
      sourceEpisodeIds: [], sourceFactIds: [snapshot.facts[0]!.id], content: '用户的饮品偏好摘要',
      createdAt: NOW, updatedAt: NOW, builderVersion: 'test',
    })
    const embed = vi.fn(async () => [0, 1])
    const service = createMemoryV4SemanticBackgroundIndex({
      index: createMemoryEmbeddingIndex(),
      model: 'verified-bge-test',
      dimension: 2,
      embed,
      seedFactVector: () => [1, 0],
    })

    const seeded = service.seed(snapshot)
    expect(seeded).toMatchObject({ factsReady: 1, summariesReady: 0, pending: 1 })
    const prepared = await service.prepare(snapshot, { batchSize: 1, maxItems: 1 })
    expect(prepared).toMatchObject({ factsReady: 1, summariesReady: 1, pending: 0, processed: 1 })
    expect(embed).toHaveBeenCalledWith('用户的饮品偏好摘要')
    const semantic = service.semanticSnapshot(snapshot)
    expect(semantic.factVectors).toHaveLength(1)
    expect(semantic.summaryVectors).toHaveLength(1)
    expect(semantic.semanticRevision).toBeGreaterThan(seeded.semanticRevision)
  })

  it('does not persist a stale vector when embedding fails validation', async () => {
    const snapshot = migratedSnapshot()
    const service = createMemoryV4SemanticBackgroundIndex({
      index: createMemoryEmbeddingIndex(), model: 'verified-bge-test', dimension: 2,
      embed: async () => [0.2, 0.2],
    })
    await expect(service.prepare(snapshot, { maxItems: 1 })).rejects.toThrow(/invalid/u)
    expect(service.status(snapshot).ready).toBe(0)
  })

  it('coalesces overlapping background passes so an item is embedded once', async () => {
    const snapshot = migratedSnapshot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const embed = vi.fn(async () => {
      await gate
      return [1, 0]
    })
    const service = createMemoryV4SemanticBackgroundIndex({
      index: createMemoryEmbeddingIndex(), model: 'verified-bge-test', dimension: 2, embed,
    })

    const first = service.prepare(snapshot, { maxItems: 1 })
    const second = service.prepare(snapshot, { maxItems: 1 })
    expect(second).toBe(first)
    release()
    await expect(first).resolves.toMatchObject({ ready: 1, pending: 0 })
    expect(embed).toHaveBeenCalledTimes(1)
  })
})

function migratedSnapshot() {
  return migrateV3PayloadToV4(JSON.stringify({
    version: 3,
    items: [{
      id: 'coffee', content: '用户喜欢手冲咖啡', status: 'active', origin: 'manual',
      importance: 0.8, confidence: 1, accessCount: 0, memoryKey: 'preference.drink',
      sourceMessageIds: ['message-1'], sourceAttachmentIds: [], sharePolicy: 'allow-remote', sensitivity: 'normal',
      scope: { ownerId: 'owner', agentId: 'deskpet' }, embedding: [], embeddingModel: 'local-hash-v3',
      createdAt: NOW, updatedAt: NOW,
    }],
  }), { now: () => NOW })
}
