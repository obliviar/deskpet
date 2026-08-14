import type { MemoryCapture, MemoryScope } from '@deskpet/contracts'
import type { MemoryCandidate } from './memory-extractor'
import { isSafeMemoryContent } from './memory-extractor'
import type { V3MemoryRecord } from './vector-store'
import type { MemoryCalibrationPrediction, MemoryConfidenceCalibrator } from './confidence-calibration'

export const LOCAL_MEMORY_VERIFIER_VERSION = 'local-evidence-verifier-v1'
export const MEMORY_WRITE_POLICY_VERSION = 'evidence-first-policy-v1'

const REVIEW_REQUIRED_PREDICATES = /^(?:profile\.(?:phone|email|vehicle_plate)|health\.|contact\.)/u

export type MemoryCandidateDecisionAction = 'ADD' | 'MERGE_EVIDENCE' | 'REFINE'
  | 'SUPERSEDE' | 'CONFLICT' | 'QUARANTINE' | 'NOOP'
export type MemoryCandidateDecisionStatus = 'accepted' | 'rejected' | 'quarantined'

export interface MemoryWriteMatches {
  exact?: V3MemoryRecord
  activeByMemoryKey: V3MemoryRecord[]
}

export interface MemoryCandidateEvaluation {
  candidate: MemoryCandidate
  action: MemoryCandidateDecisionAction
  status: MemoryCandidateDecisionStatus
  extractionScore: number
  evidenceScore: number
  durabilityScore: number
  verificationScore: number
  ambiguityFlags: string[]
  reasonCodes: string[]
  verifierVersion: string
  policyVersion: string
  matchedMemoryId?: string
  calibration: MemoryCalibrationPrediction
}

export interface MemoryCandidateVerificationContext {
  turn: MemoryCapture
  scope: MemoryScope
  matches: MemoryWriteMatches
}

export type MemoryCandidateVerifier = (
  candidate: MemoryCandidate,
  context: MemoryCandidateVerificationContext,
) => Promise<MemoryCandidateEvaluation> | MemoryCandidateEvaluation

export interface LocalMemoryCandidateVerifierOptions {
  minimumExtractionScore?: number
  minimumEvidenceScore?: number
  minimumDurabilityScore?: number
  minimumVerificationScore?: number
  calibrator?: MemoryConfidenceCalibrator
}

const CORRECTION_PATTERNS = [
  /(?:不是|不再是|并非).{0,80}(?:而是|现在是|改成|更正为)/u,
  /(?:更正|纠正|改一下|更新一下).{0,80}(?:是|为|成)/u,
  /(?:以前|过去|曾经).{0,120}(?:现在|目前|如今)/u,
  /\b(?:not|no longer).{0,80}\b(?:but|now|instead)\b/i,
  /\b(?:correct|update|change)\b.{0,80}\b(?:to|is)\b/i,
]

const NON_ASSERTED_PATTERNS: Array<[string, RegExp]> = [
  ['question', /[？?]\s*$/u],
  ['hypothetical', /^(?:如果|假如|假设|假定|要是)|\b(?:if|suppose|assuming)\b/i],
  ['reported-speech', /(?:^|[，。！？,.!?])(?:他|她|他们|她们|别人|朋友|同事)说[“"'‘’]?(?:我|我的)/u],
  ['example-or-fiction', /^(?:例如|比如|举例|示例|假想场景|虚构设定|角色扮演)|\b(?:for example|fictional|roleplay)\b/i],
]

const TRANSIENT_PATTERNS = [
  /(?:刚才|临时|暂时|这(?:两|几|\d+)(?:秒|分钟|小时))/u,
  /(?:今天的天气|刚才的(?:回答|回复)|这次的(?:回答|回复|结果))/u,
  /\b(?:just now|temporarily|for the next few (?:minutes|hours))\b/i,
]

const VAGUE_VALUE_PATTERNS = /^(?:这个|那个|它|这里|那里|这样|那样|某个|东西|事情|this|that|it|something)$/iu

const KIND_DURABILITY: Record<string, number> = {
  explicit: 1,
  identity: 0.95,
  relationship: 0.92,
  health: 0.92,
  routine: 0.9,
  preference: 0.82,
  goal: 0.78,
  project: 0.72,
  contact: 0.85,
  image: 0.65,
  other: 0.55,
}

/**
 * Conservative, deterministic pre-write verifier.
 *
 * It does not pretend to be an NLI model. It establishes a local quality floor:
 * unsafe/non-asserted text is rejected, unsupported or ambiguous candidates are
 * quarantined, and destructive single-value updates require explicit correction
 * evidence. A learned verifier can replace this function behind the same port.
 */
export function createLocalMemoryCandidateVerifier(
  options: LocalMemoryCandidateVerifierOptions = {},
): MemoryCandidateVerifier {
  const minimumExtractionScore = clampScore(options.minimumExtractionScore, 0.55)
  const minimumEvidenceScore = clampScore(options.minimumEvidenceScore, 0.62)
  const minimumDurabilityScore = clampScore(options.minimumDurabilityScore, 0.45)
  const minimumVerificationScore = clampScore(options.minimumVerificationScore, 0.72)

  return (candidate, context) => {
    const extractionScore = score(candidate.metadata.confidence, 0.7)
    const evidenceScore = calculateEvidenceScore(candidate, context.turn)
    const durabilityScore = calculateDurabilityScore(candidate, context.turn)
    const ambiguityFlags = findAmbiguityFlags(candidate, context.turn)
    const clarityScore = ambiguityFlags.length === 0 ? 1 : Math.max(0, 1 - ambiguityFlags.length * 0.25)
    const verificationScore = roundScore(
      extractionScore * 0.25 + evidenceScore * 0.45 + durabilityScore * 0.2 + clarityScore * 0.1,
    )
    const calibration = options.calibrator?.calibrate(verificationScore, calibrationCohort(candidate)) ?? {
      probability: verificationScore,
      lowerBound: 0,
      upperBound: 1,
      status: 'insufficient-data' as const,
      sampleCount: 0,
      method: 'isotonic-pav' as const,
      calibratorVersion: 'none',
      cohort: calibrationCohort(candidate),
    }
    const policyVerificationScore = calibration.status === 'calibrated'
      ? calibration.lowerBound
      : verificationScore
    const base = {
      candidate,
      extractionScore,
      evidenceScore,
      durabilityScore,
      verificationScore,
      ambiguityFlags,
      calibration,
      verifierVersion: LOCAL_MEMORY_VERIFIER_VERSION,
      policyVersion: MEMORY_WRITE_POLICY_VERSION,
    }

    if (calibration.status === 'out-of-distribution') {
      return {
        ...base,
        action: 'QUARANTINE',
        status: 'quarantined',
        ambiguityFlags: unique([...ambiguityFlags, 'calibration-out-of-distribution']),
        reasonCodes: ['calibration-cohort-out-of-distribution'],
      } satisfies MemoryCandidateEvaluation
    }

    if (!isSafeMemoryContent(candidate.content)) {
      return { ...base, action: 'NOOP', status: 'rejected', reasonCodes: ['unsafe-content'] } satisfies MemoryCandidateEvaluation
    }
    if (ambiguityFlags.some(flag => flag.startsWith('non-asserted:'))) {
      return { ...base, action: 'NOOP', status: 'rejected', reasonCodes: ['not-a-user-assertion'] } satisfies MemoryCandidateEvaluation
    }
    if (durabilityScore < minimumDurabilityScore) {
      return { ...base, action: 'NOOP', status: 'rejected', reasonCodes: ['insufficient-durability'] } satisfies MemoryCandidateEvaluation
    }
    if (extractionScore < minimumExtractionScore
      || evidenceScore < minimumEvidenceScore
      || policyVerificationScore < minimumVerificationScore
      || ambiguityFlags.includes('ambiguous-value')
      || ambiguityFlags.includes('automatic-secret')) {
      return {
        ...base,
        action: 'QUARANTINE',
        status: 'quarantined',
        reasonCodes: calibration.status === 'calibrated' && calibration.lowerBound < minimumVerificationScore
          ? ['calibrated-lower-bound-below-threshold']
          : qualityReasons(
              extractionScore,
              evidenceScore,
              verificationScore,
              ambiguityFlags,
              { minimumExtractionScore, minimumEvidenceScore, minimumVerificationScore },
            ),
      } satisfies MemoryCandidateEvaluation
    }

    const predicate = string(candidate.metadata.predicate) || string(candidate.metadata.memoryKey)
    if (REVIEW_REQUIRED_PREDICATES.test(predicate) || candidate.metadata.sensitivity === 'secret') {
      return {
        ...base,
        action: 'QUARANTINE',
        status: 'quarantined',
        ambiguityFlags: unique([...ambiguityFlags, 'high-risk-review-required']),
        reasonCodes: ['high-risk-field-requires-confirmation'],
      } satisfies MemoryCandidateEvaluation
    }

    const exact = context.matches.exact
    const activeByKey = context.matches.activeByMemoryKey
    const exactIsActive = exact?.status === 'active'
    const activeDifferent = activeByKey.filter(item => item.id !== exact?.id)
    const currentValue = normalizedCandidateValue(candidate.content)

    if (exact?.status === 'suppressed' || exact?.status === 'deleted') {
      return {
        ...base,
        action: 'NOOP',
        status: 'rejected',
        reasonCodes: ['user-lifecycle-state-protected'],
        matchedMemoryId: exact.id,
      } satisfies MemoryCandidateEvaluation
    }

    if (exactIsActive && activeDifferent.length === 0) {
      const hasNewEvidence = addsNewEvidence(candidate, context.turn, exact)
      return {
        ...base,
        action: hasNewEvidence ? 'MERGE_EVIDENCE' : 'NOOP',
        status: 'accepted',
        reasonCodes: [hasNewEvidence ? 'matching-fact-new-evidence' : 'idempotent-repeat'],
        matchedMemoryId: exact.id,
      } satisfies MemoryCandidateEvaluation
    }

    if (activeByKey.length > 0) {
      const sameValue = activeByKey.find(item => normalizedCandidateValue(item.content) === currentValue)
      if (sameValue) {
        const hasNewEvidence = addsNewEvidence(candidate, context.turn, sameValue)
        return {
          ...base,
          action: hasNewEvidence ? 'MERGE_EVIDENCE' : 'NOOP',
          status: 'accepted',
          reasonCodes: [hasNewEvidence ? 'matching-key-new-evidence' : 'idempotent-repeat'],
          matchedMemoryId: sameValue.id,
        } satisfies MemoryCandidateEvaluation
      }

      if (isHistoricalCandidate(candidate)) {
        return {
          ...base,
          action: 'ADD',
          status: 'accepted',
          reasonCodes: ['historical-version-preserved'],
        } satisfies MemoryCandidateEvaluation
      }

      const refinement = activeByKey.find(item => valuesAreRefinement(currentValue, normalizedCandidateValue(item.content)))
      if (refinement && extractionScore >= 0.8 && evidenceScore >= 0.85) {
        return {
          ...base,
          action: 'REFINE',
          status: 'accepted',
          reasonCodes: ['supported-refinement'],
          matchedMemoryId: refinement.id,
        } satisfies MemoryCandidateEvaluation
      }

      if (hasCorrectionEvidence(candidate, context.turn)) {
        return {
          ...base,
          action: 'SUPERSEDE',
          status: 'accepted',
          reasonCodes: ['explicit-supported-correction'],
          matchedMemoryId: mostRecent(activeByKey)?.id,
        } satisfies MemoryCandidateEvaluation
      }

      return {
        ...base,
        action: 'CONFLICT',
        status: 'quarantined',
        ambiguityFlags: unique([...ambiguityFlags, 'unresolved-single-value-conflict']),
        reasonCodes: ['conflict-requires-confirmation'],
        matchedMemoryId: mostRecent(activeByKey)?.id,
      } satisfies MemoryCandidateEvaluation
    }

    return {
      ...base,
      action: 'ADD',
      status: 'accepted',
      reasonCodes: [exact ? 'inactive-fact-reasserted' : 'new-supported-fact'],
      ...(exact ? { matchedMemoryId: exact.id } : {}),
    } satisfies MemoryCandidateEvaluation
  }
}

export function quarantinedVerifierFailure(
  candidate: MemoryCandidate,
  reason = 'verifier-error',
): MemoryCandidateEvaluation {
  return {
    candidate,
    action: 'QUARANTINE',
    status: 'quarantined',
    extractionScore: score(candidate.metadata.confidence, 0),
    evidenceScore: 0,
    durabilityScore: score(candidate.metadata.importance, 0),
    verificationScore: 0,
    ambiguityFlags: ['verifier-failure'],
    reasonCodes: [reason],
    verifierVersion: LOCAL_MEMORY_VERIFIER_VERSION,
    policyVersion: MEMORY_WRITE_POLICY_VERSION,
    calibration: {
      probability: 0, lowerBound: 0, upperBound: 1, status: 'insufficient-data', sampleCount: 0,
      method: 'isotonic-pav', calibratorVersion: 'none', cohort: calibrationCohort(candidate),
    },
  }
}

function calibrationCohort(candidate: MemoryCandidate): string {
  return `${string(candidate.metadata.extractionChannel) || 'unknown'}:${string(candidate.metadata.kind) || 'other'}`
}

function calculateEvidenceScore(candidate: MemoryCandidate, turn: MemoryCapture): number {
  const origin = string(candidate.metadata.origin)
  const channel = string(candidate.metadata.extractionChannel)
  if ((origin === 'image' || channel === 'image') && (turn.attachments?.length ?? 0) > 0)
    return 0.95
  if (channel === 'context-confirmation'
    && /^(?:是的|对(?:的)?|没错|确实|可以这么说|yes|correct|that's right)[。！!.\s]*$/iu.test(turn.userMessage))
    return 0.92
  if (channel === 'rules' || channel === 'rules+model')
    return 0.98

  const source = comparable(turn.userMessage)
  const value = comparable(extractCandidateValue(candidate.content))
  if (!source || !value)
    return 0
  if (source.includes(value))
    return 1

  const valueTokens = semanticTokens(value)
  const sourceTokens = semanticTokens(source)
  if (valueTokens.size === 0)
    return 0
  let overlap = 0
  for (const token of valueTokens) {
    if (sourceTokens.has(token))
      overlap += 1
  }
  return roundScore(Math.min(0.85, 0.15 + 0.7 * overlap / valueTokens.size))
}

function calculateDurabilityScore(candidate: MemoryCandidate, turn: MemoryCapture): number {
  const kind = string(candidate.metadata.kind) || 'other'
  const importance = score(candidate.metadata.importance, 0.6)
  let result = importance * 0.55 + (KIND_DURABILITY[kind] ?? KIND_DURABILITY.other!) * 0.45
  if (TRANSIENT_PATTERNS.some(pattern => pattern.test(turn.userMessage)) && kind !== 'project' && kind !== 'goal')
    result -= 0.45
  const expiresAt = timestamp(candidate.metadata.expiresAt)
  if (expiresAt !== undefined) {
    const remaining = expiresAt - Date.now()
    if (remaining <= 24 * 60 * 60 * 1000)
      result -= 0.35
    else if (remaining <= 7 * 24 * 60 * 60 * 1000)
      result -= 0.2
  }
  return roundScore(result)
}

function findAmbiguityFlags(candidate: MemoryCandidate, turn: MemoryCapture): string[] {
  const flags: string[] = []
  for (const [label, pattern] of NON_ASSERTED_PATTERNS) {
    if (pattern.test(turn.userMessage))
      flags.push(`non-asserted:${label}`)
  }
  const value = extractCandidateValue(candidate.content).trim()
  if (!value || VAGUE_VALUE_PATTERNS.test(value))
    flags.push('ambiguous-value')
  if (candidate.metadata.cardinality === 'single' && !string(candidate.metadata.memoryKey))
    flags.push('single-value-without-stable-key')
  if (candidate.metadata.sensitivity === 'secret' && candidate.metadata.origin !== 'manual')
    flags.push('automatic-secret')
  return unique(flags)
}

function qualityReasons(
  extractionScore: number,
  evidenceScore: number,
  verificationScore: number,
  ambiguityFlags: string[],
  thresholds: { minimumExtractionScore: number; minimumEvidenceScore: number; minimumVerificationScore: number },
): string[] {
  const reasons: string[] = []
  if (extractionScore < thresholds.minimumExtractionScore)
    reasons.push('low-extraction-confidence')
  if (evidenceScore < thresholds.minimumEvidenceScore)
    reasons.push('evidence-does-not-support-candidate')
  if (verificationScore < thresholds.minimumVerificationScore)
    reasons.push('verification-threshold-not-met')
  if (ambiguityFlags.length > 0)
    reasons.push('ambiguous-or-high-risk')
  return reasons.length > 0 ? reasons : ['policy-quarantine']
}

function hasCorrectionEvidence(candidate: MemoryCandidate, turn: MemoryCapture): boolean {
  const intent = string(candidate.metadata.writeIntent)
  return intent === 'correction' || intent === 'supersede'
    || CORRECTION_PATTERNS.some(pattern => pattern.test(turn.userMessage))
}

function isHistoricalCandidate(candidate: MemoryCandidate): boolean {
  return candidate.metadata.temporalQualifier === 'historical'
    || timestamp(candidate.metadata.validTo) !== undefined
    || candidate.metadata.writeIntent === 'historical'
}

function addsNewEvidence(candidate: MemoryCandidate, turn: MemoryCapture, existing: V3MemoryRecord): boolean {
  const messageIds = unique([
    ...strings(turn.metadata?.sourceMessageIds),
    ...strings(candidate.metadata.sourceMessageIds),
  ])
  const attachmentIds = unique([
    ...strings(turn.metadata?.sourceAttachmentIds),
    ...strings(candidate.metadata.sourceAttachmentIds),
    ...(turn.attachments ?? []).map(item => item.id).filter((id): id is string => !!id),
  ])
  return messageIds.some(id => !existing.sourceMessageIds.includes(id))
    || attachmentIds.some(id => !existing.sourceAttachmentIds.includes(id))
}

function valuesAreRefinement(first: string, second: string): boolean {
  if (!first || !second || first === second)
    return false
  const shorter = first.length <= second.length ? first : second
  const longer = first.length > second.length ? first : second
  return shorter.length >= 2 && longer.includes(shorter) && longer.length - shorter.length <= Math.max(6, shorter.length)
}

function extractCandidateValue(content: string): string {
  const normalized = content.normalize('NFKC').trim()
  const separator = normalized.search(/[：:]/u)
  if (separator >= 0)
    return normalized.slice(separator + 1).trim()
  return normalized
    .replace(/^(?:用户|user)(?:的)?(?:姓名(?:是|为)?|名字(?:是|为)?|叫|希望的称呼(?:是|为)?|喜欢|喜好|偏好|爱喝|常喝|不喜欢|讨厌|所在地(?:是|为)?|居住在|住在|职业(?:是|为)?|是)\s*/iu, '')
    .replace(/^(?:the user|user)\s+(?:likes?|prefers?|dislikes?|hates?|lives? in|is based in|works? as)\s+/iu, '')
    .trim()
}

function normalizedCandidateValue(content: string): string {
  return comparable(extractCandidateValue(content))
}

function semanticTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const word of value.match(/[a-z0-9]+/giu) ?? [])
    tokens.add(`w:${word.toLocaleLowerCase()}`)
  const han = value.match(/[\u3400-\u9fff]/gu) ?? []
  if (han.length === 1)
    tokens.add(`c:${han[0]}`)
  for (let index = 0; index + 1 < han.length; index++)
    tokens.add(`b:${han[index]}${han[index + 1]}`)
  return tokens
}

function comparable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function mostRecent(items: V3MemoryRecord[]): V3MemoryRecord | undefined {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim())
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function score(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? roundScore(value) : fallback
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? roundScore(value) : fallback
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000
}
