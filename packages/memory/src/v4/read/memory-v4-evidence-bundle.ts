import type {
  AdaptiveMemoryRecallResult,
  MemoryEvidencePackEntry,
  MemoryEvidenceSourceType,
  MemoryFragment,
  MemoryOrigin,
  MemoryStatus,
} from '@deskpet/contracts'
import type {
  MemoryV4ShadowRecallHit,
  MemoryV4ShadowRecallResult,
} from '../retrieval/memory-v4-shadow-retriever'

export const MEMORY_V4_EVIDENCE_BUNDLE_VERSION = 'memory-v4-evidence-bundle-v1'

export interface MemoryV4EvidenceBundleEntry {
  citation: string
  factId: string
  /** V3 identity retained by mirrored facts for feedback and rollback compatibility. */
  sourceMemoryId?: string
  memoryId: string
  content: string
  score: number
  routes: string[]
  summaryIds: string[]
  status: MemoryV4ShadowRecallHit['status']
  verificationState: MemoryV4ShadowRecallHit['verificationState']
  sharePolicy: MemoryV4ShadowRecallHit['sharePolicy']
  sensitivity: MemoryV4ShadowRecallHit['sensitivity']
  validFrom?: number
  validTo?: number
  recordedAt?: number
  updatedAt?: number
  origin?: MemoryOrigin
  importance?: number
  accessCount?: number
}

/** Immutable answer-facing contract produced only after the V4 evidence gate. */
export interface MemoryV4EvidenceBundle {
  version: typeof MEMORY_V4_EVIDENCE_BUNDLE_VERSION
  source: 'v4'
  retrieverVersion: MemoryV4ShadowRecallResult['version']
  retrievalPolicy: MemoryV4ShadowRecallResult['policy']
  snapshotRevision: number
  queryIntent: string
  candidateCount: number
  retrievalRoutes: string[]
  summariesUsed: string[]
  selectedFactIds: string[]
  selectedMemoryIds: string[]
  entries: MemoryV4EvidenceBundleEntry[]
  abstention?: MemoryV4ShadowRecallResult['abstention']
  latencyMs: number
}

export function buildMemoryV4EvidenceBundle(
  recall: MemoryV4ShadowRecallResult,
): MemoryV4EvidenceBundle {
  const entries = recall.hits.map((hit, index): MemoryV4EvidenceBundleEntry => {
    const memoryId = hit.sourceMemoryId ?? hit.factId
    return {
      citation: `M${index + 1}`,
      factId: hit.factId,
      ...(hit.sourceMemoryId ? { sourceMemoryId: hit.sourceMemoryId } : {}),
      memoryId,
      content: hit.content,
      score: hit.score,
      routes: [...hit.routes],
      summaryIds: [...hit.summaryIds],
      status: hit.status,
      verificationState: hit.verificationState,
      sharePolicy: hit.sharePolicy,
      sensitivity: hit.sensitivity,
      ...(hit.validFrom === undefined ? {} : { validFrom: hit.validFrom }),
      ...(hit.validTo === undefined ? {} : { validTo: hit.validTo }),
      ...(hit.recordedAt === undefined ? {} : { recordedAt: hit.recordedAt }),
      ...(hit.updatedAt === undefined ? {} : { updatedAt: hit.updatedAt }),
      ...(hit.origin === undefined ? {} : { origin: hit.origin }),
      ...(hit.importance === undefined ? {} : { importance: hit.importance }),
      ...(hit.accessCount === undefined ? {} : { accessCount: hit.accessCount }),
    }
  })
  return {
    version: MEMORY_V4_EVIDENCE_BUNDLE_VERSION,
    source: 'v4',
    retrieverVersion: recall.version,
    retrievalPolicy: { ...recall.policy },
    snapshotRevision: recall.snapshotRevision,
    queryIntent: recall.queryIntent,
    candidateCount: recall.candidateCount,
    retrievalRoutes: [...recall.routes],
    summariesUsed: [...recall.summariesUsed],
    selectedFactIds: entries.map(entry => entry.factId),
    selectedMemoryIds: entries.map(entry => entry.memoryId),
    entries,
    ...(recall.abstention ? { abstention: { ...recall.abstention } } : {}),
    latencyMs: recall.latencyMs,
  }
}

/** Adapt the V4 answer contract to the stable AgentMemoryPort recall shape. */
export function memoryV4EvidenceBundleToAdaptiveResult(
  bundle: MemoryV4EvidenceBundle,
): AdaptiveMemoryRecallResult {
  const memories = bundle.entries.map(entryToMemoryFragment)
  const evidencePack = bundle.entries.map(entryToEvidencePack)
  return {
    memories,
    retrievedMemoryIds: [...bundle.selectedMemoryIds],
    injectedMemoryIds: [...bundle.selectedMemoryIds],
    candidateCount: bundle.candidateCount,
    evaluatedCount: bundle.candidateCount,
    batchesEvaluated: bundle.candidateCount > 0 ? 1 : 0,
    stopReason: bundle.abstention?.abstained
      ? 'abstain-low-confidence'
      : memories.length === 0
        ? 'no-candidates'
        : 'candidates-exhausted',
    queryIntent: bundle.queryIntent,
    candidateBudget: bundle.candidateCount,
    retrievalRoutes: [...bundle.retrievalRoutes],
    queryPlanVersion: bundle.retrieverVersion,
    fusionMethod: 'memory-v4-rrf-v1',
    evidencePack,
    ...(bundle.abstention ? { abstention: { ...bundle.abstention } } : {}),
  }
}

function entryToMemoryFragment(entry: MemoryV4EvidenceBundleEntry): MemoryFragment {
  const status = compatibleMemoryStatus(entry.status)
  return {
    id: entry.memoryId,
    content: entry.content,
    score: entry.score,
    metadata: {
      authoritativeReadSource: 'v4',
      v4FactId: entry.factId,
      v4VerificationState: entry.verificationState,
      v4Routes: [...entry.routes],
      v4SummaryIds: [...entry.summaryIds],
    },
    createdAt: entry.recordedAt ?? entry.validFrom ?? 0,
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(status ? { status } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.importance === undefined ? {} : { importance: entry.importance }),
    ...(entry.accessCount === undefined ? {} : { accessCount: entry.accessCount }),
    ...(entry.validFrom === undefined ? {} : { validFrom: entry.validFrom }),
    ...(entry.validTo === undefined ? {} : { validTo: entry.validTo }),
    sharePolicy: entry.sharePolicy,
    sensitivity: entry.sensitivity,
  }
}

function entryToEvidencePack(entry: MemoryV4EvidenceBundleEntry): MemoryEvidencePackEntry {
  const status = compatibleMemoryStatus(entry.status)
  return {
    memoryId: entry.memoryId,
    citation: entry.citation,
    ...(status ? { status } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.origin ? { sourceType: sourceType(entry.origin) } : {}),
    ...(entry.importance === undefined ? {} : { importance: entry.importance }),
    ...(entry.validFrom === undefined ? {} : { validFrom: entry.validFrom }),
    ...(entry.validTo === undefined ? {} : { validTo: entry.validTo }),
    ...(entry.recordedAt === undefined ? {} : { recordedAt: entry.recordedAt }),
    sensitivity: entry.sensitivity,
    sharePolicy: entry.sharePolicy,
  }
}

function compatibleMemoryStatus(status: MemoryV4ShadowRecallHit['status']): MemoryStatus | undefined {
  switch (status) {
    case 'active':
    case 'superseded':
    case 'expired':
    case 'conflicted':
    case 'orphaned':
    case 'suppressed':
    case 'deleted':
      return status
    default:
      return undefined
  }
}

function sourceType(origin: MemoryOrigin): MemoryEvidenceSourceType {
  if (origin === 'manual')
    return 'manual'
  if (origin === 'image')
    return 'image'
  return 'user-statement'
}
