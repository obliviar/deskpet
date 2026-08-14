import type { AdaptiveMemoryRecallOptions, MemoryTemporalMode } from '@deskpet/contracts'
import { localSemanticConcepts } from './local-embedding'
import { isBroadPersonalMemoryQuery } from './adaptive-recall'
import { planTemporalQuery } from './temporal-query'

export const MEMORY_QUERY_PLANNER_VERSION = 'memory-query-planner-v1'

export type MemoryQueryIntent = 'external' | 'specific' | 'multi-fact' | 'temporal' | 'timeline' | 'enumerative'
export type MemoryRetrievalRoute = 'lexical' | 'semantic' | 'structured' | 'temporal'

export interface MemoryQueryPlan {
  version: typeof MEMORY_QUERY_PLANNER_VERSION
  intent: MemoryQueryIntent
  requiresMemory: boolean
  temporalMode: MemoryTemporalMode
  asOf?: number
  concepts: string[]
  routes: MemoryRetrievalRoute[]
  candidateBudget: number
  rankWindowSize: number
  selection: {
    initialBatchSize: number
    continuationBatchSize: number
    maxBatches: number
    maxInjected: number
    maxCharacters: number
  }
  reasonCodes: string[]
}

const PERSONAL_CUE = /(?:我的|关于我|对我|我曾|我以前|我过去|我现在|我目前|你记得我|称呼我|本人|\bmy\b|\bme\b|about\s+me|remember\s+me|know\s+about\s+me)/iu
const TIMELINE_CUE = /(?:变化|变迁|历程|时间线|先后|这些年|过去几年|从.+到|历史记录|timeline|over\s+time|through\s+the\s+years|history\s+of)/iu
const MULTI_FACT_CUE = /(?:以及|还有|分别|各自|同时|和我的|与我的|哪些.{0,12}(?:偏好|习惯|信息)|\b(?:and|also|both|respectively)\b)/iu
const EXTERNAL_KNOWLEDGE_CUE = /(?:什么是|定义是什么|如何定义|原理是什么|科普|解释一下|天气|新闻|汇率|股价|怎么计算|\bwhat\s+is\b|\bdefine\b|\bweather\b|\bnews\b|\bexchange\s+rate\b)/iu

/**
 * Plan retrieval before ranking. The planner is deliberately deterministic and
 * conservative: only clear external-knowledge requests bypass personal memory.
 */
export function planMemoryQuery(
  query: string,
  options: AdaptiveMemoryRecallOptions = {},
): MemoryQueryPlan {
  const normalized = query.normalize('NFKC').trim()
  const temporal = planTemporalQuery(normalized, options)
  const concepts = [...new Set(localSemanticConcepts(normalized))].sort()
  const broad = isBroadPersonalMemoryQuery(normalized)
  const timeline = TIMELINE_CUE.test(normalized)
  const hasPersonalCue = PERSONAL_CUE.test(normalized)
  const clearlyExternal = EXTERNAL_KNOWLEDGE_CUE.test(normalized)
    && !hasPersonalCue
    && concepts.length === 0
    && !broad
    && temporal.mode === 'current'

  let intent: MemoryQueryIntent
  if (!normalized || clearlyExternal)
    intent = 'external'
  else if (timeline)
    intent = 'timeline'
  else if (broad)
    intent = 'enumerative'
  else if (temporal.mode !== 'current' || temporal.asOf !== undefined)
    intent = 'temporal'
  else if (concepts.length > 1 || MULTI_FACT_CUE.test(normalized))
    intent = 'multi-fact'
  else
    intent = 'specific'

  const requiresMemory = intent !== 'external'
  const routes: MemoryRetrievalRoute[] = requiresMemory ? ['lexical', 'semantic'] : []
  if (requiresMemory && (concepts.length > 0 || intent === 'enumerative'))
    routes.push('structured')
  if (requiresMemory && (intent === 'temporal' || intent === 'timeline'))
    routes.push('temporal')

  const budget = intentBudget(intent)
  const reasonCodes = [
    `intent:${intent}`,
    `temporal:${temporal.mode}`,
    ...(concepts.length > 0 ? [`concept-count:${concepts.length}`] : []),
    ...(broad ? ['broad-personal-query'] : []),
    ...(timeline ? ['timeline-cue'] : []),
    ...(clearlyExternal ? ['clear-external-knowledge-query'] : []),
  ]

  return {
    version: MEMORY_QUERY_PLANNER_VERSION,
    intent,
    requiresMemory,
    temporalMode: temporal.mode,
    ...(temporal.asOf === undefined ? {} : { asOf: temporal.asOf }),
    concepts,
    routes,
    candidateBudget: budget.candidateBudget,
    rankWindowSize: Math.min(100, Math.max(budget.candidateBudget, budget.candidateBudget * 2)),
    selection: budget.selection,
    reasonCodes,
  }
}

function intentBudget(intent: MemoryQueryIntent): Pick<MemoryQueryPlan, 'candidateBudget' | 'selection'> {
  switch (intent) {
    case 'enumerative':
      return {
        candidateBudget: 80,
        selection: { initialBatchSize: 8, continuationBatchSize: 8, maxBatches: 8, maxInjected: 10, maxCharacters: 4000 },
      }
    case 'timeline':
      return {
        candidateBudget: 64,
        selection: { initialBatchSize: 4, continuationBatchSize: 4, maxBatches: 8, maxInjected: 12, maxCharacters: 4200 },
      }
    case 'temporal':
      return {
        candidateBudget: 48,
        selection: { initialBatchSize: 6, continuationBatchSize: 6, maxBatches: 6, maxInjected: 10, maxCharacters: 3200 },
      }
    case 'multi-fact':
      return {
        candidateBudget: 40,
        selection: { initialBatchSize: 6, continuationBatchSize: 6, maxBatches: 5, maxInjected: 10, maxCharacters: 3200 },
      }
    case 'specific':
      return {
        candidateBudget: 24,
        selection: { initialBatchSize: 4, continuationBatchSize: 4, maxBatches: 3, maxInjected: 8, maxCharacters: 2400 },
      }
    case 'external':
      return {
        candidateBudget: 0,
        selection: { initialBatchSize: 1, continuationBatchSize: 1, maxBatches: 1, maxInjected: 1, maxCharacters: 256 },
      }
  }
}
