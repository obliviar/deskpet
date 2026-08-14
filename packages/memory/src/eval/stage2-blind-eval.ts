import { createHash } from 'node:crypto'
import type { MemoryCapture } from '@deskpet/contracts'
import type { MemoryStage2EvalCase, MemoryStage2EvalExpectedFact } from './stage2-write-eval'

export const MEMORY_STAGE2_BLIND_SCHEMA_VERSION = 1 as const

export interface MemoryStage2BlindCase {
  id: string
  category: string
  turn: MemoryCapture
  existing?: MemoryStage2EvalCase['existing']
}

export interface MemoryStage2BlindCasePack {
  schemaVersion: typeof MEMORY_STAGE2_BLIND_SCHEMA_VERSION
  datasetVersion: string
  frozenAt: string
  cases: MemoryStage2BlindCase[]
}

export interface MemoryStage2BlindLabel {
  id: string
  expected: MemoryStage2EvalExpectedFact[]
}

export interface MemoryStage2BlindLabelPack {
  schemaVersion: typeof MEMORY_STAGE2_BLIND_SCHEMA_VERSION
  datasetVersion: string
  casePackFingerprint: string
  adjudicator: string
  labeledAt: string
  implementationCommit: string
  labelsHiddenUntilImplementationFreeze: true
  attestation: string
  labels: MemoryStage2BlindLabel[]
}

/** Fingerprint excludes labels and is stable across JSON key ordering. */
export function fingerprintMemoryStage2BlindCasePack(pack: MemoryStage2BlindCasePack): string {
  assertCasePack(pack)
  return createHash('sha256').update(canonicalJson(pack), 'utf-8').digest('hex')
}

/** Join a public prompt-only pack with a separately supplied private answer pack. */
export function assembleMemoryStage2BlindCases(
  casePack: MemoryStage2BlindCasePack,
  labelPack: MemoryStage2BlindLabelPack,
): MemoryStage2EvalCase[] {
  assertCasePack(casePack)
  assertLabelPack(labelPack)
  if (casePack.datasetVersion !== labelPack.datasetVersion)
    throw new Error('Blind memory case and label packs use different dataset versions')
  const fingerprint = fingerprintMemoryStage2BlindCasePack(casePack)
  if (fingerprint !== labelPack.casePackFingerprint)
    throw new Error('Blind memory label pack does not match the frozen case-pack fingerprint')
  const labels = new Map(labelPack.labels.map(label => [label.id, label.expected] as const))
  const caseIds = new Set(casePack.cases.map(item => item.id))
  const missing = casePack.cases.filter(item => !labels.has(item.id)).map(item => item.id)
  const extra = labelPack.labels.filter(item => !caseIds.has(item.id)).map(item => item.id)
  if (missing.length > 0 || extra.length > 0)
    throw new Error(`Blind memory labels are incomplete (missing=${missing.length}, extra=${extra.length})`)
  return casePack.cases.map(item => ({
    id: item.id,
    category: item.category,
    turn: structuredClone(item.turn),
    expected: structuredClone(labels.get(item.id)!),
    ...(item.existing ? { existing: structuredClone(item.existing) } : {}),
  }))
}

function assertCasePack(value: MemoryStage2BlindCasePack): void {
  if (!value || typeof value !== 'object' || value.schemaVersion !== MEMORY_STAGE2_BLIND_SCHEMA_VERSION)
    throw new Error('Blind memory case pack has an unsupported schema')
  requireOnlyKeys(value as unknown as Record<string, unknown>, ['schemaVersion', 'datasetVersion', 'frozenAt', 'cases'], 'case pack')
  requireText(value.datasetVersion, 'datasetVersion')
  requireTimestamp(value.frozenAt, 'frozenAt')
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error('Blind memory case pack is empty')
  const ids = new Set<string>()
  for (const raw of value.cases as Array<MemoryStage2BlindCase & { expected?: unknown }>) {
    requireText(raw.id, 'case.id')
    requireText(raw.category, `case ${raw.id}.category`)
    if (Object.prototype.hasOwnProperty.call(raw, 'expected'))
      throw new Error(`Blind memory public case ${raw.id} leaks expected answers`)
    requireOnlyKeys(raw as unknown as Record<string, unknown>, ['id', 'category', 'turn', 'existing'], `case ${raw.id}`)
    if (ids.has(raw.id))
      throw new Error(`Blind memory case pack contains duplicate id ${raw.id}`)
    ids.add(raw.id)
    if (!raw.turn || typeof raw.turn !== 'object')
      throw new Error(`Blind memory case ${raw.id} has no turn`)
    requireText(raw.turn.userMessage, `case ${raw.id}.turn.userMessage`)
    if (typeof raw.turn.assistantMessage !== 'string')
      throw new Error(`Blind memory case ${raw.id}.turn.assistantMessage is invalid`)
  }
}

function assertLabelPack(value: MemoryStage2BlindLabelPack): void {
  if (!value || typeof value !== 'object' || value.schemaVersion !== MEMORY_STAGE2_BLIND_SCHEMA_VERSION)
    throw new Error('Blind memory label pack has an unsupported schema')
  requireOnlyKeys(value as unknown as Record<string, unknown>, [
    'schemaVersion', 'datasetVersion', 'casePackFingerprint', 'adjudicator', 'labeledAt',
    'implementationCommit', 'labelsHiddenUntilImplementationFreeze', 'attestation', 'labels',
  ], 'label pack')
  requireText(value.datasetVersion, 'label.datasetVersion')
  requireText(value.casePackFingerprint, 'label.casePackFingerprint')
  requireText(value.adjudicator, 'label.adjudicator')
  requireTimestamp(value.labeledAt, 'label.labeledAt')
  requireCommit(value.implementationCommit)
  if (value.labelsHiddenUntilImplementationFreeze !== true)
    throw new Error('Blind memory labels must remain hidden until implementation freeze')
  requireText(value.attestation, 'label.attestation')
  if (!Array.isArray(value.labels) || value.labels.length === 0)
    throw new Error('Blind memory label pack is empty')
  const ids = new Set<string>()
  for (const label of value.labels) {
    requireText(label.id, 'label.id')
    if (ids.has(label.id))
      throw new Error(`Blind memory label pack contains duplicate id ${label.id}`)
    ids.add(label.id)
    if (!Array.isArray(label.expected))
      throw new Error(`Blind memory label ${label.id} has invalid expected facts`)
    for (const fact of label.expected) {
      requireText(fact.content, `label ${label.id}.content`)
      if (!['active', 'quarantined', 'rejected'].includes(fact.outcome))
        throw new Error(`Blind memory label ${label.id} has invalid outcome`)
      if (fact.action !== undefined && !['ADD', 'MERGE_EVIDENCE', 'REFINE', 'SUPERSEDE', 'CONFLICT', 'QUARANTINE', 'NOOP'].includes(fact.action))
        throw new Error(`Blind memory label ${label.id} has invalid action`)
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Blind memory ${label} must be a non-empty string`)
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  requireText(value, label)
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`Blind memory ${label} must be an ISO timestamp`)
}

function requireCommit(value: unknown): asserts value is string {
  requireText(value, 'label.implementationCommit')
  if (!/^[a-f0-9]{7,64}$/iu.test(value))
    throw new Error('Blind memory label.implementationCommit must be a Git commit id')
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0)
    throw new Error(`Blind memory ${label} contains unsupported fields: ${extras.join(', ')}`)
}
