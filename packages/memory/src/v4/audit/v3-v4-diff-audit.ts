import { createHash } from 'node:crypto'
import type { MemoryFactV4, MemoryV4Snapshot } from '../domain/types'

interface V3AuditRecord {
  id: string
  content: string
  status: string
  scope: { ownerId: string; agentId: string; sessionId?: string }
  validFrom?: number
  validTo?: number
  sourceMessageIds?: string[]
  sourceAttachmentIds?: string[]
  sharePolicy?: string
  sensitivity?: string
}

export interface MemoryV4AuditIssue {
  sourceId?: string
  factId?: string
  code: 'MISSING_FACT' | 'DUPLICATE_FACT' | 'CONTENT_MISMATCH' | 'STATUS_MISMATCH'
    | 'SCOPE_MISMATCH' | 'TIME_MISMATCH' | 'SOURCE_MISMATCH' | 'PRIVACY_MISMATCH'
    | 'UNEXPECTED_ACTIVE_FACT' | 'INVALID_VERSION_HEAD' | 'DUAL_WRITE_STATE_MISMATCH'
  detail: string
}

export interface MemoryV4AuditReport {
  sourcePayloadSha256: string
  sourceCount: number
  mirroredCount: number
  tombstoneCount: number
  exactMatchCount: number
  consistency: number
  passed: boolean
  issues: MemoryV4AuditIssue[]
}

export function auditV3V4Consistency(v3Payload: string, snapshot: MemoryV4Snapshot): MemoryV4AuditReport {
  const records = parseV3(v3Payload)
  const issues: MemoryV4AuditIssue[] = []
  const sourcePayloadSha256 = sha256(v3Payload)
  const factsBySource = new Map<string, MemoryFactV4[]>()
  for (const fact of snapshot.facts) {
    const sourceId = typeof fact.metadata?.v3SourceId === 'string' ? fact.metadata.v3SourceId : undefined
    if (sourceId)
      factsBySource.set(sourceId, [...(factsBySource.get(sourceId) ?? []), fact])
  }
  for (const legacy of snapshot.legacyImports) {
    const fact = snapshot.facts.find(item => item.id === legacy.factId)
    if (fact && !factsBySource.has(legacy.sourceItemId))
      factsBySource.set(legacy.sourceItemId, [fact])
  }

  let exactMatchCount = 0
  for (const record of records) {
    const matches = factsBySource.get(record.id) ?? []
    if (matches.length === 0) {
      issues.push({ sourceId: record.id, code: 'MISSING_FACT', detail: 'No V4 fact mirrors this V3 source.' })
      continue
    }
    if (matches.length > 1)
      issues.push({ sourceId: record.id, code: 'DUPLICATE_FACT', detail: `${matches.length} V4 facts mirror one V3 source.` })
    const fact = matches[0]!
    const before = issues.length
    if (fact.canonicalText !== record.content)
      issue(issues, record, fact, 'CONTENT_MISMATCH', 'Canonical text differs from V3 content.')
    if (fact.status !== expectedStatus(record.status, fact))
      issue(issues, record, fact, 'STATUS_MISMATCH', `Expected ${expectedStatus(record.status, fact)}, got ${fact.status}.`)
    if (!sameScope(record.scope, fact.scope))
      issue(issues, record, fact, 'SCOPE_MISMATCH', 'Owner, agent, or session scope differs.')
    if (fact.validFrom !== record.validFrom || fact.validTo !== record.validTo)
      issue(issues, record, fact, 'TIME_MISMATCH', 'Validity interval differs.')
    if (fact.sharePolicy !== normalizeShare(record.sharePolicy) || fact.sensitivity !== normalizeSensitivity(record.sensitivity))
      issue(issues, record, fact, 'PRIVACY_MISMATCH', 'Privacy policy differs.')
    const episodeRefs = snapshot.evidenceLinks.filter(link => link.factId === fact.id && link.active)
      .map(link => snapshot.episodes.find(episode => episode.id === link.episodeId))
      .filter(Boolean)
    const messageIds = unique(episodeRefs.map(episode => episode!.sourceMessageId).filter((id): id is string => !!id))
    const attachmentIds = unique(episodeRefs.flatMap(episode => episode!.sourceAttachmentIds))
    if (!sameSet(messageIds, unique(record.sourceMessageIds ?? []))
      || !isSubset(unique(record.sourceAttachmentIds ?? []), attachmentIds))
      issue(issues, record, fact, 'SOURCE_MISMATCH', 'Active evidence source identifiers differ.')
    const versions = snapshot.factVersions.filter(version => version.factId === fact.id)
    const latest = versions.sort((left, right) => right.version - left.version)[0]
    if (!latest || latest.canonicalText !== fact.canonicalText || latest.status !== fact.status)
      issue(issues, record, fact, 'INVALID_VERSION_HEAD', 'Latest fact version does not match the materialized fact.')
    if (issues.length === before)
      exactMatchCount += 1
  }

  const sourceIds = new Set(records.map(record => record.id))
  for (const [sourceId, facts] of factsBySource) {
    if (sourceIds.has(sourceId))
      continue
    for (const fact of facts) {
      if (fact.status !== 'deleted')
        issues.push({ sourceId, factId: fact.id, code: 'UNEXPECTED_ACTIVE_FACT', detail: 'V3 source is absent but V4 fact is not tombstoned.' })
    }
  }
  if (snapshot.dualWriteState?.sourcePayloadSha256 !== sourcePayloadSha256
    || snapshot.dualWriteState.sourceItemCount !== records.length) {
    issues.push({
      code: 'DUAL_WRITE_STATE_MISMATCH',
      detail: 'V4 reconciliation manifest does not match the audited V3 payload.',
    })
  }

  const denominator = Math.max(1, records.length)
  return {
    sourcePayloadSha256,
    sourceCount: records.length,
    mirroredCount: records.filter(record => (factsBySource.get(record.id)?.length ?? 0) > 0).length,
    tombstoneCount: snapshot.facts.filter(fact => fact.status === 'deleted').length,
    exactMatchCount,
    consistency: exactMatchCount / denominator,
    passed: issues.length === 0,
    issues,
  }
}

function parseV3(payload: string): V3AuditRecord[] {
  const value = JSON.parse(payload) as { version?: unknown; items?: unknown }
  if (value.version !== 3 || !Array.isArray(value.items))
    throw new Error('V3/V4 audit requires a version 3 memory payload')
  return value.items.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`V3/V4 audit found an invalid V3 record at ${index}`)
    const record = raw as unknown as V3AuditRecord
    if (!record.id || typeof record.content !== 'string' || !record.scope?.ownerId || !record.scope.agentId)
      throw new Error(`V3/V4 audit found an incomplete V3 record at ${index}`)
    return record
  })
}

function expectedStatus(status: string, fact: MemoryFactV4): MemoryFactV4['status'] {
  if (status === 'active' && fact.origin !== 'manual') {
    const hasDirectEvidence = fact.evidenceLinkIds.length > 0 && fact.evidenceScore >= 1
    return hasDirectEvidence ? 'active' : 'quarantined'
  }
  return status === 'superseded' || status === 'conflicted' || status === 'expired' || status === 'orphaned'
    || status === 'suppressed' || status === 'deleted' ? status : 'active'
}

function issue(
  issues: MemoryV4AuditIssue[],
  record: V3AuditRecord,
  fact: MemoryFactV4,
  code: MemoryV4AuditIssue['code'],
  detail: string,
): void {
  issues.push({ sourceId: record.id, factId: fact.id, code, detail })
}

function sameScope(left: V3AuditRecord['scope'], right: MemoryFactV4['scope']): boolean {
  return left.ownerId === right.ownerId && left.agentId === right.agentId
    && (left.sessionId ?? '') === (right.sessionId ?? '')
}

function normalizeShare(value: unknown): MemoryFactV4['sharePolicy'] {
  return value === 'allow-remote' || value === 'ask' ? value : 'local-only'
}

function normalizeSensitivity(value: unknown): MemoryFactV4['sensitivity'] {
  return value === 'normal' || value === 'secret' ? value : 'private'
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && isSubset(left, right)
}

function isSubset(left: string[], right: string[]): boolean {
  const target = new Set(right)
  return left.every(item => target.has(item))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}
