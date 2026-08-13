import type { MemoryV4Snapshot } from '../domain/types'
import { MEMORY_V4_SCHEMA_VERSION } from '../domain/types'
import { assertMemoryV4Snapshot, jsonClone } from '../domain/validation'

export interface MemoryV4Persistence {
  load: () => string | undefined
  save: (payload: string) => void
  /** Fold an incremental journal into the encrypted checkpoint when supported. */
  compact?: () => void
  /** Replace managed rolling backups with the current effective payload. */
  scrubBackups?: () => void
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
  if (!Number.isFinite(now) || now <= 0)
    throw new Error('Memory V4 snapshot requires a positive creation timestamp')
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
    derivedArtifacts: [],
    domainEvents: [],
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
  let transactionOpen = false

  function requireWritable(): void {
    if (options.readOnly)
      throw new Error('Memory V4 repository is read-only')
    if (transactionOpen)
      throw new Error('Memory V4 repository transaction is already active')
  }

  function commit(next: MemoryV4Snapshot): void {
    assertMemoryV4Snapshot(next)
    const payload = JSON.stringify(next)
    // Persist before publishing the new in-memory state. If persistence fails,
    // readers continue to observe the previous complete revision.
    options.persistence?.save(payload)
    // Publish a detached copy. A mutator may return part of its draft; retaining
    // that same object here would allow later caller mutations to bypass a
    // transaction and persistence entirely.
    current = JSON.parse(payload) as MemoryV4Snapshot
  }

  return {
    storagePath: options.persistence?.storagePath,
    readOnly: options.readOnly === true,
    snapshot: () => jsonClone(current),
    transaction<T>(mutator: (draft: MemoryV4Snapshot) => T): T {
      requireWritable()
      const draft = jsonClone(current)
      transactionOpen = true
      try {
        const result = mutator(draft)
        if (isThenable(result)) {
          // Consume a possible rejection from an accidentally async callback;
          // its isolated draft is discarded and never published.
          void Promise.resolve(result).catch(() => undefined)
          throw new Error('Memory V4 transactions must use a synchronous mutator')
        }
        draft.schemaVersion = MEMORY_V4_SCHEMA_VERSION
        draft.revision = current.revision + 1
        draft.createdAt = current.createdAt
        draft.updatedAt = Math.max(now(), current.updatedAt)
        commit(draft)
        return result
      }
      finally {
        transactionOpen = false
      }
    },
    replace(snapshot: MemoryV4Snapshot): void {
      requireWritable()
      // Validate before cloning so non-JSON numeric values such as NaN cannot
      // be silently converted to null by JSON serialization.
      assertMemoryV4Snapshot(snapshot)
      const next = jsonClone(snapshot)
      if (next.revision < current.revision)
        throw new Error('Memory V4 repository refuses to replace data with an older revision')
      commit(next)
    },
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? typeof (value as { then?: unknown }).then === 'function'
    : false
}

export function parseMemoryV4Snapshot(payload: string): MemoryV4Snapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse Memory V4 snapshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  upgradeStageOneSnapshot(parsed)
  assertMemoryV4Snapshot(parsed)
  return parsed
}

/** Backward-compatible, in-memory completion for snapshots written before stage-one authority fields. */
function upgradeStageOneSnapshot(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return
  const snapshot = value as Record<string, unknown>
  if (snapshot.schemaVersion !== MEMORY_V4_SCHEMA_VERSION)
    return
  snapshot.derivedArtifacts ??= []
  snapshot.domainEvents ??= []
  const facts = Array.isArray(snapshot.facts) ? snapshot.facts as Array<Record<string, unknown>> : []
  const factsById = new Map(facts.map(fact => [String(fact.id), fact]))
  for (const fact of facts) {
    fact.objectType ??= inferObjectType(fact.object)
    fact.normalizedValue ??= jsonClone(fact.object)
    fact.modality ??= 'asserted'
  }
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates as Array<Record<string, unknown>> : []
  for (const candidate of candidates) {
    candidate.objectType ??= inferObjectType(candidate.object)
    candidate.normalizedValue ??= jsonClone(candidate.object)
    candidate.modality ??= 'asserted'
  }
  const versions = Array.isArray(snapshot.factVersions) ? snapshot.factVersions as Array<Record<string, unknown>> : []
  for (const version of versions) {
    const fact = factsById.get(String(version.factId))
    const historicalText = typeof version.canonicalText === 'string' ? version.canonicalText : ''
    version.subjectId ??= fact?.subjectId ?? 'owner:unknown'
    version.predicate ??= fact?.predicate ?? 'memory.fact'
    version.object ??= historicalText
    version.objectType ??= inferObjectType(version.object)
    version.normalizedValue ??= jsonClone(version.object)
    version.polarity ??= fact?.polarity ?? 'unknown'
    version.modality ??= fact?.modality ?? 'asserted'
  }
  const versionsByFact = new Map<string, Array<Record<string, unknown>>>()
  for (const version of versions) {
    const key = String(version.factId)
    versionsByFact.set(key, [...(versionsByFact.get(key) ?? []), version])
  }
  for (const factVersions of versionsByFact.values()) {
    factVersions.sort((left, right) => Number(left.version) - Number(right.version))
    for (let index = 0; index < factVersions.length - 1; index++) {
      const current = factVersions[index]!
      const next = factVersions[index + 1]!
      current.transactionClosedAt ??= Math.max(Number(current.recordedAt), Number(next.recordedAt))
    }
    delete factVersions.at(-1)!.transactionClosedAt
  }
}

function inferObjectType(value: unknown): string {
  if (typeof value === 'string')
    return 'string'
  if (typeof value === 'number')
    return 'number'
  if (typeof value === 'boolean')
    return 'boolean'
  return 'json'
}
