import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVectorStore } from './vector-store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('persistent vector store', () => {
  it('creates an empty storage file immediately', () => {
    const storagePath = temporaryFile()

    createVectorStore({ storagePath })

    expect(existsSync(storagePath)).toBe(true)
    expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({ version: 1, items: [] })
  })

  it('persists across instances and isolates owners', async () => {
    const storagePath = temporaryFile()
    const scopeA = { ownerId: 'alice', agentId: 'deskpet' }
    const scopeB = { ownerId: 'bob', agentId: 'deskpet' }
    const options = {
      storagePath,
      embeddingModel: 'test-v1',
      minScore: 0.5,
      embedder: testEmbedder,
    }

    const first = createVectorStore(options)
    await first.remember('Alice likes coffee', scopeA)
    await first.remember('Bob likes tea', scopeB)

    const second = createVectorStore(options)
    expect(await second.count(scopeA)).toBe(1)
    expect(await second.count(scopeB)).toBe(1)
    expect((await second.recall('coffee', scopeA))[0]?.content).toBe('Alice likes coffee')
    expect(await second.recall('coffee', scopeB)).toEqual([])
  })

  it('deduplicates, forgets and clears within a scope', async () => {
    const store = createVectorStore({
      storagePath: temporaryFile(),
      embeddingModel: 'test-v1',
      minScore: 0.5,
      embedder: testEmbedder,
    })
    const scope = { ownerId: 'local', agentId: 'deskpet' }

    await store.remember('User likes coffee', scope)
    await store.remember('  User   likes coffee  ', scope, { importance: 1 })
    expect(await store.count(scope)).toBe(1)

    const hit = (await store.recall('coffee', scope))[0]!
    await store.forget(hit.id, scope)
    expect(await store.count(scope)).toBe(0)

    await store.remember('User likes tea', scope)
    await store.clear(scope)
    expect(await store.count(scope)).toBe(0)
  })
})

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-memory-'))
  temporaryDirectories.push(directory)
  return join(directory, 'memories.json')
}

async function testEmbedder(text: string): Promise<number[]> {
  const normalized = text.toLocaleLowerCase()
  if (normalized.includes('coffee'))
    return [1, 0, 0]
  if (normalized.includes('tea'))
    return [0, 1, 0]
  return [0, 0, 1]
}
