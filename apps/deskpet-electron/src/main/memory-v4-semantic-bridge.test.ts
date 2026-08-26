import { describe, expect, it, vi } from 'vitest'
import { migrateV3PayloadToV4 } from '@deskpet/memory'
import { buildMemoryV4SemanticIndexSnapshot } from './memory-v4-semantic-bridge'

const NOW = Date.UTC(2026, 7, 26)

describe('Memory V4 semantic bridge', () => {
  it('maps content-addressed V3 vectors onto mirrored V4 facts', () => {
    const snapshot = migratedSnapshot()
    const factVector = vi.fn(() => [1, 0])
    const result = buildMemoryV4SemanticIndexSnapshot({
      snapshot,
      model: 'verified-bge-v1',
      expectedDimension: 2,
      factVector,
    })

    expect(result).toMatchObject({ version: 1, snapshotRevision: snapshot.revision, semanticRevision: snapshot.revision, model: 'verified-bge-v1', dimension: 2 })
    expect(result.factVectors).toHaveLength(1)
    expect(result.factVectors[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(factVector).toHaveBeenCalledWith(expect.objectContaining({ sourceMemoryId: 'coffee', content: '用户喜欢手冲咖啡' }))
  })

  it('omits unavailable, wrong-dimensional and unnormalized vectors', () => {
    const snapshot = migratedSnapshot()
    for (const vector of [undefined, [1], [0.2, 0.2], [Number.NaN, 0]]) {
      const result = buildMemoryV4SemanticIndexSnapshot({
        snapshot,
        model: 'verified-bge-v1',
        expectedDimension: 2,
        factVector: () => vector,
      })
      expect(result.factVectors).toEqual([])
    }
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
