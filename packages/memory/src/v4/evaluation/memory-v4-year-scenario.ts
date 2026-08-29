import { createHash } from 'node:crypto'
import type { MemoryTemporalMode } from '@deskpet/contracts'

export const MEMORY_V4_YEAR_SCENARIO_SCHEMA_VERSION = 1 as const
export const MEMORY_V4_YEAR_SCENARIO_GENERATOR_VERSION = 'memory-v4-year-scenario-generator-v1'

export type MemoryV4YearOperationKind
  = 'ADD' | 'REFINE' | 'SUPERSEDE' | 'ARCHIVE' | 'RESTORE'
    | 'CONFLICT' | 'RESOLVE' | 'DELETE' | 'NOOP'

export type MemoryV4YearTransformation
  = 'paraphrase' | 'repeat' | 'hypothetical' | 'quoted' | 'distractor' | 'occurrence'

export interface MemoryV4YearFactDefinition {
  id: string
  memoryKey: string
  predicate: string
  content: string
  normalizedValue?: string
  origin?: 'manual' | 'automatic'
  importance?: number
  cardinality?: 'single' | 'multiple' | 'set'
  validFromDay?: number
  validToDay?: number
}

export interface MemoryV4YearScheduledOperation {
  id: string
  day: number
  kind: Exclude<MemoryV4YearOperationKind, 'NOOP'>
  factId: string
  replacementFactId?: string
  content?: string
  reason?: string
}

export type MemoryV4YearQueryTruth
  = { kind: 'none' }
    | { kind: 'current-memory-keys'; memoryKeys: string[] }
    | { kind: 'history-memory-key'; memoryKey: string }
    | { kind: 'active-all' }
    | { kind: 'explicit'; sourceFactIds: string[] }

export interface MemoryV4YearQueryDefinition {
  id: string
  category: 'current' | 'historical' | 'timeline' | 'overview' | 'multi-fact' | 'multi-hop' | 'abstention' | 'conflict'
  query: string
  truth: MemoryV4YearQueryTruth
  fromDay?: number
  toDay?: number
  days?: number[]
  temporalMode?: MemoryTemporalMode
  limit?: number
}

export interface MemoryV4YearScenarioDefinition {
  schemaVersion: typeof MEMORY_V4_YEAR_SCENARIO_SCHEMA_VERSION
  scenarioVersion: string
  seed: number
  days: number
  minimumEventsPerDay: number
  checkpointDays: number[]
  scaleFactCount: number
  scaleQueryCount: number
  scope: { ownerId: string; agentId: string }
  facts: MemoryV4YearFactDefinition[]
  operations: MemoryV4YearScheduledOperation[]
  queries: MemoryV4YearQueryDefinition[]
  transformations: MemoryV4YearTransformation[]
}

export interface MemoryV4YearGeneratedEvent {
  id: string
  day: number
  sequence: number
  expectedOperation: MemoryV4YearOperationKind
  factId: string
  message: string
  scheduledOperation?: MemoryV4YearScheduledOperation
  transformation?: MemoryV4YearTransformation
}

export interface MemoryV4YearGeneratedScenario {
  version: typeof MEMORY_V4_YEAR_SCENARIO_GENERATOR_VERSION
  definition: MemoryV4YearScenarioDefinition
  definitionFingerprint: string
  eventFingerprint: string
  events: MemoryV4YearGeneratedEvent[]
  eventsByDay: Map<number, MemoryV4YearGeneratedEvent[]>
}

const DEFAULT_TRANSFORMATIONS: MemoryV4YearTransformation[] = [
  'paraphrase', 'repeat', 'hypothetical', 'quoted', 'distractor', 'occurrence',
]

/** Parse and normalize the compact, repository-visible year scenario contract. */
export function parseMemoryV4YearScenario(payload: string): MemoryV4YearScenarioDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse Memory V4 year scenario: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeScenario(parsed)
}

export function fingerprintMemoryV4YearScenario(definition: MemoryV4YearScenarioDefinition): string {
  return sha256(JSON.stringify(normalizeScenario(definition)))
}

/**
 * Expand a compact scenario into a deterministic daily event stream. Scheduled
 * lifecycle operations are preserved exactly; remaining daily capacity is
 * filled by automatically transformed NOOP observations. These transformations
 * exercise repetition, paraphrase, hypothetical/quoted wrappers, distractors
 * and occurrence identity without requiring hand-authored labels.
 */
export function generateMemoryV4YearScenario(
  input: MemoryV4YearScenarioDefinition,
): MemoryV4YearGeneratedScenario {
  const definition = normalizeScenario(input)
  const random = xorshift32(definition.seed)
  const operationsByDay = new Map<number, MemoryV4YearScheduledOperation[]>()
  for (const operation of definition.operations) {
    const operations = operationsByDay.get(operation.day) ?? []
    operations.push(operation)
    operationsByDay.set(operation.day, operations)
  }
  const events: MemoryV4YearGeneratedEvent[] = []
  const eventsByDay = new Map<number, MemoryV4YearGeneratedEvent[]>()
  for (let day = 1; day <= definition.days; day += 1) {
    const scheduled = [...(operationsByDay.get(day) ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))
    const daily: MemoryV4YearGeneratedEvent[] = scheduled.map((operation, index) => ({
      id: `day-${pad(day)}-operation-${operation.id}`,
      day,
      sequence: index + 1,
      expectedOperation: operation.kind,
      factId: operation.factId,
      message: operationMessage(operation, definition.facts),
      scheduledOperation: operation,
    }))
    const targetCount = Math.max(definition.minimumEventsPerDay, daily.length)
    while (daily.length < targetCount) {
      const fact = definition.facts[Math.floor(random() * definition.facts.length)]!
      const transformation = definition.transformations[
        Math.floor(random() * definition.transformations.length)
      ]!
      const sequence = daily.length + 1
      daily.push({
        id: `day-${pad(day)}-auto-${pad(sequence)}`,
        day,
        sequence,
        expectedOperation: 'NOOP',
        factId: fact.id,
        message: transformedMessage(fact, transformation, day),
        transformation,
      })
    }
    events.push(...daily)
    eventsByDay.set(day, daily)
  }
  return {
    version: MEMORY_V4_YEAR_SCENARIO_GENERATOR_VERSION,
    definition,
    definitionFingerprint: fingerprintMemoryV4YearScenario(definition),
    eventFingerprint: sha256(JSON.stringify(events)),
    events,
    eventsByDay,
  }
}

export function memoryV4YearQueriesForDay(
  definition: MemoryV4YearScenarioDefinition,
  day: number,
): MemoryV4YearQueryDefinition[] {
  return definition.queries.filter((query) => {
    if (query.days)
      return query.days.includes(day)
    return day >= (query.fromDay ?? 1) && day <= (query.toDay ?? definition.days)
  })
}

function normalizeScenario(value: unknown): MemoryV4YearScenarioDefinition {
  const source = record(value, 'scenario')
  if (source.schemaVersion !== MEMORY_V4_YEAR_SCENARIO_SCHEMA_VERSION)
    throw new Error(`Unsupported Memory V4 year scenario schema: ${String(source.schemaVersion)}`)
  const days = integer(source.days, 1, 3_650, 'days')
  const facts = array(source.facts, 'facts').map((item, index) => normalizeFact(item, days, index))
  unique(facts.map(fact => fact.id), 'fact id')
  const factIds = new Set(facts.map(fact => fact.id))
  const operations = array(source.operations, 'operations')
    .map((item, index) => normalizeOperation(item, days, factIds, index))
    .sort((left, right) => left.day - right.day || left.id.localeCompare(right.id))
  unique(operations.map(operation => operation.id), 'operation id')
  const queries = array(source.queries, 'queries').map((item, index) => normalizeQuery(item, days, factIds, index))
  unique(queries.map(query => query.id), 'query id')
  const checkpoints = uniqueIntegers(source.checkpointDays, 1, days, 'checkpointDays')
  if (checkpoints.length === 0)
    throw new Error('Memory V4 year scenario requires at least one checkpoint')
  const transformations = source.transformations === undefined
    ? [...DEFAULT_TRANSFORMATIONS]
    : array(source.transformations, 'transformations').map((item, index) => enumValue(
        item,
        DEFAULT_TRANSFORMATIONS,
        `transformations[${index}]`,
      ))
  if (transformations.length === 0)
    throw new Error('Memory V4 year scenario requires at least one transformation')
  const rawScope = record(source.scope, 'scope')
  return {
    schemaVersion: MEMORY_V4_YEAR_SCENARIO_SCHEMA_VERSION,
    scenarioVersion: text(source.scenarioVersion, 'scenarioVersion'),
    seed: integer(source.seed, 1, 0x7FFFFFFF, 'seed'),
    days,
    minimumEventsPerDay: integer(source.minimumEventsPerDay, 1, 50, 'minimumEventsPerDay'),
    checkpointDays: checkpoints.sort((left, right) => left - right),
    scaleFactCount: integer(source.scaleFactCount ?? 20_000, 100, 100_000, 'scaleFactCount'),
    scaleQueryCount: integer(source.scaleQueryCount ?? 7, 1, 100, 'scaleQueryCount'),
    scope: { ownerId: text(rawScope.ownerId, 'scope.ownerId'), agentId: text(rawScope.agentId, 'scope.agentId') },
    facts,
    operations,
    queries,
    transformations: [...new Set(transformations)],
  }
}

function normalizeFact(value: unknown, days: number, index: number): MemoryV4YearFactDefinition {
  const source = record(value, `facts[${index}]`)
  const origin = source.origin === undefined ? 'manual' : enumValue(source.origin, ['manual', 'automatic'] as const, `facts[${index}].origin`)
  const cardinality = source.cardinality === undefined
    ? 'single'
    : enumValue(source.cardinality, ['single', 'multiple', 'set'] as const, `facts[${index}].cardinality`)
  const importance = source.importance === undefined ? 0.6 : finite(source.importance, `facts[${index}].importance`)
  if (importance < 0 || importance > 1)
    throw new Error(`facts[${index}].importance must be between 0 and 1`)
  const validFromDay = source.validFromDay === undefined
    ? undefined
    : integer(source.validFromDay, 1, days, `facts[${index}].validFromDay`)
  const validToDay = source.validToDay === undefined
    ? undefined
    : integer(source.validToDay, 1, days + 1, `facts[${index}].validToDay`)
  if (validFromDay !== undefined && validToDay !== undefined && validFromDay >= validToDay)
    throw new Error(`facts[${index}] validFromDay must be earlier than validToDay`)
  return {
    id: text(source.id, `facts[${index}].id`),
    memoryKey: text(source.memoryKey, `facts[${index}].memoryKey`),
    predicate: text(source.predicate, `facts[${index}].predicate`),
    content: text(source.content, `facts[${index}].content`),
    ...(source.normalizedValue === undefined ? {} : { normalizedValue: text(source.normalizedValue, `facts[${index}].normalizedValue`) }),
    origin,
    importance,
    cardinality,
    ...(validFromDay === undefined ? {} : { validFromDay }),
    ...(validToDay === undefined ? {} : { validToDay }),
  }
}

function normalizeOperation(
  value: unknown,
  days: number,
  factIds: ReadonlySet<string>,
  index: number,
): MemoryV4YearScheduledOperation {
  const source = record(value, `operations[${index}]`)
  const kind = enumValue(source.kind, ['ADD', 'REFINE', 'SUPERSEDE', 'ARCHIVE', 'RESTORE', 'CONFLICT', 'RESOLVE', 'DELETE'] as const, `operations[${index}].kind`)
  const factId = text(source.factId, `operations[${index}].factId`)
  if (!factIds.has(factId))
    throw new Error(`operations[${index}] references missing fact ${factId}`)
  const replacementFactId = source.replacementFactId === undefined
    ? undefined
    : text(source.replacementFactId, `operations[${index}].replacementFactId`)
  if (replacementFactId && !factIds.has(replacementFactId))
    throw new Error(`operations[${index}] references missing replacement fact ${replacementFactId}`)
  if (['SUPERSEDE', 'CONFLICT', 'RESOLVE'].includes(kind) && !replacementFactId)
    throw new Error(`operations[${index}] ${kind} requires replacementFactId`)
  return {
    id: text(source.id, `operations[${index}].id`),
    day: integer(source.day, 1, days, `operations[${index}].day`),
    kind,
    factId,
    ...(replacementFactId ? { replacementFactId } : {}),
    ...(source.content === undefined ? {} : { content: text(source.content, `operations[${index}].content`) }),
    ...(source.reason === undefined ? {} : { reason: text(source.reason, `operations[${index}].reason`) }),
  }
}

function normalizeQuery(
  value: unknown,
  days: number,
  factIds: ReadonlySet<string>,
  index: number,
): MemoryV4YearQueryDefinition {
  const source = record(value, `queries[${index}]`)
  const category = enumValue(source.category, ['current', 'historical', 'timeline', 'overview', 'multi-fact', 'multi-hop', 'abstention', 'conflict'] as const, `queries[${index}].category`)
  const truthSource = record(source.truth, `queries[${index}].truth`)
  const truthKind = enumValue(truthSource.kind, ['none', 'current-memory-keys', 'history-memory-key', 'active-all', 'explicit'] as const, `queries[${index}].truth.kind`)
  let truth: MemoryV4YearQueryTruth
  if (truthKind === 'current-memory-keys')
    truth = { kind: truthKind, memoryKeys: stringList(truthSource.memoryKeys, `queries[${index}].truth.memoryKeys`) }
  else if (truthKind === 'history-memory-key')
    truth = { kind: truthKind, memoryKey: text(truthSource.memoryKey, `queries[${index}].truth.memoryKey`) }
  else if (truthKind === 'explicit') {
    const sourceFactIds = stringList(truthSource.sourceFactIds, `queries[${index}].truth.sourceFactIds`)
    for (const factId of sourceFactIds) {
      if (!factIds.has(factId))
        throw new Error(`queries[${index}] references missing explicit fact ${factId}`)
    }
    truth = { kind: truthKind, sourceFactIds }
  }
  else
    truth = { kind: truthKind }
  const fromDay = source.fromDay === undefined ? undefined : integer(source.fromDay, 1, days, `queries[${index}].fromDay`)
  const toDay = source.toDay === undefined ? undefined : integer(source.toDay, 1, days, `queries[${index}].toDay`)
  if (fromDay !== undefined && toDay !== undefined && fromDay > toDay)
    throw new Error(`queries[${index}] fromDay must not be later than toDay`)
  return {
    id: text(source.id, `queries[${index}].id`),
    category,
    query: text(source.query, `queries[${index}].query`),
    truth,
    ...(fromDay === undefined ? {} : { fromDay }),
    ...(toDay === undefined ? {} : { toDay }),
    ...(source.days === undefined ? {} : { days: uniqueIntegers(source.days, 1, days, `queries[${index}].days`) }),
    ...(source.temporalMode === undefined ? {} : { temporalMode: enumValue(source.temporalMode, ['current', 'historical', 'all'] as const, `queries[${index}].temporalMode`) }),
    ...(source.limit === undefined ? {} : { limit: integer(source.limit, 1, 50, `queries[${index}].limit`) }),
  }
}

function operationMessage(operation: MemoryV4YearScheduledOperation, facts: readonly MemoryV4YearFactDefinition[]): string {
  const fact = facts.find(item => item.id === operation.factId)!
  const replacement = facts.find(item => item.id === operation.replacementFactId)
  if (operation.kind === 'REFINE')
    return operation.content ?? fact.content
  if (operation.kind === 'SUPERSEDE')
    return `${fact.content}，后来变为${replacement?.content ?? operation.replacementFactId}`
  if (operation.kind === 'CONFLICT')
    return `${fact.content}；另有冲突记录：${replacement?.content ?? operation.replacementFactId}`
  if (operation.kind === 'RESOLVE')
    return `确认${fact.content}，排除${replacement?.content ?? operation.replacementFactId}`
  return fact.content
}

function transformedMessage(fact: MemoryV4YearFactDefinition, transformation: MemoryV4YearTransformation, day: number): string {
  switch (transformation) {
    case 'paraphrase': return `换一种说法，${fact.content}`
    case 'repeat': return `再次确认：${fact.content}`
    case 'hypothetical': return `假如${fact.content}，这只是一个假设`
    case 'quoted': return `别人说“${fact.content}”，不是用户的新陈述`
    case 'distractor': return `第 ${day} 天讨论天气和新闻，与${fact.memoryKey}无关`
    case 'occurrence': return `第 ${day} 天又发生一次相关事件，但稳定事实保持不变：${fact.content}`
  }
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Memory V4 year ${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Memory V4 year ${label} must be an array`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Memory V4 year ${label} must be a non-empty string`)
  return value.normalize('NFKC').trim()
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Memory V4 year ${label} must be finite`)
  return value
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = finite(value, label)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw new Error(`Memory V4 year ${label} must be an integer between ${minimum} and ${maximum}`)
  return number
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error(`Memory V4 year ${label} must be one of ${allowed.join(', ')}`)
  return value as T
}

function stringList(value: unknown, label: string): string[] {
  const result = array(value, label).map((item, index) => text(item, `${label}[${index}]`))
  if (result.length === 0)
    throw new Error(`Memory V4 year ${label} must not be empty`)
  unique(result, label)
  return result
}

function uniqueIntegers(value: unknown, minimum: number, maximum: number, label: string): number[] {
  const values = array(value, label).map((item, index) => integer(item, minimum, maximum, `${label}[${index}]`))
  unique(values.map(String), label)
  return values
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Memory V4 year ${label} contains duplicates`)
}

function pad(value: number): string {
  return String(value).padStart(3, '0')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
