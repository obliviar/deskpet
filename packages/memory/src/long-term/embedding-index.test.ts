import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryEmbeddingIndex } from './embedding-index'
import { createEncryptedFilePersistence } from './encrypted-persistence'
import { createFilePersistence } from './vector-store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('memory embedding side index', () => {
  it('persists model variants without storing plaintext content and rejects stale hashes', () => {
    const storagePath = temporaryFile()
    const first = createMemoryEmbeddingIndex({ persistence: createFilePersistence(storagePath) })
    first.putBatch([
      { memoryId: 'memory-a', model: 'bge-v1', content: '用户住在杭州', vector: [1, 0] },
      { memoryId: 'memory-a', model: 'hash-v3', content: '用户住在杭州', vector: [0, 1] },
    ])

    expect(first.get('memory-a', 'bge-v1', '用户住在杭州')).toEqual([1, 0])
    expect(first.get('memory-a', 'bge-v1', '用户住在上海')).toBeUndefined()

    const second = createMemoryEmbeddingIndex({ persistence: createFilePersistence(storagePath) })
    expect(second.get('memory-a', 'hash-v3', '用户住在杭州')).toEqual([0, 1])
    expect(second.hasMemory('memory-a')).toBe(true)
    expect(second.removeMemoryIds(['memory-a'])).toBe(2)

    const third = createMemoryEmbeddingIndex({ persistence: createFilePersistence(storagePath) })
    expect(third.hasMemory('memory-a')).toBe(false)
  })

  it('removes orphan vectors during reconciliation', () => {
    const index = createMemoryEmbeddingIndex()
    index.putBatch([
      { memoryId: 'keep', model: 'bge-v1', content: '保留', vector: [1] },
      { memoryId: 'orphan', model: 'bge-v1', content: '删除', vector: [2] },
    ])

    expect(index.reconcileMemoryIds(new Set(['keep']))).toBe(1)
    expect(index.hasMemory('keep')).toBe(true)
    expect(index.hasMemory('orphan')).toBe(false)
  })

  it('uses the authenticated encrypted journal without leaking memory text', () => {
    const directory = temporaryDirectory()
    const encryptedPath = join(directory, 'memory-embeddings.enc')
    const keyPath = join(directory, 'memory-embedding-key.json')
    const persistence = () => createEncryptedFilePersistence({
      encryptedPath,
      keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })
    const first = createMemoryEmbeddingIndex({ persistence: persistence() })
    first.putBatch([{ memoryId: 'private-memory', model: 'bge-v1', content: '用户住在杭州', vector: [1, 0] }])

    expect(readFileSync(encryptedPath, 'utf-8')).not.toContain('用户住在杭州')
    expect(readFileSync(`${encryptedPath}.journal`, 'utf-8')).not.toContain('用户住在杭州')
    const second = createMemoryEmbeddingIndex({ persistence: persistence() })
    expect(second.get('private-memory', 'bge-v1', '用户住在杭州')).toEqual([1, 0])
  })

  it('does not expose uncommitted writes or hide undeleted vectors after persistence failures', () => {
    let fail = true
    const persistence = {
      load: () => undefined,
      save: () => {},
      appendDelta: () => {
        if (fail)
          throw new Error('simulated disk failure')
      },
    }
    const index = createMemoryEmbeddingIndex({ persistence })
    expect(() => index.putBatch([
      { memoryId: 'memory-a', model: 'bge-v1', content: '内容', vector: [1] },
    ])).toThrow('simulated disk failure')
    expect(index.hasMemory('memory-a')).toBe(false)

    fail = false
    index.putBatch([{ memoryId: 'memory-a', model: 'bge-v1', content: '内容', vector: [1] }])
    fail = true
    expect(() => index.removeMemoryIds(['memory-a'])).toThrow('simulated disk failure')
    expect(index.hasMemory('memory-a')).toBe(true)
  })
})

function temporaryFile(): string {
  return join(temporaryDirectory(), 'embeddings.json')
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-embedding-index-'))
  temporaryDirectories.push(directory)
  return directory
}
