/**
 * Long-term memory boundary.
 *
 * Decouples the runtime from any concrete vector store. Implementations may
 * back onto pgvector, DuckDB, in-memory cosine, or a hosted service.
 */

/** A single recalled memory fragment. */
export interface MemoryFragment {
  id: string
  content: string
  /** Relevance score in [0, 1] when produced by a retrieval call. */
  score?: number
  metadata?: Record<string, unknown>
  createdAt: number
  /** Last update time. Present for persistent stores that track deduplication updates. */
  updatedAt?: number
  status?: MemoryStatus
  origin?: MemoryOrigin
  importance?: number
  confidence?: number
  accessCount?: number
  lastAccessedAt?: number
  /** Start of real-world validity. */
  validFrom?: number
  /** End of real-world validity (exclusive). */
  validTo?: number
  /** System time at which this version was invalidated or superseded. */
  invalidatedAt?: number
  expiresAt?: number
  supersedes?: string
  memoryKey?: string
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
  sharePolicy?: MemorySharePolicy
  sensitivity?: MemorySensitivity
}

export type MemoryStatus = 'active' | 'superseded' | 'expired' | 'conflicted' | 'orphaned'
  | 'suppressed' | 'deleted'
export type MemoryOrigin = 'automatic' | 'manual' | 'image'
export type MemorySharePolicy = 'allow-remote' | 'local-only' | 'ask'
export type MemorySensitivity = 'normal' | 'private' | 'secret'
export type MemoryTemporalMode = 'current' | 'historical' | 'all'

/** Optional policy filter applied before recall scoring and usage accounting. */
export interface MemoryRecallOptions {
  sharePolicies?: MemorySharePolicy[]
  sensitivities?: MemorySensitivity[]
  /** Defaults to query-derived current or historical intent. */
  temporalMode?: MemoryTemporalMode
  /** Real-world timestamp used for point-in-time recall. */
  asOf?: number
}

/** Local policy for one-pass candidate ranking followed by adaptive selection. */
export interface AdaptiveMemoryRecallOptions extends MemoryRecallOptions {
  /** Candidates inspected in the first quality-evaluation batch. Defaults to 4. */
  initialBatchSize?: number
  /** Candidates inspected by each continuation batch. Defaults to 4. */
  continuationBatchSize?: number
  /** Maximum ranked, de-duplicated candidates retained for evaluation. Defaults to 20. */
  candidateLimit?: number
  /** Hard upper bound for memories injected into the prompt. Defaults to 10. */
  maxInjected?: number
  /** Maximum number of evaluated batches, including the first. Defaults to 3. */
  maxBatches?: number
  /** Soft prompt budget measured in normalized memory-content characters. Defaults to 2400. */
  maxCharacters?: number
  /** Minimum accepted fraction in a batch before broad recall stops. Defaults to 0.15. */
  minMarginalGain?: number
}

export type AdaptiveMemoryRecallStopReason = 'no-candidates' | 'coverage-satisfied'
  | 'score-drop' | 'marginal-gain' | 'character-budget' | 'max-injected'
  | 'max-batches' | 'candidates-exhausted' | 'memory-not-needed'
  | 'abstain-low-confidence'

/** Deterministic abstention gate applied before adaptive selection. */
export interface MemoryRecallAbstention {
  abstained: boolean
  /** Calibrated minimum fused score required for the detected query intent. */
  threshold: number
  bestScore: number
  version: string
}

/** Source-type classification used when a memory is injected as evidence. */
export type MemoryEvidenceSourceType = 'user-statement' | 'manual' | 'image' | 'inferred'

/** One injectable memory rendered as a citable, auditable evidence entry. */
export interface MemoryEvidencePackEntry {
  memoryId: string
  /** Short stable label (for example "M1") the answer model can cite as [M1]. */
  citation: string
  status?: MemoryStatus
  origin?: MemoryOrigin
  sourceType?: MemoryEvidenceSourceType
  confidence?: number
  importance?: number
  validFrom?: number
  validTo?: number
  /** System time at which this version was recorded. */
  recordedAt?: number
  sensitivity?: MemorySensitivity
  sharePolicy?: MemorySharePolicy
  supersedes?: string
  /** Bounded one-hop version/conflict neighbours for down-drill, not injected. */
  conflictGroupIds?: string[]
}

/** Result of matching recalled memories against the final answer. */
export type MemoryRecallFeedbackOutcome = 'adopted' | 'corrected' | 'denied' | 'ignored'

export interface MemoryRecallFeedbackReport {
  query: string
  scope: MemoryScope
  outcomes: Array<{ memoryId: string; outcome: MemoryRecallFeedbackOutcome }>
  /** Model identifier of the answer that produced the feedback, when known. */
  answerModel?: string
}

/** Result includes retrieval/injection separation for audit and unbiased usage accounting. */
export interface AdaptiveMemoryRecallResult {
  memories: MemoryFragment[]
  /** Candidate IDs whose quality was evaluated, whether or not they were injected. */
  retrievedMemoryIds: string[]
  /** IDs actually injected into the model prompt and counted as accessed. */
  injectedMemoryIds: string[]
  candidateCount: number
  evaluatedCount: number
  batchesEvaluated: number
  stopReason: AdaptiveMemoryRecallStopReason
  /** Deterministic query-plan intent used to choose retrieval and selection budgets. */
  queryIntent?: string
  /** Candidate budget selected before ranking; injection remains independently bounded. */
  candidateBudget?: number
  /** Retrieval routes that contributed candidates, for local audit and evaluation. */
  retrievalRoutes?: string[]
  /** Number of candidates produced by each route before fusion. */
  routeCandidateCounts?: Record<string, number>
  queryPlanVersion?: string
  fusionMethod?: string
  /** Citable evidence pack aligned with injectedMemoryIds. */
  evidencePack?: MemoryEvidencePackEntry[]
  /** Why the recall abstained or proceeded; present when the calibrated gate ran. */
  abstention?: MemoryRecallAbstention
}

/** Isolation boundary for long-term memories. */
export interface MemoryScope {
  /** Stable owner identifier. Server callers must derive this from authentication. */
  ownerId: string
  /** Stable agent/persona identifier. */
  agentId?: string
  /** Optional session restriction. Omit to recall across the owner's sessions. */
  sessionId?: string
}

/** A bounded, non-authoritative context window used only to resolve the current user turn. */
export interface MemoryCaptureContextMessage {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: number
}

export interface MemoryCaptureContext {
  /** Chronological recent messages. Implementations must cap both count and text length. */
  recentMessages: MemoryCaptureContextMessage[]
  /** Local navigation hint; never sufficient evidence for a memory by itself. */
  topicSummary?: string
}

/** A completed turn from which durable facts may be extracted. */
export interface MemoryCapture {
  userMessage: string
  /** Full source text for a segmented local capture. It is not copied into V3 fact metadata. */
  originalUserMessage?: string
  assistantMessage: string
  /** Context may disambiguate the current turn, but the current user assertion remains the authority. */
  context?: MemoryCaptureContext
  attachments?: Array<{
    type: 'image'
    data: string
    mimeType: string
    id?: string
  }>
  metadata?: Record<string, unknown>
}

export interface MemoryUpdate {
  /** Replace the user-visible fact text. Persistent stores must retain an auditable version. */
  content?: string
  importance?: number
  expiresAt?: number | null
  sharePolicy?: MemorySharePolicy
  sensitivity?: MemorySensitivity
  status?: MemoryStatus
}

export interface MemorySourceSyncResult {
  updated: number
  orphaned: number
}

export interface AgentMemoryPort {
  /** List memories inside a scope, ordered by most recently updated first. */
  list: (scope: MemoryScope, limit?: number) => Promise<MemoryFragment[]>
  /** Retrieve the top-K relevant memories inside an isolation scope. */
  recall: (
    query: string,
    scope: MemoryScope,
    topK?: number,
    options?: MemoryRecallOptions,
  ) => Promise<MemoryFragment[]>
  /** Optional adaptive recall. Older memory adapters may omit it and use recall(). */
  recallAdaptive?: (
    query: string,
    scope: MemoryScope,
    options?: AdaptiveMemoryRecallOptions,
  ) => Promise<AdaptiveMemoryRecallResult>
  /**
   * Optional post-answer feedback closure. The runtime reports which injected
   * memories were adopted (cited), ignored, corrected or denied so shadow audit
   * layers can record adopted/corrected/denied outcomes.
   */
  reportRecallFeedback?: (report: MemoryRecallFeedbackReport) => Promise<void>
  /** Persist one already-sanitized fact. */
  remember: (content: string, scope: MemoryScope, metadata?: Record<string, unknown>) => Promise<void>
  /** Extract and persist durable facts from a completed conversation turn. */
  capture: (turn: MemoryCapture, scope: MemoryScope) => Promise<number>
  /** Remove a memory by id, constrained to its owner scope. */
  forget: (id: string, scope: MemoryScope) => Promise<void>
  /** Irreversibly remove a memory and compact managed persistence. */
  purge?: (id: string, scope: MemoryScope) => Promise<boolean>
  /** Update user-managed lifecycle, privacy and importance fields. */
  update: (id: string, scope: MemoryScope, patch: MemoryUpdate) => Promise<boolean>
  /** Restore an inactive memory to the active set. */
  restore: (id: string, scope: MemoryScope) => Promise<boolean>
  /** Remove deleted chat messages as evidence and orphan unsupported automatic memories. */
  unlinkSources: (messageIds: string[], scope: MemoryScope) => Promise<MemorySourceSyncResult>
  /** Remove every memory inside a scope. */
  clear: (scope: MemoryScope) => Promise<void>
  /** Count memories inside a scope. */
  count: (scope: MemoryScope) => Promise<number>
}
