import type { MemoryQueryIntent } from '../../long-term/memory-query-planner'
import type { MemoryV4YearScenarioDefinition } from '../evaluation/memory-v4-year-scenario'
import {
  runMemoryV4YearSimulation,
  type MemoryV4YearSimulationReport,
  type MemoryV4YearStrategyMetrics,
} from '../evaluation/memory-v4-year-simulator'
import {
  createMemoryV4PolicyArtifact,
  type MemoryV4PolicyArtifact,
} from './memory-v4-policy-artifact'
import {
  BASELINE_MEMORY_V4_RETRIEVAL_POLICY,
  MEMORY_V4_RETRIEVAL_POLICY_VERSION,
  deriveMemoryV4RetrievalPolicy,
  fingerprintMemoryV4RetrievalPolicy,
  memoryV4RetrievalPolicyIdentity,
  type MemoryV4RetrievalPolicy,
  type MemoryV4RetrievalPolicyIdentity,
} from './memory-v4-retrieval-policy'

export const MEMORY_V4_POLICY_SEARCH_VERSION = 'memory-v4-constrained-pareto-search-v1'

export interface MemoryV4PolicySearchMetrics {
  readonly hardGatesPassed: boolean
  readonly recallAtFive: number
  readonly precisionAtFive: number
  readonly topOneAccuracy: number
  readonly exactCoverage: number
  readonly temporalCorrectness: number
  readonly overviewAndMultiCoverage: number
  readonly multiHopCorrectness: number
  readonly abstentionAccuracy: number
  readonly invariantPassRate: number
  readonly restartConsistency: number
  readonly writePrecision: number
  readonly writeRecall: number
  readonly operationDecisionAccuracy: number
  readonly latencyP95Ms: number
  readonly scaleLatencyP95Ms: number
  readonly meanContextCharacters: number
  readonly meanCandidateCount: number
  readonly maximumScaleCandidates: number
}

export interface MemoryV4PolicySearchEvaluation {
  readonly policy: MemoryV4RetrievalPolicyIdentity
  readonly metrics: MemoryV4PolicySearchMetrics
  readonly nonRegressionPassed: boolean
  readonly improvements: readonly string[]
  readonly paretoEligible: boolean
  readonly dominated: boolean
}

export interface MemoryV4PolicySearchReport {
  readonly version: typeof MEMORY_V4_POLICY_SEARCH_VERSION
  readonly scenarioFingerprint: string
  readonly baselinePolicyFingerprint: string
  readonly evaluations: readonly MemoryV4PolicySearchEvaluation[]
  readonly paretoPolicyFingerprints: readonly string[]
  readonly selected?: MemoryV4PolicyArtifact
}

/**
 * Evaluate a small, explicit parameter space on the exact same replay. Search
 * is offline and sequential so policy candidates never share mutable runtime
 * state. Only a Pareto-eligible non-regression candidate can become an artifact.
 */
export async function runMemoryV4PolicySearch(
  definition: MemoryV4YearScenarioDefinition,
  candidates: readonly MemoryV4RetrievalPolicy[] = defaultMemoryV4PolicyCandidates(),
): Promise<MemoryV4PolicySearchReport> {
  const baselinePolicy = BASELINE_MEMORY_V4_RETRIEVAL_POLICY
  const uniqueCandidates = deduplicatePolicies(candidates)
    .filter(policy => fingerprintMemoryV4RetrievalPolicy(policy) !== fingerprintMemoryV4RetrievalPolicy(baselinePolicy))
  const baselineSimulation = await runMemoryV4YearSimulation(definition, { policy: baselinePolicy })
  const baselineMetrics = metricsOf(baselineSimulation)
  const evaluated: Array<{ policy: MemoryV4RetrievalPolicy; simulation: MemoryV4YearSimulationReport }> = []
  for (const policy of uniqueCandidates) {
    evaluated.push({
      policy,
      simulation: await runMemoryV4YearSimulation(definition, { policy }),
    })
  }
  const raw = evaluated.map(({ policy, simulation }) => {
    const metrics = metricsOf(simulation)
    const nonRegressionPassed = nonRegression(metrics, baselineMetrics)
    const improvements = improvementReasons(metrics, baselineMetrics)
    return {
      policy,
      metrics,
      nonRegressionPassed,
      improvements,
      paretoEligible: nonRegressionPassed && improvements.length > 0,
    }
  })
  const eligible = raw.filter(item => item.paretoEligible)
  const pareto = eligible.filter(left => !eligible.some(right => right !== left && dominates(right.metrics, left.metrics)))
  const selected = [...pareto].sort(comparePreferred)[0]
  const baselineFingerprint = fingerprintMemoryV4RetrievalPolicy(baselinePolicy)
  const selectedArtifact = selected
    ? createMemoryV4PolicyArtifact({
        policy: selected.policy,
        source: {
          kind: 'constrained-search',
          scenarioFingerprint: baselineSimulation.scenarioFingerprint,
          baselinePolicyFingerprint: baselineFingerprint,
          searchVersion: MEMORY_V4_POLICY_SEARCH_VERSION,
        },
      })
    : undefined
  const evaluations: MemoryV4PolicySearchEvaluation[] = [
    {
      policy: memoryV4RetrievalPolicyIdentity(baselinePolicy),
      metrics: baselineMetrics,
      nonRegressionPassed: baselineMetrics.hardGatesPassed,
      improvements: [],
      paretoEligible: false,
      dominated: false,
    },
    ...raw.map(item => ({
      policy: memoryV4RetrievalPolicyIdentity(item.policy),
      metrics: item.metrics,
      nonRegressionPassed: item.nonRegressionPassed,
      improvements: [...item.improvements],
      paretoEligible: item.paretoEligible,
      dominated: item.paretoEligible && !pareto.includes(item),
    })),
  ]
  return {
    version: MEMORY_V4_POLICY_SEARCH_VERSION,
    scenarioFingerprint: baselineSimulation.scenarioFingerprint,
    baselinePolicyFingerprint: baselineFingerprint,
    evaluations,
    paretoPolicyFingerprints: pareto
      .map(item => fingerprintMemoryV4RetrievalPolicy(item.policy))
      .sort(),
    ...(selectedArtifact ? { selected: selectedArtifact } : {}),
  }
}

/** Finite, reviewable search space; no candidate can invent new knobs. */
export function defaultMemoryV4PolicyCandidates(): readonly MemoryV4RetrievalPolicy[] {
  return [
    budgetCandidate('deskpet-v4-retrieval-budget-875-v1', 0.875),
    budgetCandidate('deskpet-v4-retrieval-budget-750-v1', 0.75),
    budgetCandidate('deskpet-v4-retrieval-budget-625-v1', 0.625),
    deriveMemoryV4RetrievalPolicy(
      BASELINE_MEMORY_V4_RETRIEVAL_POLICY,
      { policyId: 'deskpet-v4-retrieval-budget-750-rrf40-v1', policyVersion: MEMORY_V4_RETRIEVAL_POLICY_VERSION },
      { candidateBudgetScale: budgetScales(0.75), rrfRankConstant: 40 },
    ),
  ]
}

function budgetCandidate(policyId: string, scale: number): MemoryV4RetrievalPolicy {
  return deriveMemoryV4RetrievalPolicy(
    BASELINE_MEMORY_V4_RETRIEVAL_POLICY,
    { policyId, policyVersion: MEMORY_V4_RETRIEVAL_POLICY_VERSION },
    { candidateBudgetScale: budgetScales(scale) },
  )
}

function budgetScales(scale: number): Partial<Record<MemoryQueryIntent, number>> {
  return {
    external: 1,
    specific: scale,
    'multi-fact': scale,
    temporal: scale,
    timeline: scale,
    enumerative: scale,
  }
}

function metricsOf(report: MemoryV4YearSimulationReport): MemoryV4PolicySearchMetrics {
  const v4 = requireV4Metrics(report.strategyMetrics)
  const v4Traces = report.queryTraces.filter(trace => trace.strategy === 'v4')
  return {
    hardGatesPassed: report.passed,
    recallAtFive: v4.recallAtFive,
    precisionAtFive: v4.precisionAtFive,
    topOneAccuracy: v4.topOneAccuracy,
    exactCoverage: v4.exactCoverage,
    temporalCorrectness: v4.temporalCorrectness,
    overviewAndMultiCoverage: v4.overviewAndMultiCoverage,
    multiHopCorrectness: v4.multiHopCorrectness,
    abstentionAccuracy: v4.abstentionAccuracy,
    invariantPassRate: report.invariantPassRate,
    restartConsistency: report.restartConsistency,
    writePrecision: report.operationMetrics.writePrecision,
    writeRecall: report.operationMetrics.writeRecall,
    operationDecisionAccuracy: report.operationMetrics.operationDecisionAccuracy,
    latencyP95Ms: v4.latencyP95Ms,
    scaleLatencyP95Ms: report.scale.latencyP95Ms,
    meanContextCharacters: v4.meanContextCharacters,
    meanCandidateCount: mean(v4Traces.map(trace => trace.candidateCount ?? 0)),
    maximumScaleCandidates: report.scale.maximumCandidates,
  }
}

function nonRegression(candidate: MemoryV4PolicySearchMetrics, baseline: MemoryV4PolicySearchMetrics): boolean {
  if (!candidate.hardGatesPassed)
    return false
  const maximize: Array<keyof MemoryV4PolicySearchMetrics> = [
    'recallAtFive', 'precisionAtFive', 'topOneAccuracy', 'exactCoverage',
    'temporalCorrectness', 'overviewAndMultiCoverage', 'multiHopCorrectness',
    'abstentionAccuracy', 'invariantPassRate', 'restartConsistency',
    'writePrecision', 'writeRecall', 'operationDecisionAccuracy',
  ]
  if (maximize.some(key => numeric(candidate[key]) + 1e-12 < numeric(baseline[key])))
    return false
  if (candidate.meanContextCharacters > baseline.meanContextCharacters + 1e-12)
    return false
  // The seven-query scale probe is sensitive to a single scheduler/GC outlier.
  // Timing remains a reported objective and must pass the product hard limit,
  // while deterministic candidate work decides reproducible policy selection.
  return candidate.latencyP95Ms < 100 && candidate.scaleLatencyP95Ms < 100
}

function improvementReasons(candidate: MemoryV4PolicySearchMetrics, baseline: MemoryV4PolicySearchMetrics): string[] {
  const reasons: string[] = []
  if (candidate.recallAtFive > baseline.recallAtFive + 1e-12)
    reasons.push('recall-at-five')
  if (candidate.topOneAccuracy > baseline.topOneAccuracy + 1e-12)
    reasons.push('top-one-accuracy')
  if (candidate.meanContextCharacters + 0.5 < baseline.meanContextCharacters)
    reasons.push('context-characters')
  if (candidate.latencyP95Ms < baseline.latencyP95Ms * 0.95)
    reasons.push('year-replay-p95')
  if (candidate.scaleLatencyP95Ms < baseline.scaleLatencyP95Ms * 0.95)
    reasons.push('20k-p95')
  // This deterministic bound is retained even when timing noise masks the win.
  if (candidate.maximumScaleCandidates < baseline.maximumScaleCandidates)
    reasons.push('20k-candidate-bound')
  if (candidate.meanCandidateCount < baseline.meanCandidateCount * 0.95)
    reasons.push('mean-candidate-work')
  return reasons
}

function dominates(left: MemoryV4PolicySearchMetrics, right: MemoryV4PolicySearchMetrics): boolean {
  const noWorse = left.recallAtFive >= right.recallAtFive
    && left.topOneAccuracy >= right.topOneAccuracy
    && left.meanContextCharacters <= right.meanContextCharacters
    && left.maximumScaleCandidates <= right.maximumScaleCandidates
    && left.meanCandidateCount <= right.meanCandidateCount
  const strictlyBetter = left.recallAtFive > right.recallAtFive
    || left.topOneAccuracy > right.topOneAccuracy
    || left.meanContextCharacters < right.meanContextCharacters
    || left.maximumScaleCandidates < right.maximumScaleCandidates
    || left.meanCandidateCount < right.meanCandidateCount
  return noWorse && strictlyBetter
}

function comparePreferred(
  left: { policy: MemoryV4RetrievalPolicy; metrics: MemoryV4PolicySearchMetrics },
  right: { policy: MemoryV4RetrievalPolicy; metrics: MemoryV4PolicySearchMetrics },
): number {
  return left.metrics.maximumScaleCandidates - right.metrics.maximumScaleCandidates
    || left.metrics.meanCandidateCount - right.metrics.meanCandidateCount
    || left.metrics.meanContextCharacters - right.metrics.meanContextCharacters
    || left.metrics.scaleLatencyP95Ms - right.metrics.scaleLatencyP95Ms
    || left.metrics.latencyP95Ms - right.metrics.latencyP95Ms
    || left.policy.policyId.localeCompare(right.policy.policyId)
}

function deduplicatePolicies(policies: readonly MemoryV4RetrievalPolicy[]): MemoryV4RetrievalPolicy[] {
  return [...new Map(policies.map(policy => [fingerprintMemoryV4RetrievalPolicy(policy), policy])).values()]
}

function requireV4Metrics(metrics: readonly MemoryV4YearStrategyMetrics[]): MemoryV4YearStrategyMetrics {
  const v4 = metrics.find(item => item.strategy === 'v4')
  if (!v4)
    throw new Error('Memory V4 year report is missing the V4 strategy metrics')
  return v4
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function numeric(value: number | boolean): number {
  return typeof value === 'number' ? value : Number(value)
}
