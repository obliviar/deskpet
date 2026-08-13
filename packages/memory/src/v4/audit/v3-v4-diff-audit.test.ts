import { describe, expect, it } from 'vitest'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createV4ShadowWriter } from '../dual-write/v4-shadow-writer'
import { auditV3V4Consistency } from './v3-v4-diff-audit'

const NOW = 1_800_000_000_000

describe('V3/V4 complete diff audit', () => {
  it('passes exact reconciliation and pinpoints drift', () => {
    const payload = JSON.stringify({ version: 3, items: [record('a'), record('b')] })
    const repository = createMemoryV4Repository({ now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 1, flushDelayMs: 10_000 })
    shadow.reconcileV3Payload(payload)
    const report = auditV3V4Consistency(payload, repository.snapshot())
    expect(report).toMatchObject({ passed: true, sourceCount: 2, mirroredCount: 2, exactMatchCount: 2, consistency: 1 })

    const drifted = repository.snapshot()
    drifted.facts[0]!.canonicalText = '被篡改'
    const failed = auditV3V4Consistency(payload, drifted)
    expect(failed.passed).toBe(false)
    expect(failed.issues.map(issue => issue.code)).toContain('CONTENT_MISMATCH')
  })
})

function record(id: string) {
  return {
    id, content: `用户事实 ${id}`, status: 'active', origin: 'manual', importance: 1, confidence: 1,
    accessCount: 0, sourceMessageIds: [], sourceAttachmentIds: [], sharePolicy: 'allow-remote',
    sensitivity: 'normal', scope: { ownerId: 'owner', agentId: 'agent' }, embedding: [1],
    embeddingModel: 'test', createdAt: NOW, updatedAt: NOW,
  }
}

