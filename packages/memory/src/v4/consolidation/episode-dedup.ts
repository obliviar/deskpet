import { createHash } from 'node:crypto'
import type { MemoryEpisodeV4, MemoryV4Snapshot } from '../domain/types'
import type { MemoryV4Repository } from '../repository/memory-v4-repository'

export const MEMORY_EPISODE_DEDUP_VERSION = 'episode-dedup-v2'

export interface EpisodeDedupScopeFilter {
  ownerId: string
  agentId?: string
}

export interface EpisodeDedupGroup {
  canonicalId: string
  duplicateIds: string[]
  contentHash: string
}

export interface EpisodeDedupReport {
  version: string
  mergedGroups: number
  mergedEpisodes: number
  migratedEvidence: number
  elapsedMs: number
}

export interface EpisodeDedupOptions {
  now?: () => number
}

/**
 * Stage-four episode hygiene: duplicate representations of the same source
 * occurrence are merged into one canonical episode. Equal text from another
 * message, session or timestamp remains a separate occurrence. Duplicates are
 * tombstoned with plaintext removed while the content hash and evidence links
 * survive on the canonical episode; downstream artifacts are marked stale.
 * A second pass is idempotent because no available duplicate remains.
 */
export function mergeDuplicateEpisodes(
  repository: MemoryV4Repository,
  scope: EpisodeDedupScopeFilter,
  options: EpisodeDedupOptions = {},
): EpisodeDedupReport {
  if (repository.readOnly)
    throw new Error('Episode dedup requires a writable V4 repository')
  const now = options.now ?? Date.now
  const startedAt = now()
  const groups = findDuplicateEpisodeGroups(repository.snapshot(), scope)
  if (groups.length === 0)
    return { version: MEMORY_EPISODE_DEDUP_VERSION, mergedGroups: 0, mergedEpisodes: 0, migratedEvidence: 0, elapsedMs: 0 }

  let mergedEpisodes = 0
  let migratedEvidence = 0
  repository.transaction((draft) => {
    const episodesById = new Map(draft.episodes.map(episode => [episode.id, episode]))
    for (const group of groups) {
      const canonical = episodesById.get(group.canonicalId)
      if (!canonical || canonical.contentState === 'deleted')
        continue
      for (const duplicateId of group.duplicateIds) {
        const duplicate = episodesById.get(duplicateId)
        if (!duplicate || duplicate.contentState === 'deleted')
          continue
        const timestamp = now()
        migratedEvidence += migrateEvidence(draft, duplicate, canonical, timestamp)
        invalidateDerivedForMergedEpisode(draft, duplicate.id, timestamp)
        duplicate.contentState = 'deleted'
        // Unavailable/deleted episodes must not retain plaintext; the content
        // hash keeps the audit fingerprint of what was merged away.
        delete duplicate.content
        duplicate.deletedAt = Math.max(duplicate.recordedAt, timestamp)
        mergedEpisodes += 1
      }
    }
  })

  return {
    version: MEMORY_EPISODE_DEDUP_VERSION,
    mergedGroups: groups.length,
    mergedEpisodes,
    migratedEvidence,
    elapsedMs: Math.max(0, now() - startedAt),
  }
}

/**
 * Detect duplicate representations of the same source occurrence. Equal text
 * in a later message/session is a repeated real-world occurrence, not a
 * duplicate: merging it would destroy time, frequency and provenance. A
 * source message/attachment id is authoritative; source-less records only
 * deduplicate when their full scope and recordedAt are identical.
 */
export function findDuplicateEpisodeGroups(
  snapshot: MemoryV4Snapshot,
  scope: EpisodeDedupScopeFilter,
): EpisodeDedupGroup[] {
  const buckets = new Map<string, MemoryEpisodeV4[]>()
  for (const episode of snapshot.episodes) {
    if (episode.contentState !== 'available' || !episode.contentHash || !matchesScope(episode.scope, scope))
      continue
    const key = JSON.stringify([
      episode.scope.ownerId,
      episode.scope.agentId,
      episode.scope.sessionId ?? '',
      episode.actor,
      episode.kind,
      episode.contentHash,
      occurrenceIdentity(episode),
    ])
    const bucket = buckets.get(key) ?? []
    bucket.push(episode)
    buckets.set(key, bucket)
  }
  const groups: EpisodeDedupGroup[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2)
      continue
    const sorted = [...bucket].sort((left, right) =>
      left.recordedAt - right.recordedAt || left.id.localeCompare(right.id))
    groups.push({
      canonicalId: sorted[0]!.id,
      duplicateIds: sorted.slice(1).map(episode => episode.id),
      contentHash: sorted[0]!.contentHash!,
    })
  }
  return groups.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId))
}

/**
 * Move every active evidence link of the duplicate onto the canonical episode.
 * When the fact already links to the canonical episode the duplicate link is
 * simply invalidated; otherwise a fresh link is appended with the duplicate's
 * role/strength and the fact's evidenceLinkIds index stays consistent.
 */
function migrateEvidence(
  draft: MemoryV4Snapshot,
  duplicate: MemoryEpisodeV4,
  canonical: MemoryEpisodeV4,
  timestamp: number,
): number {
  const factsById = new Map(draft.facts.map(fact => [fact.id, fact]))
  let migrated = 0
  for (const link of draft.evidenceLinks) {
    if (link.episodeId !== duplicate.id || !link.active)
      continue
    const existingToCanonical = draft.evidenceLinks.find(candidate =>
      candidate.factId === link.factId && candidate.episodeId === canonical.id)
    link.active = false
    link.invalidatedAt = Math.max(link.createdAt, timestamp)
    link.note = `Evidence migrated to merged episode ${canonical.id}.`
    if (existingToCanonical) {
      // An old inactive link must be reactivated; merely detecting it and then
      // invalidating the duplicate link would leave an active fact with no
      // active evidence.
      existingToCanonical.active = true
      delete existingToCanonical.invalidatedAt
      existingToCanonical.note = `Reactivated while merging duplicate episode ${duplicate.id}.`
      const fact = factsById.get(link.factId)
      if (fact && !fact.evidenceLinkIds.includes(existingToCanonical.id))
        fact.evidenceLinkIds.push(existingToCanonical.id)
    }
    else {
      const replacement = {
        id: `evidence:${createHash('sha256').update(`${link.factId}\0${canonical.id}`).digest('hex').slice(0, 24)}`,
        factId: link.factId,
        episodeId: canonical.id,
        role: link.role,
        strength: link.strength,
        active: true,
        createdAt: timestamp,
        note: `Merged from duplicate episode ${duplicate.id}.`,
      }
      draft.evidenceLinks.push(replacement)
      const fact = factsById.get(link.factId)
      if (fact && !fact.evidenceLinkIds.includes(replacement.id))
        fact.evidenceLinkIds.push(replacement.id)
    }
    migrated += 1
  }
  return migrated
}

function occurrenceIdentity(episode: MemoryEpisodeV4): string {
  if (episode.sourceMessageId)
    return `message:${episode.sourceMessageId}`
  if (episode.sourceAttachmentIds.length > 0)
    return `attachments:${[...episode.sourceAttachmentIds].sort().join('\0')}`
  return `recorded:${episode.recordedAt}`
}

function invalidateDerivedForMergedEpisode(
  draft: MemoryV4Snapshot,
  episodeId: string,
  timestamp: number,
): void {
  for (const artifact of draft.derivedArtifacts) {
    if (artifact.status === 'deleted' || !artifact.sourceEpisodeIds.includes(episodeId))
      continue
    artifact.status = 'stale'
    artifact.invalidatedAt = Math.max(artifact.createdAt, timestamp)
    artifact.updatedAt = Math.max(artifact.updatedAt, timestamp)
  }
}

function matchesScope(scope: { ownerId: string; agentId: string }, filter: EpisodeDedupScopeFilter): boolean {
  return scope.ownerId === filter.ownerId
    && (filter.agentId === undefined || scope.agentId === filter.agentId)
}
