import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { MemoryScope } from '@deskpet/contracts'
import { extractMemoryCandidates, type MemoryCandidate } from '../../long-term/memory-extractor'
import { createVectorStore, type V3MemoryCommit, type V3MemoryRecord } from '../../long-term/vector-store'
import { createMemoryConsolidationService } from '../consolidation/memory-consolidation-service'
import { createMemoryTieringService } from '../consolidation/memory-tiering-service'
import type { MemoryFactV4, MemoryV4Snapshot } from '../domain/types'
import { assertMemoryV4Snapshot } from '../domain/validation'
import {
  DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
  memoryV4RetrievalPolicyIdentity,
  type MemoryV4RetrievalPolicy,
  type MemoryV4RetrievalPolicyIdentity,
} from '../policy/memory-v4-retrieval-policy'
import { createV4ShadowWriter, type V4ShadowWriter } from '../dual-write/v4-shadow-writer'
import { createMemoryV4LifecycleService, type MemoryV4LifecycleService } from '../lifecycle/memory-v4-lifecycle'
import {
  createMemoryV4Repository,
  type MemoryV4Persistence,
  type MemoryV4Repository,
} from '../repository/memory-v4-repository'
import {
  createMemoryV4ShadowRetriever,
  type MemoryV4ShadowRecallResult,
} from '../retrieval/memory-v4-shadow-retriever'
import {
  generateMemoryV4YearScenario,
  memoryV4YearQueriesForDay,
  type MemoryV4YearFactDefinition,
  type MemoryV4YearGeneratedEvent,
  type MemoryV4YearGeneratedScenario,
  type MemoryV4YearOperationKind,
  type MemoryV4YearQueryDefinition,
  type MemoryV4YearScenarioDefinition,
} from './memory-v4-year-scenario'

export const MEMORY_V4_YEAR_SIMULATOR_VERSION = 'memory-v4-year-simulator-v1'
export const MEMORY_V4_YEAR_GATE_VERSION = 'memory-v4-year-functional-gate-v1'

const BASE_TIME = Date.UTC(2026, 0, 1)
const DAY_MS = 24 * 60 * 60 * 1000
const DERIVED_GRANULARITIES = ['session', 'day', 'topic', 'entity', 'stage'] as const
const TIER_OPTIONS = { hotBudget: 32, warmBudget: 128, coldBudget: 20_000 }

export type MemoryV4YearStrategy = 'v3' | 'v4' | 'v4-no-summaries'

export interface MemoryV4YearFailureLocator {
  day: number
  phase: 'operation' | 'restart' | 'rebuild' | 'query' | 'scale' | 'gate'
  operationId?: string
  queryId?: string
  sourceFactId?: string
  factId?: string
  factVersionIds?: string[]
  strategy?: MemoryV4YearStrategy
  policyVersions?: string[]
  message: string
}

export interface MemoryV4YearOperationTrace {
  day: number
  eventId: string
  operation: MemoryV4YearOperationKind
  decidedOperation: MemoryV4YearOperationKind
  sourceFactId: string
  transformation?: MemoryV4YearGeneratedEvent['transformation']
  extractedCandidateCount: number
  expectedChanged: boolean
  actualChanged: boolean
  correct: boolean
  revisionBefore: number
  revisionAfter: number
  factId?: string
  factVersionIds: string[]
}

export interface MemoryV4YearQueryTrace {
  day: number
  queryId: string
  category: MemoryV4YearQueryDefinition['category']
  strategy: MemoryV4YearStrategy
  expectedSourceFactIds: string[]
  retrievedSourceFactIds: string[]
  relevantAtFive: number
  recallAtFive: number
  precisionAtFive: number
  topOneCorrect: boolean
  exactCoverage: boolean
  abstentionCorrect: boolean
  latencyMs: number
  contextCharacters: number
  queryIntent?: string
  routes: string[]
  candidateCount?: number
  selectedCount?: number
  selectionStopReason?: string
  coldPolicy?: string
  latestFactVersionIds: string[]
  policyVersions: string[]
}

export interface MemoryV4YearStrategyMetrics {
  strategy: MemoryV4YearStrategy
  queryCount: number
  recallAtFive: number
  precisionAtFive: number
  topOneAccuracy: number
  exactCoverage: number
  temporalCorrectness: number
  overviewAndMultiCoverage: number
  multiHopCorrectness: number
  abstentionAccuracy: number
  latencyP95Ms: number
  meanContextCharacters: number
  estimatedMeanContextTokens: number
}

export interface MemoryV4YearCheckpointReport {
  day: number
  snapshotRevision: number
  factCount: number
  factVersionCount: number
  eventCount: number
  journalEntriesReplayed: number
  restartConsistent: boolean
  compactedRestartConsistent: boolean
  authoritativeStatePreservedByRebuild: boolean
  summaryCount: number
  tierIndexCount: number
  queryCount: number
  strategyMetrics: MemoryV4YearStrategyMetrics[]
}

export interface MemoryV4YearScaleReport {
  factCount: number
  queryCount: number
  maximumCandidates: number
  latencyP95Ms: number
  latencyMaxMs: number
  topOneAccuracy: number
}

export interface MemoryV4YearGateCheck {
  id: string
  actual: number
  operator: '>=' | '<' | '='
  threshold: number
  passed: boolean
  hard: boolean
}

export interface MemoryV4YearSimulationReport {
  version: typeof MEMORY_V4_YEAR_SIMULATOR_VERSION
  gateVersion: typeof MEMORY_V4_YEAR_GATE_VERSION
  scenarioVersion: string
  scenarioFingerprint: string
  eventFingerprint: string
  seed: number
  days: number
  eventCount: number
  policy: MemoryV4RetrievalPolicyIdentity
  operationMetrics: {
    expectedWrites: number
    actualWrites: number
    truePositiveWrites: number
    falsePositiveWrites: number
    writePrecision: number
    writeRecall: number
    operationDecisionAccuracy: number
  }
  invariantPassRate: number
  restartConsistency: number
  checkpoints: MemoryV4YearCheckpointReport[]
  strategyMetrics: MemoryV4YearStrategyMetrics[]
  scale: MemoryV4YearScaleReport
  operationTraces: MemoryV4YearOperationTrace[]
  queryTraces: MemoryV4YearQueryTrace[]
  failures: MemoryV4YearFailureLocator[]
  gateChecks: MemoryV4YearGateCheck[]
  passed: boolean
}

interface Runtime {
  scenario: MemoryV4YearGeneratedScenario
  persistence: DeterministicJournalPersistence
  repository: MemoryV4Repository
  writer: V4ShadowWriter
  lifecycle: MemoryV4LifecycleService
  records: Map<string, V3MemoryRecord>
  facts: Map<string, MemoryV4YearFactDefinition>
  clock: number
}

interface StrategyRecall {
  ids: string[]
  latencyMs: number
  contextCharacters: number
  queryIntent?: string
  routes: string[]
  candidateCount?: number
  selectedCount?: number
  selectionStopReason?: string
  coldPolicy?: string
  policyVersions: string[]
}

export interface MemoryV4YearSimulationOptions {
  /** Read-only retrieval policy evaluated by both full and no-summary V4 lanes. */
  policy?: MemoryV4RetrievalPolicy
}

/**
 * Run the repository-visible, deterministic 365-day functional laboratory.
 * All labels are generated from the declarative scenario; no model or human
 * judgement is used by the gate.
 */
export async function runMemoryV4YearSimulation(
  definition: MemoryV4YearScenarioDefinition,
  options: MemoryV4YearSimulationOptions = {},
): Promise<MemoryV4YearSimulationReport> {
  const policy = options.policy ?? DEFAULT_MEMORY_V4_RETRIEVAL_POLICY
  const policyIdentity = memoryV4RetrievalPolicyIdentity(policy)
  const scenario = generateMemoryV4YearScenario(definition)
  const persistence = new DeterministicJournalPersistence()
  let clock = BASE_TIME
  let runtime: Runtime
  const now = () => {
    clock += 1
    if (runtime)
      runtime.clock = clock
    return clock
  }
  const repository = createMemoryV4Repository({ persistence, now })
  runtime = {
    scenario,
    persistence,
    repository,
    writer: createV4ShadowWriter({ repository, now, flushDelayMs: 10_000 }),
    lifecycle: createMemoryV4LifecycleService(repository, { now }),
    records: new Map(),
    facts: new Map(definition.facts.map(fact => [fact.id, fact])),
    clock,
  }
  const operationTraces: MemoryV4YearOperationTrace[] = []
  const queryTraces: MemoryV4YearQueryTrace[] = []
  const checkpoints: MemoryV4YearCheckpointReport[] = []
  const failures: MemoryV4YearFailureLocator[] = []
  let invariantChecks = 0
  let invariantPasses = 0

  for (let day = 1; day <= scenario.definition.days; day += 1) {
    clock = BASE_TIME + (day - 1) * DAY_MS
    runtime.clock = clock
    for (const event of scenario.eventsByDay.get(day) ?? []) {
      const trace = applyEvent(runtime, event, now, failures)
      operationTraces.push(trace)
      if (!trace.correct) {
        failures.push({
          day,
          phase: 'operation',
          operationId: event.id,
          sourceFactId: event.factId,
          factId: trace.factId,
          factVersionIds: trace.factVersionIds,
          message: `Expected ${trace.operation}, decided ${trace.decidedOperation}, stateChanged=${trace.actualChanged}`,
        })
      }
      invariantChecks += 1
      try {
        assertMemoryV4Snapshot(runtime.repository.snapshot())
        invariantPasses += 1
      }
      catch (error) {
        failures.push(locator(day, 'operation', error, { operationId: event.id, sourceFactId: event.factId }))
      }
    }
    if (scenario.definition.checkpointDays.includes(day)) {
      const checkpoint = await runCheckpoint(runtime, day, now, queryTraces, failures, policy)
      checkpoints.push(checkpoint)
      invariantChecks += 1
      try {
        assertMemoryV4Snapshot(runtime.repository.snapshot())
        invariantPasses += 1
      }
      catch (error) {
        failures.push(locator(day, 'rebuild', error))
      }
    }
  }

  const scale = runScaleProbe(scenario.definition.scaleFactCount, scenario.definition.scaleQueryCount, policy)
  if (scale.topOneAccuracy < 1 || scale.latencyP95Ms >= 100) {
    failures.push({ day: scenario.definition.days, phase: 'scale', message: `20k scale probe failed: top1=${scale.topOneAccuracy}, p95=${scale.latencyP95Ms.toFixed(2)}ms` })
  }
  const strategyMetrics = aggregateStrategyMetrics(queryTraces)
  const expectedWrites = operationTraces.filter(trace => trace.expectedChanged).length
  const actualWrites = operationTraces.filter(trace => trace.decidedOperation !== 'NOOP').length
  const truePositiveWrites = operationTraces.filter(trace => trace.expectedChanged
    && trace.decidedOperation !== 'NOOP' && trace.actualChanged).length
  const falsePositiveWrites = operationTraces.filter(trace => !trace.expectedChanged && trace.decidedOperation !== 'NOOP').length
  const operationMetrics = {
    expectedWrites,
    actualWrites,
    truePositiveWrites,
    falsePositiveWrites,
    writePrecision: ratio(truePositiveWrites, actualWrites),
    writeRecall: ratio(truePositiveWrites, expectedWrites),
    operationDecisionAccuracy: ratio(operationTraces.filter(trace => trace.correct).length, operationTraces.length),
  }
  const invariantPassRate = ratio(invariantPasses, invariantChecks)
  const restartChecks = checkpoints.flatMap(checkpoint => [checkpoint.restartConsistent, checkpoint.compactedRestartConsistent])
  const restartConsistency = ratio(restartChecks.filter(Boolean).length, restartChecks.length)
  const gateChecks = evaluateGate(operationMetrics, invariantPassRate, restartConsistency, strategyMetrics, scale)
  for (const check of gateChecks.filter(check => check.hard && !check.passed)) {
    failures.push({
      day: scenario.definition.days,
      phase: 'gate',
      policyVersions: [MEMORY_V4_YEAR_GATE_VERSION],
      message: `${check.id}: actual ${check.actual} ${check.operator} ${check.threshold}`,
    })
  }
  return {
    version: MEMORY_V4_YEAR_SIMULATOR_VERSION,
    gateVersion: MEMORY_V4_YEAR_GATE_VERSION,
    scenarioVersion: scenario.definition.scenarioVersion,
    scenarioFingerprint: scenario.definitionFingerprint,
    eventFingerprint: scenario.eventFingerprint,
    seed: scenario.definition.seed,
    days: scenario.definition.days,
    eventCount: scenario.events.length,
    policy: policyIdentity,
    operationMetrics,
    invariantPassRate,
    restartConsistency,
    checkpoints,
    strategyMetrics,
    scale,
    operationTraces,
    queryTraces,
    failures,
    gateChecks,
    passed: gateChecks.filter(check => check.hard).every(check => check.passed),
  }
}

function applyEvent(
  runtime: Runtime,
  event: MemoryV4YearGeneratedEvent,
  now: () => number,
  failures: MemoryV4YearFailureLocator[],
): MemoryV4YearOperationTrace {
  const before = runtime.repository.snapshot()
  const expectedChanged = event.expectedOperation !== 'NOOP'
  let decidedOperation: MemoryV4YearOperationKind = 'NOOP'
  let extractedCandidateCount = 0
  try {
    if (event.scheduledOperation) {
      applyScheduledOperation(runtime, event, now)
      decidedOperation = event.expectedOperation
    }
    else {
      const decision = classifyGeneratedObservation(runtime, event)
      decidedOperation = decision.operation
      extractedCandidateCount = decision.candidateCount
    }
  }
  catch (error) {
    failures.push(locator(event.day, 'operation', error, { operationId: event.id, sourceFactId: event.factId }))
  }
  runtime.writer.flush()
  const after = runtime.repository.snapshot()
  const actualChanged = before.revision !== after.revision
  const fact = sourceFact(after, event.scheduledOperation?.replacementFactId ?? event.factId)
  return {
    day: event.day,
    eventId: event.id,
    operation: event.expectedOperation,
    decidedOperation,
    sourceFactId: event.factId,
    ...(event.transformation ? { transformation: event.transformation } : {}),
    extractedCandidateCount,
    expectedChanged,
    actualChanged,
    correct: event.expectedOperation === decidedOperation && expectedChanged === actualChanged,
    revisionBefore: before.revision,
    revisionAfter: after.revision,
    ...(fact ? { factId: fact.id } : {}),
    factVersionIds: fact ? versionsFor(after, fact.id) : [],
  }
}

/**
 * Exercise the real deterministic extractor for generated observations. A
 * wrapper may yield an already-known candidate, but it must never propose a
 * novel fact. This turns generated NOOP traffic into an actual precision gate
 * instead of assuming that skipped events are correct by construction.
 */
function classifyGeneratedObservation(
  runtime: Runtime,
  event: MemoryV4YearGeneratedEvent,
): { operation: MemoryV4YearOperationKind; candidateCount: number } {
  const candidates = extractMemoryCandidates({
    userMessage: event.message,
    assistantMessage: '',
    metadata: { sessionId: `year-day-${event.day}`, eventId: event.id },
  })
  const known = [...runtime.records.values()]
  const containsNovelCandidate = candidates.some(candidate => !known.some(record => candidateMatchesRecord(candidate, record)))
  return {
    operation: containsNovelCandidate ? 'ADD' : 'NOOP',
    candidateCount: candidates.length,
  }
}

function candidateMatchesRecord(candidate: MemoryCandidate, record: V3MemoryRecord): boolean {
  const candidateKey = typeof candidate.metadata.memoryKey === 'string' ? candidate.metadata.memoryKey : undefined
  if (candidateKey && record.memoryKey === candidateKey)
    return true
  const normalizedCandidate = candidate.content.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
  const normalizedRecord = record.content.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
  return normalizedCandidate === normalizedRecord
    || normalizedCandidate.includes(normalizedRecord)
    || normalizedRecord.includes(normalizedCandidate)
}

function applyScheduledOperation(runtime: Runtime, event: MemoryV4YearGeneratedEvent, now: () => number): void {
  const operation = event.scheduledOperation!
  const fact = requireDefinition(runtime, operation.factId)
  if (operation.kind === 'ADD') {
    const record = createRecord(fact, runtime.scenario.definition.scope, event.day, now())
    runtime.records.set(record.id, record)
    enqueueRecord(runtime.writer, record, event.message, now())
    return
  }
  const currentRecord = requireRecord(runtime, operation.factId)
  const currentFact = requireSourceFact(runtime.repository.snapshot(), operation.factId)
  if (operation.kind === 'REFINE') {
    const content = operation.content ?? fact.content
    runtime.lifecycle.editFact(currentFact.id, currentFact.scope, {
      canonicalText: content,
      object: content,
      normalizedValue: content.normalize('NFKC'),
      reason: operation.reason ?? `year simulation ${operation.id}`,
      idempotencyKey: `year:${operation.id}`,
    })
    runtime.records.set(currentRecord.id, { ...currentRecord, content, updatedAt: now() })
    return
  }
  if (operation.kind === 'ARCHIVE') {
    runtime.lifecycle.archiveFact(currentFact.id, currentFact.scope, {
      reason: operation.reason ?? `year simulation ${operation.id}`,
      idempotencyKey: `year:${operation.id}`,
    })
    runtime.records.set(currentRecord.id, { ...currentRecord, status: 'suppressed', invalidatedAt: now(), updatedAt: now() })
    return
  }
  if (operation.kind === 'RESTORE') {
    runtime.lifecycle.restoreFact(currentFact.id, currentFact.scope, {
      reason: operation.reason ?? `year simulation ${operation.id}`,
      idempotencyKey: `year:${operation.id}`,
    })
    const restored = { ...currentRecord, status: 'active' as const, updatedAt: now() }
    delete restored.invalidatedAt
    runtime.records.set(currentRecord.id, restored)
    return
  }
  if (operation.kind === 'DELETE') {
    runtime.lifecycle.deleteFact(currentFact.id, currentFact.scope, 'delete', {
      reason: operation.reason ?? `year simulation ${operation.id}`,
      idempotencyKey: `year:${operation.id}`,
    })
    runtime.records.set(currentRecord.id, { ...currentRecord, status: 'deleted', invalidatedAt: now(), updatedAt: now() })
    return
  }

  const replacementId = operation.replacementFactId!
  const replacementDefinition = requireDefinition(runtime, replacementId)
  if (operation.kind === 'SUPERSEDE') {
    const timestamp = now()
    const previous = { ...currentRecord, status: 'superseded' as const, validTo: timestamp, invalidatedAt: timestamp, updatedAt: timestamp }
    const replacement = { ...createRecord(replacementDefinition, runtime.scenario.definition.scope, event.day, timestamp), supersedes: currentRecord.id }
    runtime.records.set(previous.id, previous)
    runtime.records.set(replacement.id, replacement)
    runtime.writer.enqueueCommit(commit([previous, replacement], 'update', timestamp))
    enqueueCapture(runtime.writer, replacement, event.message, timestamp)
    return
  }
  if (operation.kind === 'CONFLICT') {
    const timestamp = now()
    const previous = { ...currentRecord, status: 'conflicted' as const, updatedAt: timestamp }
    const replacement = { ...createRecord(replacementDefinition, runtime.scenario.definition.scope, event.day, timestamp), status: 'conflicted' as const }
    runtime.records.set(previous.id, previous)
    runtime.records.set(replacement.id, replacement)
    runtime.writer.enqueueCommit(commit([previous, replacement], 'update', timestamp))
    enqueueCapture(runtime.writer, replacement, event.message, timestamp)
    runtime.writer.flush()
    linkConflict(runtime.repository, operation.factId, replacementId)
    return
  }
  const winner = { ...currentRecord, status: 'active' as const, updatedAt: now() }
  const loserRecord = requireRecord(runtime, replacementId)
  const timestamp = now()
  const loser = { ...loserRecord, status: 'superseded' as const, validTo: timestamp, invalidatedAt: timestamp, updatedAt: timestamp }
  runtime.records.set(winner.id, winner)
  runtime.records.set(loser.id, loser)
  runtime.writer.enqueueCommit(commit([winner, loser], 'update', timestamp))
  runtime.writer.flush()
  linkResolution(runtime.repository, operation.factId, replacementId)
}

async function runCheckpoint(
  runtime: Runtime,
  day: number,
  now: () => number,
  queryTraces: MemoryV4YearQueryTrace[],
  failures: MemoryV4YearFailureLocator[],
  policy: MemoryV4RetrievalPolicy,
): Promise<MemoryV4YearCheckpointReport> {
  runtime.writer.flush()
  const beforeRestart = runtime.repository.snapshot()
  const beforeHash = snapshotFingerprint(beforeRestart)
  const replayBefore = runtime.persistence.replayedEntries
  replaceRuntimeRepository(runtime, createMemoryV4Repository({ persistence: runtime.persistence, now }), now)
  const restartConsistent = snapshotFingerprint(runtime.repository.snapshot()) === beforeHash
  if (!restartConsistent)
    failures.push({ day, phase: 'restart', message: 'Journal replay produced a different snapshot' })
  const journalEntriesReplayed = runtime.persistence.replayedEntries - replayBefore
  runtime.persistence.compact()
  replaceRuntimeRepository(runtime, createMemoryV4Repository({ persistence: runtime.persistence, now }), now)
  const compactedRestartConsistent = snapshotFingerprint(runtime.repository.snapshot()) === beforeHash
  if (!compactedRestartConsistent)
    failures.push({ day, phase: 'restart', message: 'Compacted checkpoint reload produced a different snapshot' })

  const authorityBefore = authorityFingerprint(runtime.repository.snapshot())
  runtime.repository.transaction((draft) => {
    draft.derivedArtifacts = []
  })
  await createMemoryConsolidationService(runtime.repository, { now }).consolidate(runtime.scenario.definition.scope, {
    granularity: DERIVED_GRANULARITIES,
    maxBuckets: 10_000,
  })
  await createMemoryTieringService(runtime.repository, { now }).run(runtime.scenario.definition.scope, TIER_OPTIONS)
  const rebuilt = runtime.repository.snapshot()
  const authoritativeStatePreservedByRebuild = authorityFingerprint(rebuilt) === authorityBefore
  if (!authoritativeStatePreservedByRebuild)
    failures.push({ day, phase: 'rebuild', message: 'Derived rebuild changed authoritative memory state' })

  const traces = await runQueries(runtime, day, failures, policy)
  queryTraces.push(...traces)
  const queryDefinitions = memoryV4YearQueriesForDay(runtime.scenario.definition, day)
  return {
    day,
    snapshotRevision: rebuilt.revision,
    factCount: rebuilt.facts.length,
    factVersionCount: rebuilt.factVersions.length,
    eventCount: runtime.scenario.events.filter(event => event.day <= day).length,
    journalEntriesReplayed,
    restartConsistent,
    compactedRestartConsistent,
    authoritativeStatePreservedByRebuild,
    summaryCount: rebuilt.derivedArtifacts.filter(artifact => artifact.kind === 'summary' && artifact.status === 'current').length,
    tierIndexCount: rebuilt.derivedArtifacts.filter(artifact => artifact.kind === 'tier-index' && artifact.status === 'current').length,
    queryCount: queryDefinitions.length,
    strategyMetrics: aggregateStrategyMetrics(traces),
  }
}

async function runQueries(
  runtime: Runtime,
  day: number,
  failures: MemoryV4YearFailureLocator[],
  policy: MemoryV4RetrievalPolicy,
): Promise<MemoryV4YearQueryTrace[]> {
  const snapshot = runtime.repository.snapshot()
  const fullRetriever = createMemoryV4ShadowRetriever(runtime.repository, {
    now: () => runtime.clock + DAY_MS - 1,
    policy,
  })
  const ablationSnapshot = structuredClone(snapshot)
  ablationSnapshot.derivedArtifacts = ablationSnapshot.derivedArtifacts.filter(artifact => artifact.kind !== 'summary')
  const ablationRepository = createMemoryV4Repository({
    persistence: { load: () => JSON.stringify(ablationSnapshot), save: () => undefined },
    now: () => runtime.clock + DAY_MS - 1,
  })
  const ablationRetriever = createMemoryV4ShadowRetriever(ablationRepository, {
    now: () => runtime.clock + DAY_MS - 1,
    policy,
  })
  const v3Payload = JSON.stringify({ version: 3, items: [...runtime.records.values()] })
  const v3Store = createVectorStore({ persistence: { load: () => v3Payload, save: () => undefined } })
  const traces: MemoryV4YearQueryTrace[] = []
  for (const query of memoryV4YearQueriesForDay(runtime.scenario.definition, day)) {
    const expected = resolveTruth(query, snapshot)
    const strategies: Array<[MemoryV4YearStrategy, Promise<StrategyRecall>]> = [
      ['v4', Promise.resolve(v4Recall(fullRetriever.recall(query.query, recallOptions(runtime, query))))],
      ['v4-no-summaries', Promise.resolve(v4Recall(ablationRetriever.recall(query.query, recallOptions(runtime, query))))],
      ['v3', v3Recall(v3Store, query, runtime.scenario.definition.scope)],
    ]
    for (const [strategy, recallPromise] of strategies) {
      try {
        const recall = await recallPromise
        const trace = createQueryTrace(day, query, strategy, expected, recall, snapshot)
        traces.push(trace)
        if (strategy === 'v4' && !trace.exactCoverage) {
          failures.push({
            day,
            phase: 'query',
            queryId: query.id,
            strategy,
            factVersionIds: trace.latestFactVersionIds,
            policyVersions: trace.policyVersions,
            message: `Expected [${expected.join(', ')}], retrieved [${recall.ids.join(', ')}]`,
          })
        }
      }
      catch (error) {
        failures.push(locator(day, 'query', error, { queryId: query.id, strategy }))
      }
    }
  }
  return traces
}

function createQueryTrace(
  day: number,
  query: MemoryV4YearQueryDefinition,
  strategy: MemoryV4YearStrategy,
  expected: string[],
  recalled: StrategyRecall,
  snapshot: MemoryV4Snapshot,
): MemoryV4YearQueryTrace {
  const retrieved = uniqueStrings(recalled.ids)
  const expectedSet = new Set(expected)
  const topFive = retrieved.slice(0, 5)
  const relevantAtFive = topFive.filter(id => expectedSet.has(id)).length
  const expectedAtFive = Math.min(5, expected.length)
  const exactCoverage = sameSet(retrieved, expected)
  return {
    day,
    queryId: query.id,
    category: query.category,
    strategy,
    expectedSourceFactIds: [...expected],
    retrievedSourceFactIds: retrieved,
    relevantAtFive,
    recallAtFive: expected.length === 0 ? (retrieved.length === 0 ? 1 : 0) : ratio(relevantAtFive, expectedAtFive),
    precisionAtFive: topFive.length === 0 ? (expected.length === 0 ? 1 : 0) : ratio(relevantAtFive, topFive.length),
    topOneCorrect: expected.length === 0 ? retrieved.length === 0 : expectedSet.has(retrieved[0] ?? ''),
    exactCoverage,
    abstentionCorrect: expected.length === 0 ? retrieved.length === 0 : true,
    latencyMs: recalled.latencyMs,
    contextCharacters: recalled.contextCharacters,
    ...(recalled.queryIntent ? { queryIntent: recalled.queryIntent } : {}),
    routes: recalled.routes,
    ...(recalled.candidateCount === undefined ? {} : { candidateCount: recalled.candidateCount }),
    ...(recalled.selectedCount === undefined ? {} : { selectedCount: recalled.selectedCount }),
    ...(recalled.selectionStopReason ? { selectionStopReason: recalled.selectionStopReason } : {}),
    ...(recalled.coldPolicy ? { coldPolicy: recalled.coldPolicy } : {}),
    latestFactVersionIds: expected.flatMap(sourceId => {
      const fact = sourceFact(snapshot, sourceId)
      return fact ? versionsFor(snapshot, fact.id).slice(-1) : []
    }),
    policyVersions: recalled.policyVersions,
  }
}

function aggregateStrategyMetrics(traces: readonly MemoryV4YearQueryTrace[]): MemoryV4YearStrategyMetrics[] {
  const strategies: MemoryV4YearStrategy[] = ['v3', 'v4', 'v4-no-summaries']
  return strategies.map((strategy) => {
    const selected = traces.filter(trace => trace.strategy === strategy)
    const temporal = selected.filter(trace => ['current', 'historical', 'timeline', 'conflict'].includes(trace.category))
    const overview = selected.filter(trace => ['overview', 'multi-fact'].includes(trace.category))
    const multiHop = selected.filter(trace => trace.category === 'multi-hop')
    const abstention = selected.filter(trace => trace.expectedSourceFactIds.length === 0)
    return {
      strategy,
      queryCount: selected.length,
      recallAtFive: mean(selected.map(trace => trace.recallAtFive)),
      precisionAtFive: mean(selected.map(trace => trace.precisionAtFive)),
      topOneAccuracy: mean(selected.map(trace => Number(trace.topOneCorrect))),
      exactCoverage: mean(selected.map(trace => Number(trace.exactCoverage))),
      temporalCorrectness: meanOrOne(temporal.map(trace => Number(trace.exactCoverage))),
      overviewAndMultiCoverage: meanOrOne(overview.map(trace => coverage(trace))),
      multiHopCorrectness: meanOrOne(multiHop.map(trace => coverage(trace))),
      abstentionAccuracy: meanOrOne(abstention.map(trace => Number(trace.abstentionCorrect))),
      latencyP95Ms: percentile(selected.map(trace => trace.latencyMs), 0.95),
      meanContextCharacters: mean(selected.map(trace => trace.contextCharacters)),
      estimatedMeanContextTokens: mean(selected.map(trace => trace.contextCharacters)) / 2,
    }
  })
}

function evaluateGate(
  writes: MemoryV4YearSimulationReport['operationMetrics'],
  invariantPassRate: number,
  restartConsistency: number,
  strategies: MemoryV4YearStrategyMetrics[],
  scale: MemoryV4YearScaleReport,
): MemoryV4YearGateCheck[] {
  const v4 = strategies.find(strategy => strategy.strategy === 'v4')!
  return [
    check('write-precision', writes.writePrecision, '>=', 0.95),
    check('write-recall', writes.writeRecall, '>=', 0.85),
    check('operation-decision-accuracy', writes.operationDecisionAccuracy, '>=', 0.95),
    check('recall-at-5', v4.recallAtFive, '>=', 0.9),
    check('top-one-accuracy', v4.topOneAccuracy, '>=', 0.85),
    check('temporal-correctness', v4.temporalCorrectness, '>=', 0.95),
    check('overview-multi-coverage', v4.overviewAndMultiCoverage, '>=', 0.9),
    check('multi-hop-correctness', v4.multiHopCorrectness, '>=', 0.8),
    check('abstention-accuracy', v4.abstentionAccuracy, '>=', 0.95),
    check('invariant-pass-rate', invariantPassRate, '=', 1),
    check('restart-consistency', restartConsistency, '=', 1),
    check('scale-top-one-accuracy', scale.topOneAccuracy, '=', 1),
    check('scale-p95-ms', scale.latencyP95Ms, '<', 100),
    check('ordinary-context-tokens', v4.estimatedMeanContextTokens, '<', 1_500, false),
  ]
}

function runScaleProbe(
  factCount: number,
  queryCount: number,
  policy: MemoryV4RetrievalPolicy,
): MemoryV4YearScaleReport {
  const scope = { ownerId: 'year-scale-owner', agentId: 'deskpet' }
  const snapshot = scaleSnapshot(factCount, scope)
  const repository = {
    readOnly: true,
    snapshot: () => snapshot,
    transaction: () => { throw new Error('read-only year scale repository') },
    replace: () => { throw new Error('read-only year scale repository') },
  } as unknown as MemoryV4Repository
  const retriever = createMemoryV4ShadowRetriever(repository, {
    now: () => BASE_TIME + 365 * DAY_MS,
    policy,
  })
  retriever.recall(scaleQuery(factCount - 1), { scope, limit: 3 })
  const durations: number[] = []
  let correct = 0
  let maximumCandidates = 0
  for (let index = 0; index < queryCount; index += 1) {
    const target = Math.floor(index * (factCount - 1) / Math.max(1, queryCount - 1))
    const startedAt = performance.now()
    const result = retriever.recall(scaleQuery(target), { scope, limit: 3 })
    durations.push(performance.now() - startedAt)
    maximumCandidates = Math.max(maximumCandidates, result.candidateCount)
    if (result.hits[0]?.sourceMemoryId === `scale-memory-${target}`)
      correct += 1
  }
  return {
    factCount,
    queryCount,
    maximumCandidates,
    latencyP95Ms: percentile(durations, 0.95),
    latencyMaxMs: Math.max(0, ...durations),
    topOneAccuracy: ratio(correct, queryCount),
  }
}

function scaleSnapshot(count: number, scope: { ownerId: string; agentId: string }): MemoryV4Snapshot {
  return {
    schemaVersion: 4,
    revision: 1,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    episodes: [], candidates: [], evidenceLinks: [], factVersions: [], derivedArtifacts: [],
    domainEvents: [], retrievalEvents: [], migrationManifests: [], legacyImports: [],
    facts: Array.from({ length: count }, (_, index): MemoryFactV4 => {
      const marker = scaleMarker(index)
      return {
        id: `scale-fact-${index}`, scope, subjectId: `owner:${scope.ownerId}`,
        predicate: 'archive.marker', object: marker, objectType: 'string', normalizedValue: marker,
        canonicalText: `用户保存的唯一归档标记：${marker}`, memoryKey: `archive.marker.${index}`,
        cardinality: 'single', polarity: 'positive', modality: 'asserted', status: 'active',
        recordedAt: BASE_TIME - index - 1, updatedAt: BASE_TIME - index - 1, evidenceLinkIds: [],
        extractionScore: 1, verificationScore: 1, evidenceScore: 1, utilityScore: 0.8,
        importance: 0.7, accessCount: 0, userConfirmed: true, verificationState: 'verified',
        supersedesFactIds: [], conflictsWithFactIds: [], sensitivity: 'normal', sharePolicy: 'allow-remote',
        origin: 'manual', metadata: { v3SourceId: `scale-memory-${index}` },
        extractorVersion: MEMORY_V4_YEAR_SIMULATOR_VERSION, verifierVersion: MEMORY_V4_YEAR_SIMULATOR_VERSION,
      }
    }),
  }
}

function v4Recall(result: MemoryV4ShadowRecallResult): StrategyRecall {
  return {
    ids: result.hits.flatMap(hit => hit.sourceMemoryId ? [hit.sourceMemoryId] : []),
    latencyMs: result.latencyMs,
    contextCharacters: result.hits.reduce((sum, hit) => sum + hit.content.length, 0),
    queryIntent: result.queryIntent,
    routes: result.routes,
    candidateCount: result.candidateCount,
    selectedCount: result.evidenceSelection.selectedCount,
    selectionStopReason: result.evidenceSelection.stopReason,
    coldPolicy: result.tierRouting.coldPolicy,
    policyVersions: [
      `${result.policy.policyId}@${result.policy.policyVersion}#${result.policy.fingerprint}`,
      result.version,
      result.tierRouting.version,
      result.evidenceSelection.version,
      result.abstention?.version ?? 'no-abstention',
    ],
  }
}

async function v3Recall(
  store: ReturnType<typeof createVectorStore>,
  query: MemoryV4YearQueryDefinition,
  scope: MemoryScope,
): Promise<StrategyRecall> {
  const startedAt = performance.now()
  const hits = await store.recall(query.query, scope, query.limit ?? 5, {
    ...(query.temporalMode ? { temporalMode: query.temporalMode } : {}),
  })
  return {
    ids: hits.map(hit => hit.id),
    latencyMs: performance.now() - startedAt,
    contextCharacters: hits.reduce((sum, hit) => sum + hit.content.length, 0),
    routes: [],
    policyVersions: ['memory-v3-vector-store-rrf-v1'],
  }
}

function recallOptions(runtime: Runtime, query: MemoryV4YearQueryDefinition) {
  return {
    scope: runtime.scenario.definition.scope,
    limit: query.limit ?? 5,
    ...(query.temporalMode ? { temporalMode: query.temporalMode } : {}),
  }
}

function resolveTruth(query: MemoryV4YearQueryDefinition, snapshot: MemoryV4Snapshot): string[] {
  const visibleHistory = (fact: MemoryFactV4) => !['deleted', 'suppressed', 'quarantined', 'orphaned'].includes(fact.status)
  let facts: MemoryFactV4[]
  if (query.truth.kind === 'none')
    facts = []
  else if (query.truth.kind === 'active-all')
    facts = snapshot.facts.filter(fact => fact.status === 'active')
  else if (query.truth.kind === 'current-memory-keys') {
    const keys = new Set(query.truth.memoryKeys)
    facts = snapshot.facts.filter(fact => fact.status === 'active' && keys.has(fact.memoryKey))
  }
  else if (query.truth.kind === 'history-memory-key') {
    const memoryKey = query.truth.memoryKey
    facts = snapshot.facts.filter(fact => fact.memoryKey === memoryKey && visibleHistory(fact))
  }
  else {
    const sourceIds = new Set(query.truth.sourceFactIds)
    facts = snapshot.facts.filter(fact => {
      const sourceId = sourceIdOf(fact)
      return sourceId !== undefined && sourceIds.has(sourceId) && visibleHistory(fact)
    })
  }
  return uniqueStrings(facts.flatMap(fact => sourceIdOf(fact) ? [sourceIdOf(fact)!] : [])).sort()
}

function createRecord(
  fact: MemoryV4YearFactDefinition,
  scope: { ownerId: string; agentId: string },
  day: number,
  timestamp: number,
): V3MemoryRecord {
  return {
    id: fact.id,
    content: fact.content,
    metadata: { kind: fact.predicate.split('.')[0], cardinality: fact.cardinality ?? 'single', predicate: fact.predicate },
    status: 'active',
    origin: fact.origin ?? 'manual',
    importance: fact.importance ?? 0.6,
    confidence: 1,
    accessCount: 0,
    ...(fact.validFromDay === undefined ? { validFrom: BASE_TIME + (day - 1) * DAY_MS } : { validFrom: BASE_TIME + (fact.validFromDay - 1) * DAY_MS }),
    ...(fact.validToDay === undefined ? {} : { validTo: BASE_TIME + (fact.validToDay - 1) * DAY_MS }),
    memoryKey: fact.memoryKey,
    sourceMessageIds: [`year-source-${fact.id}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope: { ...scope, sessionId: `year-day-${day}` },
    embedding: [],
    embeddingModel: 'local-hash-v3',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function enqueueRecord(writer: V4ShadowWriter, record: V3MemoryRecord, message: string, timestamp: number): void {
  writer.enqueueCommit(commit([record], 'remember', timestamp))
  enqueueCapture(writer, record, message, timestamp)
}

function enqueueCapture(writer: V4ShadowWriter, record: V3MemoryRecord, message: string, timestamp: number): void {
  const candidate: MemoryCandidate = {
    content: record.content,
    metadata: {
      kind: record.metadata?.kind ?? 'fact',
      cardinality: record.metadata?.cardinality ?? 'single',
      predicate: record.memoryKey ?? 'memory.fact',
      memoryKey: record.memoryKey,
      importance: record.importance,
      confidence: 1,
    },
  }
  writer.enqueueCapture({
    turn: { userMessage: message, assistantMessage: '', metadata: { sourceMessageIds: record.sourceMessageIds } },
    scope: record.scope,
    memories: [{ candidate, record }],
    capturedAt: timestamp,
  })
}

function commit(upserts: V3MemoryRecord[], reason: V3MemoryCommit['reason'], committedAt: number): V3MemoryCommit {
  return { reason, upserts, deletedIds: [], committedAt }
}

function linkConflict(repository: MemoryV4Repository, leftSourceId: string, rightSourceId: string): void {
  repository.transaction((draft) => {
    const left = requireSourceFact(draft, leftSourceId)
    const right = requireSourceFact(draft, rightSourceId)
    left.conflictsWithFactIds = uniqueStrings([...left.conflictsWithFactIds, right.id])
    right.conflictsWithFactIds = uniqueStrings([...right.conflictsWithFactIds, left.id])
  })
}

function linkResolution(repository: MemoryV4Repository, winnerSourceId: string, loserSourceId: string): void {
  repository.transaction((draft) => {
    const winner = requireSourceFact(draft, winnerSourceId)
    const loser = requireSourceFact(draft, loserSourceId)
    winner.supersedesFactIds = uniqueStrings([...winner.supersedesFactIds, loser.id])
  })
}

function replaceRuntimeRepository(runtime: Runtime, repository: MemoryV4Repository, now: () => number): void {
  runtime.repository = repository
  runtime.writer = createV4ShadowWriter({ repository, now, flushDelayMs: 10_000 })
  runtime.lifecycle = createMemoryV4LifecycleService(repository, { now })
}

class DeterministicJournalPersistence implements MemoryV4Persistence {
  checkpoint?: string
  journal: string[] = []
  replayedEntries = 0
  compactions = 0

  load(): string | undefined {
    if (this.journal.length > 0)
      this.replayedEntries += this.journal.length
    return this.journal.at(-1) ?? this.checkpoint
  }

  save(payload: string): void {
    if (this.checkpoint === undefined)
      this.checkpoint = payload
    else
      this.journal.push(payload)
  }

  compact(): void {
    const effective = this.journal.at(-1) ?? this.checkpoint
    if (effective !== undefined)
      this.checkpoint = effective
    this.journal = []
    this.compactions += 1
  }
}

function requireDefinition(runtime: Runtime, sourceId: string): MemoryV4YearFactDefinition {
  const fact = runtime.facts.get(sourceId)
  if (!fact)
    throw new Error(`Missing year fact definition ${sourceId}`)
  return fact
}

function requireRecord(runtime: Runtime, sourceId: string): V3MemoryRecord {
  const record = runtime.records.get(sourceId)
  if (!record)
    throw new Error(`Missing year V3 record ${sourceId}`)
  return record
}

function sourceFact(snapshot: MemoryV4Snapshot, sourceId: string): MemoryFactV4 | undefined {
  return snapshot.facts.find(fact => sourceIdOf(fact) === sourceId)
}

function requireSourceFact(snapshot: MemoryV4Snapshot, sourceId: string): MemoryFactV4 {
  const fact = sourceFact(snapshot, sourceId)
  if (!fact)
    throw new Error(`Missing year V4 fact ${sourceId}`)
  return fact
}

function sourceIdOf(fact: MemoryFactV4): string | undefined {
  return typeof fact.metadata?.v3SourceId === 'string' ? fact.metadata.v3SourceId : undefined
}

function versionsFor(snapshot: MemoryV4Snapshot, factId: string): string[] {
  return snapshot.factVersions.filter(version => version.factId === factId).map(version => version.id)
}

function authorityFingerprint(snapshot: MemoryV4Snapshot): string {
  const normalized = structuredClone(snapshot)
  normalized.revision = 0
  normalized.updatedAt = normalized.createdAt
  normalized.derivedArtifacts = []
  for (const fact of normalized.facts)
    fact.utilityScore = 0
  return snapshotFingerprint(normalized)
}

function snapshotFingerprint(snapshot: MemoryV4Snapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function scaleMarker(index: number): string {
  return (Math.imul(index + 1, 2_654_435_761) >>> 0).toString(36).padStart(7, '0')
}

function scaleQuery(index: number): string {
  return `我的归档标记 ${scaleMarker(index)} 是什么？`
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function coverage(trace: MemoryV4YearQueryTrace): number {
  if (trace.expectedSourceFactIds.length === 0)
    return trace.retrievedSourceFactIds.length === 0 ? 1 : 0
  const retrieved = new Set(trace.retrievedSourceFactIds)
  return ratio(trace.expectedSourceFactIds.filter(id => retrieved.has(id)).length, trace.expectedSourceFactIds.length)
}

function check(id: string, actual: number, operator: MemoryV4YearGateCheck['operator'], threshold: number, hard = true): MemoryV4YearGateCheck {
  const passed = operator === '>=' ? actual >= threshold : operator === '<' ? actual < threshold : actual === threshold
  return { id, actual, operator, threshold, passed, hard }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function meanOrOne(values: readonly number[]): number {
  return values.length > 0 ? mean(values) : 1
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
}

function locator(
  day: number,
  phase: MemoryV4YearFailureLocator['phase'],
  error: unknown,
  patch: Partial<MemoryV4YearFailureLocator> = {},
): MemoryV4YearFailureLocator {
  return { day, phase, ...patch, message: error instanceof Error ? error.message : String(error) }
}
