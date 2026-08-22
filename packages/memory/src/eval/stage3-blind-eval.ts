import type { MemoryRecallOptions, MemoryTemporalMode } from '@deskpet/contracts'
import {
  BLIND_PACK_SCHEMA_VERSION,
  fingerprintJson,
  requireCommit,
  requireOnlyKeys,
  requireStringArray,
  requireText,
  requireTimestamp,
} from './blind-pack-common'
import type { MemoryStage3RetrievalEvalCase } from './stage3-retrieval-eval'

export const MEMORY_STAGE3_BLIND_SCHEMA_VERSION = BLIND_PACK_SCHEMA_VERSION

export interface MemoryStage3BlindFact {
  key: string
  content: string
  kind: string
  importance?: number
  memoryKey?: string
  validFrom?: string
  suppressAfterWrite?: boolean
  sensitivity?: 'normal' | 'private' | 'secret'
  sharePolicy?: 'allow-remote' | 'local-only' | 'ask'
}

export interface MemoryStage3BlindCase {
  id: string
  category: string
  query: string
  options?: MemoryRecallOptions
}

export interface MemoryStage3BlindCasePack {
  schemaVersion: typeof MEMORY_STAGE3_BLIND_SCHEMA_VERSION
  datasetVersion: string
  frozenAt: string
  facts: MemoryStage3BlindFact[]
  cases: MemoryStage3BlindCase[]
}

export interface MemoryStage3BlindLabel {
  id: string
  relevantKeys: string[]
}

export interface MemoryStage3BlindLabelPack {
  schemaVersion: typeof MEMORY_STAGE3_BLIND_SCHEMA_VERSION
  datasetVersion: string
  casePackFingerprint: string
  adjudicator: string
  labeledAt: string
  implementationCommit: string
  labelsHiddenUntilImplementationFreeze: true
  attestation: string
  labels: MemoryStage3BlindLabel[]
}

export interface MemoryStage3BlindAssembled {
  datasetVersion: string
  facts: MemoryStage3BlindFact[]
  cases: MemoryStage3RetrievalEvalCase[]
}

export function fingerprintMemoryStage3BlindCasePack(pack: MemoryStage3BlindCasePack): string {
  assertCasePack(pack)
  return fingerprintJson(pack)
}

export function assembleMemoryStage3BlindCases(
  casePack: MemoryStage3BlindCasePack,
  labelPack: MemoryStage3BlindLabelPack,
): MemoryStage3BlindAssembled {
  assertCasePack(casePack)
  assertLabelPack(labelPack)
  if (casePack.datasetVersion !== labelPack.datasetVersion)
    throw new Error('Blind stage-3 case and label packs use different dataset versions')
  const fingerprint = fingerprintMemoryStage3BlindCasePack(casePack)
  if (fingerprint !== labelPack.casePackFingerprint)
    throw new Error('Blind stage-3 label pack does not match the frozen case-pack fingerprint')
  const labels = new Map(labelPack.labels.map(label => [label.id, label.relevantKeys] as const))
  const caseIds = new Set(casePack.cases.map(item => item.id))
  const missing = casePack.cases.filter(item => !labels.has(item.id)).map(item => item.id)
  const extra = labelPack.labels.filter(item => !caseIds.has(item.id)).map(item => item.id)
  if (missing.length > 0 || extra.length > 0)
    throw new Error(`Blind stage-3 labels are incomplete (missing=${missing.length}, extra=${extra.length})`)
  const factKeys = new Set(casePack.facts.map(fact => fact.key))
  for (const label of labelPack.labels) {
    const unknown = label.relevantKeys.filter(key => !factKeys.has(key))
    if (unknown.length > 0)
      throw new Error(`Blind stage-3 label ${label.id} references unknown fact keys: ${unknown.join(', ')}`)
  }
  const cases: MemoryStage3RetrievalEvalCase[] = casePack.cases.map(item => ({
    id: item.id,
    category: item.category,
    query: item.query,
    relevantKeys: [...labels.get(item.id)!],
    ...(item.options ? { options: item.options } : {}),
  }))
  return {
    datasetVersion: casePack.datasetVersion,
    facts: structuredClone(casePack.facts),
    cases,
  }
}

function assertCasePack(value: MemoryStage3BlindCasePack): void {
  if (!value || typeof value !== 'object' || value.schemaVersion !== MEMORY_STAGE3_BLIND_SCHEMA_VERSION)
    throw new Error('Blind stage-3 case pack has an unsupported schema')
  requireOnlyKeys(value as unknown as Record<string, unknown>, ['schemaVersion', 'datasetVersion', 'frozenAt', 'facts', 'cases'], 'stage-3 case pack')
  requireText(value.datasetVersion, 'stage-3 datasetVersion')
  requireTimestamp(value.frozenAt, 'stage-3 frozenAt')
  if (!Array.isArray(value.facts) || value.facts.length === 0)
    throw new Error('Blind stage-3 case pack has no facts')
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error('Blind stage-3 case pack is empty')
  const factKeys = new Set<string>()
  for (const fact of value.facts as Array<MemoryStage3BlindFact & { relevantKeys?: unknown }>) {
    requireText(fact.key, 'stage-3 fact.key')
    requireText(fact.content, `stage-3 fact ${fact.key}.content`)
    requireText(fact.kind, `stage-3 fact ${fact.key}.kind`)
    if (Object.prototype.hasOwnProperty.call(fact, 'relevantKeys'))
      throw new Error(`Blind stage-3 fact ${fact.key} leaks answer keys`)
    if (fact.sensitivity !== undefined && !['normal', 'private', 'secret'].includes(fact.sensitivity))
      throw new Error(`Blind stage-3 fact ${fact.key} has invalid sensitivity`)
    if (fact.sharePolicy !== undefined && !['allow-remote', 'local-only', 'ask'].includes(fact.sharePolicy))
      throw new Error(`Blind stage-3 fact ${fact.key} has invalid sharePolicy`)
    if (factKeys.has(fact.key))
      throw new Error(`Blind stage-3 case pack contains duplicate fact key: ${fact.key}`)
    factKeys.add(fact.key)
  }
  const ids = new Set<string>()
  for (const raw of value.cases as Array<MemoryStage3BlindCase & { relevantKeys?: unknown }>) {
    requireText(raw.id, 'stage-3 case.id')
    requireText(raw.category, `stage-3 case ${raw.id}.category`)
    requireText(raw.query, `stage-3 case ${raw.id}.query`)
    if (Object.prototype.hasOwnProperty.call(raw, 'relevantKeys'))
      throw new Error(`Blind stage-3 public case ${raw.id} leaks relevantKeys`)
    if (ids.has(raw.id))
      throw new Error(`Blind stage-3 case pack contains duplicate id ${raw.id}`)
    ids.add(raw.id)
    if (raw.options !== undefined)
      validateRecallOptions(raw.options, `stage-3 case ${raw.id}.options`)
  }
}

function assertLabelPack(value: MemoryStage3BlindLabelPack): void {
  if (!value || typeof value !== 'object' || value.schemaVersion !== MEMORY_STAGE3_BLIND_SCHEMA_VERSION)
    throw new Error('Blind stage-3 label pack has an unsupported schema')
  requireOnlyKeys(value as unknown as Record<string, unknown>, [
    'schemaVersion', 'datasetVersion', 'casePackFingerprint', 'adjudicator', 'labeledAt',
    'implementationCommit', 'labelsHiddenUntilImplementationFreeze', 'attestation', 'labels',
  ], 'stage-3 label pack')
  requireText(value.datasetVersion, 'stage-3 label.datasetVersion')
  requireText(value.casePackFingerprint, 'stage-3 label.casePackFingerprint')
  requireText(value.adjudicator, 'stage-3 label.adjudicator')
  requireTimestamp(value.labeledAt, 'stage-3 label.labeledAt')
  requireCommit(value.implementationCommit, 'stage-3 label.implementationCommit')
  if (value.labelsHiddenUntilImplementationFreeze !== true)
    throw new Error('Blind stage-3 labels must remain hidden until implementation freeze')
  requireText(value.attestation, 'stage-3 label.attestation')
  if (!Array.isArray(value.labels) || value.labels.length === 0)
    throw new Error('Blind stage-3 label pack is empty')
  const ids = new Set<string>()
  for (const label of value.labels) {
    requireText(label.id, 'stage-3 label.id')
    if (ids.has(label.id))
      throw new Error(`Blind stage-3 label pack contains duplicate id ${label.id}`)
    ids.add(label.id)
    requireStringArray(label.relevantKeys, `stage-3 label ${label.id}.relevantKeys`)
  }
}

function validateRecallOptions(options: MemoryRecallOptions, label: string): void {
  if (!options || typeof options !== 'object')
    throw new Error(`Blind pack ${label} must be an object`)
  const allowed: Array<keyof MemoryRecallOptions> = ['sharePolicies', 'sensitivities', 'temporalMode', 'asOf']
  requireOnlyKeys(options as unknown as Record<string, unknown>, allowed as string[], label)
  if (options.temporalMode !== undefined && !['current', 'historical', 'all'].includes(options.temporalMode))
    throw new Error(`Blind pack ${label}.temporalMode is invalid`)
  if (options.asOf !== undefined && (typeof options.asOf !== 'number' || !Number.isFinite(options.asOf) || options.asOf <= 0))
    throw new Error(`Blind pack ${label}.asOf must be a positive finite number`)
}
