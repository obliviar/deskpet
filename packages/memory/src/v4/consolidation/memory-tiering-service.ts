import { createHash } from 'node:crypto'
import type {
  MemoryDerivedArtifactV4,
  MemoryFactV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'
import { createMemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'
import type { MemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'

export const MEMORY_TIERING_SERVICE_VERSION = 'memory-tiering-v2'

export type MemoryTier = 'hot' | 'warm' | 'cold' | 'quarantine'

/** Aggregated retrieval feedback for one fact, derived from retrievalEvents. */
export interface FactUtilitySignals {
  adoptedCount: number
  correctedCount: number
  deniedCount: number
  /** Number of active facts sharing this fact's memoryKey. */
  keyGroupSize: number
}

export interface FactUtilityBreakdown {
  factId: string
  utility: number
  tier: MemoryTier
  /** Cold-tier overflow beyond the capacity budget; archiveColdFacts consumes these. */
  archiveCandidate: boolean
  protectedFromArchive: boolean
  reasons: string[]
}

export interface TieringOptions {
  /** Utility at or above this level enters the hot tier. Default 0.65. */
  hotUtility?: number
  /** Utility at or above this level enters the warm tier. Default 0.35. */
  warmUtility?: number
  /** Denied feedback count that routes a fact to quarantine. Default 2. */
  quarantineDeniedCount?: number
  /** Importance at or above this level protects a fact from archival. Default 0.85. */
  protectedImportance?: number
  /** Recency half-life in milliseconds. Default 30 days. */
  recencyHalfLifeMs?: number
  /** Maximum facts retained in the hot tier. Default 500. */
  hotBudget?: number
  /** Maximum facts retained in the warm tier. Default 2,000. */
  warmBudget?: number
  /** Maximum facts retained in the cold tier before archival candidates appear. Default 10,000. */
  coldBudget?: number
}

export interface TierCapacityBudgets {
  hot: number
  warm: number
  cold: number
}

export interface TieringRunReport {
  version: string
  factCount: number
  tierCounts: Record<MemoryTier, number>
  archiveCandidates: string[]
  protectedCount: number
  /** True when the existing tier-index artifact was already current. */
  skipped: boolean
  elapsedMs: number
}

export interface ArchiveColdFactsOptions {
  /** Hard cap on facts archived in one call. Default 16. */
  maxArchives?: number
  /** Prefix for the archival reason recorded on each fact version. */
  reason?: string
  /** Idempotency namespace; each archive uses `${prefix}:${index}`. */
  idempotencyKeyPrefix?: string
}

export interface ArchiveColdFactsReport {
  version: string
  archived: string[]
  failed: Array<{ factId: string; error: string }>
  elapsedMs: number
}

export interface TierAssignmentView {
  version: string
  generatedAt: number
  tiers: Record<MemoryTier, string[]>
  /** Rounded utility cache used to detect meaningful score-only changes. */
  utilities: Record<string, number>
}

export interface MemoryTieringService {
  /** Compute utilities, assign tiers and persist a tier-index derived artifact. */
  run: (scope: { ownerId: string; agentId?: string }, options?: TieringOptions) => Promise<TieringRunReport>
  /** Archive the lowest-utility cold facts beyond the capacity budget. */
  archiveColdFacts: (
    scope: { ownerId: string; agentId?: string },
    options?: ArchiveColdFactsOptions & TieringOptions,
  ) => Promise<ArchiveColdFactsReport>
  /** Read the latest persisted tier assignment for a scope. */
  listTierAssignment: (scope: { ownerId: string; agentId?: string }) => TierAssignmentView | undefined
}

export interface MemoryTieringServiceOptions {
  now?: () => number
  /** Lifecycle service used to execute archival; defaults to one over the repository. */
  lifecycle?: MemoryV4LifecycleService
}

const DEFAULTS = {
  hotUtility: 0.65,
  warmUtility: 0.35,
  quarantineDeniedCount: 2,
  protectedImportance: 0.85,
  recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  hotBudget: 500,
  warmBudget: 2_000,
  coldBudget: 10_000,
} as const

/**
 * Stage-four capacity governance. Utility is driven by importance, evidence
 * durability, retrieval adoption, recency, memoryKey coverage uniqueness and
 * negative feedback; tiers are capacity-budgeted (hot/warm/cold) with a
 * quarantine lane for repeatedly denied facts. The assignment persists as a
 * rebuildable `tier-index` derived artifact, so lifecycle edits invalidate it
 * automatically and the next idle run rebuilds it. Archival only ever moves
 * unprotected low-utility facts to the 'archived' status through the audited
 * lifecycle path; user-confirmed and high-importance facts are never archived.
 */
export function createMemoryTieringService(
  repository: MemoryV4Repository,
  options: MemoryTieringServiceOptions = {},
): MemoryTieringService {
  const now = options.now ?? Date.now
  const lifecycle = options.lifecycle ?? createMemoryV4LifecycleService(repository, { now })

  function listTierAssignment(scope: { ownerId: string; agentId?: string }): TierAssignmentView | undefined {
    const artifact = repository.snapshot().derivedArtifacts.find(item =>
      item.kind === 'tier-index' && item.status === 'current' && matchesScope(item.scope, scope))
    if (!artifact?.content)
      return undefined
    try {
      const parsed = JSON.parse(artifact.content) as Partial<TierAssignmentView>
      if (typeof parsed.version !== 'string' || typeof parsed.generatedAt !== 'number' || !parsed.tiers)
        return undefined
      return {
        version: parsed.version,
        generatedAt: parsed.generatedAt,
        tiers: {
          hot: [...parsed.tiers.hot ?? []],
          warm: [...parsed.tiers.warm ?? []],
          cold: [...parsed.tiers.cold ?? []],
          quarantine: [...parsed.tiers.quarantine ?? []],
        },
        utilities: { ...(parsed.utilities ?? {}) },
      }
    }
    catch {
      return undefined
    }
  }

  async function run(
    scope: { ownerId: string; agentId?: string },
    runOptions: TieringOptions = {},
  ): Promise<TieringRunReport> {
    if (repository.readOnly)
      throw new Error('Memory tiering requires a writable V4 repository')
    const startedAt = now()
    const snapshot = repository.snapshot()
    const facts = snapshot.facts.filter(fact =>
      fact.status === 'active' && matchesScope(fact.scope, scope))
    const signals = aggregateSignals(snapshot, scope)
    const breakdown = assignTiers(facts, signals, runOptions, now())

    const artifactId = tierArtifactId(scope)
    const ownerScope = ownerLevelScope(scope)
    const tiers: TierAssignmentView['tiers'] = {
      hot: breakdown.filter(item => item.tier === 'hot').map(item => item.factId).sort(),
      warm: breakdown.filter(item => item.tier === 'warm').map(item => item.factId).sort(),
      cold: breakdown.filter(item => item.tier === 'cold').map(item => item.factId).sort(),
      quarantine: breakdown.filter(item => item.tier === 'quarantine').map(item => item.factId).sort(),
    }
    const payload: TierAssignmentView = {
      version: MEMORY_TIERING_SERVICE_VERSION,
      generatedAt: startedAt,
      tiers,
      utilities: Object.fromEntries([...breakdown]
        .sort((left, right) => left.factId.localeCompare(right.factId))
        .map(item => [item.factId, item.utility])),
    }
    const existing = snapshot.derivedArtifacts.find(artifact => artifact.id === artifactId)
    const previous = parseTierAssignment(existing?.content)
    const factById = new Map(facts.map(fact => [fact.id, fact]))
    const utilityChanged = breakdown.some((item) => {
      const fact = factById.get(item.factId)
      return fact?.utilityScore !== round3(item.utility)
    })
    // generatedAt is audit metadata, not assignment identity. Comparing the
    // actual tier membership prevents an unchanged idle pass from rewriting
    // the encrypted journal merely because wall-clock time advanced.
    const skipped = existing?.status === 'current'
      && existing.builderVersion === MEMORY_TIERING_SERVICE_VERSION
      && previous !== undefined
      && sameTierMembership(previous.tiers, tiers)
      && !utilityChanged

    const content = JSON.stringify(payload)
    const contentHash = sha256(content)

    if (!skipped) {
      const utilityById = new Map(breakdown.map(item => [item.factId, item.utility]))
      repository.transaction((draft) => {
        // Persist computed utility back onto each fact so retrieval layers can
        // consume it without recomputation. utilityScore is a derived cache:
        // updatedAt stays untouched so recency (and therefore idempotency of
        // this run) is unaffected, and the latest-version consistency fields
        // are not part of this change either.
        for (const fact of draft.facts) {
          const utility = utilityById.get(fact.id)
          if (utility === undefined || fact.utilityScore === round3(utility))
            continue
          fact.utilityScore = round3(utility)
        }
        const artifact = draft.derivedArtifacts.find(item => item.id === artifactId)
        const timestamp = Math.max(now(), artifact?.updatedAt ?? 0)
        const next: MemoryDerivedArtifactV4 = {
          id: artifactId,
          scope: ownerScope,
          kind: 'tier-index',
          status: 'current',
          sourceEpisodeIds: [],
          sourceFactIds: [...utilityById.keys()].sort(),
          content,
          contentHash,
          createdAt: artifact?.createdAt ?? timestamp,
          updatedAt: timestamp,
          builderVersion: MEMORY_TIERING_SERVICE_VERSION,
        }
        if (artifact)
          draft.derivedArtifacts.splice(draft.derivedArtifacts.indexOf(artifact), 1, next)
        else
          draft.derivedArtifacts.push(next)
      })
    }

    return {
      version: MEMORY_TIERING_SERVICE_VERSION,
      factCount: facts.length,
      tierCounts: countTiers(breakdown),
      archiveCandidates: breakdown
        .filter(item => item.archiveCandidate)
        .sort((left, right) => left.utility - right.utility || left.factId.localeCompare(right.factId))
        .map(item => item.factId),
      protectedCount: breakdown.filter(item => item.protectedFromArchive).length,
      skipped,
      elapsedMs: Math.max(0, now() - startedAt),
    }
  }

  async function archiveColdFacts(
    scope: { ownerId: string; agentId?: string },
    options: ArchiveColdFactsOptions & TieringOptions = {},
  ): Promise<ArchiveColdFactsReport> {
    const startedAt = now()
    const maxArchives = clampInteger(options.maxArchives ?? 16, 0, 1_000)
    const reason = options.reason ?? 'utility-driven archival from capacity governance'
    const prefix = options.idempotencyKeyPrefix ?? 'tiering-archive'
    if (maxArchives === 0 || repository.readOnly)
      return { version: MEMORY_TIERING_SERVICE_VERSION, archived: [], failed: [], elapsedMs: Math.max(0, now() - startedAt) }

    const report = await run(scope, options)
    const targets = report.archiveCandidates.slice(0, maxArchives)
    const archived: string[] = []
    const failed: Array<{ factId: string; error: string }> = []
    for (const [index, factId] of targets.entries()) {
      try {
        const before = repository.snapshot().facts.find(fact => fact.id === factId)
        if (!before || before.status !== 'active')
          continue
        const result = lifecycle.archiveFact(factId, before.scope, {
          reason,
          // A restored or source-refreshed fact has a newer updatedAt and must
          // be eligible for a future independent archival decision.
          idempotencyKey: `${prefix}:${factId}:${before.updatedAt}:${index}`,
        })
        if (result.changed || repository.snapshot().facts.find(fact => fact.id === factId)?.status === 'archived')
          archived.push(factId)
      }
      catch (error) {
        failed.push({ factId, error: errorMessage(error) })
      }
    }
    // archiveFact invalidates the tier-index. Rebuild once after the bounded
    // batch so readers never observe an intentionally stale final assignment.
    if (archived.length > 0)
      await run(scope, options)
    return { version: MEMORY_TIERING_SERVICE_VERSION, archived, failed, elapsedMs: Math.max(0, now() - startedAt) }
  }

  return { run, archiveColdFacts, listTierAssignment }
}

/**
 * Pure tier assignment: quarantine by negative feedback first, then hot/warm/
 * cold by utility with capacity budgets, and archive candidates from the cold
 * overflow. Protected facts never fall below warm and never become archive
 * candidates.
 */
export function assignTiers(
  facts: readonly MemoryFactV4[],
  signals: Map<string, FactUtilitySignals>,
  options: TieringOptions,
  now: number,
): FactUtilityBreakdown[] {
  const thresholds = {
    hotUtility: options.hotUtility ?? DEFAULTS.hotUtility,
    warmUtility: options.warmUtility ?? DEFAULTS.warmUtility,
    quarantineDeniedCount: options.quarantineDeniedCount ?? DEFAULTS.quarantineDeniedCount,
    protectedImportance: options.protectedImportance ?? DEFAULTS.protectedImportance,
    recencyHalfLifeMs: options.recencyHalfLifeMs ?? DEFAULTS.recencyHalfLifeMs,
  }
  const budgets: TierCapacityBudgets = {
    hot: Math.max(1, options.hotBudget ?? DEFAULTS.hotBudget),
    warm: Math.max(1, options.warmBudget ?? DEFAULTS.warmBudget),
    cold: Math.max(1, options.coldBudget ?? DEFAULTS.coldBudget),
  }

  const scored = facts.map((fact) => {
    const signal = signals.get(fact.id)
      ?? { adoptedCount: 0, correctedCount: 0, deniedCount: 0, keyGroupSize: 1 }
    const utility = computeFactUtility(fact, signal, thresholds, now)
    const protectedFromArchive = fact.userConfirmed || fact.importance >= thresholds.protectedImportance
    const quarantine = signal.deniedCount >= thresholds.quarantineDeniedCount
    return { fact, signal, utility, protectedFromArchive, quarantine }
  })

  const eligible = scored.filter(item => !item.quarantine)

  const byUtilityDesc = [...eligible].sort((left, right) =>
    right.utility - left.utility || left.fact.id.localeCompare(right.fact.id))
  const hotIds = new Set(byUtilityDesc
    .filter(item => item.utility >= thresholds.hotUtility)
    .slice(0, budgets.hot)
    .map(item => item.fact.id))
  const afterHot = byUtilityDesc.filter(item => !hotIds.has(item.fact.id))
  const protectedWarm = afterHot.filter(item => item.protectedFromArchive)
  const warmCapacity = Math.max(0, budgets.warm - protectedWarm.length)
  const regularWarm = afterHot
    .filter(item => !item.protectedFromArchive && item.utility >= thresholds.warmUtility)
    .slice(0, warmCapacity)
  const warmIds = new Set([...protectedWarm, ...regularWarm].map(item => item.fact.id))
  const coldPool = afterHot.filter(item => !warmIds.has(item.fact.id))
  const overflowIds = new Set(coldPool.slice(budgets.cold).map(item => item.fact.id))

  const breakdown: FactUtilityBreakdown[] = []
  for (const item of scored) {
    let tier: MemoryTier
    if (item.quarantine)
      tier = 'quarantine'
    else if (hotIds.has(item.fact.id))
      tier = 'hot'
    else if (warmIds.has(item.fact.id))
      tier = 'warm'
    else
      tier = 'cold'
    breakdown.push({
      factId: item.fact.id,
      utility: round3(item.utility),
      tier,
      archiveCandidate: !item.quarantine && !item.protectedFromArchive && overflowIds.has(item.fact.id),
      protectedFromArchive: item.protectedFromArchive,
      reasons: utilityReasons(item),
    })
  }
  return breakdown
}

/** Deterministic 0..1 utility from importance, durability, adoption, recency, uniqueness and penalties. */
export function computeFactUtility(
  fact: MemoryFactV4,
  signal: FactUtilitySignals,
  thresholds: { recencyHalfLifeMs: number },
  now: number,
): number {
  const importanceSignal = clamp01(fact.importance)
  const durabilitySignal = clamp01(fact.evidenceScore)
  const accessSignal = clamp01(signal.adoptedCount * 0.25 + fact.accessCount * 0.1)
  const reference = fact.lastAccessedAt ?? fact.updatedAt
  const age = Math.max(0, now - reference)
  const recencySignal = age === 0
    ? 1
    : Math.pow(0.5, age / Math.max(1, thresholds.recencyHalfLifeMs))
  const uniquenessSignal = signal.keyGroupSize <= 1 ? 1 : 0.4
  const penalty = Math.min(0.5, signal.deniedCount * 0.2 + signal.correctedCount * 0.1)
  return clamp01(
    0.30 * importanceSignal
    + 0.15 * durabilitySignal
    + 0.20 * accessSignal
    + 0.15 * recencySignal
    + 0.10 * uniquenessSignal
    + 0.10 * (fact.userConfirmed ? 1 : 0)
    - penalty,
  )
}

function aggregateSignals(
  snapshot: MemoryV4Snapshot,
  scope: { ownerId: string; agentId?: string },
): Map<string, FactUtilitySignals> {
  const signals = new Map<string, FactUtilitySignals>()
  const keyGroups = new Map<string, number>()
  for (const fact of snapshot.facts) {
    if (fact.status !== 'active' || !matchesScope(fact.scope, scope))
      continue
    const key = `${fact.scope.ownerId}\0${fact.memoryKey}`
    keyGroups.set(key, (keyGroups.get(key) ?? 0) + 1)
  }
  for (const fact of snapshot.facts) {
    if (fact.status !== 'active' || !matchesScope(fact.scope, scope))
      continue
    signals.set(fact.id, {
      adoptedCount: 0,
      correctedCount: 0,
      deniedCount: 0,
      keyGroupSize: keyGroups.get(`${fact.scope.ownerId}\0${fact.memoryKey}`) ?? 1,
    })
  }
  for (const event of snapshot.retrievalEvents) {
    if (!matchesScope(event.scope, scope))
      continue
    for (const factId of event.adoptedFactIds) {
      const signal = signals.get(factId)
      if (signal)
        signal.adoptedCount += 1
    }
    for (const factId of event.correctedFactIds) {
      const signal = signals.get(factId)
      if (signal)
        signal.correctedCount += 1
    }
    for (const factId of event.deniedFactIds) {
      const signal = signals.get(factId)
      if (signal)
        signal.deniedCount += 1
    }
  }
  return signals
}

function utilityReasons(
  item: { fact: MemoryFactV4; signal: FactUtilitySignals; utility: number; quarantine: boolean },
): string[] {
  const reasons: string[] = []
  if (item.quarantine)
    reasons.push(`denied:${item.signal.deniedCount}`)
  if (item.fact.userConfirmed)
    reasons.push('user-confirmed')
  if (item.fact.importance >= 0.85)
    reasons.push('high-importance')
  if (item.signal.adoptedCount > 0)
    reasons.push(`adopted:${item.signal.adoptedCount}`)
  if (item.fact.accessCount > 0)
    reasons.push(`access:${item.fact.accessCount}`)
  return reasons
}

function countTiers(breakdown: readonly FactUtilityBreakdown[]): Record<MemoryTier, number> {
  const counts: Record<MemoryTier, number> = { hot: 0, warm: 0, cold: 0, quarantine: 0 }
  for (const item of breakdown) {
    if (item.tier in counts)
      counts[item.tier] += 1
  }
  return counts
}

function tierArtifactId(scope: { ownerId: string; agentId?: string }): string {
  const key = JSON.stringify([scope.ownerId, scope.agentId ?? ''])
  return `tier-index:${sha256(key).slice(0, 24)}`
}

function ownerLevelScope(scope: { ownerId: string; agentId?: string }): MemoryV4Scope {
  return { ownerId: scope.ownerId, agentId: scope.agentId ?? 'deskpet' }
}

function factScopeFor(snapshot: MemoryV4Snapshot, factId: string): MemoryV4Scope {
  const fact = snapshot.facts.find(item => item.id === factId)
  if (!fact)
    throw new Error(`Memory V4 fact ${factId} disappeared before archival`)
  return fact.scope
}

function matchesScope(scope: MemoryV4Scope, filter: { ownerId: string; agentId?: string }): boolean {
  return scope.ownerId === filter.ownerId
    && (filter.agentId === undefined || scope.agentId === filter.agentId)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.min(1, Math.max(0, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const clamped = Math.floor(value)
  if (!Number.isFinite(clamped))
    throw new Error(`Expected a finite number, received ${String(value)}`)
  return Math.min(maximum, Math.max(minimum, clamped))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseTierAssignment(content: string | undefined): TierAssignmentView | undefined {
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
        hot: [...value.tiers.hot ?? []],
        warm: [...value.tiers.warm ?? []],
        cold: [...value.tiers.cold ?? []],
        quarantine: [...value.tiers.quarantine ?? []],
      },
      utilities: { ...(value.utilities ?? {}) },
    }
  }
  catch {
    return undefined
  }
}

function sameTierMembership(left: TierAssignmentView['tiers'], right: TierAssignmentView['tiers']): boolean {
  return (Object.keys(right) as MemoryTier[]).every(tier => sameStrings(left[tier], right[tier]))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
