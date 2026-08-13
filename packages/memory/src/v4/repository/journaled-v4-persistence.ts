import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryV4Persistence } from './memory-v4-repository'
import type { EncryptedV4CheckpointPersistence } from './encrypted-v4-persistence'

const ZERO_HASH = '0'.repeat(64)

interface MemoryV4JournalFrame {
  version: 1
  schema: 'deskpet-memory-v4-journal'
  sequence: number
  previousPayloadSha256: string
  payloadSha256: string
  payload: string
}

export interface JournaledV4PersistenceOptions {
  checkpoint: EncryptedV4CheckpointPersistence
  journalPath: string
  /** Defaults to 100 complete revisions. */
  maxEntries?: number
  /** Defaults to 16 MiB of authenticated ciphertext. */
  maxBytes?: number
  readOnly?: boolean
  /** Test-only crash hook invoked after checkpoint replacement, before journal cleanup. */
  afterCheckpointWrite?: () => void
}

export interface JournaledV4Persistence extends MemoryV4Persistence {
  readonly journalPath: string
  pendingEntries: () => number
  compact: () => void
  scrubBackups: () => void
}

/**
 * Compatibility-preserving V4 write-ahead journal. Existing memory-v4.enc
 * remains a valid encrypted checkpoint; subsequent complete revisions are
 * authenticated independently and replayed in sequence. A torn final line is
 * discarded, while corruption of any complete frame is rejected.
 */
export function createJournaledV4Persistence(options: JournaledV4PersistenceOptions): JournaledV4Persistence {
  const maxEntries = positiveInteger(options.maxEntries, 100)
  const maxBytes = positiveInteger(options.maxBytes, 16 * 1024 * 1024)
  let cachedPayload: string | undefined
  let cachedEntries = 0

  function replay(repairTail: boolean): { payload: string | undefined; entries: number } {
    let payload = options.checkpoint.loadCheckpoint()
    if (!existsSync(options.journalPath))
      return { payload, entries: 0 }
    if (payload === undefined)
      throw new Error('Memory V4 journal exists without an encrypted checkpoint')

    const raw = readFileSync(options.journalPath, 'utf-8')
    const lastNewline = raw.lastIndexOf('\n')
    const complete = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : ''
    if (repairTail && complete !== raw)
      atomicRewrite(options.journalPath, complete)
    const frames: MemoryV4JournalFrame[] = []
    let expectedSequence = 1
    for (const line of complete.split('\n')) {
      if (!line.trim())
        continue
      const frame = parseFrame(options.checkpoint.decryptFrame(line))
      if (frame.sequence !== expectedSequence)
        throw new Error(`Invalid Memory V4 journal sequence: expected ${expectedSequence}`)
      if (sha256(frame.payload) !== frame.payloadSha256)
        throw new Error('Memory V4 journal payload hash is invalid')
      const priorFrame = frames.at(-1)
      if (priorFrame && frame.previousPayloadSha256 !== priorFrame.payloadSha256)
        throw new Error('Memory V4 journal contains a broken internal hash chain')
      frames.push(frame)
      expectedSequence += 1
    }
    const checkpointHash = sha256(payload)
    // Crash-safe compaction: the checkpoint replacement may complete before
    // the old journal is removed. A fully validated journal whose final state
    // equals that checkpoint is already subsumed and must not be replayed.
    if (frames.at(-1)?.payloadSha256 === checkpointHash) {
      if (repairTail)
        rmSync(options.journalPath, { force: true })
      return { payload, entries: 0 }
    }
    if (frames[0] && frames[0].previousPayloadSha256 !== checkpointHash)
      throw new Error('Memory V4 journal hash chain does not match its checkpoint')
    for (const frame of frames)
      payload = frame.payload
    return { payload, entries: frames.length }
  }

  function load(): string | undefined {
    const recovered = replay(options.readOnly !== true)
    cachedPayload = recovered.payload
    cachedEntries = recovered.entries
    return recovered.payload
  }

  function compactWithBackupPolicy(rotateBackup: boolean): void {
    if (options.readOnly)
      throw new Error('Memory V4 journal persistence is read-only')
    const recovered = replay(true)
    if (recovered.payload === undefined)
      return
    options.checkpoint.writeCheckpoint(recovered.payload, rotateBackup)
    options.afterCheckpointWrite?.()
    rmSync(options.journalPath, { force: true })
    cachedPayload = recovered.payload
    cachedEntries = 0
  }

  function compact(): void {
    compactWithBackupPolicy(true)
  }

  function save(payload: string): void {
    if (options.readOnly)
      throw new Error('Memory V4 journal persistence is read-only')
    if (cachedPayload === undefined) {
      const recovered = replay(true)
      cachedPayload = recovered.payload
      cachedEntries = recovered.entries
    }
    if (cachedPayload === undefined) {
      options.checkpoint.writeCheckpoint(payload)
      cachedPayload = payload
      cachedEntries = 0
      return
    }
    if (payload === cachedPayload)
      return
    const frame: MemoryV4JournalFrame = {
      version: 1,
      schema: 'deskpet-memory-v4-journal',
      sequence: cachedEntries + 1,
      previousPayloadSha256: sha256(cachedPayload),
      payloadSha256: sha256(payload),
      payload,
    }
    const encrypted = options.checkpoint.encryptFrame(JSON.stringify(frame))
    // Verify before append so a local encryption/configuration failure cannot
    // add an unreadable complete line to the authoritative journal.
    parseFrame(options.checkpoint.decryptFrame(encrypted))
    mkdirSync(dirname(options.journalPath), { recursive: true })
    appendDurably(options.journalPath, `${encrypted}\n`)
    cachedPayload = payload
    cachedEntries += 1
    if (cachedEntries >= maxEntries || statSync(options.journalPath).size >= maxBytes)
      compact()
  }

  return {
    storagePath: options.checkpoint.storagePath,
    journalPath: options.journalPath,
    load,
    save,
    pendingEntries: () => cachedEntries,
    compact,
    scrubBackups(): void {
      // Privacy compaction must not rotate the pre-purge checkpoint into a
      // recoverable backup. The current sanitized checkpoint is written first.
      compactWithBackupPolicy(false)
      options.checkpoint.scrubBackups?.()
    },
  }
}

function appendDurably(path: string, payload: string): void {
  const descriptor = openSync(path, 'a', 0o600)
  try {
    writeSync(descriptor, payload, undefined, 'utf-8')
    fsyncSync(descriptor)
  }
  finally {
    closeSync(descriptor)
  }
}

function atomicRewrite(path: string, payload: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryPath, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(temporaryPath, path)
  }
  catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function parseFrame(payload: string): MemoryV4JournalFrame {
  let frame: MemoryV4JournalFrame
  try { frame = JSON.parse(payload) as MemoryV4JournalFrame }
  catch (error) {
    throw new Error(`Unable to parse Memory V4 journal frame: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (frame.version !== 1 || frame.schema !== 'deskpet-memory-v4-journal'
    || !Number.isInteger(frame.sequence) || frame.sequence <= 0
    || typeof frame.payload !== 'string'
    || !isHash(frame.previousPayloadSha256) || !isHash(frame.payloadSha256))
    throw new Error('Unsupported or invalid Memory V4 journal frame')
  return frame
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && (/^[a-f0-9]{64}$/u.test(value) || value === ZERO_HASH)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback
}
