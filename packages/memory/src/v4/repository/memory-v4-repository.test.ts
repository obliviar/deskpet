import { describe, expect, it, vi } from 'vitest'
import type { MemoryV4Persistence } from './memory-v4-repository'
import { createMemoryV4Repository } from './memory-v4-repository'

describe('Memory V4 repository', () => {
  it('commits a complete revision and reloads it', () => {
    let stored: string | undefined
    const persistence: MemoryV4Persistence = {
      load: () => stored,
      save: payload => { stored = payload },
    }
    const repository = createMemoryV4Repository({ persistence, now: () => 200 })
    repository.transaction((draft) => {
      draft.retrievalEvents.push({
        id: 'retrieval-1',
        scope: { ownerId: 'owner', agentId: 'agent' },
        queryHash: 'hash',
        queryType: 'none',
        retrievedFactIds: [],
        injectedFactIds: [],
        adoptedFactIds: [],
        correctedFactIds: [],
        deniedFactIds: [],
        createdAt: 200,
        retrievalVersion: 'test',
      })
    })

    expect(repository.snapshot().revision).toBe(1)
    expect(stored).toContain('retrieval-1')
    const reloaded = createMemoryV4Repository({ persistence })
    expect(reloaded.snapshot()).toEqual(repository.snapshot())
  })

  it('rolls back mutations when the callback or persistence fails', () => {
    const repository = createMemoryV4Repository({ now: () => 300 })
    expect(() => repository.transaction((draft) => {
      draft.updatedAt = 999
      throw new Error('abort')
    })).toThrow('abort')
    expect(repository.snapshot().revision).toBe(0)
    expect(repository.snapshot().updatedAt).toBe(300)

    const save = vi.fn(() => { throw new Error('disk full') })
    const failing = createMemoryV4Repository({
      persistence: { load: () => undefined, save },
      now: () => 400,
    })
    expect(() => failing.transaction((draft) => {
      draft.retrievalEvents.push({
        id: 'not-committed',
        scope: { ownerId: 'owner', agentId: 'agent' },
        queryHash: 'hash',
        queryType: 'none',
        retrievedFactIds: [], injectedFactIds: [], adoptedFactIds: [],
        correctedFactIds: [], deniedFactIds: [],
        createdAt: 400,
        retrievalVersion: 'test',
      })
    })).toThrow('disk full')
    expect(save).toHaveBeenCalledOnce()
    expect(failing.snapshot().retrievalEvents).toEqual([])
    expect(failing.snapshot().revision).toBe(0)
  })

  it('refuses invalid cross-record references and read-only writes', () => {
    const repository = createMemoryV4Repository({ now: () => 500 })
    expect(() => repository.transaction((draft) => {
      draft.facts.push({
        id: 'fact-without-evidence',
        scope: { ownerId: 'owner', agentId: 'agent' },
        subjectId: 'owner:owner', predicate: 'profile.name', object: 'A',
        canonicalText: '用户名字是 A', memoryKey: 'profile.name', cardinality: 'single',
        polarity: 'unknown', status: 'active', recordedAt: 500, updatedAt: 500,
        evidenceLinkIds: [], extractionScore: 1, verificationScore: 1, evidenceScore: 1,
        utilityScore: 0.5, importance: 0.8, accessCount: 0, userConfirmed: true,
        verificationState: 'verified', supersedesFactIds: [], conflictsWithFactIds: [],
        sensitivity: 'normal', sharePolicy: 'allow-remote', origin: 'manual',
        extractorVersion: 'test', verifierVersion: 'test',
      })
    })).toThrow('has no active evidence')
    expect(repository.snapshot().facts).toEqual([])

    const readOnly = createMemoryV4Repository({ readOnly: true, now: () => 500 })
    expect(() => readOnly.transaction(() => undefined)).toThrow('read-only')
  })
})
