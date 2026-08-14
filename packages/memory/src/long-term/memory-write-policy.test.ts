import { describe, expect, it } from 'vitest'
import { createLocalMemoryCandidateVerifier } from './memory-write-policy'
import type { MemoryCandidate } from './memory-extractor'
import type { V3MemoryRecord } from './vector-store'

const scope = { ownerId: 'quality-user', agentId: 'deskpet' }
const verifier = createLocalMemoryCandidateVerifier()

describe('evidence-first memory write policy', () => {
  it('accepts a durable rule candidate supported by the user message', async () => {
    const candidate = memoryCandidate('用户姓名/名字：小秦', {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我叫小秦', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [] },
    })

    expect(result).toMatchObject({ action: 'ADD', status: 'accepted' })
    expect(result.evidenceScore).toBeGreaterThanOrEqual(0.95)
    expect(result.verificationScore).toBeGreaterThanOrEqual(0.9)
  })

  it('quarantines an unsupported model claim instead of writing it', async () => {
    const candidate = memoryCandidate('用户住在火星', {
      kind: 'identity', memoryKey: 'profile.location', cardinality: 'single',
      confidence: 0.99, importance: 0.9, extractionChannel: 'model',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我住在杭州', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [] },
    })

    expect(result).toMatchObject({ action: 'QUARANTINE', status: 'quarantined' })
    expect(result.reasonCodes).toContain('evidence-does-not-support-candidate')
  })

  it('rejects hypothetical or question evidence', async () => {
    const candidate = memoryCandidate('用户所在地：上海', {
      kind: 'identity', memoryKey: 'profile.location', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'model',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '如果我住在上海会怎样？', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [] },
    })

    expect(result).toMatchObject({ action: 'NOOP', status: 'rejected' })
    expect(result.ambiguityFlags).toContain('non-asserted:hypothetical')
  })

  it('does not destructively replace a single-value fact without correction evidence', async () => {
    const old = record('old-name', '用户姓名/名字：小秦', 'profile.name')
    const candidate = memoryCandidate('用户姓名/名字：小明', {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我叫小明', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [old] },
    })

    expect(result).toMatchObject({ action: 'CONFLICT', status: 'quarantined', matchedMemoryId: old.id })
    expect(result.ambiguityFlags).toContain('unresolved-single-value-conflict')
  })

  it('supersedes a single-value fact only when the user explicitly corrects it', async () => {
    const old = record('old-name', '用户姓名/名字：小秦', 'profile.name')
    const candidate = memoryCandidate('用户姓名/名字：小明', {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules', writeIntent: 'correction',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '更正一下，我的名字不是小秦，而是小明', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [old] },
    })

    expect(result).toMatchObject({ action: 'SUPERSEDE', status: 'accepted', matchedMemoryId: old.id })
  })

  it('uses NOOP for an idempotent repeat with no new source evidence', async () => {
    const existing = record('same-name', '用户姓名/名字：小秦', 'profile.name')
    const candidate = memoryCandidate(existing.content, {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我叫小秦', assistantMessage: '' },
      scope,
      matches: { exact: existing, activeByMemoryKey: [existing] },
    })

    expect(result).toMatchObject({ action: 'NOOP', status: 'accepted', matchedMemoryId: existing.id })
  })

  it('merges direct evidence for the same fact from a new source message', async () => {
    const existing = record('same-name', '用户姓名/名字：小秦', 'profile.name')
    existing.sourceMessageIds = ['m1']
    const candidate = memoryCandidate(existing.content, {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我叫小秦', assistantMessage: '', metadata: { sourceMessageIds: ['m2'] } },
      scope,
      matches: { exact: existing, activeByMemoryKey: [existing] },
    })

    expect(result).toMatchObject({ action: 'MERGE_EVIDENCE', status: 'accepted', matchedMemoryId: existing.id })
  })

  it('uses REFINE for a strongly supported compatible single-value expansion', async () => {
    const existing = record('short-name', '用户希望的称呼：小秦', 'profile.preferred_name')
    const candidate = memoryCandidate('用户希望的称呼：小秦同学', {
      kind: 'identity', memoryKey: 'profile.preferred_name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '请叫我小秦同学', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [existing] },
    })

    expect(result).toMatchObject({ action: 'REFINE', status: 'accepted', matchedMemoryId: existing.id })
  })

  it('does not automatically resurrect a user-suppressed memory', async () => {
    const existing = { ...record('suppressed-name', '用户姓名/名字：小秦', 'profile.name'), status: 'suppressed' as const }
    const candidate = memoryCandidate(existing.content, {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.95, importance: 0.9, extractionChannel: 'rules',
    })
    const result = await verifier(candidate, {
      turn: { userMessage: '我叫小秦', assistantMessage: '' },
      scope,
      matches: { exact: existing, activeByMemoryKey: [] },
    })

    expect(result).toMatchObject({
      action: 'NOOP', status: 'rejected', matchedMemoryId: existing.id,
      reasonCodes: ['user-lifecycle-state-protected'],
    })
  })

  it('quarantines an out-of-distribution calibrated cohort instead of falling back to a raw score', async () => {
    const calibratedVerifier = createLocalMemoryCandidateVerifier({
      calibrator: {
        version: 'test-ood-v1',
        calibrate: () => ({
          probability: 0.99, lowerBound: 0.95, upperBound: 1,
          status: 'out-of-distribution', sampleCount: 500, method: 'isotonic-pav',
          calibratorVersion: 'test-ood-v1', cohort: 'global',
        }),
      },
    })
    const candidate = memoryCandidate('用户姓名/名字：小秦', {
      kind: 'identity', memoryKey: 'profile.name', cardinality: 'single',
      confidence: 0.99, importance: 0.9, extractionChannel: 'new-model',
    })
    const result = await calibratedVerifier(candidate, {
      turn: { userMessage: '我叫小秦', assistantMessage: '' },
      scope,
      matches: { activeByMemoryKey: [] },
    })
    expect(result).toMatchObject({
      action: 'QUARANTINE', status: 'quarantined',
      reasonCodes: ['calibration-cohort-out-of-distribution'],
    })
  })
})

function memoryCandidate(content: string, metadata: Record<string, unknown>): MemoryCandidate {
  return { content, metadata }
}

function record(id: string, content: string, memoryKey: string): V3MemoryRecord {
  return {
    id,
    content,
    metadata: { kind: 'identity', cardinality: 'single' },
    status: 'active', origin: 'automatic', importance: 0.9, confidence: 0.95, accessCount: 0,
    memoryKey, sourceMessageIds: [], sourceAttachmentIds: [], sharePolicy: 'allow-remote', sensitivity: 'normal',
    scope: { ownerId: scope.ownerId, agentId: scope.agentId },
    embedding: [1, 0], embeddingModel: 'test', createdAt: 1, updatedAt: 1,
  }
}
