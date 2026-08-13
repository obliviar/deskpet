import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryV4Persistence } from './memory-v4-repository'

const ALGORITHM = 'aes-256-gcm'
const KEY_SIZE = 32
const IV_SIZE = 12

interface EncryptedV4Envelope {
  version: 1
  schema: 'deskpet-memory-v4'
  algorithm: typeof ALGORITHM
  iv: string
  authTag: string
  ciphertext: string
}

interface ProtectedV4KeyEnvelope {
  version: 1
  schema: 'deskpet-memory-v4-key'
  protectedKey: string
}

export interface EncryptedV4PersistenceOptions {
  encryptedPath: string
  keyPath: string
  protectKey: (key: Buffer) => Buffer
  unprotectKey: (protectedKey: Buffer) => Buffer
  /** Optional rolling encrypted backup retained next to the authoritative snapshot. */
  backupPath?: string
  readOnly?: boolean
}

export interface EncryptedV4CheckpointPersistence extends MemoryV4Persistence {
  loadCheckpoint: () => string | undefined
  writeCheckpoint: (payload: string, rotateBackup?: boolean) => void
  encryptFrame: (payload: string) => string
  decryptFrame: (payload: string) => string
}

/**
 * Authenticated V4 snapshot storage. V3 files and keys are deliberately not
 * reused, so a failed V4 migration cannot damage the working V3 store.
 */
export function createEncryptedV4Persistence(
  options: EncryptedV4PersistenceOptions,
): EncryptedV4CheckpointPersistence {
  function getExistingKey(): Buffer {
    if (!existsSync(options.keyPath))
      throw new Error('Protected Memory V4 key does not exist')
    const envelope = parseJson<ProtectedV4KeyEnvelope>(readFileSync(options.keyPath, 'utf-8'), 'Memory V4 key')
    if (envelope.version !== 1 || envelope.schema !== 'deskpet-memory-v4-key'
      || typeof envelope.protectedKey !== 'string')
      throw new Error('Unsupported or invalid protected Memory V4 key')
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
      throw new Error('Operating-system key protection returned an empty Memory V4 key')
    atomicWrite(options.keyPath, JSON.stringify({
      version: 1,
      schema: 'deskpet-memory-v4-key',
      protectedKey: protectedKey.toString('base64'),
    } satisfies ProtectedV4KeyEnvelope))
    return key
  }

  function decryptStoredPayload(): string {
    const envelope = readFileSync(options.encryptedPath, 'utf-8')
    return decryptPayload(envelope, getExistingKey())
  }

  function writeCheckpoint(payload: string, rotateBackup = true): void {
    if (options.readOnly)
      throw new Error('Encrypted Memory V4 persistence is read-only')
    const key = getOrCreateKey()
    const encrypted = encryptPayload(payload, key)
    // Verify encryption before replacing the only complete snapshot.
    if (decryptPayload(encrypted, key) !== payload)
      throw new Error('Memory V4 encryption verification failed')
    if (rotateBackup && options.backupPath && existsSync(options.encryptedPath)) {
      const current = readFileSync(options.encryptedPath, 'utf-8')
      // Never rotate a corrupt snapshot into the only backup.
      decryptPayload(current, key)
      atomicCopy(options.encryptedPath, options.backupPath)
    }
    atomicWrite(options.encryptedPath, encrypted)
  }

  return {
    storagePath: options.encryptedPath,
    load: () => existsSync(options.encryptedPath) ? decryptStoredPayload() : undefined,
    loadCheckpoint: () => existsSync(options.encryptedPath) ? decryptStoredPayload() : undefined,
    save: payload => writeCheckpoint(payload),
    writeCheckpoint,
    encryptFrame: payload => encryptPayload(payload, getOrCreateKey()),
    decryptFrame: payload => decryptPayload(payload, getExistingKey()),
    scrubBackups(): void {
      if (options.readOnly)
        throw new Error('Encrypted Memory V4 persistence is read-only')
      if (!options.backupPath || !existsSync(options.encryptedPath))
        return
      const payload = decryptStoredPayload()
      atomicWrite(options.backupPath, encryptPayload(payload, getExistingKey()))
    },
  }
}

function atomicCopy(sourcePath: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    copyFileSync(sourcePath, temporaryPath)
    replaceFileWithRetry(temporaryPath, targetPath)
  }
  catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function encryptPayload(payload: string, key: Buffer): string {
  assertMasterKey(key)
  const iv = randomBytes(IV_SIZE)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  return JSON.stringify({
    version: 1,
    schema: 'deskpet-memory-v4',
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  } satisfies EncryptedV4Envelope)
}

function decryptPayload(payload: string, key: Buffer): string {
  assertMasterKey(key)
  const envelope = parseJson<EncryptedV4Envelope>(payload, 'encrypted Memory V4 snapshot')
  if (envelope.version !== 1 || envelope.schema !== 'deskpet-memory-v4'
    || envelope.algorithm !== ALGORITHM || typeof envelope.iv !== 'string'
    || typeof envelope.authTag !== 'string' || typeof envelope.ciphertext !== 'string')
    throw new Error('Unsupported or invalid encrypted Memory V4 envelope')
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf-8')
  }
  catch (error) {
    throw new Error(`Unable to decrypt Memory V4: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertMasterKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_SIZE)
    throw new Error('Memory V4 master key must be exactly 32 bytes')
}

function atomicWrite(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryPath, payload, { encoding: 'utf-8', mode: 0o600 })
    replaceFileWithRetry(temporaryPath, path)
  }
  catch (error) {
    // A failed replacement must leave neither a partial target nor plaintext-
    // adjacent temporary ciphertext behind.
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function replaceFileWithRetry(temporaryPath: string, targetPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporaryPath, targetPath)
      return
    }
    catch (error) {
      if (attempt >= 5 || !isTransientWindowsFileError(error))
        throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 2 ** attempt)
    }
  }
}

function isTransientWindowsFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function parseJson<T>(payload: string, label: string): T {
  try {
    return JSON.parse(payload) as T
  }
  catch (error) {
    throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
