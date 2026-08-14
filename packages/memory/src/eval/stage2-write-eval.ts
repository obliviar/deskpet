import type { MemoryCapture, MemoryScope } from '@deskpet/contracts'
import type { MemoryCandidate, MemoryExtractor } from '../long-term/memory-extractor'
import { extractMemoryCandidates } from '../long-term/memory-extractor'
import type { MemoryCandidateEvaluation, MemoryCandidateVerifier } from '../long-term/memory-write-policy'
import { createLocalMemoryCandidateVerifier } from '../long-term/memory-write-policy'
import { createVectorStore } from '../long-term/vector-store'

export const MEMORY_STAGE2_EVAL_VERSION = 'stage2-write-eval-v1'

export interface MemoryStage2EvalExpectedFact {
  content: string
  outcome: 'active' | 'quarantined' | 'rejected'
  action?: MemoryCandidateEvaluation['action']
}

export interface MemoryStage2EvalCase {
  id: string
  category: string
  turn: MemoryCapture
  expected: MemoryStage2EvalExpectedFact[]
  existing?: Array<{ content: string; metadata: Record<string, unknown> }>
}

export interface MemoryStage2EvalError {
  caseId: string
  category: string
  type: 'false-positive' | 'false-negative' | 'wrong-outcome' | 'wrong-action' | 'unsupported-active'
  expected?: string
  actual?: string
}

export interface MemoryStage2EvalReport {
  evalVersion: string
  datasetVersion: string
  caseCount: number
  expectedFactCount: number
  predictedFactCount: number
  truePositive: number
  falsePositive: number
  falseNegative: number
  precision: number
  recall: number
  f1: number
  outcomeAccuracy: number
  operationAccuracy: number
  unsupportedActiveRate: number
  activePrecision: number
  confidence95: {
    precision: MemoryProportionInterval
    recall: MemoryProportionInterval
    activePrecision: MemoryProportionInterval
    unsupportedActiveRate: MemoryProportionInterval
  }
  qualityGate: {
    pointTargetsPassed: boolean
    confidenceBoundTargetsPassed: boolean
  }
  byCategory: Record<string, { cases: number; precision: number; recall: number; errors: number }>
  errors: MemoryStage2EvalError[]
}

export interface MemoryProportionInterval {
  successes: number
  total: number
  estimate: number
  /** One-sided 95% Wilson lower bound. */
  lower: number
  /** One-sided 95% Wilson upper bound. */
  upper: number
}

export interface RunMemoryStage2EvalOptions {
  datasetVersion: string
  extractor?: MemoryExtractor
  verifier?: MemoryCandidateVerifier
  scope?: MemoryScope
}

export async function runMemoryStage2WriteEval(
  cases: MemoryStage2EvalCase[],
  options: RunMemoryStage2EvalOptions,
): Promise<MemoryStage2EvalReport> {
  const extractor = options.extractor ?? extractMemoryCandidates
  const verifier = options.verifier ?? createLocalMemoryCandidateVerifier()
  const defaultScope = options.scope ?? { ownerId: 'stage2-eval-user', agentId: 'deskpet' }
  const errors: MemoryStage2EvalError[] = []
  const categoryStats = new Map<string, { cases: number; tp: number; fp: number; fn: number; errors: number }>()
  let expectedFactCount = 0
  let predictedFactCount = 0
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  let outcomeCorrect = 0
  let outcomeTotal = 0
  let operationCorrect = 0
  let operationTotal = 0
  let activePredictions = 0
  let activeCorrect = 0
  let unsupportedActive = 0

  for (const testCase of cases) {
    const scope = { ...defaultScope, sessionId: testCase.id }
    const store = createVectorStore({ minScore: 0, maxMemories: 1000 })
    for (const existing of testCase.existing ?? [])
      await store.remember(existing.content, scope, existing.metadata)
    const candidates = await extractor(testCase.turn)
    const actual: Array<{ candidate: MemoryCandidate; evaluation: MemoryCandidateEvaluation }> = []
    for (const candidate of candidates) {
      const memoryKey = typeof candidate.metadata.memoryKey === 'string'
        ? candidate.metadata.memoryKey
        : typeof candidate.metadata.predicate === 'string' ? candidate.metadata.predicate : undefined
      const matches = await store.inspectWriteMatches(candidate.content, scope, memoryKey)
      actual.push({ candidate, evaluation: await verifier(candidate, { turn: testCase.turn, scope, matches }) })
    }
    const category = categoryStats.get(testCase.category) ?? { cases: 0, tp: 0, fp: 0, fn: 0, errors: 0 }
    category.cases += 1
    categoryStats.set(testCase.category, category)
    expectedFactCount += testCase.expected.length
    predictedFactCount += actual.length
    const unmatched = new Set(actual.map((_, index) => index))
    for (const expected of testCase.expected) {
      const expectedKey = factKey(expected.content)
      const index = actual.findIndex((item, itemIndex) => unmatched.has(itemIndex) && factKey(item.candidate.content) === expectedKey)
      if (index < 0) {
        falseNegative += 1
        category.fn += 1
        category.errors += 1
        errors.push({ caseId: testCase.id, category: testCase.category, type: 'false-negative', expected: expected.content })
        continue
      }
      unmatched.delete(index)
      truePositive += 1
      category.tp += 1
      const evaluation = actual[index]!.evaluation
      const outcome = decisionOutcome(evaluation)
      outcomeTotal += 1
      if (outcome === expected.outcome)
        outcomeCorrect += 1
      else {
        category.errors += 1
        errors.push({ caseId: testCase.id, category: testCase.category, type: 'wrong-outcome', expected: expected.outcome, actual: outcome })
      }
      if (expected.action) {
        operationTotal += 1
        if (evaluation.action === expected.action)
          operationCorrect += 1
        else {
          category.errors += 1
          errors.push({ caseId: testCase.id, category: testCase.category, type: 'wrong-action', expected: expected.action, actual: evaluation.action })
        }
      }
      if (outcome === 'active') {
        activePredictions += 1
        if (expected.outcome === 'active')
          activeCorrect += 1
        else {
          unsupportedActive += 1
          errors.push({ caseId: testCase.id, category: testCase.category, type: 'unsupported-active', expected: expected.outcome, actual: evaluation.action })
        }
      }
    }
    for (const index of unmatched) {
      falsePositive += 1
      category.fp += 1
      category.errors += 1
      const item = actual[index]!
      errors.push({ caseId: testCase.id, category: testCase.category, type: 'false-positive', actual: item.candidate.content })
      if (decisionOutcome(item.evaluation) === 'active') {
        activePredictions += 1
        unsupportedActive += 1
        errors.push({ caseId: testCase.id, category: testCase.category, type: 'unsupported-active', actual: item.candidate.content })
      }
    }
  }
  const precision = ratio(truePositive, truePositive + falsePositive)
  const recall = ratio(truePositive, truePositive + falseNegative)
  const outcomeAccuracy = ratio(outcomeCorrect, outcomeTotal)
  const operationAccuracy = ratio(operationCorrect, operationTotal)
  const unsupportedActiveRate = ratio(unsupportedActive, activePredictions, 0)
  const activePrecision = ratio(activeCorrect, activePredictions)
  const confidence95 = {
    precision: wilsonInterval(truePositive, truePositive + falsePositive),
    recall: wilsonInterval(truePositive, truePositive + falseNegative),
    activePrecision: wilsonInterval(activeCorrect, activePredictions),
    unsupportedActiveRate: wilsonInterval(unsupportedActive, activePredictions),
  }
  return {
    evalVersion: MEMORY_STAGE2_EVAL_VERSION,
    datasetVersion: options.datasetVersion,
    caseCount: cases.length,
    expectedFactCount,
    predictedFactCount,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    outcomeAccuracy,
    operationAccuracy,
    unsupportedActiveRate,
    activePrecision,
    confidence95,
    qualityGate: {
      pointTargetsPassed: precision >= 0.95 && recall >= 0.85 && unsupportedActiveRate < 0.01
        && outcomeAccuracy >= 0.95 && operationAccuracy >= 0.95,
      confidenceBoundTargetsPassed: confidence95.precision.lower >= 0.95
        && confidence95.recall.lower >= 0.85
        && confidence95.unsupportedActiveRate.upper < 0.01,
    },
    byCategory: Object.fromEntries([...categoryStats].map(([key, value]) => [key, {
      cases: value.cases,
      precision: ratio(value.tp, value.tp + value.fp),
      recall: ratio(value.tp, value.tp + value.fn),
      errors: value.errors,
    }])),
    errors,
  }
}

function decisionOutcome(evaluation: MemoryCandidateEvaluation): MemoryStage2EvalExpectedFact['outcome'] {
  return evaluation.status === 'accepted' && evaluation.action !== 'NOOP' ? 'active'
    : evaluation.status === 'quarantined' ? 'quarantined' : 'rejected'
}

function factKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').replace(/[，。！？,.!?]/gu, '').toLocaleLowerCase()
}

function ratio(numerator: number, denominator: number, empty = 1): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : empty
}

function wilsonInterval(successes: number, total: number, z = 1.644854): MemoryProportionInterval {
  if (total <= 0)
    return { successes: 0, total: 0, estimate: 0, lower: 0, upper: 1 }
  const estimate = successes / total
  const denominator = 1 + z ** 2 / total
  const centre = (estimate + z ** 2 / (2 * total)) / denominator
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z ** 2 / (4 * total)) / total) / denominator
  return {
    successes,
    total,
    estimate: rounded(estimate),
    lower: rounded(Math.max(0, centre - margin)),
    upper: rounded(Math.min(1, centre + margin)),
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}
