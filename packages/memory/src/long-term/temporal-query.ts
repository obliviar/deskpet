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
  const inferredAsOf = explicitAsOf ?? parseCalendarAsOf(query)
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

function parseCalendarAsOf(query: string): number | undefined {
  const iso = /(?:^|\D)((?:19|20)\d{2})[-/.](0?[1-9]|1[0-2])(?:[-/.](0?[1-9]|[12]\d|3[01]))?(?:\D|$)/u.exec(query)
  if (iso?.[1] && iso[2])
    return calendarTimestamp(Number(iso[1]), Number(iso[2]), optionalNumber(iso[3]))

  const chinese = /(?:^|\D)((?:19|20)\d{2})\s*年(?:\s*(0?[1-9]|1[0-2])\s*月(?:份)?(?:\s*(0?[1-9]|[12]\d|3[01])\s*(?:日|号))?)?/u.exec(query)
  if (chinese?.[1])
    return calendarTimestamp(Number(chinese[1]), optionalNumber(chinese[2]), optionalNumber(chinese[3]))

  const englishMonth = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
  const monthFirst = new RegExp(`(?:^|\\W)${englishMonth}\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+)?((?:19|20)\\d{2})(?:\\W|$)`, 'i').exec(query)
  if (monthFirst?.[1] && monthFirst[3])
    return calendarTimestamp(Number(monthFirst[3]), englishMonthNumber(monthFirst[1]), optionalNumber(monthFirst[2]))
  const yearFirst = new RegExp(`(?:^|\\W)((?:19|20)\\d{2})\\s+${englishMonth}(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:\\W|$)`, 'i').exec(query)
  if (yearFirst?.[1] && yearFirst[2])
    return calendarTimestamp(Number(yearFirst[1]), englishMonthNumber(yearFirst[2]), optionalNumber(yearFirst[3]))

  return undefined
}

function calendarTimestamp(year: number, month?: number, day?: number): number | undefined {
  if (!Number.isInteger(year) || year < 1900 || year > 2099)
    return undefined
  if (month === undefined)
    return Date.UTC(year, 6, 1, 12)
  if (!Number.isInteger(month) || month < 1 || month > 12)
    return undefined
  const selectedDay = day ?? 15
  const candidate = Date.UTC(year, month - 1, selectedDay, 12)
  const date = new Date(candidate)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== selectedDay)
    return undefined
  return candidate
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value)
}

function englishMonthNumber(value: string): number | undefined {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const index = months.findIndex(month => value.toLocaleLowerCase().startsWith(month))
  return index < 0 ? undefined : index + 1
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
