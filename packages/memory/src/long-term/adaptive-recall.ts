import type {
  AdaptiveMemoryRecallOptions,
  AdaptiveMemoryRecallStopReason,
  MemoryFragment,
} from '@deskpet/contracts'
import { localSemanticConcepts } from './local-embedding'

export interface AdaptiveRankedMemory {
  memory: MemoryFragment
  score: number
  semanticScore: number
  lexicalScore: number
}

export interface AdaptiveRecallSelection {
  selectedMemoryIds: string[]
  evaluatedMemoryIds: string[]
  batchesEvaluated: number
  stopReason: AdaptiveMemoryRecallStopReason
}

const BROAD_PERSONAL_QUERY_PATTERNS = [
  /(?:我的|关于我|对我的|我过去|我以前|我这些年).{0,20}(?:哪些|所有|全部|总结|概括|回顾|偏好|习惯|经历|变化|历史|过去一年|多方面|分别|列出|信息|事情|记忆)/iu,
  /(?:总结|概括|回顾|列出|说说).{0,20}(?:我的|关于我|对我的|我过去|我以前|我这些年|你记得我的)/iu,
  /你(?:还)?记得我.{0,12}(?:什么|哪些|多少|事情|信息|记忆)/iu,
  /(?:my|about\s+me|what\s+you\s+(?:remember|know)\s+about\s+me).{0,32}(?:anything|everything|all|summary|summari[sz]e|preferences|habits|history|changes|facts|memories)/iu,
  /(?:summary|summari[sz]e|list|recap).{0,32}(?:my|about\s+me|what\s+you\s+(?:remember|know)\s+about\s+me)/iu,
]

export function isBroadPersonalMemoryQuery(query: string): boolean {
  return BROAD_PERSONAL_QUERY_PATTERNS.some(pattern => pattern.test(query))
}

/**
 * Evaluate an already-ranked pool in batches. This function performs no I/O
 * and never changes access counters, which keeps quality evaluation separate
 * from actual prompt injection.
 */
export function selectAdaptiveRecall(
  query: string,
  candidates: readonly AdaptiveRankedMemory[],
  options: AdaptiveMemoryRecallOptions = {},
): AdaptiveRecallSelection {
  if (candidates.length === 0) {
    return {
      selectedMemoryIds: [],
      evaluatedMemoryIds: [],
      batchesEvaluated: 0,
      stopReason: 'no-candidates',
    }
  }

  const initialBatchSize = clampInteger(options.initialBatchSize, 1, 10, 4)
  const continuationBatchSize = clampInteger(options.continuationBatchSize, 1, 10, 4)
  const maxInjected = clampInteger(options.maxInjected, 1, 20, 10)
  const maxBatches = clampInteger(options.maxBatches, 1, 10, 3)
  const maxCharacters = clampInteger(options.maxCharacters, 256, 20_000, 2400)
  const minMarginalGain = clampScore(options.minMarginalGain, 0.15)
  const queryConcepts = new Set(localSemanticConcepts(query))
  const enumerativeIntent = isBroadPersonalMemoryQuery(query)
    || options.temporalMode === 'historical'
    || options.temporalMode === 'all'
  const multiConceptIntent = queryConcepts.size > 1
  const bestScore = candidates[0]!.score
  const evaluatedMemoryIds: string[] = []
  const selected: AdaptiveRankedMemory[] = []
  const selectedTokenSets: Set<string>[] = []
  const coveredConcepts = new Set<string>()
  let usedCharacters = 0
  let offset = 0
  let batchesEvaluated = 0
  let stopReason: AdaptiveMemoryRecallStopReason = 'candidates-exhausted'

  while (offset < candidates.length && batchesEvaluated < maxBatches) {
    const batchSize = batchesEvaluated === 0 ? initialBatchSize : continuationBatchSize
    const batch = candidates.slice(offset, offset + batchSize)
    if (batch.length === 0)
      break
    offset += batch.length
    batchesEvaluated += 1
    evaluatedMemoryIds.push(...batch.map(candidate => candidate.memory.id))
    const selectedBeforeBatch = selected.length

    for (const candidate of batch) {
      if (selected.length >= maxInjected) {
        stopReason = 'max-injected'
        break
      }

      const candidateConcepts = new Set(localSemanticConcepts(candidate.memory.content))
      const matchingConcepts = intersection(candidateConcepts, queryConcepts)
      const addsConcept = [...matchingConcepts].some(concept => !coveredConcepts.has(concept))
      const tokens = recallTokens(candidate.memory.content)
      const novelty = selectedTokenSets.length === 0
        ? 1
        : 1 - Math.max(...selectedTokenSets.map(existing => jaccard(tokens, existing)))
      const hasKnownButUnrequestedConcept = queryConcepts.size > 0
        && candidateConcepts.size > 0
        && matchingConcepts.size === 0
      if (hasKnownButUnrequestedConcept)
        continue

      const relativeScore = bestScore > 0 ? candidate.score / bestScore : 0
      const unclassifiedStrongMatch = queryConcepts.size > 0
        && candidateConcepts.size === 0
        && relativeScore >= 0.9
      const shouldSelect = selected.length === 0
        ? queryConcepts.size === 0 || matchingConcepts.size > 0 || unclassifiedStrongMatch
        : addsConcept
          || (enumerativeIntent
            && (queryConcepts.size === 0 || matchingConcepts.size > 0)
            && relativeScore >= 0.55
            && novelty >= 0.2)
          || (!enumerativeIntent && !multiConceptIntent && queryConcepts.size === 0
            && relativeScore >= 0.86 && novelty >= 0.25)
      if (!shouldSelect)
        continue

      const characterCost = normalizedCharacterCost(candidate.memory.content)
      if (selected.length > 0 && usedCharacters + characterCost > maxCharacters) {
        stopReason = 'character-budget'
        break
      }
      selected.push(candidate)
      selectedTokenSets.push(tokens)
      usedCharacters += characterCost
      for (const concept of matchingConcepts)
        coveredConcepts.add(concept)
    }

    if (stopReason === 'max-injected' || stopReason === 'character-budget')
      break

    const coverageComplete = queryConcepts.size > 0
      && [...queryConcepts].every(concept => coveredConcepts.has(concept))
    if (coverageComplete && !enumerativeIntent) {
      stopReason = 'coverage-satisfied'
      break
    }

    const acceptedInBatch = selected.length - selectedBeforeBatch
    const marginalGain = acceptedInBatch / batch.length
    if (acceptedInBatch === 0 || (batchesEvaluated > 1 && marginalGain < minMarginalGain)) {
      stopReason = 'marginal-gain'
      break
    }

    if (!enumerativeIntent && !multiConceptIntent && queryConcepts.size === 0) {
      stopReason = 'coverage-satisfied'
      break
    }

    const nextCandidate = candidates[offset]
    if (nextCandidate && bestScore > 0 && nextCandidate.score / bestScore < 0.45) {
      stopReason = 'score-drop'
      break
    }
  }

  if (offset < candidates.length && batchesEvaluated >= maxBatches
    && stopReason === 'candidates-exhausted')
    stopReason = 'max-batches'

  return {
    selectedMemoryIds: selected.map(candidate => candidate.memory.id),
    evaluatedMemoryIds,
    batchesEvaluated,
    stopReason,
  }
}

function normalizedCharacterCost(content: string): number {
  return Math.min(1000, content.replace(/\s+/gu, ' ').trim().length)
}

function recallTokens(content: string): Set<string> {
  const normalized = content.normalize('NFKC').toLocaleLowerCase()
  const tokens = new Set(normalized.match(/[a-z0-9]+|[\u3400-\u9fff]/gu) ?? [])
  for (const concept of localSemanticConcepts(normalized))
    tokens.add(`concept:${concept}`)
  return tokens
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter(value => right.has(value)))
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

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}
