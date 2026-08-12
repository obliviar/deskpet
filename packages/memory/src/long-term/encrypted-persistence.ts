import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryPersistence, MemoryPersistenceDelta } from './vector-store'

const ALGORITHM = 'aes-256-gcm'
const KEY_SIZE = 32
const IV_SIZE = 12

interface EncryptedEnvelope {
  version: 1
  algorithm: typeof ALGORITHM
  iv: string
  authTag: string
  ciphertext: string
}

interface ProtectedKeyEnvelope {
  version: 1
  protectedKey: string
}

interface MemoryJournalFrame {
  version: 1
  sequence: number
  delta: MemoryPersistenceDelta
}

interface MutableMemoryIndex {
  version: number
  records: Map<string, Record<string, unknown>>
  order: string[]
}

export interface EncryptedFilePersistenceOptions {
  encryptedPath: string
  keyPath: string
  /** Defaults to `<encryptedPath>.pre-v3.backup`. */
  backupPath?: string
  /** Defaults to `<encryptedPath>.journal`. */
  journalPath?: string
  /** Compact journal changes into the encrypted snapshot at this count. */
  maxJournalEntries?: number
  /** Compact when the encrypted journal reaches this many bytes. */
  maxJournalBytes?: number
  legacyPath?: string
  /** Protect the random master key with the operating-system credential store. */
  protectKey: (key: Buffer) => Buffer
  /** Recover the master key from the operating-system protected representation. */
  unprotectKey: (protectedKey: Buffer) => Buffer
}

export interface EncryptedMemoryPersistence extends MemoryPersistence {
  encryptedPath: string
  keyPath: string
  backupPath: string
  journalPath: string
  legacyPath?: string
  wasLegacyMigrated: () => boolean
  /** Load a recovered view without compacting, repairing or migrating files. */
  loadReadOnly: () => string | undefined
}

/**
 * Create an authenticated encrypted persistence adapter for the vector store.
 *
 * The memory payload is encrypted with a random AES-256 key. The caller is
 * responsible for protecting that key (Electron uses safeStorage/DPAPI). A
 * legacy plaintext file is only removed after an encrypt-decrypt verification.
 */
export function createEncryptedFilePersistence(
  options: EncryptedFilePersistenceOptions,
): EncryptedMemoryPersistence {
  let legacyMigrated = false
  const backupPath = options.backupPath ?? `${options.encryptedPath}.pre-v3.backup`
  const journalPath = options.journalPath ?? `${options.encryptedPath}.journal`
  const maxJournalEntries = positiveInteger(options.maxJournalEntries, 500)
  const maxJournalBytes = positiveInteger(options.maxJournalBytes, 16 * 1024 * 1024)
  let cachedIndex: MutableMemoryIndex | undefined
  let cachedPayload: string | undefined
  let journalEntries = 0
  let nextSequence = 1

  function getExistingKey(): Buffer {
    if (!existsSync(options.keyPath))
      throw new Error('Protected long-term memory key does not exist')
    const envelope = parseJson<ProtectedKeyEnvelope>(readFileSync(options.keyPath, 'utf-8'), 'memory key')
    if (envelope.version !== 1 || typeof envelope.protectedKey !== 'string')
      throw new Error('Unsupported or invalid protected memory key')
    const key = options.unprotectKey(Buffer.from(envelope.protectedKey, 'base64'))
    assertMasterKey(key)
    return key
  }

  function getOrCreateKey(): Buffer {
    if (existsSync(options.keyPath))
      return getExistingKey()

    const key = randomBytes(KEY_SIZE)
    const protectedKey = options.protectKey(key)
    if (!Buffer.isBuffer(protectedKey) || protectedKey.length === 0)
      throw new Error('Operating-system key protection returned an empty value')
    atomicWrite(options.keyPath, JSON.stringify({
      version: 1,
      protectedKey: protectedKey.toString('base64'),
    } satisfies ProtectedKeyEnvelope))
    return key
  }

  function decryptStoredPayload(key = getExistingKey()): string {
    const encrypted = readFileSync(options.encryptedPath, 'utf-8')
    return decryptPayload(encrypted, key)
  }

  function save(payload: string): void {
    const key = getOrCreateKey()
    atomicWrite(options.encryptedPath, encryptPayload(payload, key))
    if (existsSync(journalPath))
      unlinkSync(journalPath)
    cachedIndex = tryParseMemoryIndex(payload)
    cachedPayload = payload
    journalEntries = 0
    nextSequence = 1
  }

  function loadCurrent(): string | undefined {
    if (existsSync(options.encryptedPath)) {
      const key = getExistingKey()
      const snapshot = decryptStoredPayload(key)
      if (!existsSync(journalPath)) {
        cachedIndex = tryParseMemoryIndex(snapshot)
        cachedPayload = snapshot
        journalEntries = 0
        nextSequence = 1
        return snapshot
      }
      const recovered = replayJournal(snapshot, journalPath, key)
      cachedIndex = recovered.index
      cachedPayload = serializeMemoryIndex(recovered.index)
      journalEntries = recovered.entries
      nextSequence = recovered.nextSequence
      return cachedPayload
    }
    if (existsSync(journalPath))
      throw new Error('Long-term memory journal exists without an encrypted snapshot')

    if (!options.legacyPath || !existsSync(options.legacyPath))
      return undefined

    const plaintext = readFileSync(options.legacyPath, 'utf-8')
    save(plaintext)
    const verified = decryptStoredPayload()
    if (verified !== plaintext)
      throw new Error('Long-term memory encryption verification failed')
    unlinkSync(options.legacyPath)
    legacyMigrated = true
    return verified
  }

  function loadReadOnly(): string | undefined {
    if (existsSync(options.encryptedPath)) {
      const key = getExistingKey()
      const snapshot = decryptStoredPayload(key)
      if (!existsSync(journalPath))
        return snapshot
      return serializeMemoryIndex(replayJournal(snapshot, journalPath, key, false).index)
    }
    if (existsSync(journalPath))
      throw new Error('Long-term memory journal exists without an encrypted snapshot')
    return options.legacyPath && existsSync(options.legacyPath)
      ? readFileSync(options.legacyPath, 'utf-8')
      : undefined
  }

  function appendDelta(delta: MemoryPersistenceDelta): void {
    validateDelta(delta)
    if (delta.upserts.length === 0 && delta.deletes.length === 0)
      return
    const durableDelta = parseJson<MemoryPersistenceDelta>(JSON.stringify(delta), 'memory delta')
    validateDelta(durableDelta)
    if (!cachedIndex)
      loadCurrent()
    const current = cachedIndex
    if (!current)
      throw new Error('Cannot append a memory delta before the encrypted snapshot exists')
    const frame: MemoryJournalFrame = { version: 1, sequence: nextSequence, delta: durableDelta }
    const key = getOrCreateKey()
    mkdirSync(dirname(journalPath), { recursive: true })
    appendFileSync(journalPath, `${encryptPayload(JSON.stringify(frame), key)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    applyDelta(current, durableDelta)
    cachedPayload = undefined
    journalEntries += 1
    nextSequence += 1
    if (journalEntries >= maxJournalEntries || statSync(journalPath).size >= maxJournalBytes)
      save(serializeMemoryIndex(current))
  }

  return {
    storagePath: options.encryptedPath,
    encryptedPath: options.encryptedPath,
    keyPath: options.keyPath,
    backupPath,
    journalPath,
    legacyPath: options.legacyPath,
    wasLegacyMigrated: () => legacyMigrated,
    loadReadOnly,
    backupBeforeMigration(): void {
      if (existsSync(backupPath))
        return
      if (!cachedIndex)
        loadCurrent()
      const payload = cachedIndex ? serializeMemoryIndex(cachedIndex) : cachedPayload
      if (payload === undefined)
        return
      const key = getOrCreateKey()
      atomicWrite(backupPath, encryptPayload(payload, key))
      if (decryptPayload(readFileSync(backupPath, 'utf-8'), key) !== payload)
        throw new Error('Long-term memory pre-migration backup verification failed')
    },
    load: loadCurrent,
    save,
    appendDelta,
  }
}

function replayJournal(snapshot: string, journalPath: string, key: Buffer, repairTail = true): {
  index: MutableMemoryIndex
  entries: number
  nextSequence: number
} {
  const index = parseMemoryIndex(snapshot)
  const raw = readFileSync(journalPath, 'utf-8')
  const lastNewline = raw.lastIndexOf('\n')
  const complete = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : ''
  if (repairTail && complete !== raw)
    atomicWrite(journalPath, complete)

  let expectedSequence = 1
  let entries = 0
  for (const line of complete.split('\n')) {
    if (!line.trim())
      continue
    const frame = parseJson<MemoryJournalFrame>(decryptPayload(line, key), 'memory journal frame')
    if (frame.version !== 1 || !Number.isInteger(frame.sequence) || frame.sequence !== expectedSequence)
      throw new Error(`Invalid long-term memory journal sequence: expected ${expectedSequence}`)
    validateDelta(frame.delta)
    applyDelta(index, frame.delta)
    entries += 1
    expectedSequence += 1
  }
  return { index, entries, nextSequence: expectedSequence }
}

function applyDelta(index: MutableMemoryIndex, delta: MemoryPersistenceDelta): void {
  for (const raw of delta.upserts) {
    const item = requireRecordWithId(raw, 'journal upsert')
    const id = String(item.id)
    if (!index.records.has(id))
      index.order.push(id)
    index.records.set(id, item)
  }
  for (const id of delta.deletes)
    index.records.delete(id)
  index.version = delta.indexVersion
}

function parseMemoryIndex(payload: string): MutableMemoryIndex {
  const parsed = parseJson<{ version?: unknown; items?: unknown }>(payload, 'memory snapshot')
  if (typeof parsed.version !== 'number' || !Array.isArray(parsed.items))
    throw new Error('Long-term memory snapshot has no valid version or items array')
  const records = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  for (const [position, raw] of parsed.items.entries()) {
    const item = requireRecordWithId(raw, `snapshot item ${position}`)
    const id = String(item.id)
    if (records.has(id))
      throw new Error(`Long-term memory snapshot contains duplicate id: ${id}`)
    records.set(id, item)
    order.push(id)
  }
  return { version: parsed.version, records, order }
}

function tryParseMemoryIndex(payload: string): MutableMemoryIndex | undefined {
  try {
    return parseMemoryIndex(payload)
  }
  catch {
    return undefined
  }
}

function serializeMemoryIndex(index: MutableMemoryIndex): string {
  const items: Record<string, unknown>[] = []
  const retainedOrder: string[] = []
  for (const id of index.order) {
    const item = index.records.get(id)
    if (!item)
      continue
    items.push(item)
    retainedOrder.push(id)
  }
  index.order = retainedOrder
  return JSON.stringify({ version: index.version, items })
}

function validateDelta(value: unknown): asserts value is MemoryPersistenceDelta {
  if (!value || typeof value !== 'object')
    throw new Error('Long-term memory delta is not an object')
  const delta = value as Partial<MemoryPersistenceDelta>
  if (delta.indexVersion !== 3 || !Array.isArray(delta.upserts) || !Array.isArray(delta.deletes))
    throw new Error('Unsupported or invalid long-term memory delta')
  for (const [position, item] of delta.upserts.entries())
    requireRecordWithId(item, `delta upsert ${position}`)
  if (!delta.deletes.every(id => typeof id === 'string' && id.length > 0))
    throw new Error('Long-term memory delta contains an invalid deletion id')
}

function requireRecordWithId(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string')
    throw new Error(`Long-term memory ${label} has no valid id`)
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function encryptPayload(payload: string, key: Buffer): string {
  assertMasterKey(key)
  const iv = randomBytes(IV_SIZE)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return JSON.stringify(envelope)
}

function decryptPayload(payload: string, key: Buffer): string {
  assertMasterKey(key)
  const envelope = parseJson<EncryptedEnvelope>(payload, 'encrypted memory')
  if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM
    || typeof envelope.iv !== 'string'
    || typeof envelope.authTag !== 'string'
    || typeof envelope.ciphertext !== 'string')
    throw new Error('Unsupported or invalid encrypted memory envelope')
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf-8')
  }
  catch (error) {
    throw new Error(`Unable to decrypt long-term memory: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertMasterKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_SIZE)
    throw new Error('Long-term memory master key must be exactly 32 bytes')
}

function atomicWrite(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporaryPath, payload, { encoding: 'utf-8', mode: 0o600 })
  renameSync(temporaryPath, path)
}

function parseJson<T>(payload: string, label: string): T {
  try {
    return JSON.parse(payload) as T
  }
  catch (error) {
    throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
