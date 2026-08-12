import type { MemoryRecallOptions, MemoryTemporalMode } from '@deskpet/contracts'

export interface TemporalQueryPlan {
  mode: MemoryTemporalMode
  asOf?: number
}

const HISTORICAL_PATTERNS = [
  /(?:以前|曾经|过去|从前|原来|之前|当时|那时|历史上|早些时候)/u,
  /\b(?:used\s+to|previously|formerly|before|in\s+the\s+past|back\s+then)\b/i,
]

const CURRENT_PATTERNS = [
  /(?:现在|目前|如今|当前|现阶段|最近)/u,
  /\b(?:now|currently|at\s+present|these\s+days)\b/i,
]

/**
 * Produce a deterministic temporal retrieval plan without sending the query
 * to a model. Explicit recall options always take precedence over inference.
 */
export function planTemporalQuery(query: string, options?: MemoryRecallOptions): TemporalQueryPlan {
  const explicitAsOf = normalizeTimestamp(options?.asOf)
  const inferredAsOf = explicitAsOf ?? parseYearAsOf(query)
  if (options?.temporalMode)
    return { mode: options.temporalMode, ...(inferredAsOf ? { asOf: inferredAsOf } : {}) }
  if (inferredAsOf)
    return { mode: 'historical', asOf: inferredAsOf }
  if (HISTORICAL_PATTERNS.some(pattern => pattern.test(query)))
    return { mode: 'historical' }
  if (CURRENT_PATTERNS.some(pattern => pattern.test(query)))
    return { mode: 'current' }
  return { mode: 'current' }
}

function parseYearAsOf(query: string): number | undefined {
  const match = /(?:^|\D)((?:19|20)\d{2})(?:\s*年|\b)/u.exec(query)
  if (!match?.[1])
    return undefined
  const year = Number(match[1])
  // Mid-year avoids incorrectly missing facts that began early in the named
  // year while retaining deterministic point-in-time behavior.
  return Date.UTC(year, 6, 1)
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
