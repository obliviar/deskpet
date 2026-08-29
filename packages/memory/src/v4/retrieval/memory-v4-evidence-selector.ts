import { localSemanticConcepts } from '../../long-term/local-embedding'
import type { MemoryQueryIntent } from '../../long-term/memory-query-planner'
import type { MemoryFactV4 } from '../domain/types'
import { DEFAULT_MEMORY_V4_RETRIEVAL_POLICY } from '../policy/memory-v4-retrieval-policy'

export const MEMORY_V4_EVIDENCE_SELECTOR_VERSION = 'memory-v4-evidence-selector-v1'

export type MemoryV4EvidenceSelectionStopReason
  = 'no-candidates' | 'coverage-satisfied' | 'marginal-gain'
    | 'character-budget' | 'max-selected' | 'candidates-exhausted'

export interface MemoryV4EvidenceCandidate {
  fact: MemoryFactV4
  evidenceScore: number
}

export interface MemoryV4EvidenceSelectionOptions {
  query: string
  intent: MemoryQueryIntent
  concepts?: readonly string[]
  subQueries?: readonly string[]
  maxSelected: number
  maxCharacters: number
  minMarginalGain?: number
}

export interface MemoryV4EvidenceSelection<T extends MemoryV4EvidenceCandidate> {
  version: typeof MEMORY_V4_EVIDENCE_SELECTOR_VERSION
  selected: T[]
  evaluatedFactIds: string[]
  coveredRequirements: string[]
  stopReason: MemoryV4EvidenceSelectionStopReason
  usedCharacters: number
}

/**
 * Greedy minimal-sufficient evidence selection over candidates that already
 * passed the retriever's absolute evidence gate. Query requirements drive
 * coverage; memory keys, temporal states and token novelty provide diversity.
 * Static rank remains a tie-breaker, never a substitute for new evidence.
 */
export function selectMemoryV4Evidence<T extends MemoryV4EvidenceCandidate>(
  candidates: readonly T[],
  options: MemoryV4EvidenceSelectionOptions,
): MemoryV4EvidenceSelection<T> {
  if (candidates.length === 0) {
    return {
      version: MEMORY_V4_EVIDENCE_SELECTOR_VERSION,
      selected: [],
      evaluatedFactIds: [],
      coveredRequirements: [],
      stopReason: 'no-candidates',
      usedCharacters: 0,
    }
  }

  const broad = options.intent === 'enumerative' || options.intent === 'timeline'
  const requirements = queryRequirements(options.query, options.concepts ?? [], options.subQueries ?? [])
  const maxSelected = clampInteger(options.maxSelected, 1, 50)
  const maxCharacters = clampInteger(options.maxCharacters, 128, 20_000)
  const minimumGain = clamp01(options.minMarginalGain ?? (broad
    ? DEFAULT_MEMORY_V4_RETRIEVAL_POLICY.evidenceSelection.broadMinimumMarginalGain
    : DEFAULT_MEMORY_V4_RETRIEVAL_POLICY.evidenceSelection.defaultMinimumMarginalGain))
  const bestScore = Math.max(0, ...candidates.map(candidate => candidate.evidenceScore))
  const remaining = candidates.map((candidate, index) => ({ candidate, index }))
  const selected: Array<{ candidate: T; index: number }> = []
  const evaluatedFactIds = new Set<string>()
  const coveredRequirements = new Set<string>()
  const coveredDiversity = new Set<string>()
  const selectedTokenSets: Set<string>[] = []
  let usedCharacters = 0
  let stopReason: MemoryV4EvidenceSelectionStopReason = 'candidates-exhausted'

  while (remaining.length > 0 && selected.length < maxSelected) {
    let bestIndex = -1
    let bestUtility = Number.NEGATIVE_INFINITY
    let bestMarginalGain = 0
    for (const [index, item] of remaining.entries()) {
      evaluatedFactIds.add(item.candidate.fact.id)
      const coverage = candidateCoverage(item.candidate.fact, requirements)
      const newRequirements = [...coverage.requirements]
        .filter(requirement => !coveredRequirements.has(requirement)).length
      const diversityKey = factDiversityKey(item.candidate.fact, options.intent)
      const diversityGain = coveredDiversity.has(diversityKey) ? 0 : 1
      const tokens = evidenceTokens(item.candidate.fact.canonicalText)
      const novelty = selectedTokenSets.length === 0
        ? 1
        : 1 - Math.max(...selectedTokenSets.map(existing => jaccard(tokens, existing)))
      const requirementGain = requirements.size === 0 ? 0 : newRequirements / requirements.size
      const relativeScore = bestScore > 0 ? item.candidate.evidenceScore / bestScore : 0
      const marginalGain = broad
        ? 0.45 * requirementGain + 0.35 * diversityGain + 0.20 * novelty
        : 0.70 * requirementGain + 0.20 * diversityGain + 0.10 * novelty
      const utility = selected.length === 0
        ? relativeScore
        : 0.72 * marginalGain + 0.28 * relativeScore
      if (utility > bestUtility
        || (utility === bestUtility && item.candidate.evidenceScore > (remaining[bestIndex]?.candidate.evidenceScore ?? -1))
        || (utility === bestUtility && item.candidate.evidenceScore === (remaining[bestIndex]?.candidate.evidenceScore ?? -1)
          && item.index < (remaining[bestIndex]?.index ?? Number.POSITIVE_INFINITY))) {
        bestIndex = index
        bestUtility = utility
        bestMarginalGain = marginalGain
      }
    }

    if (bestIndex < 0)
      break
    const next = remaining[bestIndex]!
    if (selected.length > 0 && bestMarginalGain < minimumGain) {
      stopReason = requirementsCovered(requirements, coveredRequirements) ? 'coverage-satisfied' : 'marginal-gain'
      break
    }
    const characterCost = normalizedCharacterCost(next.candidate.fact.canonicalText)
    if (selected.length > 0 && usedCharacters + characterCost > maxCharacters) {
      stopReason = 'character-budget'
      break
    }

    remaining.splice(bestIndex, 1)
    selected.push(next)
    usedCharacters += characterCost
    const coverage = candidateCoverage(next.candidate.fact, requirements)
    for (const requirement of coverage.requirements)
      coveredRequirements.add(requirement)
    coveredDiversity.add(factDiversityKey(next.candidate.fact, options.intent))
    selectedTokenSets.push(evidenceTokens(next.candidate.fact.canonicalText))

    const sufficient = requirementsCovered(requirements, coveredRequirements)
    if (!broad && sufficient) {
      // A specific question is satisfied by the smallest supported answer. A
      // multi-fact question only stops here after every clause/concept is met.
      stopReason = 'coverage-satisfied'
      break
    }
  }

  if (selected.length >= maxSelected && remaining.length > 0 && stopReason === 'candidates-exhausted')
    stopReason = 'max-selected'
  const ordered = [...selected].sort((left, right) => left.index - right.index)
  return {
    version: MEMORY_V4_EVIDENCE_SELECTOR_VERSION,
    selected: ordered.map(item => item.candidate),
    evaluatedFactIds: [...evaluatedFactIds],
    coveredRequirements: [...coveredRequirements].sort(),
    stopReason,
    usedCharacters,
  }
}

function queryRequirements(
  query: string,
  concepts: readonly string[],
  subQueries: readonly string[],
): Set<string> {
  const requirements = new Set(concepts.map(concept => `concept:${concept}`))
  for (const [index, subQuery] of subQueries.entries()) {
    const tokens = evidenceTokens(subQuery)
    if (tokens.size > 0)
      requirements.add(`clause:${index}:${[...tokens].sort().join('|')}`)
  }
  if (requirements.size === 0) {
    for (const token of evidenceTokens(query))
      requirements.add(`token:${token}`)
  }
  return requirements
}

function candidateCoverage(fact: MemoryFactV4, requirements: ReadonlySet<string>): { requirements: Set<string> } {
  const haystack = `${fact.memoryKey} ${fact.predicate} ${fact.canonicalText}`
  const concepts = new Set(localSemanticConcepts(haystack))
  const tokens = evidenceTokens(haystack)
  const matched = new Set<string>()
  for (const requirement of requirements) {
    if (requirement.startsWith('concept:') && concepts.has(requirement.slice('concept:'.length)))
      matched.add(requirement)
    else if (requirement.startsWith('token:') && tokens.has(requirement.slice('token:'.length)))
      matched.add(requirement)
    else if (requirement.startsWith('clause:')) {
      const clauseTokens = requirement.split(':').slice(2).join(':').split('|').filter(Boolean)
      if (clauseTokens.some(token => tokens.has(token)))
        matched.add(requirement)
    }
  }
  return { requirements: matched }
}

function requirementsCovered(requirements: ReadonlySet<string>, covered: ReadonlySet<string>): boolean {
  return requirements.size === 0 || [...requirements].every(requirement => covered.has(requirement))
}

function factDiversityKey(fact: MemoryFactV4, intent: MemoryQueryIntent): string {
  if (intent === 'timeline' || intent === 'temporal')
    return `${fact.memoryKey}\0${fact.validFrom ?? fact.recordedAt}\0${fact.status}\0${fact.normalizedValue}`
  return fact.memoryKey || fact.predicate || fact.id
}

function evidenceTokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]+|[\u3400-\u9fff]{2,}/gu) ?? [])
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/gu) ?? []
  for (const run of chineseRuns) {
    for (let index = 0; index < run.length - 1; index += 1)
      tokens.add(run.slice(index, index + 2))
  }
  for (const stop of ['我的', '关于', '什么', '哪些', '用户', '记得', '分别', 'the', 'what', 'about', 'remember'])
    tokens.delete(stop)
  return tokens
}

function normalizedCharacterCost(content: string): number {
  return Math.min(2_000, content.replace(/\s+/gu, ' ').trim().length)
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0)
    return 1
  let overlap = 0
  for (const value of left) {
    if (right.has(value))
      overlap += 1
  }
  return overlap / Math.max(1, left.size + right.size - overlap)
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value))
    return minimum
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.min(1, Math.max(0, value))
}
