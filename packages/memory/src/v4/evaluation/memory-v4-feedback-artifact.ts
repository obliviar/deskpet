import { createHash } from 'node:crypto'
import {
  evaluateMemoryV4FeedbackCalibrationGate,
  fitMemoryV4InternalFeedbackCalibration,
  type MemoryV4FeedbackCalibrationDataset,
  type MemoryV4FeedbackCalibrationGateReport,
} from './memory-v4-feedback-calibration'
import type { MemoryV4LocalCalibrationArtifact } from './memory-v4-local-calibration'

export const MEMORY_V4_FEEDBACK_ARTIFACT_VERSION = 'memory-v4-feedback-artifact-v1'
export const MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION = 1 as const
export const MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION = 'memory-v4-feedback-approval-checklist-v1'

export interface MemoryV4FeedbackArtifactPersistence {
  load: () => string | undefined
  save: (payload: string) => void
  storagePath?: string
}

export interface MemoryV4FeedbackArtifactChecklist {
  labelsReviewed: boolean
  privacyReviewed: boolean
  splitLocked: boolean
  metricsAccepted: boolean
}

export interface MemoryV4FeedbackArtifactApproval {
  reviewer: string
  approvedAt: number
  checklistVersion: typeof MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION
  noteHash?: string
}

export type MemoryV4FeedbackArtifactState = 'draft' | 'approved' | 'revoked'

export interface MemoryV4FeedbackArtifact {
  id: string
  version: typeof MEMORY_V4_FEEDBACK_ARTIFACT_VERSION
  artifactFingerprint: string
  state: MemoryV4FeedbackArtifactState
  createdAt: number
  dataset: MemoryV4FeedbackCalibrationDataset
  gate: MemoryV4FeedbackCalibrationGateReport
  calibration: MemoryV4LocalCalibrationArtifact
  approval?: MemoryV4FeedbackArtifactApproval
  revokedAt?: number
  revokeReasonHash?: string
  automaticActivation: false
  authoritativeAnswerSource: 'v3'
}

interface MemoryV4FeedbackArtifactSnapshot {
  schemaVersion: typeof MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION
  createdAt: number
  updatedAt: number
  artifacts: MemoryV4FeedbackArtifact[]
}

export interface MemoryV4FeedbackArtifactSummary {
  id: string
  artifactFingerprint: string
  state: MemoryV4FeedbackArtifactState
  createdAt: number
  datasetVersion: string
  datasetFingerprint: string
  calibrationVersion: string
  calibrationSamples: number
  validationSamples: number
  approvedAt?: number
  revokedAt?: number
  automaticActivation: false
  authoritativeAnswerSource: 'v3'
}

export interface MemoryV4FeedbackArtifactStatus {
  version: typeof MEMORY_V4_FEEDBACK_ARTIFACT_VERSION
  storagePath?: string
  encrypted: boolean
  retainedArtifacts: number
  drafts: number
  approved: number
  revoked: number
  pendingWrites: number
  current?: MemoryV4FeedbackArtifactSummary
}

export type MemoryV4FeedbackArtifactApprovalResult =
  | { ok: true; artifact: MemoryV4FeedbackArtifactSummary }
  | { ok: false; reason: 'unknown-artifact' | 'invalid-state' | 'incomplete-checklist' | 'missing-reviewer' }

export type MemoryV4FeedbackArtifactRevocationResult =
  | { ok: true; artifact: MemoryV4FeedbackArtifactSummary }
  | { ok: false; reason: 'unknown-artifact' | 'invalid-state' | 'missing-reason' }

export interface MemoryV4FeedbackArtifactStore {
  create: (dataset: MemoryV4FeedbackCalibrationDataset) => MemoryV4FeedbackArtifact
  approve: (artifactId: string, input: {
    reviewer: string
    checklist: MemoryV4FeedbackArtifactChecklist
    note?: string
  }) => MemoryV4FeedbackArtifactApprovalResult
  revoke: (artifactId: string, reason: string) => MemoryV4FeedbackArtifactRevocationResult
  list: () => MemoryV4FeedbackArtifactSummary[]
  status: () => MemoryV4FeedbackArtifactStatus
  flush: () => void
  clear: () => void
}

/**
 * Stores frozen, integrity-checked offline calibration artifacts. Approval is
 * deliberately separate from fitting and never activates the artifact online.
 */
export function createMemoryV4FeedbackArtifactStore(options: {
  persistence?: MemoryV4FeedbackArtifactPersistence
  encrypted?: boolean
  maxArtifacts?: number
  flushDelayMs?: number
  now?: () => number
  onPersistenceError?: (error: unknown) => void
} = {}): MemoryV4FeedbackArtifactStore {
  const now = options.now ?? Date.now
  const maxArtifacts = boundedInteger(options.maxArtifacts ?? 20, 1, 100)
  const flushDelayMs = boundedInteger(options.flushDelayMs ?? 1_000, 0, 60_000)
  const loaded = options.persistence?.load()
  let snapshot = loaded ? parseSnapshot(loaded) : emptySnapshot(timestamp(now(), 'createdAt'))
  if (snapshot.artifacts.length > maxArtifacts)
    snapshot.artifacts.splice(0, snapshot.artifacts.length - maxArtifacts)
  let dirty = false
  let pendingWrites = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.persistence && loaded === undefined)
    options.persistence.save(JSON.stringify(snapshot))

  function reportPersistenceError(error: unknown): void {
    try {
      options.onPersistenceError?.(error)
    }
    catch {
      // Diagnostics must never affect the authoritative V3 answer path.
    }
  }

  function flushSafely(): void {
    try {
      flush()
    }
    catch (error) {
      reportPersistenceError(error)
    }
  }

  function scheduleFlush(): void {
    dirty = true
    pendingWrites += 1
    if (!options.persistence || timer)
      return
    if (flushDelayMs === 0) {
      flushSafely()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      flushSafely()
    }, flushDelayMs)
    timer.unref?.()
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty || !options.persistence) {
      pendingWrites = 0
      return
    }
    options.persistence.save(JSON.stringify(snapshot))
    dirty = false
    pendingWrites = 0
  }

  function mutateArtifact(id: string): MemoryV4FeedbackArtifact | undefined {
    return snapshot.artifacts.find(artifact => artifact.id === id.trim())
  }

  return {
    create(dataset) {
      const gate = evaluateMemoryV4FeedbackCalibrationGate(dataset)
      if (gate.decision !== 'eligible-for-offline-fit')
        throw new Error(`V4 feedback calibration artifact is not eligible: ${gate.decision}`)
      const calibration = fitMemoryV4InternalFeedbackCalibration(dataset, gate)
      const createdAt = timestamp(now(), 'createdAt')
      const artifact: MemoryV4FeedbackArtifact = {
        id: sha256(`artifact\0${dataset.datasetFingerprint}\0${createdAt}`),
        version: MEMORY_V4_FEEDBACK_ARTIFACT_VERSION,
        artifactFingerprint: '',
        state: 'draft',
        createdAt,
        dataset: clone(dataset),
        gate: clone(gate),
        calibration: clone(calibration),
        automaticActivation: false,
        authoritativeAnswerSource: 'v3',
      }
      artifact.artifactFingerprint = fingerprintArtifact(artifact)
      snapshot.artifacts.push(artifact)
      if (snapshot.artifacts.length > maxArtifacts)
        snapshot.artifacts.splice(0, snapshot.artifacts.length - maxArtifacts)
      snapshot.updatedAt = Math.max(snapshot.updatedAt, createdAt)
      scheduleFlush()
      return clone(artifact)
    },
    approve(artifactId, input) {
      const artifact = mutateArtifact(artifactId)
      if (!artifact)
        return { ok: false, reason: 'unknown-artifact' }
      if (artifact.state !== 'draft')
        return { ok: false, reason: 'invalid-state' }
      if (!allChecklistItemsAccepted(input.checklist))
        return { ok: false, reason: 'incomplete-checklist' }
      const reviewer = input.reviewer.trim().slice(0, 120)
      if (!reviewer)
        return { ok: false, reason: 'missing-reviewer' }
      const approvedAt = timestamp(now(), 'approvedAt')
      artifact.state = 'approved'
      artifact.approval = {
        reviewer,
        approvedAt,
        checklistVersion: MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION,
        ...(input.note?.trim() ? { noteHash: sha256(input.note.trim()) } : {}),
      }
      snapshot.updatedAt = Math.max(snapshot.updatedAt, approvedAt)
      scheduleFlush()
      return { ok: true, artifact: summarize(artifact) }
    },
    revoke(artifactId, reasonInput) {
      const artifact = mutateArtifact(artifactId)
      if (!artifact)
        return { ok: false, reason: 'unknown-artifact' }
      if (artifact.state === 'revoked')
        return { ok: false, reason: 'invalid-state' }
      const reason = reasonInput.trim()
      if (!reason)
        return { ok: false, reason: 'missing-reason' }
      const revokedAt = timestamp(now(), 'revokedAt')
      artifact.state = 'revoked'
      artifact.revokedAt = revokedAt
      artifact.revokeReasonHash = sha256(reason)
      snapshot.updatedAt = Math.max(snapshot.updatedAt, revokedAt)
      scheduleFlush()
      return { ok: true, artifact: summarize(artifact) }
    },
    list: () => snapshot.artifacts.map(summarize).reverse(),
    status: () => buildStatus(
      snapshot,
      options.persistence?.storagePath,
      options.encrypted === true && options.persistence !== undefined,
      pendingWrites,
    ),
    flush,
    clear() {
      snapshot = emptySnapshot(timestamp(now(), 'createdAt'))
      scheduleFlush()
      flushSafely()
    },
  }
}

function fingerprintArtifact(artifact: MemoryV4FeedbackArtifact): string {
  return sha256(stableStringify({
    version: artifact.version,
    id: artifact.id,
    createdAt: artifact.createdAt,
    dataset: artifact.dataset,
    gate: artifact.gate,
    calibration: artifact.calibration,
    automaticActivation: artifact.automaticActivation,
    authoritativeAnswerSource: artifact.authoritativeAnswerSource,
  }))
}

function parseSnapshot(payload: string): MemoryV4FeedbackArtifactSnapshot {
  let value: unknown
  try {
    value = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse V4 feedback artifact snapshot: ${errorMessage(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('V4 feedback artifact snapshot is invalid')
  const source = value as Partial<MemoryV4FeedbackArtifactSnapshot>
  if (source.schemaVersion !== MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION || !Array.isArray(source.artifacts))
    throw new Error('Unsupported V4 feedback artifact schema')
  const snapshot: MemoryV4FeedbackArtifactSnapshot = {
    schemaVersion: MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION,
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    artifacts: source.artifacts.map(parseArtifact),
  }
  return snapshot
}

function parseArtifact(value: unknown): MemoryV4FeedbackArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('V4 feedback artifact is invalid')
  const artifact = value as MemoryV4FeedbackArtifact
  if (artifact.version !== MEMORY_V4_FEEDBACK_ARTIFACT_VERSION
    || !isHash(artifact.id)
    || !isHash(artifact.artifactFingerprint)
    || !['draft', 'approved', 'revoked'].includes(artifact.state)
    || artifact.automaticActivation !== false
    || artifact.authoritativeAnswerSource !== 'v3'
    || !artifact.dataset || !artifact.gate || !artifact.calibration)
    throw new Error('V4 feedback artifact fields are invalid')
  timestamp(artifact.createdAt, 'artifact createdAt')
  if (artifact.dataset.datasetFingerprint !== artifact.gate.datasetFingerprint
    || artifact.dataset.datasetVersion !== artifact.gate.datasetVersion)
    throw new Error('V4 feedback artifact dataset and gate do not match')
  if (artifact.gate.decision !== 'eligible-for-offline-fit')
    throw new Error('V4 feedback artifact contains an ineligible gate')
  if (fingerprintArtifact(artifact) !== artifact.artifactFingerprint)
    throw new Error('V4 feedback artifact integrity check failed')
  if (artifact.state === 'approved') {
    if (!artifact.approval || artifact.approval.checklistVersion !== MEMORY_V4_FEEDBACK_ARTIFACT_CHECKLIST_VERSION)
      throw new Error('V4 feedback artifact approval is invalid')
    timestamp(artifact.approval.approvedAt, 'approvedAt')
    if (!artifact.approval.reviewer?.trim())
      throw new Error('V4 feedback artifact reviewer is missing')
  }
  if (artifact.state === 'revoked') {
    timestamp(artifact.revokedAt, 'revokedAt')
    if (!isHash(artifact.revokeReasonHash))
      throw new Error('V4 feedback artifact revocation is invalid')
  }
  return clone(artifact)
}

function buildStatus(
  snapshot: MemoryV4FeedbackArtifactSnapshot,
  storagePath: string | undefined,
  encrypted: boolean,
  pendingWrites: number,
): MemoryV4FeedbackArtifactStatus {
  const current = [...snapshot.artifacts].reverse().find(artifact => artifact.state !== 'revoked')
  return {
    version: MEMORY_V4_FEEDBACK_ARTIFACT_VERSION,
    ...(storagePath ? { storagePath } : {}),
    encrypted,
    retainedArtifacts: snapshot.artifacts.length,
    drafts: snapshot.artifacts.filter(artifact => artifact.state === 'draft').length,
    approved: snapshot.artifacts.filter(artifact => artifact.state === 'approved').length,
    revoked: snapshot.artifacts.filter(artifact => artifact.state === 'revoked').length,
    pendingWrites,
    ...(current ? { current: summarize(current) } : {}),
  }
}

function summarize(artifact: MemoryV4FeedbackArtifact): MemoryV4FeedbackArtifactSummary {
  return {
    id: artifact.id,
    artifactFingerprint: artifact.artifactFingerprint,
    state: artifact.state,
    createdAt: artifact.createdAt,
    datasetVersion: artifact.dataset.datasetVersion,
    datasetFingerprint: artifact.dataset.datasetFingerprint,
    calibrationVersion: artifact.dataset.calibrationVersion,
    calibrationSamples: artifact.dataset.calibrationStats.samples,
    validationSamples: artifact.dataset.validationStats.samples,
    ...(artifact.approval ? { approvedAt: artifact.approval.approvedAt } : {}),
    ...(artifact.revokedAt ? { revokedAt: artifact.revokedAt } : {}),
    automaticActivation: false,
    authoritativeAnswerSource: 'v3',
  }
}

function allChecklistItemsAccepted(value: MemoryV4FeedbackArtifactChecklist): boolean {
  return value?.labelsReviewed === true
    && value.privacyReviewed === true
    && value.splitLocked === true
    && value.metricsAccepted === true
}

function emptySnapshot(now: number): MemoryV4FeedbackArtifactSnapshot {
  return {
    schemaVersion: MEMORY_V4_FEEDBACK_ARTIFACT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    artifacts: [],
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`V4 feedback artifact ${name} is invalid`)
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : minimum
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
