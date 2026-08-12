import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEncryptedFilePersistence } from './encrypted-persistence'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('encrypted memory persistence', () => {
  it('encrypts the payload and reloads it with the protected key', () => {
    const paths = temporaryPaths()
    const first = createPersistence(paths)
    first.save('{"version":3,"items":[{"id":"m1","content":"用户喜欢咖啡","accessCount":0}]}')
    const snapshot = readFileSync(paths.encryptedPath, 'utf-8')
    first.appendDelta?.({
      indexVersion: 3,
      upserts: [{ id: 'm1', content: '用户喜欢咖啡', accessCount: 1 }],
      deletes: [],
    })

    expect(readFileSync(paths.encryptedPath, 'utf-8')).not.toContain('用户喜欢咖啡')
    expect(readFileSync(paths.encryptedPath, 'utf-8')).toBe(snapshot)
    expect(readFileSync(paths.journalPath, 'utf-8')).not.toContain('用户喜欢咖啡')
    expect(readFileSync(paths.keyPath, 'utf-8')).not.toContain('0123456789abcdef0123456789abcdef')

    const restarted = createPersistence(paths)
    expect(JSON.parse(restarted.load()!).items[0].accessCount).toBe(1)
  })

  it('migrates legacy plaintext only after encrypted verification', () => {
    const paths = temporaryPaths()
    const legacy = '{"version":1,"items":[{"content":"legacy fact"}]}'
    writeFileSync(paths.legacyPath, legacy, 'utf-8')

    const persistence = createPersistence(paths)
    expect(persistence.load()).toBe(legacy)
    expect(persistence.wasLegacyMigrated()).toBe(true)
    expect(existsSync(paths.legacyPath)).toBe(false)
    expect(existsSync(paths.encryptedPath)).toBe(true)
    expect(createPersistence(paths).load()).toBe(legacy)
  })

  it('preserves and verifies one encrypted backup before schema migration', () => {
    const paths = temporaryPaths()
    const persistence = createPersistence(paths)
    persistence.save('{"version":3,"items":[{"id":"m1","content":"first"}]}')
    persistence.appendDelta?.({
      indexVersion: 3,
      upserts: [{ id: 'm2', content: 'journal fact' }],
      deletes: [],
    })
    persistence.backupBeforeMigration?.()

    expect(existsSync(persistence.backupPath)).toBe(true)
    const backup = readFileSync(persistence.backupPath, 'utf-8')
    const backupReader = createPersistence({
      ...paths,
      encryptedPath: persistence.backupPath,
      journalPath: `${persistence.backupPath}.journal`,
    })
    expect(JSON.parse(backupReader.load()!).items.map((item: { id: string }) => item.id)).toEqual(['m1', 'm2'])

    persistence.save('{"version":3,"items":[]}')
    persistence.backupBeforeMigration?.()
    expect(readFileSync(persistence.backupPath, 'utf-8')).toBe(backup)
  })

  it('compacts authenticated journal entries into a new snapshot', () => {
    const paths = temporaryPaths()
    const persistence = createPersistence(paths, { maxJournalEntries: 2 })
    persistence.save('{"version":3,"items":[{"id":"m1","value":0}]}')
    const snapshot = readFileSync(paths.encryptedPath, 'utf-8')
    persistence.appendDelta?.({ indexVersion: 3, upserts: [{ id: 'm1', value: 1 }], deletes: [] })
    expect(readFileSync(paths.encryptedPath, 'utf-8')).toBe(snapshot)
    persistence.appendDelta?.({ indexVersion: 3, upserts: [{ id: 'm1', value: 2 }], deletes: [] })

    expect(existsSync(paths.journalPath)).toBe(false)
    expect(readFileSync(paths.encryptedPath, 'utf-8')).not.toBe(snapshot)
    expect(JSON.parse(createPersistence(paths).load()!).items[0].value).toBe(2)
  })

  it('discards only an incomplete trailing journal frame after a crash', () => {
    const paths = temporaryPaths()
    const persistence = createPersistence(paths)
    persistence.save('{"version":3,"items":[{"id":"m1"}]}')
    persistence.appendDelta?.({ indexVersion: 3, upserts: [{ id: 'm2' }], deletes: [] })
    appendFileSync(paths.journalPath, '{"partial"', 'utf-8')

    const recovered = createPersistence(paths)
    expect(JSON.parse(recovered.load()!).items.map((item: { id: string }) => item.id)).toEqual(['m1', 'm2'])
    expect(readFileSync(paths.journalPath, 'utf-8')).not.toContain('partial')
  })

  it('loads a recovered view without modifying an incomplete source journal', () => {
    const paths = temporaryPaths()
    const persistence = createPersistence(paths)
    persistence.save('{"version":3,"items":[]}')
    persistence.appendDelta?.({
      indexVersion: 3,
      upserts: [{ id: 'memory-readonly', content: 'kept' }],
      deletes: [],
    })
    appendFileSync(paths.journalPath, '{incomplete-encrypted-frame', 'utf-8')
    const before = readFileSync(paths.journalPath, 'utf-8')

    const recovered = JSON.parse(persistence.loadReadOnly()!) as { items: Array<{ id: string }> }

    expect(recovered.items.map(item => item.id)).toEqual(['memory-readonly'])
    expect(readFileSync(paths.journalPath, 'utf-8')).toBe(before)
  })

  it('does not create a replacement key when an encrypted source key is missing', () => {
    const paths = temporaryPaths()
    const persistence = createPersistence(paths)
    persistence.save('{"version":3,"items":[]}')
    rmSync(paths.keyPath)

    expect(() => persistence.loadReadOnly()).toThrow('does not exist')
    expect(existsSync(paths.keyPath)).toBe(false)
  })
})

function temporaryPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-encrypted-memory-'))
  temporaryDirectories.push(directory)
  return {
    encryptedPath: join(directory, 'memories.enc'),
    journalPath: join(directory, 'memories.enc.journal'),
    keyPath: join(directory, 'memory-key.json'),
    legacyPath: join(directory, 'memories.json'),
  }
}

function createPersistence(
  paths: ReturnType<typeof temporaryPaths>,
  overrides: { maxJournalEntries?: number; maxJournalBytes?: number } = {},
) {
  return createEncryptedFilePersistence({
    ...paths,
    ...overrides,
    protectKey: key => Buffer.from(key.map(byte => byte ^ 0x5a)),
    unprotectKey: key => Buffer.from(key.map(byte => byte ^ 0x5a)),
  })
}
