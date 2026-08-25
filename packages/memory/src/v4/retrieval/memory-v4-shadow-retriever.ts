import { createHash } from 'node:crypto'
import type { MemoryRecallAbstention, MemorySensitivity, MemorySharePolicy, MemoryTemporalMode } from '@deskpet/contracts'
import {
  calibrateRecallAbstention,
  type RecallAbstentionCalibrationModel,
} from '../../long-term/abstention-calibration'
import { createMemoryBm25Index, tokenizeBm25 } from '../../long-term/bm25-index'
import { createLocalEmbedding } from '../../long-term/local-embedding'
import { planMemoryQuery } from '../../long-term/memory-query-planner'
import { reciprocalRankFusion } from '../../long-term/reciprocal-rank-fusion'
import { createSparseVectorCandidateIndex } from '../../long-term/sparse-vector-candidate-index'
import type {
  MemoryDerivedArtifactV4,
  MemoryFactV4,
  MemoryFactStatusV4,
  MemoryV4Scope,
  MemoryV4Snapshot,
} from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export const MEMORY_V4_SHADOW_RETRIEVER_VERSION = 'memory-v4-shadow-retriever-v2'
export const MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION = 'memory-v3-v4-shadow-comparator-v1'
export const MEMORY_V4_LOCAL_CALIBRATION_DATASET_FINGERPRINT = 'e039d598c093be3b22d4727762fdcaf0db0da3f41715d3e1a50f3d505e160899'
export const DEFAULT_MEMORY_V4_RECALL_ABSTENTION_CALIBRATION: RecallAbstentionCalibrationModel = {
  version: 'memory-v4-local-calibration-v1:deskpet-v4-local-synthetic-calibration-v1',
  defaultThreshold: 0.45778665141358,
  thresholds: {
    enumerative: 0.36,
    'multi-fact': 0.59778665141358,
    specific: 0.583808110636619,
    temporal: 0.5519159852738316,
    timeline: 0.5,
  },
  datasetVersion: 'deskpet-v4-local-synthetic-calibration-v1',
  sampleCount: 700,
}

const MIN_LEXICAL_CANDIDATE_SCORE = 0.12
const MIN_SEMANTIC_CANDIDATE_SCORE = 0.08
const MIN_SUMMARY_EVIDENCE_SCORE = 0.28
const SUMMARY_EVIDENCE_WEIGHT = 0.25
const V4_BM25_STOP_TERMS = new Set([
  'w:a', 'w:an', 'w:and', 'w:are', 'w:do', 'w:does', 'w:i', 'w:is', 'w:me',
  'w:my', 'w:of', 'w:please', 'w:tell', 'w:the', 'w:to', 'w:user', 'w:what',
  'w:you', 'w:your',
])

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
  /** Absolute-evidence reject decision; RRF rank is deliberately excluded. */
  abstention?: MemoryRecallAbstention
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

export interface MemoryV4ShadowRetrieverOptions {
  now?: () => number
  /** Must be fitted on V4 absolute-evidence scores, never on normalized RRF. */
  abstentionCalibration?: RecallAbstentionCalibrationModel
}

interface IndexedSummary {
  artifact: MemoryDerivedArtifactV4
}

interface IndexedFact {
  fact: MemoryFactV4
  sourceMemoryId?: string
}

/**
 * Rebuildable V4 abstract index. Current summaries form the navigation layer;
 * facts form an independent direct route. A summary hit only contributes fact
 * ids and is always down-drilled through current fact/privacy/time checks.
 */
export function createMemoryV4ShadowRetriever(
  repository: MemoryV4Repository,
  options: MemoryV4ShadowRetrieverOptions = {},
): MemoryV4ShadowRetriever {
  const now = options.now ?? Date.now
  const abstentionCalibration = options.abstentionCalibration
    ?? DEFAULT_MEMORY_V4_RECALL_ABSTENTION_CALIBRATION
  const summaryLexical = createMemoryBm25Index({ tokenizer: tokenizeV4Evidence })
  const factLexical = createMemoryBm25Index({ tokenizer: tokenizeV4Evidence })
  const summarySemantic = createSparseVectorCandidateIndex()
  const factSemantic = createSparseVectorCandidateIndex()
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
    summarySemantic.clear()
    factSemantic.clear()

    for (const artifact of snapshot.derivedArtifacts) {
      if (artifact.kind !== 'summary' || artifact.status !== 'current' || !artifact.content)
        continue
      const vector = createLocalEmbedding(artifact.content)
      summaries.set(artifact.id, { artifact })
      summarySemantic.upsert(artifact.id, vector)
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
      const vector = createLocalEmbedding(content)
      const legacySourceId = legacySourceIds.get(fact.id)
      const v3SourceId = sourceMemoryId(fact) ?? legacySourceId
      facts.set(fact.id, {
        fact,
        ...(v3SourceId ? { sourceMemoryId: v3SourceId } : {}),
      })
      factSemantic.upsert(fact.id, vector)
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
      const abstention = calibrateRecallAbstention(plan.intent, 0, abstentionCalibration)
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
        abstention,
      })
    }

    const summaryScope = normalizedScope(recallOptions.scope)
    const summaryLexicalHits = summaryLexical.search(normalizedQuery, {
      scope: summaryScope,
      mode: 'current',
      limit: candidateBudget,
      minScore: MIN_LEXICAL_CANDIDATE_SCORE,
    })
    const queryVector = createLocalEmbedding(normalizedQuery)
    const summarySemanticHits = summarySemantic.search(queryVector, {
      limit: candidateBudget,
      minScore: MIN_SEMANTIC_CANDIDATE_SCORE,
      allow: id => summaries.get(id)?.artifact
        ? matchesScope(summaries.get(id)!.artifact.scope, recallOptions.scope)
        : false,
    }).flatMap(hit => summaries.get(hit.id)
      ? [{ indexed: summaries.get(hit.id)!, score: hit.score }]
      : [])
    const summaryLexicalScores = new Map(summaryLexicalHits.map(hit => [hit.id, hit.score]))
    const summarySemanticScores = new Map(summarySemanticHits.map(hit => [hit.indexed.artifact.id, hit.score]))
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
      .map(item => ({
        ...item,
        evidenceScore: combineRouteEvidence([
          summaryLexicalScores.get(item.id) ?? 0,
          summarySemanticScores.get(item.id) ?? 0,
        ]),
      }))
      .filter(item => item.evidenceScore >= MIN_SUMMARY_EVIDENCE_SCORE)
      .sort((left, right) =>
        right.evidenceScore - left.evidenceScore
        || right.normalizedScore - left.normalizedScore
        || left.id.localeCompare(right.id))
    const selectedSummaries = fusedSummaries.slice(0, summaryLimit)
    const summaryFactSupport = new Map<string, { rank: number; evidenceScore: number }>()
    for (const [rank, summary] of selectedSummaries.entries()) {
      for (const factId of summary.item.sourceFactIds) {
        if (!allowedFacts.has(factId))
          continue
        const current = summaryFactSupport.get(factId)
        if (!current || summary.evidenceScore > current.evidenceScore) {
          summaryFactSupport.set(factId, {
            rank: rank + 1,
            evidenceScore: summary.evidenceScore,
          })
        }
      }
    }

    const lexicalHits = factLexical.search(normalizedQuery, {
      scope: summaryScope,
      mode,
      limit: candidateBudget,
      minScore: MIN_LEXICAL_CANDIDATE_SCORE,
      allow: id => allowedFacts.has(id),
    })
    const semanticHits = factSemantic.search(queryVector, {
      limit: candidateBudget,
      minScore: MIN_SEMANTIC_CANDIDATE_SCORE,
      allow: id => allowedFacts.has(id),
    }).flatMap(hit => facts.get(hit.id) ? [{ indexed: facts.get(hit.id)!, score: hit.score }] : [])
    const structuredHits = plan.concepts.length === 0 && plan.intent !== 'enumerative'
      ? []
      : [...allowedFacts]
          .flatMap(id => facts.get(id) ? [facts.get(id)!.fact] : [])
          .filter(fact => structuredConceptEvidence(fact, plan.concepts, plan.intent) > 0)
          .sort((left, right) => right.utilityScore - left.utilityScore || left.id.localeCompare(right.id))
          .slice(0, candidateBudget)
    const lexicalScores = new Map(lexicalHits.map(hit => [hit.id, hit.score]))
    const semanticScores = new Map(semanticHits.map(hit => [hit.indexed.fact.id, hit.score]))
    const structuredScores = new Map(structuredHits.map(fact => [
      fact.id,
      structuredConceptEvidence(fact, plan.concepts, plan.intent),
    ]))
    const directCandidateIds = new Set([
      ...lexicalScores.keys(),
      ...semanticScores.keys(),
      ...structuredScores.keys(),
      ...summaryFactSupport.keys(),
    ])
    const directEvidence = new Map([...directCandidateIds].map(id => [
      id,
      combineRouteEvidence([
        lexicalScores.get(id) ?? 0,
        semanticScores.get(id) ?? 0,
        structuredScores.get(id) ?? 0,
      ]),
    ]))
    const threshold = calibrateRecallAbstention(plan.intent, 0, abstentionCalibration).threshold
    const minimumSummaryFactEvidence = threshold * 0.5
    const summaryHits = [...summaryFactSupport]
      // A summary is navigation, not evidence that every fact in its bucket is relevant.
      .filter(([id]) => (directEvidence.get(id) ?? 0) >= minimumSummaryFactEvidence)
      .sort((left, right) => left[1].rank - right[1].rank || left[0].localeCompare(right[0]))
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
      .map((item) => {
        const directScore = directEvidence.get(item.id) ?? 0
        const summaryScore = item.routes.includes('summary-down-drill')
          ? summaryFactSupport.get(item.id)?.evidenceScore ?? 0
          : 0
        const evidenceScore = clamp01(
          directScore + SUMMARY_EVIDENCE_WEIGHT * summaryScore * (1 - directScore),
        )
        // Rank support and static quality may break close ties, but cannot make
        // an item eligible when its absolute evidence is below the reject gate.
        const rankingScore = clamp01(
          0.88 * evidenceScore
          + 0.06 * item.normalizedScore * evidenceScore
          + 0.02 * item.item.verificationScore
          + 0.02 * item.item.utilityScore
          + 0.02 * item.item.importance,
        )
        return { ...item, evidenceScore, rankingScore }
      })
      .sort((left, right) =>
        right.rankingScore - left.rankingScore
        || right.evidenceScore - left.evidenceScore
        || left.id.localeCompare(right.id))
    const bestEvidenceScore = fusedFacts[0]?.evidenceScore ?? 0
    const abstention = calibrateRecallAbstention(plan.intent, bestEvidenceScore, abstentionCalibration)
    const eligibleFacts = abstention.abstained
      ? []
      : fusedFacts.filter(item => item.evidenceScore >= abstention.threshold)
    const hits = eligibleFacts.slice(0, limit).map(({ item, evidenceScore, routes }) => ({
      factId: item.id,
      ...(facts.get(item.id)?.sourceMemoryId ? { sourceMemoryId: facts.get(item.id)!.sourceMemoryId } : {}),
      content: item.canonicalText,
      score: evidenceScore,
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
      abstention,
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
  queryIntent: string
  retrievalRoutes: string[]
  snapshotRevision: number
  candidateCount: number
  summaryCandidates: number
  indexRebuildCount: number
  v3RetrievedCount: number
  v3InjectedCount: number
  v4RetrievedCount: number
  v4Abstained?: boolean
  v4BestEvidenceScore?: number
  v4AbstentionThreshold?: number
  v4AbstentionVersion?: string
  overlapCount: number
  /** Agreement against the current V3 baseline, not ground-truth recall. */
  v3AgreementRecallAtK: number
  v3AgreementPrecisionAtK: number
  jaccard: number
  v4LatencyMs: number
  privacyFiltered: number
  temporalFiltered: number
}

export interface V3V4ShadowFailure {
  queryHash: string
  errorName: string
  errorFingerprint: string
  failedAt: number
}

export interface V3V4ShadowComparisonSink {
  recordComparison: (comparison: V3V4ShadowComparison) => void
  recordFailure: (failure: V3V4ShadowFailure) => void
}

export interface V3V4ShadowComparisonStatus {
  version: typeof MEMORY_V3_V4_SHADOW_COMPARATOR_VERSION
  comparisons: number
  failures: number
  averageAgreementRecallAtK: number
  averageAgreementPrecisionAtK: number
  averageV4LatencyMs: number
  last?: V3V4ShadowComparison
  lastFailure?: V3V4ShadowFailure
}

export interface V3V4ShadowComparator {
  compare: (query: string, v3RetrievedIds: readonly string[], v3InjectedIds: readonly string[], v4: MemoryV4ShadowRecallResult) => V3V4ShadowComparison
  recordFailure: (query: string, error: unknown) => void
  status: () => V3V4ShadowComparisonStatus
}

/** In-memory, plaintext-free rollout telemetry for V3/V4 dual-read. */
export function createV3V4ShadowComparator(options: {
  now?: () => number
  /** Product builds use a per-installation HMAC; SHA-256 remains a deterministic test fallback. */
  queryHasher?: (query: string) => string
  sink?: V3V4ShadowComparisonSink
  onSinkError?: (error: unknown) => void
} = {}): V3V4ShadowComparator {
  const now = options.now ?? Date.now
  const queryHasher = options.queryHasher ?? sha256
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
        queryHash: queryHasher(query.normalize('NFKC')),
        comparedAt: now(),
        queryIntent: v4.queryIntent,
        retrievalRoutes: [...v4.routes],
        snapshotRevision: v4.snapshotRevision,
        candidateCount: v4.candidateCount,
        summaryCandidates: v4.summaryCandidates,
        indexRebuildCount: v4.index.rebuildCount,
        v3RetrievedCount: v3.size,
        v3InjectedCount: new Set(v3InjectedIds).size,
        v4RetrievedCount: v4Ids.size,
        ...(v4.abstention
          ? {
              v4Abstained: v4.abstention.abstained,
              v4BestEvidenceScore: v4.abstention.bestScore,
              v4AbstentionThreshold: v4.abstention.threshold,
              v4AbstentionVersion: v4.abstention.version,
            }
          : {}),
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
      notifySink(() => options.sink?.recordComparison(comparison), options.onSinkError)
      return comparison
    },
    recordFailure(query, error) {
      failures += 1
      const errorMessage = error instanceof Error ? error.message : String(error)
      lastFailure = {
        queryHash: queryHasher(query.normalize('NFKC')),
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorFingerprint: sha256(errorMessage),
        failedAt: now(),
      }
      notifySink(() => options.sink?.recordFailure(lastFailure!), options.onSinkError)
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

function notifySink(action: () => void, onError: ((error: unknown) => void) | undefined): void {
  try {
    action()
  }
  catch (error) {
    try {
      onError?.(error)
    }
    catch {
      // Evaluation telemetry must not escape into the answer path.
    }
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
  abstention?: MemoryRecallAbstention
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
    ...(input.abstention ? { abstention: input.abstention } : {}),
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

/** V4 BM25 treats Chinese bigrams as evidence and drops collision-prone unigrams. */
function tokenizeV4Evidence(value: string): string[] {
  return tokenizeBm25(value).filter(token => !token.startsWith('c:') && !V4_BM25_STOP_TERMS.has(token))
}

function structuredConceptEvidence(
  fact: MemoryFactV4,
  concepts: readonly string[],
  intent: string,
): number {
  // An explicit broad personal-memory request asks for the active fact set.
  // Scope/privacy/time filtering has already run, so every remaining fact is
  // directly responsive even when no single semantic field was named.
  if (intent === 'enumerative')
    return 0.72
  if (concepts.includes(fact.memoryKey))
    return 1
  return concepts.some(concept =>
    fact.memoryKey.startsWith(`${concept}.`) || concept.startsWith(`${fact.memoryKey}.`))
    ? 0.86
    : 0
}

/** Preserve absolute route strength while giving bounded credit to corroboration. */
function combineRouteEvidence(scores: readonly number[]): number {
  const ordered = scores.map(clamp01).sort((left, right) => right - left)
  const strongest = ordered[0] ?? 0
  const remaining = 1 - strongest
  return clamp01(
    strongest
    + remaining * 0.16 * (ordered[1] ?? 0)
    + remaining * 0.08 * (ordered[2] ?? 0),
  )
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
