import { createHash } from 'node:crypto'
import type { MemorySensitivity, MemorySharePolicy, MemoryTemporalMode } from '@deskpet/contracts'
import { createMemoryBm25Index } from '../../long-term/bm25-index'
import { createLocalEmbedding } from '../../long-term/local-embedding'
import { planMemoryQuery } from '../../long-term/memory-query-planner'
import { reciprocalRankFusion } from '../../long-term/reciprocal-rank-fusion'
import type {
  MemoryDerivedArtifactV4,
  MemoryFactV4,
  MemoryFactStatusV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export const MEMORY_V4_SHADOW_RETRIEVER_VERSION = 'memory-v4-shadow-retriever-v1'
export const MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION = 'memory-v3-v4-shadow-comparator-v1'

export interface MemoryV4ShadowRecallOptions {
  scope: { ownerId: string; agentId?: string; sessionId?: string }
  limit?: number
  summaryLimit?: number
  sharePolicies?: MemorySharePolicy[]
  sensitivities?: MemorySensitivity[]
  temporalMode?: MemoryTemporalMode
  asOf?: number
}

export interface MemoryV4ShadowRecallHit {
  factId: string
  sourceMemoryId?: string
  content: string
  score: number
  routes: string[]
  summaryIds: string[]
  status: MemoryFactStatusV4
  verificationState: MemoryFactV4['verificationState']
  sharePolicy: MemoryFactV4['sharePolicy']
  sensitivity: MemoryFactV4['sensitivity']
  validFrom?: number
  validTo?: number
}

export interface MemoryV4ShadowRecallResult {
  version: typeof MEMORY_V4_SHADOW_RETRIEVER_VERSION
  snapshotRevision: number
  queryIntent: string
  routes: string[]
  candidateCount: number
  summaryCandidates: number
  summariesUsed: string[]
  privacyFiltered: number
  temporalFiltered: number
  hits: MemoryV4ShadowRecallHit[]
  latencyMs: number
  index: {
    summaries: number
    facts: number
    rebuildCount: number
  }
}

export interface MemoryV4ShadowRetriever {
  /** Read-only: it never mutates V4 or influences the answer path. */
  recall: (query: string, options: MemoryV4ShadowRecallOptions) => MemoryV4ShadowRecallResult
  indexStatus: () => { summaries: number; facts: number; rebuildCount: number; revision?: number }
}

interface IndexedSummary {
  artifact: MemoryDerivedArtifactV4
  vector: number[]
}

interface IndexedFact {
  fact: MemoryFactV4
  vector: number[]
  sourceMemoryId?: string
}

/**
 * Rebuildable V4 abstract index. Current summaries form the navigation layer;
 * facts form an independent direct route. A summary hit only contributes fact
 * ids and is always down-drilled through current fact/privacy/time checks.
 */
export function createMemoryV4ShadowRetriever(
  repository: MemoryV4Repository,
  options: { now?: () => number } = {},
): MemoryV4ShadowRetriever {
  const now = options.now ?? Date.now
  const summaryLexical = createMemoryBm25Index()
  const factLexical = createMemoryBm25Index()
  const summaries = new Map<string, IndexedSummary>()
  const facts = new Map<string, IndexedFact>()
  let indexedRevision: number | undefined
  let indexedSignature = ''
  let rebuildCount = 0

  function rebuild(snapshot: MemoryV4Snapshot): void {
    const signature = indexSignature(snapshot)
    indexedRevision = snapshot.revision
    if (signature === indexedSignature)
      return
    indexedSignature = signature
    rebuildCount += 1
    summaries.clear()
    facts.clear()
    summaryLexical.clear()
    factLexical.clear()

    for (const artifact of snapshot.derivedArtifacts) {
      if (artifact.kind !== 'summary' || artifact.status !== 'current' || !artifact.content)
        continue
      summaries.set(artifact.id, { artifact, vector: createLocalEmbedding(artifact.content) })
      summaryLexical.upsert({
        id: artifact.id,
        content: artifact.content,
        scope: artifact.scope,
        state: 'active',
      })
    }
    const legacySourceIds = new Map(snapshot.legacyImports.map(item => [item.factId, item.sourceItemId]))
    for (const fact of snapshot.facts) {
      if (!indexableFact(fact))
        continue
      const content = `${fact.memoryKey} ${fact.predicate} ${fact.canonicalText}`
      const legacySourceId = legacySourceIds.get(fact.id)
      const v3SourceId = sourceMemoryId(fact) ?? legacySourceId
      facts.set(fact.id, {
        fact,
        vector: createLocalEmbedding(content),
        ...(v3SourceId ? { sourceMemoryId: v3SourceId } : {}),
      })
      factLexical.upsert({
        id: fact.id,
        content,
        scope: fact.scope,
        state: fact.status === 'active' ? 'active' : 'historical',
      })
    }
  }

  function recall(query: string, recallOptions: MemoryV4ShadowRecallOptions): MemoryV4ShadowRecallResult {
    const startedAt = performance.now()
    const normalizedQuery = query.normalize('NFKC').trim()
    const snapshot = repository.snapshot()
    if (indexedRevision !== snapshot.revision)
      rebuild(snapshot)
    const plan = planMemoryQuery(normalizedQuery, {
      ...(recallOptions.temporalMode ? { temporalMode: recallOptions.temporalMode } : {}),
      ...(recallOptions.asOf ? { asOf: recallOptions.asOf } : {}),
    })
    const mode = plan.temporalMode === 'current' ? 'current' : 'historical'
    const candidateBudget = Math.max(8, Math.min(256, plan.candidateBudget))
    const summaryLimit = clampInteger(
      recallOptions.summaryLimit ?? Math.max(4, Math.min(24, Math.ceil(candidateBudget / 4))),
      1,
      64,
    )
    const limit = clampInteger(recallOptions.limit ?? plan.selection.maxInjected, 1, 50)
    const allowedFacts = new Set<string>()
    let privacyFiltered = 0
    let temporalFiltered = 0
    for (const [id, indexed] of facts) {
      if (!matchesScope(indexed.fact.scope, recallOptions.scope))
        continue
      if (!passesPrivacy(indexed.fact, recallOptions)) {
        privacyFiltered += 1
        continue
      }
      if (!passesTemporal(indexed.fact, plan.temporalMode, plan.asOf, plan.validBetween, now())) {
        temporalFiltered += 1
        continue
      }
      allowedFacts.add(id)
    }

    if (!normalizedQuery || !plan.requiresMemory || allowedFacts.size === 0) {
      return result({
        snapshot,
        plan,
        privacyFiltered,
        temporalFiltered,
        hits: [],
        summaryCandidates: 0,
        summariesUsed: [],
        routes: [],
        candidateCount: 0,
        startedAt,
        summaries: summaries.size,
        facts: facts.size,
        rebuildCount,
      })
    }

    const summaryScope = normalizedScope(recallOptions.scope)
    const summaryLexicalHits = summaryLexical.search(normalizedQuery, {
      scope: summaryScope,
      mode: 'current',
      limit: candidateBudget,
    })
    const queryVector = createLocalEmbedding(normalizedQuery)
    const summarySemanticHits = [...summaries.values()]
      .filter(indexed => matchesScope(indexed.artifact.scope, recallOptions.scope))
      .map(indexed => ({ indexed, score: cosine(queryVector, indexed.vector) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.indexed.artifact.id.localeCompare(right.indexed.artifact.id))
      .slice(0, candidateBudget)
    const fusedSummaries = reciprocalRankFusion<MemoryDerivedArtifactV4>([
      {
        name: 'summary-lexical',
        items: summaryLexicalHits.flatMap(hit => summaries.get(hit.id)?.artifact
          ? [{ id: hit.id, item: summaries.get(hit.id)!.artifact }]
          : []),
      },
      {
        name: 'summary-semantic',
        items: summarySemanticHits.map(item => ({ id: item.indexed.artifact.id, item: item.indexed.artifact })),
      },
    ], { windowSize: candidateBudget })
    const selectedSummaries = fusedSummaries.slice(0, summaryLimit)
    const summaryFactRanks = new Map<string, number>()
    for (const [rank, summary] of selectedSummaries.entries()) {
      for (const factId of summary.item.sourceFactIds) {
        if (allowedFacts.has(factId) && !summaryFactRanks.has(factId))
          summaryFactRanks.set(factId, rank + 1)
      }
    }

    const lexicalHits = factLexical.search(normalizedQuery, {
      scope: summaryScope,
      mode,
      limit: candidateBudget,
      allow: id => allowedFacts.has(id),
    })
    const semanticHits = [...allowedFacts]
      .flatMap(id => facts.get(id) ? [facts.get(id)!] : [])
      .map(indexed => ({ indexed, score: cosine(queryVector, indexed.vector) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.indexed.fact.id.localeCompare(right.indexed.fact.id))
      .slice(0, candidateBudget)
    const structuredHits = [...allowedFacts]
      .flatMap(id => facts.get(id) ? [facts.get(id)!.fact] : [])
      .filter(fact => plan.concepts.some(concept =>
        fact.memoryKey === concept || fact.memoryKey.startsWith(`${concept}.`) || concept.startsWith(`${fact.memoryKey}.`)))
      .sort((left, right) => right.utilityScore - left.utilityScore || left.id.localeCompare(right.id))
      .slice(0, candidateBudget)
    const summaryHits = [...summaryFactRanks]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .flatMap(([id]) => facts.get(id)?.fact ? [{ id, item: facts.get(id)!.fact }] : [])

    const routes = [
      {
        name: 'fact-lexical',
        items: lexicalHits.flatMap(hit => facts.get(hit.id)?.fact
          ? [{ id: hit.id, item: facts.get(hit.id)!.fact }]
          : []),
      },
      {
        name: 'fact-semantic',
        items: semanticHits.map(item => ({ id: item.indexed.fact.id, item: item.indexed.fact })),
      },
      { name: 'fact-structured', items: structuredHits.map(fact => ({ id: fact.id, item: fact })) },
      { name: 'summary-down-drill', items: summaryHits },
    ].filter(route => route.items.length > 0)
    const fusedFacts = reciprocalRankFusion<MemoryFactV4>(routes, { windowSize: candidateBudget })
      .map(item => ({
        ...item,
        qualityScore: clamp01(
          0.72 * item.normalizedScore
          + 0.10 * item.item.verificationScore
          + 0.10 * item.item.utilityScore
          + 0.08 * item.item.importance,
        ),
      }))
      .sort((left, right) => right.qualityScore - left.qualityScore || left.id.localeCompare(right.id))
    const hits = fusedFacts.slice(0, limit).map(({ item, qualityScore, routes }) => ({
      factId: item.id,
      ...(facts.get(item.id)?.sourceMemoryId ? { sourceMemoryId: facts.get(item.id)!.sourceMemoryId } : {}),
      content: item.canonicalText,
      score: qualityScore,
      routes,
      summaryIds: selectedSummaries
        .filter(summary => summary.item.sourceFactIds.includes(item.id))
        .map(summary => summary.id),
      status: item.status,
      verificationState: item.verificationState,
      sharePolicy: item.sharePolicy,
      sensitivity: item.sensitivity,
      ...(item.validFrom === undefined ? {} : { validFrom: item.validFrom }),
      ...(item.validTo === undefined ? {} : { validTo: item.validTo }),
    }))
    return result({
      snapshot,
      plan,
      privacyFiltered,
      temporalFiltered,
      hits,
      summaryCandidates: fusedSummaries.length,
      summariesUsed: selectedSummaries.map(summary => summary.id),
      routes: routes.map(route => route.name),
      candidateCount: fusedFacts.length,
      startedAt,
      summaries: summaries.size,
      facts: facts.size,
      rebuildCount,
    })
  }

  return {
    recall,
    indexStatus: () => ({
      summaries: summaries.size,
      facts: facts.size,
      rebuildCount,
      ...(indexedRevision === undefined ? {} : { revision: indexedRevision }),
    }),
  }
}

export interface V3V4ShadowComparison {
  queryHash: string
  comparedAt: number
  v3RetrievedCount: number
  v3InjectedCount: number
  v4RetrievedCount: number
  overlapCount: number
  /** Agreement against the current V3 baseline, not ground-truth recall. */
  v3AgreementRecallAtK: number
  v3AgreementPrecisionAtK: number
  jaccard: number
  v4LatencyMs: number
  privacyFiltered: number
  temporalFiltered: number
}

export interface V3V4ShadowComparisonStatus {
  version: typeof MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION
  comparisons: number
  failures: number
  averageAgreementRecallAtK: number
  averageAgreementPrecisionAtK: number
  averageV4LatencyMs: number
  last?: V3V4ShadowComparison
  lastFailure?: { queryHash: string; message: string; failedAt: number }
}

export interface V3V4ShadowComparator {
  compare: (query: string, v3RetrievedIds: readonly string[], v3InjectedIds: readonly string[], v4: MemoryV4ShadowRecallResult) => V3V4ShadowComparison
  recordFailure: (query: string, error: unknown) => void
  status: () => V3V4ShadowComparisonStatus
}

/** In-memory, plaintext-free rollout telemetry for V3/V4 dual-read. */
export function createV3V4ShadowComparator(options: { now?: () => number } = {}): V3V4ShadowComparator {
  const now = options.now ?? Date.now
  let comparisons = 0
  let failures = 0
  let recallTotal = 0
  let precisionTotal = 0
  let latencyTotal = 0
  let last: V3V4ShadowComparison | undefined
  let lastFailure: V3V4ShadowComparisonStatus['lastFailure']

  return {
    compare(query, v3RetrievedIds, v3InjectedIds, v4) {
      const v3 = new Set(v3RetrievedIds)
      const v4Ids = new Set(v4.hits.flatMap(hit => hit.sourceMemoryId ? [hit.sourceMemoryId] : []))
      const overlapCount = [...v3].filter(id => v4Ids.has(id)).length
      const union = new Set([...v3, ...v4Ids]).size
      const comparison: V3V4ShadowComparison = {
        queryHash: sha256(query),
        comparedAt: now(),
        v3RetrievedCount: v3.size,
        v3InjectedCount: new Set(v3InjectedIds).size,
        v4RetrievedCount: v4Ids.size,
        overlapCount,
        v3AgreementRecallAtK: v3.size > 0 ? overlapCount / v3.size : (v4Ids.size === 0 ? 1 : 0),
        v3AgreementPrecisionAtK: v4Ids.size > 0 ? overlapCount / v4Ids.size : (v3.size === 0 ? 1 : 0),
        jaccard: union > 0 ? overlapCount / union : 1,
        v4LatencyMs: v4.latencyMs,
        privacyFiltered: v4.privacyFiltered,
        temporalFiltered: v4.temporalFiltered,
      }
      comparisons += 1
      recallTotal += comparison.v3AgreementRecallAtK
      precisionTotal += comparison.v3AgreementPrecisionAtK
      latencyTotal += comparison.v4LatencyMs
      last = comparison
      return comparison
    },
    recordFailure(query, error) {
      failures += 1
      lastFailure = {
        queryHash: sha256(query),
        message: error instanceof Error ? error.message : String(error),
        failedAt: now(),
      }
    },
    status: () => ({
      version: MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION,
      comparisons,
      failures,
      averageAgreementRecallAtK: comparisons > 0 ? recallTotal / comparisons : 0,
      averageAgreementPrecisionAtK: comparisons > 0 ? precisionTotal / comparisons : 0,
      averageV4LatencyMs: comparisons > 0 ? latencyTotal / comparisons : 0,
      ...(last ? { last } : {}),
      ...(lastFailure ? { lastFailure } : {}),
    }),
  }
}

function result(input: {
  snapshot: MemoryV4Snapshot
  plan: ReturnType<typeof planMemoryQuery>
  privacyFiltered: number
  temporalFiltered: number
  hits: MemoryV4ShadowRecallHit[]
  summaryCandidates: number
  summariesUsed: string[]
  routes: string[]
  candidateCount: number
  startedAt: number
  summaries: number
  facts: number
  rebuildCount: number
}): MemoryV4ShadowRecallResult {
  return {
    version: MEMORY_V4_SHADOW_RETRIEVER_VERSION,
    snapshotRevision: input.snapshot.revision,
    queryIntent: input.plan.intent,
    routes: input.routes,
    candidateCount: input.candidateCount,
    summaryCandidates: input.summaryCandidates,
    summariesUsed: input.summariesUsed,
    privacyFiltered: input.privacyFiltered,
    temporalFiltered: input.temporalFiltered,
    hits: input.hits,
    latencyMs: Math.max(0, performance.now() - input.startedAt),
    index: {
      summaries: input.summaries,
      facts: input.facts,
      rebuildCount: input.rebuildCount,
    },
  }
}

function indexSignature(snapshot: MemoryV4Snapshot): string {
  const facts = snapshot.facts.map(fact =>
    [fact.id, fact.updatedAt, fact.status, fact.canonicalText, fact.sharePolicy, fact.sensitivity].join('\0'))
  const summaries = snapshot.derivedArtifacts
    .filter(artifact => artifact.kind === 'summary')
    .map(artifact => [artifact.id, artifact.status, artifact.contentHash ?? '', artifact.updatedAt].join('\0'))
  return sha256([...facts.sort(), ...summaries.sort()].join('\n'))
}

function indexableFact(fact: MemoryFactV4): boolean {
  return fact.canonicalText !== '[purged]'
    && fact.verificationState !== 'rejected'
    && !['deleted', 'suppressed', 'quarantined', 'orphaned'].includes(fact.status)
}

function matchesScope(scope: MemoryV4Scope, filter: MemoryV4ShadowRecallOptions['scope']): boolean {
  return scope.ownerId === filter.ownerId
    && (filter.agentId === undefined || scope.agentId === filter.agentId)
    && (filter.sessionId === undefined || scope.sessionId === undefined || scope.sessionId === filter.sessionId)
}

function normalizedScope(scope: MemoryV4ShadowRecallOptions['scope']): MemoryV4Scope {
  return {
    ownerId: scope.ownerId,
    agentId: scope.agentId ?? 'deskpet',
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
  }
}

function passesPrivacy(fact: MemoryFactV4, options: MemoryV4ShadowRecallOptions): boolean {
  return (!options.sharePolicies || options.sharePolicies.includes(fact.sharePolicy))
    && (!options.sensitivities || options.sensitivities.includes(fact.sensitivity))
}

function passesTemporal(
  fact: MemoryFactV4,
  mode: MemoryTemporalMode,
  asOf: number | undefined,
  range: { from: number; to: number } | undefined,
  now: number,
): boolean {
  const reference = asOf ?? now
  const validFrom = fact.validFrom ?? Number.NEGATIVE_INFINITY
  const validTo = fact.validTo ?? fact.expiresAt ?? Number.POSITIVE_INFINITY
  if (range)
    return validFrom < range.to && validTo > range.from
  if (mode === 'current')
    return fact.status === 'active' && validFrom <= reference && validTo > reference
  if (asOf !== undefined) {
    const transactionEnd = fact.invalidatedAt ?? Number.POSITIVE_INFINITY
    return fact.recordedAt <= reference && transactionEnd > reference
      && validFrom <= reference && validTo > reference
  }
  return true
}

function sourceMemoryId(fact: MemoryFactV4): string | undefined {
  const value = fact.metadata?.v3SourceId
  return typeof value === 'string' && value.trim() ? value : undefined
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  for (let index = 0; index < length; index++)
    dot += (left[index] ?? 0) * (right[index] ?? 0)
  return Math.max(0, Math.min(1, dot))
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
