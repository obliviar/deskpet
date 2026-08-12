import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
