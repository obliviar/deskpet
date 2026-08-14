import type { MemoryFragment, MemoryRecallOptions } from '@deskpet/contracts'
import { performance } from 'node:perf_hooks'

export const MEMORY_STAGE3_RETRIEVAL_EVAL_VERSION = 'memory-stage3-retrieval-eval-v1'

export interface MemoryStage3RetrievalEvalCase {
  id: string
  category: string
  query: string
  relevantKeys: string[]
  options?: MemoryRecallOptions
}

export interface MemoryStage3RetrievalMetrics {
  answerableCases: number
  abstentionCases: number
  recallAtK: number
  hitRateAtK: number
  top1Accuracy: number
  mrrAtK: number
  ndcgAtK: number
  abstentionAccuracy: number
  meanLatencyMilliseconds: number
  p95LatencyMilliseconds: number
  maxLatencyMilliseconds: number
}

export interface MemoryStage3RetrievalEvalReport extends MemoryStage3RetrievalMetrics {
  evalVersion: typeof MEMORY_STAGE3_RETRIEVAL_EVAL_VERSION
  datasetVersion: string
  topK: number
  caseCount: number
  byCategory: Record<string, MemoryStage3RetrievalMetrics>
  failures: Array<{
    id: string
    category: string
    relevantKeys: string[]
    retrievedKeys: string[]
  }>
  top1Failures: Array<{
    id: string
    category: string
    relevantKeys: string[]
    retrievedKey?: string
  }>
}

export async function runMemoryStage3RetrievalEval(
  cases: readonly MemoryStage3RetrievalEvalCase[],
  retrieve: (query: string, topK: number, options?: MemoryRecallOptions) => Promise<MemoryFragment[]>,
  options: { datasetVersion: string; topK?: number },
): Promise<MemoryStage3RetrievalEvalReport> {
  const topK = clampInteger(options.topK, 1, 100, 5)
  const outcomes: EvalOutcome[] = []
  for (const testCase of cases) {
    const startedAt = performance.now()
    const memories = await retrieve(testCase.query, topK, testCase.options)
    const elapsed = performance.now() - startedAt
    const retrievedKeys = memories
      .map(memory => typeof memory.metadata?.evalKey === 'string' ? memory.metadata.evalKey : memory.id)
      .slice(0, topK)
    outcomes.push({ testCase, retrievedKeys, elapsed })
  }

  const metrics = summarize(outcomes, topK)
  const categories = [...new Set(cases.map(testCase => testCase.category))].sort()
  const byCategory = Object.fromEntries(categories.map(category => [
    category,
    summarize(outcomes.filter(outcome => outcome.testCase.category === category), topK),
  ]))
  const failures = outcomes
    .filter((outcome) => {
      const relevant = new Set(outcome.testCase.relevantKeys)
      return relevant.size === 0
        ? outcome.retrievedKeys.length > 0
        : !outcome.retrievedKeys.some(key => relevant.has(key))
    })
    .map(outcome => ({
      id: outcome.testCase.id,
      category: outcome.testCase.category,
      relevantKeys: outcome.testCase.relevantKeys,
      retrievedKeys: outcome.retrievedKeys,
    }))
  const top1Failures = outcomes
    .filter(outcome => outcome.testCase.relevantKeys.length > 0
      && !outcome.testCase.relevantKeys.includes(outcome.retrievedKeys[0] ?? ''))
    .map(outcome => ({
      id: outcome.testCase.id,
      category: outcome.testCase.category,
      relevantKeys: outcome.testCase.relevantKeys,
      ...(outcome.retrievedKeys[0] ? { retrievedKey: outcome.retrievedKeys[0] } : {}),
    }))

  return {
    evalVersion: MEMORY_STAGE3_RETRIEVAL_EVAL_VERSION,
    datasetVersion: options.datasetVersion,
    topK,
    caseCount: cases.length,
    ...metrics,
    byCategory,
    failures,
    top1Failures,
  }
}

interface EvalOutcome {
  testCase: MemoryStage3RetrievalEvalCase
  retrievedKeys: string[]
  elapsed: number
}

function summarize(outcomes: readonly EvalOutcome[], topK: number): MemoryStage3RetrievalMetrics {
  const answerable = outcomes.filter(outcome => outcome.testCase.relevantKeys.length > 0)
  const abstention = outcomes.filter(outcome => outcome.testCase.relevantKeys.length === 0)
  const recalls = answerable.map((outcome) => {
    const relevant = new Set(outcome.testCase.relevantKeys)
    return outcome.retrievedKeys.filter(key => relevant.has(key)).length / relevant.size
  })
  const reciprocalRanks = answerable.map((outcome) => {
    const relevant = new Set(outcome.testCase.relevantKeys)
    const index = outcome.retrievedKeys.findIndex(key => relevant.has(key))
    return index < 0 ? 0 : 1 / (index + 1)
  })
  const ndcg = answerable.map(outcome => binaryNdcg(outcome.retrievedKeys, new Set(outcome.testCase.relevantKeys), topK))
  const latencies = outcomes.map(outcome => outcome.elapsed).sort((left, right) => left - right)
  return {
    answerableCases: answerable.length,
    abstentionCases: abstention.length,
    recallAtK: rounded(mean(recalls)),
    hitRateAtK: rounded(mean(recalls.map(value => value > 0 ? 1 : 0))),
    top1Accuracy: rounded(mean(answerable.map(outcome => outcome.testCase.relevantKeys.includes(outcome.retrievedKeys[0] ?? '') ? 1 : 0))),
    mrrAtK: rounded(mean(reciprocalRanks)),
    ndcgAtK: rounded(mean(ndcg)),
    abstentionAccuracy: rounded(mean(abstention.map(outcome => outcome.retrievedKeys.length === 0 ? 1 : 0))),
    meanLatencyMilliseconds: rounded(mean(latencies)),
    p95LatencyMilliseconds: rounded(percentile(latencies, 0.95)),
    maxLatencyMilliseconds: rounded(latencies.at(-1) ?? 0),
  }
}

function binaryNdcg(retrieved: readonly string[], relevant: ReadonlySet<string>, topK: number): number {
  let dcg = 0
  for (const [index, key] of retrieved.slice(0, topK).entries()) {
    if (relevant.has(key))
      dcg += 1 / Math.log2(index + 2)
  }
  let ideal = 0
  for (let index = 0; index < Math.min(topK, relevant.size); index++)
    ideal += 1 / Math.log2(index + 2)
  return ideal > 0 ? dcg / ideal : 0
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0)
    return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
