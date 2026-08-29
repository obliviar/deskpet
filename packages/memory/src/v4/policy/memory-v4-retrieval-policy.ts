import { createHash } from 'node:crypto'
import type { RecallAbstentionCalibrationModel } from '../../long-term/abstention-calibration'
import type { MemoryQueryIntent } from '../../long-term/memory-query-planner'

export const MEMORY_V4_RETRIEVAL_POLICY_SCHEMA_VERSION = 1 as const
export const MEMORY_V4_RETRIEVAL_POLICY_VERSION = 'memory-v4-retrieval-policy-v1'

export const MEMORY_V4_POLICY_INTENTS = [
  'external',
  'specific',
  'multi-fact',
  'temporal',
  'timeline',
  'enumerative',
] as const satisfies readonly MemoryQueryIntent[]

export interface MemoryV4RetrievalPolicy {
  readonly schemaVersion: typeof MEMORY_V4_RETRIEVAL_POLICY_SCHEMA_VERSION
  readonly policyVersion: string
  readonly policyId: string
  readonly candidateBudgetScale: Readonly<Record<MemoryQueryIntent, number>>
  readonly rrfRankConstant: number
  readonly evidenceThresholds: {
    readonly lexicalCandidateScore: number
    readonly semanticCandidateScore: number
    readonly learnedSemanticCosine: number
    readonly summaryEvidenceScore: number
    readonly summaryEvidenceWeight: number
    readonly minimumSummaryFactEvidenceRatio: number
  }
  readonly tierQuotas: {
    readonly eagerHotFraction: number
    readonly eagerColdFraction: number
    readonly fallbackHotFraction: number
    readonly fallbackColdFraction: number
    readonly fallbackColdMaximum: number
  }
  readonly summarySelection: {
    readonly minimum: number
    readonly maximum: number
    readonly candidateDivisor: number
  }
  readonly evidenceSelection: {
    readonly broadMinimumMarginalGain: number
    readonly defaultMinimumMarginalGain: number
    readonly maximumCharactersScale: number
  }
  readonly abstentionCalibration: RecallAbstentionCalibrationModel
}

export interface MemoryV4RetrievalPolicyIdentity {
  readonly policyId: string
  readonly policyVersion: string
  readonly fingerprint: string
}

export interface MemoryV4RetrievalPolicyOverrides {
  candidateBudgetScale?: Partial<Record<MemoryQueryIntent, number>>
  rrfRankConstant?: number
  evidenceThresholds?: Partial<MemoryV4RetrievalPolicy['evidenceThresholds']>
  tierQuotas?: Partial<MemoryV4RetrievalPolicy['tierQuotas']>
  summarySelection?: Partial<MemoryV4RetrievalPolicy['summarySelection']>
  evidenceSelection?: Partial<MemoryV4RetrievalPolicy['evidenceSelection']>
  abstentionCalibration?: RecallAbstentionCalibrationModel
}

const BASELINE_POLICY_INPUT: MemoryV4RetrievalPolicy = {
  schemaVersion: MEMORY_V4_RETRIEVAL_POLICY_SCHEMA_VERSION,
  policyVersion: MEMORY_V4_RETRIEVAL_POLICY_VERSION,
  policyId: 'deskpet-v4-retrieval-baseline-v1',
  candidateBudgetScale: {
    external: 1,
    specific: 1,
    'multi-fact': 1,
    temporal: 1,
    timeline: 1,
    enumerative: 1,
  },
  rrfRankConstant: 60,
  evidenceThresholds: {
    lexicalCandidateScore: 0.12,
    semanticCandidateScore: 0.08,
    learnedSemanticCosine: 0.45,
    summaryEvidenceScore: 0.28,
    summaryEvidenceWeight: 0.25,
    minimumSummaryFactEvidenceRatio: 0.5,
  },
  tierQuotas: {
    eagerHotFraction: 0.25,
    eagerColdFraction: 0.30,
    fallbackHotFraction: 1 / 3,
    fallbackColdFraction: 1 / 3,
    fallbackColdMaximum: 16,
  },
  summarySelection: {
    minimum: 4,
    maximum: 24,
    candidateDivisor: 4,
  },
  evidenceSelection: {
    broadMinimumMarginalGain: 0.16,
    defaultMinimumMarginalGain: 0.08,
    maximumCharactersScale: 1,
  },
  abstentionCalibration: {
    version: 'memory-v4-local-calibration-v2:deskpet-v4-local-synthetic-calibration-v2',
    defaultThreshold: 0.36,
    thresholds: {
      enumerative: 0.36,
      'multi-fact': 0.5,
      specific: 0.49321711682041386,
      temporal: 0.5,
      timeline: 0.5,
    },
    datasetVersion: 'deskpet-v4-local-synthetic-calibration-v2',
    sampleCount: 700,
  },
}

/** Pre-search behavior retained as the reproducible non-regression baseline. */
export const BASELINE_MEMORY_V4_RETRIEVAL_POLICY = createMemoryV4RetrievalPolicy(BASELINE_POLICY_INPUT)

/** P4-selected policy used by V4 retrieval; its checked-in artifact verifies this fingerprint. */
export const DEFAULT_MEMORY_V4_RETRIEVAL_POLICY = deriveMemoryV4RetrievalPolicy(
  BASELINE_MEMORY_V4_RETRIEVAL_POLICY,
  {
    policyId: 'deskpet-v4-retrieval-budget-625-v1',
    policyVersion: MEMORY_V4_RETRIEVAL_POLICY_VERSION,
  },
  {
    candidateBudgetScale: {
      external: 1,
      specific: 0.625,
      'multi-fact': 0.625,
      temporal: 0.625,
      timeline: 0.625,
      enumerative: 0.625,
    },
  },
)

export function createMemoryV4RetrievalPolicy(input: MemoryV4RetrievalPolicy): MemoryV4RetrievalPolicy {
  const copy = clonePolicy(input)
  validatePolicy(copy)
  return deepFreeze(copy)
}

export function deriveMemoryV4RetrievalPolicy(
  base: MemoryV4RetrievalPolicy,
  identity: Pick<MemoryV4RetrievalPolicy, 'policyId' | 'policyVersion'>,
  overrides: MemoryV4RetrievalPolicyOverrides,
): MemoryV4RetrievalPolicy {
  return createMemoryV4RetrievalPolicy({
    ...base,
    ...identity,
    candidateBudgetScale: { ...base.candidateBudgetScale, ...overrides.candidateBudgetScale },
    rrfRankConstant: overrides.rrfRankConstant ?? base.rrfRankConstant,
    evidenceThresholds: { ...base.evidenceThresholds, ...overrides.evidenceThresholds },
    tierQuotas: { ...base.tierQuotas, ...overrides.tierQuotas },
    summarySelection: { ...base.summarySelection, ...overrides.summarySelection },
    evidenceSelection: { ...base.evidenceSelection, ...overrides.evidenceSelection },
    abstentionCalibration: overrides.abstentionCalibration ?? base.abstentionCalibration,
  })
}

export function parseMemoryV4RetrievalPolicy(value: unknown): MemoryV4RetrievalPolicy {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('Memory V4 retrieval policy must be an object')
  return createMemoryV4RetrievalPolicy(parsed as MemoryV4RetrievalPolicy)
}

export function fingerprintMemoryV4RetrievalPolicy(policy: MemoryV4RetrievalPolicy): string {
  validatePolicy(policy)
  return createHash('sha256').update(stableJson(policy)).digest('hex')
}

export function memoryV4RetrievalPolicyIdentity(
  policy: MemoryV4RetrievalPolicy,
): MemoryV4RetrievalPolicyIdentity {
  return deepFreeze({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    fingerprint: fingerprintMemoryV4RetrievalPolicy(policy),
  })
}

function validatePolicy(policy: MemoryV4RetrievalPolicy): void {
  if (policy.schemaVersion !== MEMORY_V4_RETRIEVAL_POLICY_SCHEMA_VERSION)
    throw new RangeError(`Unsupported Memory V4 retrieval policy schema: ${String(policy.schemaVersion)}`)
  nonEmpty(policy.policyId, 'policyId')
  nonEmpty(policy.policyVersion, 'policyVersion')
  for (const intent of MEMORY_V4_POLICY_INTENTS)
    finiteRange(policy.candidateBudgetScale?.[intent], 0.25, 2, `candidateBudgetScale.${intent}`)
  integerRange(policy.rrfRankConstant, 1, 1_000, 'rrfRankConstant')
  for (const [name, value] of Object.entries(policy.evidenceThresholds ?? {}))
    finiteRange(value, 0, 1, `evidenceThresholds.${name}`)
  const quotas = policy.tierQuotas
  finiteRange(quotas?.eagerHotFraction, 0.05, 0.9, 'tierQuotas.eagerHotFraction')
  finiteRange(quotas?.eagerColdFraction, 0.05, 0.9, 'tierQuotas.eagerColdFraction')
  if (quotas.eagerHotFraction + quotas.eagerColdFraction >= 1)
    throw new RangeError('Eager hot and cold fractions must leave a positive warm quota')
  finiteRange(quotas.fallbackHotFraction, 0.05, 0.95, 'tierQuotas.fallbackHotFraction')
  finiteRange(quotas.fallbackColdFraction, 0.05, 1, 'tierQuotas.fallbackColdFraction')
  integerRange(quotas.fallbackColdMaximum, 1, 256, 'tierQuotas.fallbackColdMaximum')
  const summaries = policy.summarySelection
  integerRange(summaries?.minimum, 1, 64, 'summarySelection.minimum')
  integerRange(summaries?.maximum, 1, 64, 'summarySelection.maximum')
  integerRange(summaries?.candidateDivisor, 1, 64, 'summarySelection.candidateDivisor')
  if (summaries.minimum > summaries.maximum)
    throw new RangeError('summarySelection.minimum cannot exceed maximum')
  finiteRange(policy.evidenceSelection?.broadMinimumMarginalGain, 0, 1, 'evidenceSelection.broadMinimumMarginalGain')
  finiteRange(policy.evidenceSelection?.defaultMinimumMarginalGain, 0, 1, 'evidenceSelection.defaultMinimumMarginalGain')
  finiteRange(policy.evidenceSelection?.maximumCharactersScale, 0.25, 2, 'evidenceSelection.maximumCharactersScale')
  validateCalibration(policy.abstentionCalibration)
}

function validateCalibration(model: RecallAbstentionCalibrationModel): void {
  if (!model || typeof model !== 'object')
    throw new TypeError('abstentionCalibration must be an object')
  nonEmpty(model.version, 'abstentionCalibration.version')
  nonEmpty(model.datasetVersion, 'abstentionCalibration.datasetVersion')
  finiteRange(model.defaultThreshold, 0, 1, 'abstentionCalibration.defaultThreshold')
  integerRange(model.sampleCount, 1, Number.MAX_SAFE_INTEGER, 'abstentionCalibration.sampleCount')
  for (const [intent, threshold] of Object.entries(model.thresholds))
    finiteRange(threshold, 0, 1, `abstentionCalibration.thresholds.${intent}`)
}

function clonePolicy(policy: MemoryV4RetrievalPolicy): MemoryV4RetrievalPolicy {
  return JSON.parse(JSON.stringify(policy)) as MemoryV4RetrievalPolicy
}

function nonEmpty(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160)
    throw new TypeError(`${path} must be a non-empty string of at most 160 characters`)
}

function finiteRange(value: unknown, minimum: number, maximum: number, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`${path} must be between ${minimum} and ${maximum}`)
}

function integerRange(value: unknown, minimum: number, maximum: number, path: string): void {
  finiteRange(value, minimum, maximum, path)
  if (!Number.isInteger(value))
    throw new RangeError(`${path} must be an integer`)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
