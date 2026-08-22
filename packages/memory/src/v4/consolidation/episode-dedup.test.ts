import { describe, expect, it } from 'vitest'
import { createMemoryWriter } from '../../long-term/memory-writer'
import { createVectorStore } from '../../long-term/vector-store'
import { assertMemoryV4Snapshot } from '../domain/validation'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { createV4ShadowWriter } from '../dual-write/v4-shadow-writer'
import { findDuplicateEpisodeGroups, mergeDuplicateEpisodes } from './episode-dedup'
import { createMemoryConsolidationService } from './memory-consolidation-service'

const scope = { ownerId: 'dedup-user', agentId: 'deskpet' }
const NOW = 1_800_000_000_000

/**
 * Materializes two representations of the same source occurrence and moves
 * the active evidence onto the duplicate representation.
 */
async function seedDuplicateCapture(): Promise<ReturnType<typeof createMemoryV4Repository>> {
  const repository = createMemoryV4Repository({ now: () => NOW })
  const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
  const writer = createMemoryWriter({
    store: createVectorStore({ onCommittedChange: shadow.enqueueCommit }),
    extractor: turn => [{
      content: `preference.drink：${turn.userMessage}`,
      metadata: {
        kind: 'identity', memoryKey: 'preference.drink', cardinality: 'multiple' as const,
        confidence: 0.95, importance: 0.5, extractionChannel: 'rules', extractorVersion: 'test-rules',
      },
    }],
    onCaptured: shadow.enqueueCapture,
  })
  await writer.capture({
    userMessage: '小秦喜欢喝咖啡',
    assistantMessage: '',
    metadata: { sessionId: 'session-1', sourceMessageIds: ['message-1'] },
  }, scope)
  shadow.flush()
  repository.transaction((draft) => {
    const canonical = draft.episodes.find(episode => episode.kind === 'message' && episode.contentState === 'available')!
    const duplicate = structuredClone(canonical)
    duplicate.id = `${canonical.id}-duplicate`
    draft.episodes.push(duplicate)
    const link = draft.evidenceLinks.find(item => item.episodeId === canonical.id && item.active)!
    link.episodeId = duplicate.id
  })
  return repository
}

describe('episode dedup', () => {
  it('detects exact content duplicates and picks the earliest as canonical', async () => {
    const repository = await seedDuplicateCapture()
    const available = repository.snapshot().episodes.filter(episode =>
      episode.kind === 'message' && episode.contentState === 'available')
    expect(available).toHaveLength(2)
    expect(new Set(available.map(episode => episode.contentHash)).size).toBe(1)

    const groups = findDuplicateEpisodeGroups(repository.snapshot(), scope)
    expect(groups).toHaveLength(1)
    const earliest = [...available].sort((left, right) => left.recordedAt - right.recordedAt)[0]!
    expect(groups[0]!.canonicalId).toBe(earliest.id)
    expect(groups[0]!.duplicateIds).toHaveLength(1)
  })

  it('merges duplicates, migrates evidence and keeps every fact answerable', async () => {
    const repository = await seedDuplicateCapture()
    const groups = findDuplicateEpisodeGroups(repository.snapshot(), scope)
    const duplicateId = groups[0]!.duplicateIds[0]!
    const canonicalId = groups[0]!.canonicalId
    const factOnDuplicate = repository.snapshot().facts.find(fact =>
      fact.status === 'active'
      && repository.snapshot().evidenceLinks.some(link => link.active && link.factId === fact.id && link.episodeId === duplicateId))!

    const report = mergeDuplicateEpisodes(repository, scope, { now: () => NOW + 5000 })
    expect(report.mergedGroups).toBe(1)
    expect(report.mergedEpisodes).toBe(1)
    expect(report.migratedEvidence).toBe(1)

    const snapshot = repository.snapshot()
    const duplicate = snapshot.episodes.find(episode => episode.id === duplicateId)!
    expect(duplicate.contentState).toBe('deleted')
    expect(duplicate.content).toBeUndefined()
    expect(duplicate.contentHash).toBeDefined()
    expect(duplicate.deletedAt).toBeGreaterThanOrEqual(duplicate.recordedAt)

    // The fact keeps an active evidence link, now pointing at the canonical episode.
    const replacement = snapshot.evidenceLinks.find(link =>
      link.factId === factOnDuplicate.id && link.episodeId === canonicalId)
    expect(replacement?.active).toBe(true)
    expect(snapshot.facts.find(fact => fact.id === factOnDuplicate.id)?.evidenceLinkIds).toContain(replacement!.id)
    expect(() => assertMemoryV4Snapshot(snapshot)).not.toThrow()
  })

  it('reactivates an existing inactive canonical evidence link', async () => {
    const repository = await seedDuplicateCapture()
    const group = findDuplicateEpisodeGroups(repository.snapshot(), scope)[0]!
    repository.transaction((draft) => {
      const duplicateLink = draft.evidenceLinks.find(link => link.episodeId === group.duplicateIds[0] && link.active)!
      const inactive = {
        ...structuredClone(duplicateLink),
        id: `${duplicateLink.id}-inactive-canonical`,
        episodeId: group.canonicalId,
        active: false,
        invalidatedAt: NOW + 20,
      }
      draft.evidenceLinks.push(inactive)
      draft.facts.find(fact => fact.id === inactive.factId)!.evidenceLinkIds.push(inactive.id)
    })

    mergeDuplicateEpisodes(repository, scope, { now: () => NOW + 5000 })

    const activeCanonical = repository.snapshot().evidenceLinks.find(link =>
      link.episodeId === group.canonicalId && link.active)
    expect(activeCanonical).toBeDefined()
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })

  it('is idempotent: a second pass finds no available duplicates', async () => {
    const repository = await seedDuplicateCapture()
    mergeDuplicateEpisodes(repository, scope, { now: () => NOW + 5000 })

    const second = mergeDuplicateEpisodes(repository, scope, { now: () => NOW + 6000 })
    expect(second.mergedGroups).toBe(0)
    expect(second.mergedEpisodes).toBe(0)
  })

  it('does not merge equal text from different source messages or sessions', async () => {
    const repository = createMemoryV4Repository({ now: () => NOW })
    const shadow = createV4ShadowWriter({ repository, now: () => NOW + 10, flushDelayMs: 10_000 })
    const writer = createMemoryWriter({
      store: createVectorStore({ onCommittedChange: shadow.enqueueCommit }),
      extractor: turn => [{ content: turn.userMessage, metadata: {
        kind: 'identity', memoryKey: 'repeat', cardinality: 'multiple' as const,
        confidence: 0.95, importance: 0.5, extractionChannel: 'rules', extractorVersion: 'test-rules',
      } }],
      onCaptured: shadow.enqueueCapture,
    })
    await writer.capture({ userMessage: '同一句话', assistantMessage: '', metadata: { sessionId: 's1', sourceMessageIds: ['m1'] } }, scope)
    await writer.capture({ userMessage: '同一句话', assistantMessage: '', metadata: { sessionId: 's2', sourceMessageIds: ['m2'] } }, scope)
    shadow.flush()

    expect(findDuplicateEpisodeGroups(repository.snapshot(), scope)).toHaveLength(0)
    expect(mergeDuplicateEpisodes(repository, scope).mergedEpisodes).toBe(0)
  })

  it('lets summary consolidation rebuild against the deduplicated episode set', async () => {
    const repository = await seedDuplicateCapture()
    const consolidation = createMemoryConsolidationService(repository, { now: () => NOW })
    await consolidation.consolidate(scope)

    const merged = mergeDuplicateEpisodes(repository, scope, { now: () => NOW + 5000 })
    expect(merged.mergedEpisodes).toBe(1)
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()

    const rebuilt = await consolidation.consolidate(scope)
    expect(rebuilt.rebuilt + rebuilt.built).toBeGreaterThan(0)
    // Session buckets keyed by the surviving episodes stay consistent.
    for (const summary of consolidation.listSummaries(scope)) {
      for (const episodeId of summary.sourceEpisodeIds) {
        const episode = repository.snapshot().episodes.find(item => item.id === episodeId)
        expect(episode).toBeDefined()
        if (summary.status === 'current')
          expect(episode?.contentState).not.toBe('deleted')
      }
    }
    expect(() => assertMemoryV4Snapshot(repository.snapshot())).not.toThrow()
  })
})
