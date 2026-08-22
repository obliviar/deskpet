import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MemoryRecallOptions } from '@deskpet/contracts'
import { createVectorStore } from '../long-term/vector-store'
import { assembleMemoryStage3BlindCases } from './stage3-blind-eval'
import type { MemoryStage3BlindCasePack, MemoryStage3BlindLabelPack } from './stage3-blind-eval'
import { runMemoryStage3RetrievalEval } from './stage3-retrieval-eval'

const casePath = process.env.DESKPET_MEMORY_STAGE3_BLIND_CASES
const labelPath = process.env.DESKPET_MEMORY_STAGE3_BLIND_LABELS
const expectedCaseSha256 = process.env.DESKPET_MEMORY_STAGE3_BLIND_CASE_SHA256
const expectedLabelSha256 = process.env.DESKPET_MEMORY_STAGE3_BLIND_LABEL_SHA256
const latencyTargetMs = Number(process.env.DESKPET_MEMORY_STAGE3_BLIND_P95_TARGET_MS ?? 100)
const externalConfigured = Boolean(casePath || labelPath || expectedCaseSha256 || expectedLabelSha256)

describe('externally administered stage 3 blind retrieval evaluation', () => {
  it.skipIf(!externalConfigured)('meets statistical release gates without exposing private labels', async () => {
    expect(casePath, 'DESKPET_MEMORY_STAGE3_BLIND_CASES is required').toBeTruthy()
    expect(labelPath, 'DESKPET_MEMORY_STAGE3_BLIND_LABELS is required').toBeTruthy()
    expect(expectedCaseSha256, 'DESKPET_MEMORY_STAGE3_BLIND_CASE_SHA256 is required').toMatch(/^[a-f0-9]{64}$/iu)
    expect(expectedLabelSha256, 'DESKPET_MEMORY_STAGE3_BLIND_LABEL_SHA256 is required').toMatch(/^[a-f0-9]{64}$/iu)

    const caseBytes = readFileSync(casePath!)
    const labelBytes = readFileSync(labelPath!)
    const caseSha256 = createHash('sha256').update(caseBytes).digest('hex')
    const labelSha256 = createHash('sha256').update(labelBytes).digest('hex')
    expect(caseSha256).toBe(expectedCaseSha256!.toLocaleLowerCase())
    expect(labelSha256).toBe(expectedLabelSha256!.toLocaleLowerCase())

    const casePack = JSON.parse(caseBytes.toString('utf-8')) as MemoryStage3BlindCasePack
    const labelPack = JSON.parse(labelBytes.toString('utf-8')) as MemoryStage3BlindLabelPack
    const assembled = assembleMemoryStage3BlindCases(casePack, labelPack)

    const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim().toLocaleLowerCase()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim()
    expect(dirty, 'External blind certification requires a clean worktree').toBe('')
    expect(labelPack.implementationCommit.toLocaleLowerCase()).toBe(implementationCommit)
    expect(assembled.cases.length, 'The external blind pack is too small for release certification').toBeGreaterThanOrEqual(300)
    expect(assembled.facts.length, 'The external blind pack has too few facts and distractors').toBeGreaterThanOrEqual(200)
    expect(new Set(assembled.cases.map(item => item.category)).size, 'The external blind pack lacks category diversity').toBeGreaterThanOrEqual(8)
    expect(labelPack.adjudicator, 'Repository-generated labels cannot certify an external blind evaluation')
      .not.toMatch(/repository-generated|synthetic|self-labeled/iu)
    const suppressedKeys = new Set(assembled.facts.filter(fact => fact.suppressAfterWrite).map(fact => fact.key))
    expect(assembled.cases.every(item => item.relevantKeys.every(key => !suppressedKeys.has(key))),
      'Suppressed facts must never be labeled relevant for ordinary recall').toBe(true)

    const store = createVectorStore()
    const scope = { ownerId: 'stage3-blind-eval', agentId: 'deskpet' }
    for (const fact of assembled.facts) {
      const metadata: Record<string, unknown> = {
        evalKey: fact.key,
        kind: fact.kind,
        importance: fact.importance ?? 0.85,
        confidence: 0.95,
        ...(fact.memoryKey ? { memoryKey: fact.memoryKey, cardinality: 'single' } : {}),
        ...(fact.validFrom ? { validFrom: Date.parse(fact.validFrom) } : {}),
        ...(fact.sensitivity ? { sensitivity: fact.sensitivity } : {}),
        ...(fact.sharePolicy ? { sharePolicy: fact.sharePolicy } : {}),
      }
      const remembered = await store.remember(fact.content, scope, metadata)
      if (fact.suppressAfterWrite && remembered)
        await store.update(remembered.id, scope, { status: 'suppressed' })
    }

    const report = await runMemoryStage3RetrievalEval(
      assembled.cases,
      (query: string, topK: number, options?: MemoryRecallOptions) => store.recall(query, scope, topK, options),
      { datasetVersion: assembled.datasetVersion, topK: 5 },
    )

    console.log(JSON.stringify({
      stage: 'memory-stage3-external-blind',
      datasetVersion: report.datasetVersion,
      casePackSha256: caseSha256,
      labelPackSha256: labelSha256,
      casePackFingerprint: labelPack.casePackFingerprint,
      implementationCommit,
      adjudicator: labelPack.adjudicator,
      caseCount: report.caseCount,
      factCount: assembled.facts.length,
      recallAt5: report.recallAtK,
      hitRateAt5: report.hitRateAtK,
      top1Accuracy: report.top1Accuracy,
      mrrAt5: report.mrrAtK,
      ndcgAt5: report.ndcgAtK,
      abstentionAccuracy: report.abstentionAccuracy,
      meanLatencyMs: report.meanLatencyMilliseconds,
      p95LatencyMs: report.p95LatencyMilliseconds,
      maxLatencyMs: report.maxLatencyMilliseconds,
      byCategory: report.byCategory,
    }))

    expect(report.recallAtK, 'Recall@5 must be >= 0.90').toBeGreaterThanOrEqual(0.90)
    expect(report.top1Accuracy, 'Top-1 accuracy must be >= 0.85').toBeGreaterThanOrEqual(0.85)
    expect(report.abstentionAccuracy, 'Abstention accuracy must be >= 0.95').toBeGreaterThanOrEqual(0.95)
    const temporal = report.byCategory.temporal
    if (temporal && temporal.answerableCases > 0)
      expect(temporal.top1Accuracy, 'Temporal Top-1 accuracy must be >= 0.95').toBeGreaterThanOrEqual(0.95)
    if (Number.isFinite(latencyTargetMs) && latencyTargetMs > 0)
      expect(report.p95LatencyMilliseconds, `P95 latency must be < ${latencyTargetMs} ms`).toBeLessThan(latencyTargetMs)
  }, 120_000)
})
