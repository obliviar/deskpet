import type { MemoryTemporalMode } from '@deskpet/contracts'
import type { MemoryQueryIntent } from '../../long-term/memory-query-planner'
import type { MemoryDerivedArtifactV4, MemoryFactStatusV4, MemoryV4Snapshot } from '../domain/types'
import type { MemoryTier, TierAssignmentView } from '../consolidation/memory-tiering-service'
import {
  DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
  type MemoryV4RetrievalPolicy,
} from '../policy/memory-v4-retrieval-policy'

export const MEMORY_V4_TIER_ROUTER_VERSION = 'memory-v4-tier-router-v1'

export type MemoryV4SearchTier = 'hot' | 'warm' | 'cold'
export type MemoryV4ColdPolicy = 'disabled' | 'fallback' | 'eager'

export interface MemoryV4TierRoutingPlan {
  version: typeof MEMORY_V4_TIER_ROUTER_VERSION
  assignmentVersion?: string
  assignmentGeneratedAt?: number
  coldPolicy: MemoryV4ColdPolicy
  candidateBudgets: Record<MemoryV4SearchTier, number>
  tiers: Record<MemoryV4SearchTier, string[]>
  quarantineFactIds: string[]
  unassignedFactIds: string[]
}

export interface MemoryV4TierRoutingOptions {
  scope: { ownerId: string; agentId?: string }
  eligibleFactIds: ReadonlySet<string>
  intent: MemoryQueryIntent
  temporalMode: MemoryTemporalMode
  candidateBudget: number
  tierQuotas?: MemoryV4RetrievalPolicy['tierQuotas']
}

/**
 * Convert the persisted tier-index into bounded retrieval lanes. Active facts
 * without a current assignment remain available through warm so a stale or
 * missing rebuildable index can never make authoritative facts disappear.
 * Historical and archived facts are cold by definition and are only searched
 * by broad/history queries or after an evidence-poor ordinary pass.
 */
export function routeMemoryV4Tiers(
  snapshot: MemoryV4Snapshot,
  options: MemoryV4TierRoutingOptions,
): MemoryV4TierRoutingPlan {
  const assignment = currentAssignment(snapshot, options.scope)
  const assignedTier = assignmentTierIndex(assignment)
  const tiers: Record<MemoryV4SearchTier, string[]> = { hot: [], warm: [], cold: [] }
  const quarantineFactIds: string[] = []
  const unassignedFactIds: string[] = []
  const factById = new Map(snapshot.facts.map(fact => [fact.id, fact]))

  for (const factId of [...options.eligibleFactIds].sort()) {
    const fact = factById.get(factId)
    if (!fact)
      continue
    const assigned = assignedTier.get(factId)
    if (fact.status === 'quarantined' || assigned === 'quarantine') {
      quarantineFactIds.push(factId)
      continue
    }
    if (isHistoricalStatus(fact.status)) {
      tiers.cold.push(factId)
      continue
    }
    if (assigned === 'hot' || assigned === 'warm' || assigned === 'cold') {
      tiers[assigned].push(factId)
      continue
    }
    // The tier index is derived and may be absent/stale between maintenance
    // runs. Warm is the lossless fail-open lane for an authoritative fact.
    tiers.warm.push(factId)
    unassignedFactIds.push(factId)
  }

  const candidateBudget = clampInteger(options.candidateBudget, 1, 256)
  const coldPolicy = coldPolicyFor(options.intent, options.temporalMode)
  const candidateBudgets = allocateBudgets(candidateBudget, coldPolicy, options.tierQuotas)
  return {
    version: MEMORY_V4_TIER_ROUTER_VERSION,
    ...(assignment ? { assignmentVersion: assignment.version, assignmentGeneratedAt: assignment.generatedAt } : {}),
    coldPolicy,
    candidateBudgets,
    tiers,
    quarantineFactIds,
    unassignedFactIds,
  }
}

export function memoryV4TierSearchIds(
  plan: MemoryV4TierRoutingPlan,
  coldAwakened = plan.coldPolicy === 'eager',
): Set<string> {
  return new Set([
    ...plan.tiers.hot,
    ...plan.tiers.warm,
    ...(coldAwakened ? plan.tiers.cold : []),
  ])
}

function coldPolicyFor(intent: MemoryQueryIntent, temporalMode: MemoryTemporalMode): MemoryV4ColdPolicy {
  if (intent === 'external')
    return 'disabled'
  if (temporalMode !== 'current' || intent === 'timeline' || intent === 'temporal' || intent === 'enumerative')
    return 'eager'
  return 'fallback'
}

function allocateBudgets(
  candidateBudget: number,
  coldPolicy: MemoryV4ColdPolicy,
  quotas: MemoryV4RetrievalPolicy['tierQuotas'] = DEFAULT_MEMORY_V4_RETRIEVAL_POLICY.tierQuotas,
): Record<MemoryV4SearchTier, number> {
  if (coldPolicy === 'disabled')
    return { hot: 0, warm: 0, cold: 0 }
  if (coldPolicy === 'eager') {
    const hot = Math.max(1, Math.floor(candidateBudget * quotas.eagerHotFraction))
    const cold = Math.max(1, Math.floor(candidateBudget * quotas.eagerColdFraction))
    return { hot, warm: Math.max(1, candidateBudget - hot - cold), cold }
  }
  const hot = Math.max(1, Math.floor(candidateBudget * quotas.fallbackHotFraction))
  return {
    hot,
    warm: Math.max(1, candidateBudget - hot),
    // This budget is dormant unless the hot/warm pass cannot supply enough
    // absolute evidence. It is deliberately smaller than the primary pass.
    cold: Math.max(1, Math.min(
      quotas.fallbackColdMaximum,
      Math.ceil(candidateBudget * quotas.fallbackColdFraction),
    )),
  }
}

function currentAssignment(
  snapshot: MemoryV4Snapshot,
  scope: { ownerId: string; agentId?: string },
): TierAssignmentView | undefined {
  const artifacts = snapshot.derivedArtifacts
    .filter(artifact => artifact.kind === 'tier-index' && artifact.status === 'current' && matchesScope(artifact, scope))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  for (const artifact of artifacts) {
    const parsed = parseAssignment(artifact.content)
    if (parsed)
      return parsed
  }
  return undefined
}

function parseAssignment(content: string | undefined): TierAssignmentView | undefined {
  if (!content)
    return undefined
  try {
    const value = JSON.parse(content) as Partial<TierAssignmentView>
    if (typeof value.version !== 'string' || typeof value.generatedAt !== 'number' || !value.tiers)
      return undefined
    return {
      version: value.version,
      generatedAt: value.generatedAt,
      tiers: {
        hot: stringArray(value.tiers.hot),
        warm: stringArray(value.tiers.warm),
        cold: stringArray(value.tiers.cold),
        quarantine: stringArray(value.tiers.quarantine),
      },
      utilities: value.utilities && typeof value.utilities === 'object' ? { ...value.utilities } : {},
    }
  }
  catch {
    return undefined
  }
}

function assignmentTierIndex(assignment: TierAssignmentView | undefined): Map<string, MemoryTier> {
  const index = new Map<string, MemoryTier>()
  if (!assignment)
    return index
  for (const tier of ['hot', 'warm', 'cold', 'quarantine'] as const) {
    for (const factId of assignment.tiers[tier]) {
      if (!index.has(factId))
        index.set(factId, tier)
    }
  }
  return index
}

function isHistoricalStatus(status: MemoryFactStatusV4): boolean {
  return status !== 'active'
}

function matchesScope(
  artifact: MemoryDerivedArtifactV4,
  scope: { ownerId: string; agentId?: string },
): boolean {
  return artifact.scope.ownerId === scope.ownerId
    && (scope.agentId === undefined || artifact.scope.agentId === scope.agentId)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}
