import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryConsolidationService } from '../v4/consolidation/memory-consolidation-service'
import { migrateV3PayloadToV4 } from '../v4/migration/v3-to-v4'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createMemoryV4ShadowRetriever } from '../v4/retrieval/memory-v4-shadow-retriever'
import { createVectorStore } from '../long-term/vector-store'
import {
  evaluateMemoryV4RolloutGate,
  fingerprintMemoryV4RolloutDataset,
  parseMemoryV4RolloutDataset,
  recommendMemoryV4RolloutTransition,
  runMemoryV4RolloutEvaluation,
  type MemoryV4RolloutDataset,
  type MemoryV4RolloutRetrievalStrategy,
} from './stage5-v4-rollout-eval'

const NOW = Date.UTC(2026, 7, 25)
const fixturePath = fileURLToPath(new URL('../../../../evals/memory/stage5-v4-rollout-dev-v1.json', import.meta.url))

function fixture(): MemoryV4RolloutDataset {
  return parseMemoryV4RolloutDataset(readFileSync(fixturePath, 'utf8'))
}

describe('Stage 5 versioned V3/V4 ground-truth evaluation', () => {
  it('validates and fingerprints a label set without exposing labels to retrieval strategies', async () => {
    const dataset = fixture()
    const strategy = vi.fn<MemoryV4RolloutRetrievalStrategy>((request) => {
      expect(request).not.toHaveProperty('relevantFactIds')
      expect(request).not.toHaveProperty('forbiddenFactIds')
      return { retrievedFactIds: [], latencyMs: 2 }
    })
    const report = await runMemoryV4RolloutEvaluation(dataset, { v3: strategy, v4: strategy }, { now: () => NOW })

    expect(report).toMatchObject({
      datasetVersion: 'deskpet-stage5-v4-rollout-dev-v1',
      datasetPurpose: 'development',
      caseCount: 8,
      executionOrder: 'counterbalanced',
    })
    expect(report.datasetFingerprint).toBe(fingerprintMemoryV4RolloutDataset(dataset))
    expect(report.datasetFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(report)).not.toContain('我平时爱喝哪种饮品')
    expect(strategy).toHaveBeenCalledTimes(16)
  })

  it('rejects ambiguous, duplicate and malformed truth labels', () => {
    const dataset = fixture()
    const duplicate = structuredClone(dataset)
    duplicate.cases[1]!.id = duplicate.cases[0]!.id
    expect(() => parseMemoryV4RolloutDataset(JSON.stringify(duplicate))).toThrow(/Duplicate/u)

    const overlap = structuredClone(dataset)
    overlap.cases[0]!.forbiddenFactIds = [...overlap.cases[0]!.relevantFactIds]
    expect(() => parseMemoryV4RolloutDataset(JSON.stringify(overlap))).toThrow(/overlapping/u)

    const safetyWithoutForbidden = structuredClone(dataset)
    safetyWithoutForbidden.cases[0]!.safetyTags = ['privacy']
    expect(() => parseMemoryV4RolloutDataset(JSON.stringify(safetyWithoutForbidden))).toThrow(/requires forbidden facts/u)
  })

  it('runs the repository-visible development set against independent V3 and V4 retrieval paths', async () => {
    const dataset = fixture()
    const payload = seedV3Payload()
    const v3 = createVectorStore({
      persistence: { load: () => payload, save: () => undefined },
    })
    const repository = createMemoryV4Repository({ now: () => NOW })
    repository.replace(migrateV3PayloadToV4(payload, { now: () => NOW }))
    await createMemoryConsolidationService(repository).consolidate(
      { ownerId: 'rollout-user', agentId: 'deskpet' },
      { granularity: ['session', 'day', 'topic', 'entity', 'stage'] },
    )
    const v4 = createMemoryV4ShadowRetriever(repository, { now: () => NOW })

    const report = await runMemoryV4RolloutEvaluation(dataset, {
      v3: async (request, topK) => ({
        retrievedFactIds: (await v3.recall(request.query, request.scope, topK, request.options)).map(memory => memory.id),
      }),
      v4: (request, topK) => ({
        retrievedFactIds: v4.recall(request.query, {
          scope: request.scope,
          limit: topK,
          ...request.options,
        }).hits.map(hit => hit.sourceMemoryId ?? hit.factId),
      }),
    }, { topK: 5, now: () => NOW })

    expect(report.v4.failureCases).toBe(0)
    expect(report.v4.forbiddenLeakCases).toBe(0)
    expect(report.v4.byCategory.privacy?.forbiddenLeakCases).toBe(0)
    expect(report.v4.byCategory.deletion?.forbiddenLeakCases).toBe(0)
    expect(report.v4.byCategory.scope?.forbiddenLeakCases).toBe(0)
    expect(evaluateMemoryV4RolloutGate(report)).toMatchObject({
      decision: 'insufficient-data',
      authoritativeAnswerSource: 'v3',
      automaticPromotion: false,
    })
  })
})

describe('Stage 5 fail-closed rollout gate', () => {
  it('never accepts a missing report or a repository-visible development set', async () => {
    expect(evaluateMemoryV4RolloutGate()).toMatchObject({
      decision: 'insufficient-data',
      failedCheckIds: ['trusted-ground-truth-report-loaded'],
    })

    const dataset = fixture()
    const perfect: MemoryV4RolloutRetrievalStrategy = request => ({
      retrievedFactIds: dataset.cases.find(testCase => testCase.id === request.caseId)?.relevantFactIds ?? [],
      latencyMs: 1,
    })
    const report = await runMemoryV4RolloutEvaluation(dataset, { v3: perfect, v4: perfect }, { now: () => NOW })
    const gate = evaluateMemoryV4RolloutGate(report, permissivePolicy())
    expect(gate.decision).toBe('insufficient-data')
    expect(gate.failedCheckIds).toContain('trusted-dataset-purpose')
  })

  it('uses sample, confidence, non-inferiority, safety and latency checks before internal review eligibility', async () => {
    const dataset = { ...fixture(), purpose: 'external-blind' as const }
    const perfect: MemoryV4RolloutRetrievalStrategy = request => ({
      retrievedFactIds: dataset.cases.find(testCase => testCase.id === request.caseId)?.relevantFactIds ?? [],
      latencyMs: 5,
    })
    const report = await runMemoryV4RolloutEvaluation(dataset, { v3: perfect, v4: perfect }, { now: () => NOW })
    const gate = evaluateMemoryV4RolloutGate(report, permissivePolicy())

    expect(gate.decision).toBe('eligible-for-internal-review')
    expect(gate.failedCheckIds).toEqual([])
    expect(gate.authoritativeAnswerSource).toBe('v3')
    expect(gate.automaticPromotion).toBe(false)
  })

  it('blocks observed leakage and rolls any live rollout stage back to shadow', async () => {
    const dataset = { ...fixture(), purpose: 'external-blind' as const }
    const v3: MemoryV4RolloutRetrievalStrategy = request => ({
      retrievedFactIds: dataset.cases.find(testCase => testCase.id === request.caseId)?.relevantFactIds ?? [],
      latencyMs: 5,
    })
    const v4: MemoryV4RolloutRetrievalStrategy = request => ({
      retrievedFactIds: request.caseId === 'remote-private-filter' ? ['secret'] : [],
      latencyMs: 5,
    })
    const report = await runMemoryV4RolloutEvaluation(dataset, { v3, v4 }, { now: () => NOW })
    const gate = evaluateMemoryV4RolloutGate(report, permissivePolicy())
    const transition = recommendMemoryV4RolloutTransition('percent-10', gate, { manualApproval: true })

    expect(gate.decision).toBe('blocked')
    expect(gate.failedCheckIds).toContain('zero-forbidden-leak-cases')
    expect(transition).toMatchObject({
      recommendedStage: 'shadow',
      automaticRollbackRequired: true,
      manualApprovalConsumed: false,
    })
  })

  it('requires explicit approval and advances at most one stage after a passing gate', async () => {
    const dataset = { ...fixture(), purpose: 'production-audit' as const }
    const perfect: MemoryV4RolloutRetrievalStrategy = request => ({
      retrievedFactIds: dataset.cases.find(testCase => testCase.id === request.caseId)?.relevantFactIds ?? [],
      latencyMs: 5,
    })
    const report = await runMemoryV4RolloutEvaluation(dataset, { v3: perfect, v4: perfect }, { now: () => NOW })
    const gate = evaluateMemoryV4RolloutGate(report, permissivePolicy())

    expect(recommendMemoryV4RolloutTransition('shadow', gate)).toMatchObject({
      recommendedStage: 'shadow', manualApprovalConsumed: false,
    })
    expect(recommendMemoryV4RolloutTransition('shadow', gate, { manualApproval: true })).toMatchObject({
      recommendedStage: 'internal', manualApprovalConsumed: true,
    })
    expect(recommendMemoryV4RolloutTransition('internal', gate, { manualApproval: true })).toMatchObject({
      recommendedStage: 'internal', manualApprovalConsumed: false,
    })
  })

  it('hashes failure text and does not retain a custom potentially sensitive error name', async () => {
    const dataset = fixture()
    const report = await runMemoryV4RolloutEvaluation(dataset, {
      v3: () => ({ retrievedFactIds: [] }),
      v4: () => {
        const error = new Error('private query and provider details')
        error.name = 'UserSecretInCustomErrorName'
        throw error
      },
    }, { now: () => NOW })

    expect(report.v4.failures[0]).toMatchObject({ errorName: 'OtherError' })
    expect(report.v4.failures[0]?.errorFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(report)).not.toContain('private query and provider details')
    expect(JSON.stringify(report)).not.toContain('UserSecretInCustomErrorName')
  })
})

function permissivePolicy() {
  return {
    minimumCases: 1,
    minimumAnswerableCases: 1,
    minimumAbstentionCases: 1,
    minimumSafetyCases: 1,
    minimumRecallLower95: 0,
    minimumTop1Lower95: 0,
    minimumAbstentionLower95: 0,
    maximumFailureRate: 1,
    maximumFailureUpper95: 1,
    maximumForbiddenLeakUpper95: 1,
    maximumP95LatencyMs: 100,
    maximumP99LatencyMs: 100,
  }
}

function seedV3Payload(): string {
  const scope = { ownerId: 'rollout-user', agentId: 'deskpet', sessionId: 'session-a' }
  const item = (id: string, content: string, memoryKey: string, patch: Record<string, unknown> = {}) => ({
    id,
    content,
    metadata: { kind: memoryKey.split('.')[0], cardinality: 'single' },
    status: 'active',
    origin: 'manual',
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    memoryKey,
    sourceMessageIds: [`source-${id}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope,
    embedding: [],
    embeddingModel: 'local-hash-v3',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...patch,
  })
  return JSON.stringify({
    version: 3,
    items: [
      item('coffee', '用户喜欢喝手冲咖啡', 'preference.drink'),
      item('name', '用户姓名/名字：小秦', 'profile.name'),
      item('secret', '用户的私人备注：不可外发', 'profile.note', {
        sharePolicy: 'local-only', sensitivity: 'private',
      }),
      item('old-project', '用户以前的项目：OldDesk', 'project.current', {
        status: 'superseded',
        validFrom: Date.UTC(2024, 0, 1),
        validTo: Date.UTC(2025, 0, 1),
        invalidatedAt: Date.UTC(2025, 0, 2),
        createdAt: Date.UTC(2024, 0, 1),
        updatedAt: Date.UTC(2025, 0, 2),
      }),
      item('deleted-door', '用户删除过的门禁码：4826', 'private.door-code', { status: 'deleted' }),
      item('other-owner-code', '另一个用户的内部代号：ORBIT', 'profile.code', {
        scope: { ownerId: 'other-user', agentId: 'deskpet' },
      }),
    ],
  })
}
