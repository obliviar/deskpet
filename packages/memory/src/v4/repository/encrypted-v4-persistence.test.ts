import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEncryptedV4Persistence } from './encrypted-v4-persistence'
import { createMemoryV4Repository } from './memory-v4-repository'

describe('encrypted Memory V4 persistence', () => {
  it('encrypts, authenticates and reloads a V4 snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const protectKey = (key: Buffer) => Buffer.from(key).reverse()
    const unprotectKey = (key: Buffer) => Buffer.from(key).reverse()
    const persistence = createEncryptedV4Persistence({ encryptedPath, keyPath, protectKey, unprotectKey })
    const repository = createMemoryV4Repository({ persistence, now: () => 1000 })

    repository.transaction((draft) => {
      draft.retrievalEvents.push({
        id: 'event-secret', scope: { ownerId: 'owner', agentId: 'agent' },
        queryHash: 'hash-secret', queryType: 'test', retrievedFactIds: [], injectedFactIds: [],
        adoptedFactIds: [], correctedFactIds: [], deniedFactIds: [], createdAt: 1000,
        retrievalVersion: 'test',
      })
    })

    const ciphertext = readFileSync(encryptedPath, 'utf-8')
    expect(ciphertext).not.toContain('event-secret')
    expect(ciphertext).not.toContain('hash-secret')
    expect(createMemoryV4Repository({ persistence }).snapshot()).toEqual(repository.snapshot())
  })

  it('atomically replaces an existing encrypted snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-replace-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const persistence = createEncryptedV4Persistence({
      encryptedPath, keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })

    persistence.save('{"revision":1,"secret":"first"}')
    const firstCiphertext = readFileSync(encryptedPath, 'utf-8')
    persistence.save('{"revision":2,"secret":"second"}')

    expect(persistence.load()).toBe('{"revision":2,"secret":"second"}')
    expect(readFileSync(encryptedPath, 'utf-8')).not.toBe(firstCiphertext)
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rotates only an authenticated previous snapshot into the encrypted backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-backup-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const backupPath = join(directory, 'memory-v4.enc.backup')
    const keyPath = join(directory, 'memory-v4-key.json')
    const persistence = createEncryptedV4Persistence({
      encryptedPath, backupPath, keyPath,
      protectKey: key => Buffer.from(key), unprotectKey: key => Buffer.from(key),
    })
    persistence.save('{"revision":1,"secret":"first"}')
    persistence.save('{"revision":2,"secret":"second"}')
    const activeCiphertext = readFileSync(encryptedPath, 'utf-8')
    const backupCiphertext = readFileSync(backupPath, 'utf-8')
    expect(activeCiphertext).not.toContain('second')
    expect(backupCiphertext).not.toContain('first')
    expect(activeCiphertext).not.toBe(backupCiphertext)

    writeFileSync(encryptedPath, '{corrupt', 'utf-8')
    expect(() => persistence.save('{"revision":3}')).toThrow()
    expect(readFileSync(backupPath, 'utf-8')).toBe(backupCiphertext)
  })

  it('rejects a tampered encrypted snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-tamper-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const persistence = createEncryptedV4Persistence({
      encryptedPath,
      keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })
    persistence.save(JSON.stringify({ hello: 'world' }))
    const envelope = JSON.parse(readFileSync(encryptedPath, 'utf-8')) as { ciphertext: string }
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`
    writeFileSync(encryptedPath, JSON.stringify(envelope), 'utf-8')
    expect(() => persistence.load()).toThrow('Unable to decrypt Memory V4')
  })

  it('does not create a new key when an existing snapshot lost its key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-key-loss-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const persistence = createEncryptedV4Persistence({
      encryptedPath,
      keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })
    persistence.save('{"test":true}')
    rmSync(keyPath)

    expect(() => persistence.load()).toThrow('does not exist')
    expect(existsSync(keyPath)).toBe(false)
  })

  it('rejects a wrong or malformed protected key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-wrong-key-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const identity = createEncryptedV4Persistence({
      encryptedPath, keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })
    identity.save('{"secret":"value"}')

    const wrong = createEncryptedV4Persistence({
      encryptedPath, keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key.map(byte => byte ^ 0xff)),
    })
    expect(() => wrong.load()).toThrow('Unable to decrypt Memory V4')

    writeFileSync(keyPath, JSON.stringify({
      version: 1, schema: 'deskpet-memory-v4-key', protectedKey: 'AQ==',
    }), 'utf-8')
    expect(() => identity.load()).toThrow('exactly 32 bytes')
  })

  it('cleans up temporary files when atomic replacement fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-atomic-fail-'))
    const encryptedPath = join(directory, 'cannot-replace-directory')
    const keyPath = join(directory, 'memory-v4-key.json')
    mkdirSync(encryptedPath)
    const persistence = createEncryptedV4Persistence({
      encryptedPath, keyPath,
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
    })

    expect(() => persistence.save('{"test":true}')).toThrow()
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('supports a read-only recovery mode without rewriting encrypted data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v4-readonly-'))
    const encryptedPath = join(directory, 'memory-v4.enc')
    const keyPath = join(directory, 'memory-v4-key.json')
    const writable = createEncryptedV4Persistence({
      encryptedPath, keyPath, protectKey: key => Buffer.from(key), unprotectKey: key => Buffer.from(key),
    })
    writable.save('{"revision":1}')
    const before = readFileSync(encryptedPath, 'utf-8')
    const readOnly = createEncryptedV4Persistence({
      encryptedPath, keyPath, readOnly: true,
      protectKey: key => Buffer.from(key), unprotectKey: key => Buffer.from(key),
    })
    expect(readOnly.load()).toBe('{"revision":1}')
    expect(() => readOnly.save('{"revision":2}')).toThrow('read-only')
    expect(readFileSync(encryptedPath, 'utf-8')).toBe(before)
  })
})
