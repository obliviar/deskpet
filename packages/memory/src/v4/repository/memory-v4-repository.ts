import type { MemoryV4Snapshot } from '../domain/types'
import { MEMORY_V4_SCHEMA_VERSION } from '../domain/types'
import { assertMemoryV4Snapshot, jsonClone } from '../domain/validation'

export interface MemoryV4Persistence {
  load: () => string | undefined
  save: (payload: string) => void
  storagePath?: string
}

export interface MemoryV4RepositoryOptions {
  persistence?: MemoryV4Persistence
  readOnly?: boolean
  now?: () => number
}

export interface MemoryV4Repository {
  readonly storagePath?: string
  readonly readOnly: boolean
  snapshot: () => MemoryV4Snapshot
  transaction: <T>(mutator: (draft: MemoryV4Snapshot) => T) => T
  replace: (snapshot: MemoryV4Snapshot) => void
}

export function createEmptyMemoryV4Snapshot(now = Date.now()): MemoryV4Snapshot {
  return {
    schemaVersion: MEMORY_V4_SCHEMA_VERSION,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    episodes: [],
    candidates: [],
    facts: [],
    evidenceLinks: [],
    factVersions: [],
    retrievalEvents: [],
    migrationManifests: [],
    legacyImports: [],
  }
}

export function createMemoryV4Repository(options: MemoryV4RepositoryOptions = {}): MemoryV4Repository {
  const now = options.now ?? Date.now
  const persisted = options.persistence?.load()
  let current = persisted === undefined
    ? createEmptyMemoryV4Snapshot(now())
    : parseMemoryV4Snapshot(persisted)

  function requireWritable(): void {
    if (options.readOnly)
      throw new Error('Memory V4 repository is read-only')
  }

  function commit(next: MemoryV4Snapshot): void {
    assertMemoryV4Snapshot(next)
    const payload = JSON.stringify(next)
    // Persist before publishing the new in-memory state. If persistence fails,
    // readers continue to observe the previous complete revision.
    options.persistence?.save(payload)
    current = next
  }

  return {
    storagePath: options.persistence?.storagePath,
    readOnly: options.readOnly === true,
    snapshot: () => jsonClone(current),
    transaction<T>(mutator: (draft: MemoryV4Snapshot) => T): T {
      requireWritable()
      const draft = jsonClone(current)
      const result = mutator(draft)
      draft.schemaVersion = MEMORY_V4_SCHEMA_VERSION
      draft.revision = current.revision + 1
      draft.createdAt = current.createdAt
      draft.updatedAt = Math.max(now(), current.updatedAt)
      commit(draft)
      return result
    },
    replace(snapshot: MemoryV4Snapshot): void {
      requireWritable()
      const next = jsonClone(snapshot)
      assertMemoryV4Snapshot(next)
      if (next.revision < current.revision)
        throw new Error('Memory V4 repository refuses to replace data with an older revision')
      commit(next)
    },
  }
}

export function parseMemoryV4Snapshot(payload: string): MemoryV4Snapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse Memory V4 snapshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertMemoryV4Snapshot(parsed)
  return parsed
}
