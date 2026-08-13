import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEncryptedV4Persistence } from './encrypted-v4-persistence'
import { createJournaledV4Persistence } from './journaled-v4-persistence'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('journaled Memory V4 persistence', () => {
  it('opens an existing encrypted snapshot and replays authenticated revisions after restart', () => {
    const fixture = createFixture()
    fixture.checkpoint.save('{"revision":1,"secret":"checkpoint"}')
    const persistence = fixture.journal()
    expect(persistence.load()).toBe('{"revision":1,"secret":"checkpoint"}')
    persistence.save('{"revision":2,"secret":"journal-one"}')
    persistence.save('{"revision":3,"secret":"journal-two"}')

    expect(readFileSync(fixture.encryptedPath, 'utf-8')).not.toContain('checkpoint')
    expect(readFileSync(fixture.journalPath, 'utf-8')).not.toContain('journal-one')
    expect(fixture.journal().load()).toBe('{"revision":3,"secret":"journal-two"}')
  })

  it('repairs only a torn final frame and keeps every complete revision', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1}')
    persistence.save('{"revision":2}')
    appendFileSync(fixture.journalPath, '{torn-ciphertext', 'utf-8')

    expect(fixture.journal().load()).toBe('{"revision":2}')
    expect(readFileSync(fixture.journalPath, 'utf-8')).not.toContain('torn-ciphertext')
  })

  it('rejects a corrupted complete frame instead of silently falling back', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1}')
    persistence.save('{"revision":2}')
    const lines = readFileSync(fixture.journalPath, 'utf-8').trimEnd().split('\n')
    const envelope = JSON.parse(lines[0]!) as { ciphertext: string }
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`
    lines[0] = JSON.stringify(envelope)
    writeFileSync(fixture.journalPath, `${lines.join('\n')}\n`, 'utf-8')

    expect(() => fixture.journal().load()).toThrow('Unable to decrypt Memory V4')
  })

  it('compacts at the configured threshold and preserves the effective payload', () => {
    const fixture = createFixture()
    const persistence = fixture.journal({ maxEntries: 2 })
    persistence.save('{"revision":1}')
    persistence.save('{"revision":2}')
    persistence.save('{"revision":3}')

    expect(existsSync(fixture.journalPath)).toBe(false)
    expect(fixture.checkpoint.load()).toBe('{"revision":3}')
    expect(fixture.journal().load()).toBe('{"revision":3}')
  })

  it('recovers when a crash leaves an already-compacted journal beside the new checkpoint', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1}')
    persistence.save('{"revision":2}')
    const journalBeforeCrash = readFileSync(fixture.journalPath, 'utf-8')
    fixture.checkpoint.writeCheckpoint('{"revision":2}', false)
    expect(readFileSync(fixture.journalPath, 'utf-8')).toBe(journalBeforeCrash)

    expect(fixture.journal().load()).toBe('{"revision":2}')
    expect(existsSync(fixture.journalPath)).toBe(false)
  })

  it('fault-injects a crash between checkpoint replacement and journal cleanup', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1}')
    persistence.save('{"revision":2}')
    const crashing = createJournaledV4Persistence({
      checkpoint: fixture.checkpoint,
      journalPath: fixture.journalPath,
      afterCheckpointWrite: () => { throw new Error('simulated power loss') },
    })

    expect(() => crashing.compact()).toThrow('simulated power loss')
    expect(existsSync(fixture.journalPath)).toBe(true)
    expect(fixture.journal().load()).toBe('{"revision":2}')
    expect(existsSync(fixture.journalPath)).toBe(false)
  })

  it('rejects a complete journal when its checkpoint was rolled back independently', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1}')
    const checkpointBefore = readFileSync(fixture.encryptedPath, 'utf-8')
    persistence.save('{"revision":2}')
    fixture.checkpoint.writeCheckpoint('{"revision":3}', false)
    expect(readFileSync(fixture.encryptedPath, 'utf-8')).not.toBe(checkpointBefore)

    expect(() => fixture.journal().load()).toThrow('does not match its checkpoint')
  })

  it('compacts and scrubs the rolling backup after irreversible content removal', () => {
    const fixture = createFixture()
    const persistence = fixture.journal()
    persistence.save('{"revision":1,"secret":"remove-me"}')
    persistence.save('{"revision":2,"secret":"[purged]"}')
    persistence.scrubBackups()

    expect(existsSync(fixture.journalPath)).toBe(false)
    expect(fixture.checkpoint.load()).toBe('{"revision":2,"secret":"[purged]"}')
    const backupPersistence = createEncryptedV4Persistence({
      encryptedPath: fixture.backupPath,
      keyPath: fixture.keyPath,
      protectKey: key => Buffer.from(key), unprotectKey: key => Buffer.from(key),
    })
    expect(backupPersistence.load()).toBe('{"revision":2,"secret":"[purged]"}')
  })
})

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-journal-'))
  temporaryDirectories.push(directory)
  const encryptedPath = join(directory, 'memory-v4.enc')
  const backupPath = join(directory, 'memory-v4.enc.backup')
  const keyPath = join(directory, 'memory-v4-key.json')
  const journalPath = join(directory, 'memory-v4.journal')
  const checkpoint = createEncryptedV4Persistence({
    encryptedPath, backupPath, keyPath,
    protectKey: key => Buffer.from(key), unprotectKey: key => Buffer.from(key),
  })
  return {
    encryptedPath, backupPath, keyPath, journalPath, checkpoint,
    journal: (options: { maxEntries?: number } = {}) => createJournaledV4Persistence({
      checkpoint, journalPath, ...options,
    }),
  }
}
