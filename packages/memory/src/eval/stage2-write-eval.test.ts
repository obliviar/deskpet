import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MemoryStage2EvalCase } from './stage2-write-eval'
import { runMemoryStage2WriteEval } from './stage2-write-eval'

interface Fixture {
  datasetVersion: string
  cases: Array<{
    id: string
    category: string
    userMessage: string
    context?: Array<{ role: 'user' | 'assistant'; content: string }>
    metadata?: Record<string, unknown>
    expected: MemoryStage2EvalCase['expected']
    existing?: MemoryStage2EvalCase['existing']
  }>
}

describe('stage 2 frozen write evaluation', () => {
  it('meets the product write quality gates and reports error types', async () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../evals/memory/stage2-write-frozen-v1.json', import.meta.url)), 'utf-8')) as Fixture
    const cases: MemoryStage2EvalCase[] = fixture.cases.map(item => ({
      id: item.id,
      category: item.category,
      turn: {
        userMessage: item.userMessage,
        assistantMessage: '',
        ...(item.context ? { context: { recentMessages: item.context } } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
      },
      expected: item.expected,
      ...(item.existing ? { existing: item.existing } : {}),
    }))
    const report = await runMemoryStage2WriteEval(cases, { datasetVersion: fixture.datasetVersion })
    console.log(JSON.stringify({ stage: 'memory-stage2-write-eval', ...report }))
    expect(report.precision).toBeGreaterThanOrEqual(0.95)
    expect(report.recall).toBeGreaterThanOrEqual(0.85)
    expect(report.unsupportedActiveRate).toBeLessThan(0.01)
    expect(report.outcomeAccuracy).toBeGreaterThanOrEqual(0.95)
    expect(report.operationAccuracy).toBeGreaterThanOrEqual(0.95)
    expect(report.qualityGate.pointTargetsPassed).toBe(true)
    // Twenty-four repository-visible cases are a regression suite, not enough
    // evidence to certify the product thresholds with one-sided 95% bounds.
    expect(report.qualityGate.confidenceBoundTargetsPassed).toBe(false)
    expect(report.confidence95.precision.lower).toBeLessThan(0.95)
  })
})
