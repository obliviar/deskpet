import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEncryptedFilePersistence } from '../../long-term/encrypted-persistence'
import { createEncryptedV4Persistence } from '../repository/encrypted-v4-persistence'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import { migrateV3SourceIntoV4 } from './v3-to-v4'

describe('encrypted V3 to V4 integration', () => {
  it('migrates snapshot plus journal without changing any V3 source file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deskpet-v3-v4-'))
    const v3EncryptedPath = join(directory, 'memories.enc')
    const v3KeyPath = join(directory, 'memory-key.json')
    const v3JournalPath = join(directory, 'memories.enc.journal')
    const protect = (key: Buffer) => Buffer.from(key.map(byte => byte ^ 0x6d))
    const unprotect = (key: Buffer) => Buffer.from(key.map(byte => byte ^ 0x6d))
    const v3 = createEncryptedFilePersistence({
      encryptedPath: v3EncryptedPath,
      keyPath: v3KeyPath,
      journalPath: v3JournalPath,
      protectKey: protect,
      unprotectKey: unprotect,
    })
    v3.save(JSON.stringify({ version: 3, items: [v3Item('m1', '用户姓名：小秦', 'manual')] }))
    v3.appendDelta!({
      indexVersion: 3,
      upserts: [v3Item('m2', '用户喜欢茶', 'automatic')],
      deletes: [],
    })
    const sourceHashes = new Map([
      [v3EncryptedPath, fileSha256(v3EncryptedPath)],
      [v3KeyPath, fileSha256(v3KeyPath)],
      [v3JournalPath, fileSha256(v3JournalPath)],
    ])

    const v4Persistence = createEncryptedV4Persistence({
      encryptedPath: join(directory, 'memory-v4.enc'),
      keyPath: join(directory, 'memory-v4-key.json'),
      protectKey: protect,
      unprotectKey: unprotect,
    })
    const v4 = createMemoryV4Repository({ persistence: v4Persistence, now: () => 2000 })
    const result = migrateV3SourceIntoV4({ load: v3.loadReadOnly }, v4, { now: () => 2000 })

    expect(result).toMatchObject({ migrated: true, sourceItemCount: 2, factCount: 2 })
    expect(v4.snapshot().facts.map(item => [item.canonicalText, item.status])).toEqual([
      ['用户姓名：小秦', 'active'],
      ['用户喜欢茶', 'quarantined'],
    ])
    for (const [path, hash] of sourceHashes)
      expect(fileSha256(path)).toBe(hash)
    expect(readFileSync(join(directory, 'memory-v4.enc'), 'utf-8')).not.toContain('用户姓名')
  })
})

function v3Item(id: string, content: string, origin: 'manual' | 'automatic') {
  return {
    id,
    content,
    metadata: { kind: 'identity', cardinality: 'multiple' },
    status: 'active',
    origin,
    importance: 0.7,
    confidence: 0.9,
    accessCount: 0,
    sourceMessageIds: origin === 'automatic' ? [`message-${id}`] : [],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope: { ownerId: 'owner', agentId: 'agent' },
    embedding: [0.1],
    embeddingModel: 'test',
    createdAt: 1000,
    updatedAt: 1000,
  }
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
