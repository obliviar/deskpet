import type { MemoryRecallOptions, MemoryTemporalMode } from '@deskpet/contracts'

/** Half-open real-world validity window [from, to). */
export interface TemporalQueryRange {
  from: number
  to: number
}

export interface TemporalQueryPlan {
  mode: MemoryTemporalMode
  asOf?: number
  validBetween?: TemporalQueryRange
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
 * to the model. Explicit recall options always take precedence over inference.
 * A parsed start–end range or bounded relative window produces a historical
 * plan with `validBetween`; vague expressions such as “过去几年” are
 * deliberately not treated as ranges.
 */
export function planTemporalQuery(query: string, options?: MemoryRecallOptions): TemporalQueryPlan {
  const explicitAsOf = normalizeTimestamp(options?.asOf)
  const inferredAsOf = explicitAsOf ?? parseCalendarAsOf(query)
  if (options?.temporalMode)
    return { mode: options.temporalMode, ...(inferredAsOf ? { asOf: inferredAsOf } : {}) }
  const range = parseExplicitRange(query) ?? parseRelativeRange(query, explicitAsOf ?? Date.now())
  if (range && range.to > range.from)
    return { mode: 'historical', validBetween: range }
  if (inferredAsOf)
    return { mode: 'historical', asOf: inferredAsOf }
  if (HISTORICAL_PATTERNS.some(pattern => pattern.test(query)))
    return { mode: 'historical' }
  if (CURRENT_PATTERNS.some(pattern => pattern.test(query)))
    return { mode: 'current' }
  return { mode: 'current' }
}

const DATE_CHUNK_ZH = '((?:19|20)\\d{2})\\s*年(?:\\s*(1[0-2]|0?[1-9])\\s*月(?:份)?(?:\\s*([12]\\d|3[01]|0?[1-9])\\s*(?:日|号))?)?'
const MONTH_CHUNK_ZH = '(1[0-2]|0?[1-9])\\s*月(?:份)?'
const DATE_CHUNK_NUMERIC = '((?:19|20)\\d{2})[-/.](1[0-2]|0?[1-9])(?:[-/.]([12]\\d|3[01]|0?[1-9]))?'
const DATE_CHUNK_EN = `((?:19|20)\\d{2})(?:\\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?`
const RANGE_SEPARATORS = '(?:到|至|━|—|–|~|―|-|到\\s|\\s(?:to|until|till|through)\\s)'

/** Parse explicit “start to end” calendar ranges in Chinese, ISO and English. */
export function parseExplicitRange(query: string): TemporalQueryRange | undefined {
  const chunk = (prefix: string, suffix: string) => new RegExp(`${prefix}${RANGE_SEPARATORS}${suffix}`, 'u')
  const patterns = [
    { pattern: chunk(DATE_CHUNK_ZH, DATE_CHUNK_ZH), kind: 'zh' as const },
    { pattern: chunk(DATE_CHUNK_NUMERIC, DATE_CHUNK_NUMERIC), kind: 'numeric' as const },
    // “2025年3月到5月”: the right-hand month inherits the left-hand year.
    { pattern: new RegExp(`((?:19|20)\\d{2})\\s*年(?:\\s*${MONTH_CHUNK_ZH})?${RANGE_SEPARATORS}${MONTH_CHUNK_ZH}`, 'u'), kind: 'zh-month-inherit' as const },
    { pattern: new RegExp(`(?:between\\s+)?${DATE_CHUNK_EN}(?:\\s+(?:and|to|until|through)\\s+)${DATE_CHUNK_EN}`, 'iu'), kind: 'en' as const },
  ]
  for (const { pattern, kind } of patterns) {
    const match = pattern.exec(query)
    if (!match)
      continue
    if (kind === 'zh-month-inherit') {
      const inheritYear = match[1]!
      const start = rangeBoundary(inheritYear, match[2], undefined, 'start')
      const end = rangeBoundary(inheritYear, match[3], undefined, 'end')
      if (start !== undefined && end !== undefined && end > start)
        return { from: start, to: end }
      continue
    }
    const groups = kind === 'zh'
      ? [match[1], match[2], match[3], match[4], match[5], match[6]]
      : kind === 'numeric'
        ? [match[1], match[2], match[3], match[4], match[5], match[6]]
        : [match[1], match[3], match[4], match[5], match[7], match[8]]
    const start = rangeBoundary(groups[0], groups[1], groups[2], 'start')
    const end = rangeBoundary(groups[3], groups[4], groups[5], 'end')
    if (start !== undefined && end !== undefined && end > start)
      return { from: start, to: end }
  }
  return undefined
}

/**
 * Parse bounded relative windows such as “去年”, “上个月”, “最近三个月” or
 * “last year”. Vague phrases (“过去几年”) are intentionally not matched.
 */
export function parseRelativeRange(query: string, now: number): TemporalQueryRange | undefined {
  const nowDate = new Date(now)
  const yearStart = Date.UTC(nowDate.getUTCFullYear(), 0, 1)
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)

  const lastYear = /(?:前年|大前年|去年|上一年|last\s+year|the\s+year\s+before)/iu.exec(query)
  if (lastYear) {
    const offset = /前年/.test(lastYear[0]) ? 2 : /大前年/.test(lastYear[0]) ? 3 : 1
    const from = Date.UTC(nowDate.getUTCFullYear() - offset, 0, 1)
    return { from, to: Date.UTC(nowDate.getUTCFullYear() - offset + 1, 0, 1) }
  }
  if (/(?:上个月|上月|last\s+month|previous\s+month)/iu.test(query)) {
    const month = nowDate.getUTCMonth() - 1
    const from = Date.UTC(nowDate.getUTCFullYear(), month, 1)
    return { from, to: Date.UTC(nowDate.getUTCFullYear(), month + 1, 1) }
  }
  if (/(?:今年|本年度|this\s+year|current\s+year)/iu.test(query))
    return { from: yearStart, to: Date.UTC(nowDate.getUTCFullYear() + 1, 0, 1) }
  if (/(?:本月|当月|this\s+month|current\s+month)/iu.test(query))
    return { from: monthStart, to: Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1) }

  const quantified = /(?:最近|近|过去|past|last)\s*([0-9]{1,3}|[一二两三四五六七八九十]{1,3})\s*(年|个月|月|周|星期|天|日|years?|months?|weeks?|days?)/iu.exec(query)
  if (quantified) {
    const amount = parseCjkQuantity(quantified[1] ?? '')
    const unit = quantified[2] ?? ''
    if (unit && Number.isInteger(amount) && amount > 0 && amount <= 100) {
      const unitMs = /年|years?/iu.test(unit)
        ? 365.25 * 86_400_000
        : /个月|月|months?/iu.test(unit)
            ? 30.44 * 86_400_000
            : /周|星期|weeks?/iu.test(unit)
                ? 7 * 86_400_000
                : 86_400_000
      return { from: now - Math.round(amount * unitMs), to: now }
    }
  }
  return undefined
}

/** Parse a quantity written in ASCII digits or simple Chinese numerals (1-99). */
function parseCjkQuantity(text: string): number {
  if (/^[0-9]+$/.test(text))
    return Number(text)
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text === '十')
    return 10
  const tenIndex = text.indexOf('十')
  if (tenIndex > 0) {
    const tens = digits[text[tenIndex - 1]!]
    const ones = text.length > tenIndex + 1 ? (digits[text[tenIndex + 1]!] ?? 0) : 0
    return tens === undefined ? Number.NaN : tens * 10 + ones
  }
  if (tenIndex === 0) {
    const ones = text.length > 1 ? digits[text[1]!] : undefined
    return ones === undefined ? Number.NaN : 10 + ones
  }
  if (text.length === 1 && digits[text] !== undefined)
    return digits[text]!
  return Number.NaN
}

/** Start (or exclusive end) boundary for a calendar chunk at its own precision. */
function rangeBoundary(
  yearText: string | undefined,
  monthText: string | undefined,
  dayText: string | undefined,
  boundary: 'start' | 'end',
): number | undefined {
  if (!yearText)
    return undefined
  const year = Number(yearText)
  if (!Number.isInteger(year) || year < 1900 || year > 2099)
    return undefined
  const month = monthText === undefined ? undefined : Number(monthText)
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12))
    return undefined
  const day = dayText === undefined ? undefined : Number(dayText)
  if (boundary === 'start') {
    if (month === undefined)
      return Date.UTC(year, 0, 1)
    if (day === undefined)
      return Date.UTC(year, month - 1, 1)
    const candidate = Date.UTC(year, month - 1, day)
    if (new Date(candidate).getUTCDate() !== day || new Date(candidate).getUTCMonth() !== month - 1)
      return undefined
    return candidate
  }
  if (month === undefined)
    return Date.UTC(year + 1, 0, 1)
  if (day === undefined)
    return Date.UTC(year, month, 1)
  const candidate = Date.UTC(year, month - 1, day)
  if (new Date(candidate).getUTCDate() !== day || new Date(candidate).getUTCMonth() !== month - 1)
    return undefined
  return candidate + 86_400_000
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
