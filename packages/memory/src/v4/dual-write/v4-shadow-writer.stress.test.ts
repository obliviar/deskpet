import { describe, expect, it } from 'vitest'
import type { V3MemoryRecord } from '../../long-term/vector-store'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createV4ShadowWriter } from './v4-shadow-writer'

describe('Memory V4 stage-two reconciliation scale', () => {
  it('reconciles 5,000 V3 records linearly and skips an unchanged restart', () => {
    const itemCount = 5_000
    const now = 1_800_000_000_000
    const items = Array.from({ length: itemCount }, (_, index): V3MemoryRecord => ({
      id: `scale-${index}`,
      content: `用户长期事实 ${index}`,
      metadata: { kind: index % 3 === 0 ? 'preference' : 'project' },
      status: 'active',
      origin: index % 10 === 0 ? 'manual' : 'automatic',
      importance: 0.7,
      confidence: 0.9,
      accessCount: index % 5,
      sourceMessageIds: [`message-${index}`],
      sourceAttachmentIds: [],
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
      scope: { ownerId: 'scale-user', agentId: 'deskpet' },
      embedding: [index % 7, index % 11],
      embeddingModel: 'scale-test',
      createdAt: now + index,
      updatedAt: now + index,
    }))
    const payload = JSON.stringify({ version: 3, items })
    const repository = createMemoryV4Repository({ now: () => now })
    const shadow = createV4ShadowWriter({ repository, now: () => now + itemCount + 1, flushDelayMs: 10_000 })

    const startedAt = performance.now()
    const first = shadow.reconcileV3Payload(payload)
    const firstMilliseconds = Math.round(performance.now() - startedAt)
    const revision = repository.snapshot().revision
    const restartStartedAt = performance.now()
    const second = shadow.reconcileV3Payload(payload)
    const restartMilliseconds = Math.round(performance.now() - restartStartedAt)
    const snapshot = repository.snapshot()

    expect(first).toMatchObject({ changed: true, sourceCount: itemCount, mirroredCount: itemCount })
    expect(second).toMatchObject({ changed: false, sourceCount: itemCount, mirroredCount: itemCount })
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.facts).toHaveLength(itemCount)
    expect(snapshot.dualWriteState?.sourceItemCount).toBe(itemCount)
    expect(firstMilliseconds).toBeLessThan(15_000)
    expect(restartMilliseconds).toBeLessThan(1_000)
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()

    console.log(JSON.stringify({
      stage: 'memory-v4-stage2-reconciliation-stress',
      itemCount,
      episodeCount: snapshot.episodes.length,
      evidenceCount: snapshot.evidenceLinks.length,
      firstMilliseconds,
      unchangedRestartMilliseconds: restartMilliseconds,
    }))
  })
})
