import type {
  MemoryRecallOptions,
  MemoryScope,
  MemorySensitivity,
  MemorySharePolicy,
  MemoryTemporalMode,
} from '@deskpet/contracts'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const MEMORY_STAGE5_V4_ROLLOUT_DATASET_SCHEMA_VERSION = 1 as const
export const MEMORY_STAGE5_V4_ROLLOUT_EVAL_VERSION = 'memory-stage5-v4-rollout-eval-v1'
export const MEMORY_STAGE5_V4_ROLLOUT_GATE_VERSION = 'memory-stage5-v4-rollout-gate-v1'
export const MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION = 'memory-stage5-v4-rollout-transition-v1'

export type MemoryV4RolloutDatasetPurpose = 'development' | 'external-blind' | 'production-audit'
export type MemoryV4RolloutSafetyTag = 'privacy' | 'deletion' | 'scope' | 'temporal'
export type MemoryV4RolloutStage = 'off' | 'shadow' | 'internal' | 'percent-1' | 'percent-10' | 'percent-50' | 'percent-100'

export interface MemoryV4RolloutEvalCase {
  id: string
  category: string
  query: string
  scope: MemoryScope
  relevantFactIds: string[]
  forbiddenFactIds: string[]
  safetyTags: MemoryV4RolloutSafetyTag[]
  options?: MemoryRecallOptions
}

export interface MemoryV4RolloutDataset {
  schemaVersion: typeof MEMORY_STAGE5_V4_ROLLOUT_DATASET_SCHEMA_VERSION
  datasetVersion: string
  purpose: MemoryV4RolloutDatasetPurpose
  createdAt: number
  description?: string
  cases: MemoryV4RolloutEvalCase[]
}

/** Truth labels are deliberately excluded so a strategy cannot read the answer. */
export interface MemoryV4RolloutQuery {
  caseId: string
  category: string
  query: string
  scope: MemoryScope
  options?: MemoryRecallOptions
}

export interface MemoryV4RolloutRetrievalResult {
  retrievedFactIds: readonly string[]
  /** Optional measured latency supplied by an isolated runner. */
  latencyMs?: number
}

export type MemoryV4RolloutRetrievalStrategy = (
  request: Readonly<MemoryV4RolloutQuery>,
  topK: number,
) => MemoryV4RolloutRetrievalResult | Promise<MemoryV4RolloutRetrievalResult>

export interface MemoryV4RolloutProportionInterval {
  successes: number
  total: number
  estimate: number
  /** One-sided 95% Wilson lower bound. */
  lower: number
  /** One-sided 95% Wilson upper bound. */
  upper: number
}

export interface MemoryV4RolloutStrategyMetrics {
  cases: number
  answerableCases: number
  abstentionCases: number
  safetyCases: number
  relevantFacts: number
  retrievedRelevantFacts: number
  recallAtK: number
  precisionAtK: number
  hitRateAtK: number
  top1Accuracy: number
  mrrAtK: number
  ndcgAtK: number
  abstentionAccuracy: number
  failureRate: number
  forbiddenLeakRate: number
  failureCases: number
  forbiddenLeakCases: number
  latencyMs: {
    mean: number
    p50: number
    p95: number
    p99: number
    max: number
  }
  confidence95: {
    recall: MemoryV4RolloutProportionInterval
    precision: MemoryV4RolloutProportionInterval
    hitRate: MemoryV4RolloutProportionInterval
    top1Accuracy: MemoryV4RolloutProportionInterval
    abstentionAccuracy: MemoryV4RolloutProportionInterval
    failureRate: MemoryV4RolloutProportionInterval
    forbiddenLeakRate: MemoryV4RolloutProportionInterval
  }
  safetyByTag: Record<MemoryV4RolloutSafetyTag, { cases: number; leakCases: number; leakRate: number }>
}

export interface MemoryV4RolloutStrategyReport extends MemoryV4RolloutStrategyMetrics {
  byCategory: Record<string, MemoryV4RolloutStrategyMetrics>
  failures: Array<{ caseId: string; errorName: string; errorFingerprint: string }>
  leakages: Array<{ caseId: string; safetyTags: MemoryV4RolloutSafetyTag[]; forbiddenFactIds: string[] }>
}

export interface MemoryV4RolloutEvaluationReport {
  evalVersion: typeof MEMORY_STAGE5_V4_ROLLOUT_EVAL_VERSION
  datasetVersion: string
  datasetPurpose: MemoryV4RolloutDatasetPurpose
  datasetFingerprint: string
  evaluatedAt: number
  topK: number
  caseCount: number
  executionOrder: 'counterbalanced'
  v3: MemoryV4RolloutStrategyReport
  v4: MemoryV4RolloutStrategyReport
  deltaV4MinusV3: {
    recallAtK: number
    precisionAtK: number
    hitRateAtK: number
    top1Accuracy: number
    mrrAtK: number
    ndcgAtK: number
    abstentionAccuracy: number
    failureRate: number
    forbiddenLeakRate: number
    p95LatencyMs: number
  }
}

export interface MemoryV4RolloutGatePolicy {
  trustedPurposes: MemoryV4RolloutDatasetPurpose[]
  minimumCases: number
  minimumAnswerableCases: number
  minimumAbstentionCases: number
  minimumSafetyCases: number
  minimumRecallLower95: number
  minimumTop1Lower95: number
  minimumAbstentionLower95: number
  maximumRecallRegression: number
  maximumTop1Regression: number
  maximumAbstentionRegression: number
  maximumFailureRate: number
  maximumFailureUpper95: number
  maximumForbiddenLeakCases: number
  maximumForbiddenLeakUpper95: number
  maximumP95LatencyMs: number
  maximumP99LatencyMs: number
}

export type MemoryV4RolloutGateDecision = 'insufficient-data' | 'blocked' | 'eligible-for-internal-review'

export interface MemoryV4RolloutGateCheck {
  id: string
  kind: 'evidence' | 'quality' | 'redline'
  passed: boolean
  observed: number | string
  required: number | string
}

export interface MemoryV4RolloutGateReport {
  version: typeof MEMORY_STAGE5_V4_ROLLOUT_GATE_VERSION
  decision: MemoryV4RolloutGateDecision
  authoritativeAnswerSource: 'v3'
  automaticPromotion: false
  datasetVersion?: string
  datasetFingerprint?: string
  checks: MemoryV4RolloutGateCheck[]
  failedCheckIds: string[]
  reason: string
}

export interface MemoryV4RolloutTransition {
  version: typeof MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION
  currentStage: MemoryV4RolloutStage
  recommendedStage: MemoryV4RolloutStage
  automaticRollbackRequired: boolean
  manualApprovalConsumed: boolean
  reason: string
}

export const DEFAULT_MEMORY_V4_ROLLOUT_GATE_POLICY: Readonly<MemoryV4RolloutGatePolicy> = Object.freeze({
  trustedPurposes: ['external-blind', 'production-audit'] as MemoryV4RolloutDatasetPurpose[],
  minimumCases: 1_000,
  minimumAnswerableCases: 500,
  minimumAbstentionCases: 200,
  minimumSafetyCases: 300,
  minimumRecallLower95: 0.90,
  minimumTop1Lower95: 0.85,
  minimumAbstentionLower95: 0.95,
  maximumRecallRegression: 0.02,
  maximumTop1Regression: 0.02,
  maximumAbstentionRegression: 0.02,
  maximumFailureRate: 0.005,
  maximumFailureUpper95: 0.01,
  maximumForbiddenLeakCases: 0,
  maximumForbiddenLeakUpper95: 0.01,
  maximumP95LatencyMs: 100,
  maximumP99LatencyMs: 250,
})

export function parseMemoryV4RolloutDataset(payload: string): MemoryV4RolloutDataset {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse Stage 5 rollout dataset: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeDataset(parsed)
}

export function fingerprintMemoryV4RolloutDataset(dataset: MemoryV4RolloutDataset): string {
  const normalized = normalizeDataset(dataset)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export async function runMemoryV4RolloutEvaluation(
  datasetInput: MemoryV4RolloutDataset,
  strategies: { v3: MemoryV4RolloutRetrievalStrategy; v4: MemoryV4RolloutRetrievalStrategy },
  options: { topK?: number; now?: () => number } = {},
): Promise<MemoryV4RolloutEvaluationReport> {
  const dataset = normalizeDataset(datasetInput)
  const topK = clampInteger(options.topK ?? 5, 1, 100)
  const pairs: EvaluationPair[] = []
  for (const [index, testCase] of dataset.cases.entries()) {
    const request = queryRequest(testCase)
    let v3: StrategyOutcome
    let v4: StrategyOutcome
    if (index % 2 === 0) {
      v3 = await executeStrategy(strategies.v3, request, topK)
      v4 = await executeStrategy(strategies.v4, request, topK)
    }
    else {
      v4 = await executeStrategy(strategies.v4, request, topK)
      v3 = await executeStrategy(strategies.v3, request, topK)
    }
    pairs.push({ testCase, v3, v4 })
  }
  const v3 = strategyReport(pairs.map(pair => ({ testCase: pair.testCase, outcome: pair.v3 })), topK)
  const v4 = strategyReport(pairs.map(pair => ({ testCase: pair.testCase, outcome: pair.v4 })), topK)
  return {
    evalVersion: MEMORY_STAGE5_V4_ROLLOUT_EVAL_VERSION,
    datasetVersion: dataset.datasetVersion,
    datasetPurpose: dataset.purpose,
    datasetFingerprint: fingerprintMemoryV4RolloutDataset(dataset),
    evaluatedAt: positiveTimestamp((options.now ?? Date.now)()),
    topK,
    caseCount: dataset.cases.length,
    executionOrder: 'counterbalanced',
    v3,
    v4,
    deltaV4MinusV3: {
      recallAtK: rounded(v4.recallAtK - v3.recallAtK),
      precisionAtK: rounded(v4.precisionAtK - v3.precisionAtK),
      hitRateAtK: rounded(v4.hitRateAtK - v3.hitRateAtK),
      top1Accuracy: rounded(v4.top1Accuracy - v3.top1Accuracy),
      mrrAtK: rounded(v4.mrrAtK - v3.mrrAtK),
      ndcgAtK: rounded(v4.ndcgAtK - v3.ndcgAtK),
      abstentionAccuracy: rounded(v4.abstentionAccuracy - v3.abstentionAccuracy),
      failureRate: rounded(v4.failureRate - v3.failureRate),
      forbiddenLeakRate: rounded(v4.forbiddenLeakRate - v3.forbiddenLeakRate),
      p95LatencyMs: rounded(v4.latencyMs.p95 - v3.latencyMs.p95),
    },
  }
}

/**
 * Fail-closed gate. Development data and missing reports can never unlock V4;
 * passing only makes a build eligible for explicit internal review.
 */
export function evaluateMemoryV4RolloutGate(
  report?: MemoryV4RolloutEvaluationReport,
  overrides: Partial<MemoryV4RolloutGatePolicy> = {},
): MemoryV4RolloutGateReport {
  if (!report) {
    return {
      version: MEMORY_STAGE5_V4_ROLLOUT_GATE_VERSION,
      decision: 'insufficient-data',
      authoritativeAnswerSource: 'v3',
      automaticPromotion: false,
      checks: [{
        id: 'trusted-ground-truth-report-loaded',
        kind: 'evidence',
        passed: false,
        observed: 'missing',
        required: 'versioned external-blind or production-audit report',
      }],
      failedCheckIds: ['trusted-ground-truth-report-loaded'],
      reason: 'No trusted versioned ground-truth report is loaded; V3 remains authoritative.',
    }
  }
  const policy = normalizeGatePolicy(overrides)
  const checks: MemoryV4RolloutGateCheck[] = []
  const add = (
    id: string,
    kind: MemoryV4RolloutGateCheck['kind'],
    observed: number | string,
    required: number | string,
    passed: boolean,
  ) => checks.push({ id, kind, observed, required, passed })

  add('trusted-dataset-purpose', 'evidence', report.datasetPurpose, policy.trustedPurposes.join('|'), policy.trustedPurposes.includes(report.datasetPurpose))
  add('minimum-cases', 'evidence', report.caseCount, policy.minimumCases, report.caseCount >= policy.minimumCases)
  add('minimum-answerable-cases', 'evidence', report.v4.answerableCases, policy.minimumAnswerableCases, report.v4.answerableCases >= policy.minimumAnswerableCases)
  add('minimum-abstention-cases', 'evidence', report.v4.abstentionCases, policy.minimumAbstentionCases, report.v4.abstentionCases >= policy.minimumAbstentionCases)
  add('minimum-safety-cases', 'evidence', report.v4.safetyCases, policy.minimumSafetyCases, report.v4.safetyCases >= policy.minimumSafetyCases)

  add('zero-forbidden-leak-cases', 'redline', report.v4.forbiddenLeakCases, policy.maximumForbiddenLeakCases, report.v4.forbiddenLeakCases <= policy.maximumForbiddenLeakCases)
  add('v4-failure-rate-point', 'redline', report.v4.failureRate, policy.maximumFailureRate, report.v4.failureRate <= policy.maximumFailureRate)
  add('v4-p95-latency', 'redline', report.v4.latencyMs.p95, policy.maximumP95LatencyMs, report.v4.latencyMs.p95 <= policy.maximumP95LatencyMs)
  add('v4-p99-latency', 'redline', report.v4.latencyMs.p99, policy.maximumP99LatencyMs, report.v4.latencyMs.p99 <= policy.maximumP99LatencyMs)

  add('v4-forbidden-leak-upper95', 'quality', report.v4.confidence95.forbiddenLeakRate.upper, policy.maximumForbiddenLeakUpper95, report.v4.confidence95.forbiddenLeakRate.upper <= policy.maximumForbiddenLeakUpper95)
  add('v4-failure-upper95', 'quality', report.v4.confidence95.failureRate.upper, policy.maximumFailureUpper95, report.v4.confidence95.failureRate.upper <= policy.maximumFailureUpper95)
  add('v4-recall-lower95', 'quality', report.v4.confidence95.recall.lower, policy.minimumRecallLower95, report.v4.confidence95.recall.lower >= policy.minimumRecallLower95)
  add('v4-top1-lower95', 'quality', report.v4.confidence95.top1Accuracy.lower, policy.minimumTop1Lower95, report.v4.confidence95.top1Accuracy.lower >= policy.minimumTop1Lower95)
  add('v4-abstention-lower95', 'quality', report.v4.confidence95.abstentionAccuracy.lower, policy.minimumAbstentionLower95, report.v4.confidence95.abstentionAccuracy.lower >= policy.minimumAbstentionLower95)
  add('v4-recall-noninferiority-point', 'quality', report.deltaV4MinusV3.recallAtK, -policy.maximumRecallRegression, report.deltaV4MinusV3.recallAtK >= -policy.maximumRecallRegression)
  add('v4-top1-noninferiority-point', 'quality', report.deltaV4MinusV3.top1Accuracy, -policy.maximumTop1Regression, report.deltaV4MinusV3.top1Accuracy >= -policy.maximumTop1Regression)
  add('v4-abstention-noninferiority-point', 'quality', report.deltaV4MinusV3.abstentionAccuracy, -policy.maximumAbstentionRegression, report.deltaV4MinusV3.abstentionAccuracy >= -policy.maximumAbstentionRegression)
  add('v4-recall-noninferiority-lower95', 'quality', report.v4.confidence95.recall.lower - report.v3.confidence95.recall.lower, -policy.maximumRecallRegression, report.v4.confidence95.recall.lower + policy.maximumRecallRegression >= report.v3.confidence95.recall.lower)
  add('v4-top1-noninferiority-lower95', 'quality', report.v4.confidence95.top1Accuracy.lower - report.v3.confidence95.top1Accuracy.lower, -policy.maximumTop1Regression, report.v4.confidence95.top1Accuracy.lower + policy.maximumTop1Regression >= report.v3.confidence95.top1Accuracy.lower)
  add('v4-abstention-noninferiority-lower95', 'quality', report.v4.confidence95.abstentionAccuracy.lower - report.v3.confidence95.abstentionAccuracy.lower, -policy.maximumAbstentionRegression, report.v4.confidence95.abstentionAccuracy.lower + policy.maximumAbstentionRegression >= report.v3.confidence95.abstentionAccuracy.lower)

  const failed = checks.filter(check => !check.passed)
  const decision: MemoryV4RolloutGateDecision = failed.some(check => check.kind === 'redline')
    ? 'blocked'
    : failed.some(check => check.kind === 'evidence')
      ? 'insufficient-data'
      : failed.length > 0
        ? 'blocked'
        : 'eligible-for-internal-review'
  return {
    version: MEMORY_STAGE5_V4_ROLLOUT_GATE_VERSION,
    decision,
    authoritativeAnswerSource: 'v3',
    automaticPromotion: false,
    datasetVersion: report.datasetVersion,
    datasetFingerprint: report.datasetFingerprint,
    checks,
    failedCheckIds: failed.map(check => check.id),
    reason: decision === 'eligible-for-internal-review'
      ? 'All evidence, safety, quality and latency checks passed; manual internal review is still required.'
      : decision === 'insufficient-data'
        ? 'The report is not trusted or statistically large enough; V3 remains authoritative.'
        : 'One or more quality or safety redlines failed; V4 must remain shadow-only.',
  }
}

/** Never auto-promotes. A failed or missing gate automatically returns live stages to shadow. */
export function recommendMemoryV4RolloutTransition(
  currentStage: MemoryV4RolloutStage,
  gate: MemoryV4RolloutGateReport,
  options: { manualApproval?: boolean } = {},
): MemoryV4RolloutTransition {
  const manualApproval = options.manualApproval === true
  if (gate.decision !== 'eligible-for-internal-review') {
    const recommendedStage = currentStage === 'off' ? 'off' : 'shadow'
    return {
      version: MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION,
      currentStage,
      recommendedStage,
      automaticRollbackRequired: currentStage !== 'off' && currentStage !== 'shadow',
      manualApprovalConsumed: false,
      reason: gate.reason,
    }
  }
  if (!manualApproval) {
    return {
      version: MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION,
      currentStage,
      recommendedStage: currentStage,
      automaticRollbackRequired: false,
      manualApprovalConsumed: false,
      reason: 'The gate passed, but rollout advancement requires explicit manual approval.',
    }
  }
  if (currentStage === 'internal' || currentStage.startsWith('percent-')) {
    return {
      version: MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION,
      currentStage,
      recommendedStage: currentStage,
      automaticRollbackRequired: false,
      manualApprovalConsumed: false,
      reason: 'This gate authorizes internal review only; percentage rollout requires a fresh stage-specific production audit.',
    }
  }
  return {
    version: MEMORY_STAGE5_V4_ROLLOUT_TRANSITION_VERSION,
    currentStage,
    recommendedStage: nextRolloutStage(currentStage),
    automaticRollbackRequired: false,
    manualApprovalConsumed: true,
    reason: 'Manual approval advances only to the next non-production stage; percentage rollout requires fresh evidence.',
  }
}

interface StrategyOutcome {
  retrievedFactIds: string[]
  latencyMs: number
  failure?: { errorName: string; errorFingerprint: string }
}

interface EvaluationPair {
  testCase: MemoryV4RolloutEvalCase
  v3: StrategyOutcome
  v4: StrategyOutcome
}

async function executeStrategy(
  strategy: MemoryV4RolloutRetrievalStrategy,
  request: MemoryV4RolloutQuery,
  topK: number,
): Promise<StrategyOutcome> {
  const startedAt = performance.now()
  try {
    const result = await strategy(request, topK)
    if (!result || !Array.isArray(result.retrievedFactIds))
      throw new Error('Retrieval strategy returned an invalid result')
    const retrievedFactIds = uniqueBoundedStrings(result.retrievedFactIds, topK, 'retrieved fact id')
    const measured = performance.now() - startedAt
    const latencyMs = result.latencyMs === undefined ? measured : nonNegativeNumber(result.latencyMs)
    return { retrievedFactIds, latencyMs }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      retrievedFactIds: [],
      latencyMs: Math.max(0, performance.now() - startedAt),
      failure: {
        errorName: genericErrorName(error),
        errorFingerprint: createHash('sha256').update(message).digest('hex'),
      },
    }
  }
}

function strategyReport(
  entries: Array<{ testCase: MemoryV4RolloutEvalCase; outcome: StrategyOutcome }>,
  topK: number,
): MemoryV4RolloutStrategyReport {
  const metrics = summarize(entries, topK)
  const categories = [...new Set(entries.map(entry => entry.testCase.category))].sort()
  return {
    ...metrics,
    byCategory: Object.fromEntries(categories.map(category => [
      category,
      summarize(entries.filter(entry => entry.testCase.category === category), topK),
    ])),
    failures: entries.flatMap(entry => entry.outcome.failure
      ? [{ caseId: entry.testCase.id, ...entry.outcome.failure }]
      : []),
    leakages: entries.flatMap((entry) => {
      const forbidden = new Set(entry.testCase.forbiddenFactIds)
      const leaked = entry.outcome.retrievedFactIds.filter(id => forbidden.has(id))
      return leaked.length > 0
        ? [{ caseId: entry.testCase.id, safetyTags: [...entry.testCase.safetyTags], forbiddenFactIds: leaked }]
        : []
    }),
  }
}

function summarize(
  entries: Array<{ testCase: MemoryV4RolloutEvalCase; outcome: StrategyOutcome }>,
  topK: number,
): MemoryV4RolloutStrategyMetrics {
  const answerable = entries.filter(entry => entry.testCase.relevantFactIds.length > 0)
  const abstention = entries.filter(entry => entry.testCase.relevantFactIds.length === 0)
  const safety = entries.filter(entry => entry.testCase.safetyTags.length > 0 || entry.testCase.forbiddenFactIds.length > 0)
  const evaluations = entries.map(entry => evaluateOutcome(entry.testCase, entry.outcome, topK))
  const answerableEvaluations = evaluations.filter(item => item.answerable)
  const abstentionEvaluations = evaluations.filter(item => !item.answerable)
  const safetyEvaluations = evaluations.filter(item => item.safety)
  const relevantFacts = answerable.reduce((sum, entry) => sum + entry.testCase.relevantFactIds.length, 0)
  const retrievedRelevantFacts = answerableEvaluations.reduce((sum, item) => sum + item.relevantRetrieved, 0)
  const retrievedOnAnswerable = answerableEvaluations.reduce((sum, item) => sum + item.retrievedCount, 0)
  const hitSuccesses = answerableEvaluations.filter(item => item.hit).length
  const top1Successes = answerableEvaluations.filter(item => item.top1).length
  const abstentionSuccesses = abstentionEvaluations.filter(item => item.abstainedCorrectly).length
  const failureCases = evaluations.filter(item => item.failed).length
  const forbiddenLeakCases = safetyEvaluations.filter(item => item.leaked).length
  const latencies = entries.map(entry => entry.outcome.latencyMs).sort((left, right) => left - right)
  const safetyByTag = Object.fromEntries((['privacy', 'deletion', 'scope', 'temporal'] as const).map((tag) => {
    const tagged = entries.filter(entry => entry.testCase.safetyTags.includes(tag))
    const leakCases = tagged.filter((entry) => {
      const forbidden = new Set(entry.testCase.forbiddenFactIds)
      return entry.outcome.retrievedFactIds.some(id => forbidden.has(id))
    }).length
    return [tag, { cases: tagged.length, leakCases, leakRate: ratio(leakCases, tagged.length, 0) }]
  })) as MemoryV4RolloutStrategyMetrics['safetyByTag']
  return {
    cases: entries.length,
    answerableCases: answerable.length,
    abstentionCases: abstention.length,
    safetyCases: safety.length,
    relevantFacts,
    retrievedRelevantFacts,
    recallAtK: rounded(mean(answerableEvaluations.map(item => item.recall))),
    precisionAtK: rounded(mean(answerableEvaluations.map(item => item.precision))),
    hitRateAtK: ratio(hitSuccesses, answerable.length, 0),
    top1Accuracy: ratio(top1Successes, answerable.length, 0),
    mrrAtK: rounded(mean(answerableEvaluations.map(item => item.reciprocalRank))),
    ndcgAtK: rounded(mean(answerableEvaluations.map(item => item.ndcg))),
    abstentionAccuracy: ratio(abstentionSuccesses, abstention.length, 0),
    failureRate: ratio(failureCases, entries.length, 0),
    forbiddenLeakRate: ratio(forbiddenLeakCases, safety.length, 0),
    failureCases,
    forbiddenLeakCases,
    latencyMs: {
      mean: rounded(mean(latencies)),
      p50: rounded(percentile(latencies, 0.50)),
      p95: rounded(percentile(latencies, 0.95)),
      p99: rounded(percentile(latencies, 0.99)),
      max: rounded(latencies.at(-1) ?? 0),
    },
    confidence95: {
      recall: wilsonInterval(retrievedRelevantFacts, relevantFacts),
      precision: wilsonInterval(retrievedRelevantFacts, retrievedOnAnswerable),
      hitRate: wilsonInterval(hitSuccesses, answerable.length),
      top1Accuracy: wilsonInterval(top1Successes, answerable.length),
      abstentionAccuracy: wilsonInterval(abstentionSuccesses, abstention.length),
      failureRate: wilsonInterval(failureCases, entries.length),
      forbiddenLeakRate: wilsonInterval(forbiddenLeakCases, safety.length),
    },
    safetyByTag,
  }
}

function evaluateOutcome(testCase: MemoryV4RolloutEvalCase, outcome: StrategyOutcome, topK: number) {
  const relevant = new Set(testCase.relevantFactIds)
  const forbidden = new Set(testCase.forbiddenFactIds)
  const retrieved = outcome.retrievedFactIds.slice(0, topK)
  const relevantRetrieved = retrieved.filter(id => relevant.has(id)).length
  const firstRelevantRank = retrieved.findIndex(id => relevant.has(id))
  return {
    answerable: relevant.size > 0,
    safety: testCase.safetyTags.length > 0 || forbidden.size > 0,
    relevantRetrieved,
    retrievedCount: retrieved.length,
    recall: relevant.size > 0 ? relevantRetrieved / relevant.size : 0,
    precision: retrieved.length > 0 ? relevantRetrieved / retrieved.length : 0,
    hit: relevant.size > 0 && relevantRetrieved > 0,
    top1: relevant.size > 0 && relevant.has(retrieved[0] ?? ''),
    reciprocalRank: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    ndcg: binaryNdcg(retrieved, relevant, topK),
    abstainedCorrectly: relevant.size === 0 && !outcome.failure && retrieved.length === 0,
    failed: outcome.failure !== undefined,
    leaked: retrieved.some(id => forbidden.has(id)),
  }
}

function queryRequest(testCase: MemoryV4RolloutEvalCase): MemoryV4RolloutQuery {
  return {
    caseId: testCase.id,
    category: testCase.category,
    query: testCase.query,
    scope: { ...testCase.scope },
    ...(testCase.options ? { options: { ...testCase.options } } : {}),
  }
}

function normalizeDataset(value: unknown): MemoryV4RolloutDataset {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Stage 5 rollout dataset must be an object')
  const source = value as Partial<MemoryV4RolloutDataset>
  if (source.schemaVersion !== MEMORY_STAGE5_V4_ROLLOUT_DATASET_SCHEMA_VERSION)
    throw new Error('Unsupported Stage 5 rollout dataset schema')
  const datasetVersion = boundedString(source.datasetVersion, 128, '')
  if (!datasetVersion)
    throw new Error('Stage 5 rollout datasetVersion is required')
  if (!isPurpose(source.purpose))
    throw new Error('Invalid Stage 5 rollout dataset purpose')
  if (!Array.isArray(source.cases) || source.cases.length === 0)
    throw new Error('Stage 5 rollout dataset must contain cases')
  const ids = new Set<string>()
  const cases = source.cases.map((raw, index) => normalizeCase(raw, index, ids))
  return {
    schemaVersion: MEMORY_STAGE5_V4_ROLLOUT_DATASET_SCHEMA_VERSION,
    datasetVersion,
    purpose: source.purpose,
    createdAt: positiveTimestamp(source.createdAt),
    ...(typeof source.description === 'string' && source.description.trim()
      ? { description: source.description.trim().slice(0, 1_000) }
      : {}),
    cases,
  }
}

function normalizeCase(value: unknown, index: number, ids: Set<string>): MemoryV4RolloutEvalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid Stage 5 rollout case at index ${index}`)
  const source = value as Partial<MemoryV4RolloutEvalCase>
  const id = boundedString(source.id, 128, '')
  const category = boundedString(source.category, 64, '')
  const query = boundedString(source.query, 10_000, '')
  if (!id || !category || !query)
    throw new Error(`Stage 5 rollout case ${index} requires id, category and query`)
  if (ids.has(id))
    throw new Error(`Duplicate Stage 5 rollout case id: ${id}`)
  ids.add(id)
  const scope = normalizeScope(source.scope)
  const relevantFactIds = uniqueBoundedStrings(source.relevantFactIds, 100, 'relevant fact id')
  const forbiddenFactIds = uniqueBoundedStrings(source.forbiddenFactIds, 100, 'forbidden fact id')
  const forbidden = new Set(forbiddenFactIds)
  if (relevantFactIds.some(factId => forbidden.has(factId)))
    throw new Error(`Stage 5 rollout case ${id} has overlapping relevant and forbidden facts`)
  const safetyTags = normalizeSafetyTags(source.safetyTags)
  if (safetyTags.length > 0 && forbiddenFactIds.length === 0)
    throw new Error(`Stage 5 rollout safety case ${id} requires forbidden facts`)
  const options = normalizeRecallOptions(source.options)
  return {
    id,
    category,
    query,
    scope,
    relevantFactIds,
    forbiddenFactIds,
    safetyTags,
    ...(options ? { options } : {}),
  }
}

function normalizeScope(value: unknown): MemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Stage 5 rollout case scope is required')
  const source = value as Partial<MemoryScope>
  const ownerId = boundedString(source.ownerId, 256, '')
  if (!ownerId)
    throw new Error('Stage 5 rollout scope ownerId is required')
  const agentId = boundedString(source.agentId, 256, '')
  const sessionId = boundedString(source.sessionId, 256, '')
  return {
    ownerId,
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

function normalizeRecallOptions(value: unknown): MemoryRecallOptions | undefined {
  if (value === undefined)
    return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Stage 5 rollout recall options')
  const source = value as MemoryRecallOptions
  const sharePolicies = normalizeEnumArray<MemorySharePolicy>(source.sharePolicies, ['allow-remote', 'local-only', 'ask'], 'share policy')
  const sensitivities = normalizeEnumArray<MemorySensitivity>(source.sensitivities, ['normal', 'private', 'secret'], 'sensitivity')
  const temporalMode = source.temporalMode
  if (temporalMode !== undefined && !(['current', 'historical', 'all'] as MemoryTemporalMode[]).includes(temporalMode))
    throw new Error('Invalid Stage 5 rollout temporal mode')
  const asOf = source.asOf === undefined ? undefined : positiveTimestamp(source.asOf)
  return {
    ...(sharePolicies.length > 0 ? { sharePolicies } : {}),
    ...(sensitivities.length > 0 ? { sensitivities } : {}),
    ...(temporalMode ? { temporalMode } : {}),
    ...(asOf === undefined ? {} : { asOf }),
  }
}

function normalizeSafetyTags(value: unknown): MemoryV4RolloutSafetyTag[] {
  if (value === undefined)
    return []
  if (!Array.isArray(value))
    throw new Error('Stage 5 rollout safetyTags must be an array')
  const allowed: MemoryV4RolloutSafetyTag[] = ['privacy', 'deletion', 'scope', 'temporal']
  const result = [...new Set(value.map((tag) => {
    if (typeof tag !== 'string' || !allowed.includes(tag as MemoryV4RolloutSafetyTag))
      throw new Error('Invalid Stage 5 rollout safety tag')
    return tag as MemoryV4RolloutSafetyTag
  }))]
  return result.sort()
}

function normalizeEnumArray<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  if (value === undefined)
    return []
  if (!Array.isArray(value))
    throw new Error(`Stage 5 rollout ${label} must be an array`)
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || !allowed.includes(item as T))
      throw new Error(`Invalid Stage 5 rollout ${label}`)
    return item as T
  }))].sort()
}

function normalizeGatePolicy(overrides: Partial<MemoryV4RolloutGatePolicy>): MemoryV4RolloutGatePolicy {
  const source = { ...DEFAULT_MEMORY_V4_ROLLOUT_GATE_POLICY, ...overrides }
  return {
    trustedPurposes: [...new Set(source.trustedPurposes.filter(isPurpose))],
    minimumCases: clampInteger(source.minimumCases, 1, 1_000_000),
    minimumAnswerableCases: clampInteger(source.minimumAnswerableCases, 1, 1_000_000),
    minimumAbstentionCases: clampInteger(source.minimumAbstentionCases, 1, 1_000_000),
    minimumSafetyCases: clampInteger(source.minimumSafetyCases, 1, 1_000_000),
    minimumRecallLower95: clamp01(source.minimumRecallLower95),
    minimumTop1Lower95: clamp01(source.minimumTop1Lower95),
    minimumAbstentionLower95: clamp01(source.minimumAbstentionLower95),
    maximumRecallRegression: clamp01(source.maximumRecallRegression),
    maximumTop1Regression: clamp01(source.maximumTop1Regression),
    maximumAbstentionRegression: clamp01(source.maximumAbstentionRegression),
    maximumFailureRate: clamp01(source.maximumFailureRate),
    maximumFailureUpper95: clamp01(source.maximumFailureUpper95),
    maximumForbiddenLeakCases: clampInteger(source.maximumForbiddenLeakCases, 0, 1_000_000),
    maximumForbiddenLeakUpper95: clamp01(source.maximumForbiddenLeakUpper95),
    maximumP95LatencyMs: nonNegativeNumber(source.maximumP95LatencyMs),
    maximumP99LatencyMs: nonNegativeNumber(source.maximumP99LatencyMs),
  }
}

function uniqueBoundedStrings(value: unknown, maximumItems: number, label: string): string[] {
  if (!Array.isArray(value))
    throw new Error(`Stage 5 rollout ${label}s must be an array`)
  if (value.length > maximumItems)
    throw new Error(`Too many Stage 5 rollout ${label}s`)
  return [...new Set(value.map((item) => {
    const normalized = boundedString(item, 256, '')
    if (!normalized)
      throw new Error(`Invalid Stage 5 rollout ${label}`)
    return normalized
  }))]
}

function nextRolloutStage(stage: MemoryV4RolloutStage): MemoryV4RolloutStage {
  const stages: MemoryV4RolloutStage[] = ['off', 'shadow', 'internal', 'percent-1', 'percent-10', 'percent-50', 'percent-100']
  return stages[Math.min(stages.length - 1, stages.indexOf(stage) + 1)] ?? 'off'
}

function genericErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError'
  return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError'].includes(name)
    ? name
    : 'OtherError'
}

function binaryNdcg(retrieved: readonly string[], relevant: ReadonlySet<string>, topK: number): number {
  let dcg = 0
  for (const [index, factId] of retrieved.slice(0, topK).entries()) {
    if (relevant.has(factId))
      dcg += 1 / Math.log2(index + 2)
  }
  let ideal = 0
  for (let index = 0; index < Math.min(topK, relevant.size); index++)
    ideal += 1 / Math.log2(index + 2)
  return ideal > 0 ? dcg / ideal : 0
}

function wilsonInterval(successes: number, total: number, z = 1.644854): MemoryV4RolloutProportionInterval {
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

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0)
    return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator > 0 ? rounded(numerator / denominator) : empty
}

function positiveTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error('Expected a positive Stage 5 rollout timestamp')
  return Math.floor(value)
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Expected a non-negative Stage 5 rollout number')
  return value
}

function boundedString(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.max(0, Math.min(1, value))
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function isPurpose(value: unknown): value is MemoryV4RolloutDatasetPurpose {
  return value === 'development' || value === 'external-blind' || value === 'production-audit'
}
