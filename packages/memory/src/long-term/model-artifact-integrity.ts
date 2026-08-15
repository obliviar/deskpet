import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export const MODEL_ARTIFACT_MANIFEST_VERSION = 1

export interface ModelArtifactIdentity {
  fingerprint: string
  model: string
  revision: string
  dtype: string
  runtime: Record<string, string>
  expectedDimension: number
}

export interface ModelArtifactFile {
  path: string
  size: number
  sha256: string
}

export interface ModelArtifactProbeRecord {
  version: string
  dimension: number
  normalized: boolean
}

export interface ModelArtifactManifest extends ModelArtifactIdentity {
  version: typeof MODEL_ARTIFACT_MANIFEST_VERSION
  files: ModelArtifactFile[]
  probe: ModelArtifactProbeRecord
  installedAt: string
  verifiedAt: string
}

export interface ModelArtifactInspection {
  state: 'missing' | 'invalid' | 'present'
  manifest?: ModelArtifactManifest
  error?: string
}

export interface ModelArtifactVerification {
  ok: boolean
  state: 'ready' | 'missing' | 'corrupt' | 'incompatible'
  manifest?: ModelArtifactManifest
  error?: string
  checkedFiles: number
  checkedBytes: number
}

export async function buildModelArtifactManifest(
  root: string,
  identity: ModelArtifactIdentity,
  relativePaths: readonly string[],
  probe: ModelArtifactProbeRecord,
  now = new Date(),
): Promise<ModelArtifactManifest> {
  assertIdentity(identity)
  const files: ModelArtifactFile[] = []
  for (const path of [...new Set(relativePaths)].sort()) {
    const absolutePath = safeArtifactPath(root, path)
    assertRegularArtifact(absolutePath)
    const stats = statSync(absolutePath)
    files.push({ path: portableRelativePath(path), size: stats.size, sha256: await sha256File(absolutePath) })
  }
  if (files.length === 0)
    throw new Error('Model artifact manifest cannot be empty')
  const timestamp = now.toISOString()
  return {
    version: MODEL_ARTIFACT_MANIFEST_VERSION,
    ...identity,
    runtime: { ...identity.runtime },
    files,
    probe: { ...probe },
    installedAt: timestamp,
    verifiedAt: timestamp,
  }
}

export function inspectModelArtifactManifest(
  root: string,
  manifestPath: string,
  expected: ModelArtifactIdentity,
): ModelArtifactInspection {
  if (!existsSync(manifestPath))
    return { state: 'missing' }
  try {
    const manifest = parseManifest(readFileSync(manifestPath, 'utf-8'))
    assertCompatible(manifest, expected)
    for (const file of manifest.files) {
      const absolutePath = safeArtifactPath(root, file.path)
      assertRegularArtifact(absolutePath)
      if (statSync(absolutePath).size !== file.size)
        throw new Error(`Model artifact size mismatch: ${file.path}`)
    }
    return { state: 'present', manifest }
  }
  catch (error) {
    return { state: 'invalid', error: errorMessage(error) }
  }
}

export async function verifyModelArtifactManifest(
  root: string,
  manifestPath: string,
  expected: ModelArtifactIdentity,
): Promise<ModelArtifactVerification> {
  if (!existsSync(manifestPath))
    return { ok: false, state: 'missing', error: 'Model artifact manifest is missing', checkedFiles: 0, checkedBytes: 0 }
  let manifest: ModelArtifactManifest
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf-8'))
    assertCompatible(manifest, expected)
  }
  catch (error) {
    return { ok: false, state: 'incompatible', error: errorMessage(error), checkedFiles: 0, checkedBytes: 0 }
  }

  let checkedFiles = 0
  let checkedBytes = 0
  try {
    for (const file of manifest.files) {
      const absolutePath = safeArtifactPath(root, file.path)
      assertRegularArtifact(absolutePath)
      const stats = statSync(absolutePath)
      if (stats.size !== file.size)
        throw new Error(`Model artifact size mismatch: ${file.path}`)
      const digest = await sha256File(absolutePath)
      if (digest !== file.sha256)
        throw new Error(`Model artifact SHA-256 mismatch: ${file.path}`)
      checkedFiles += 1
      checkedBytes += stats.size
    }
  }
  catch (error) {
    return {
      ok: false,
      state: 'corrupt',
      manifest,
      error: errorMessage(error),
      checkedFiles,
      checkedBytes,
    }
  }
  return { ok: true, state: 'ready', manifest, checkedFiles, checkedBytes }
}

export function writeModelArtifactManifestAtomic(manifestPath: string, manifest: ModelArtifactManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true })
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf-8')
    renameSync(temporaryPath, manifestPath)
  }
  finally {
    if (existsSync(temporaryPath))
      rmSync(temporaryPath, { force: true })
  }
}

function parseManifest(payload: string): ModelArtifactManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  }
  catch (error) {
    throw new Error(`Unable to parse model artifact manifest: ${errorMessage(error)}`)
  }
  if (!isManifest(parsed))
    throw new Error('Model artifact manifest has an invalid schema')
  return {
    ...parsed,
    runtime: { ...parsed.runtime },
    files: parsed.files.map(file => ({ ...file })),
    probe: { ...parsed.probe },
  }
}

function assertCompatible(manifest: ModelArtifactManifest, expected: ModelArtifactIdentity): void {
  assertIdentity(expected)
  if (manifest.fingerprint !== expected.fingerprint
    || manifest.model !== expected.model
    || manifest.revision !== expected.revision
    || manifest.dtype !== expected.dtype
    || manifest.expectedDimension !== expected.expectedDimension)
    throw new Error('Model artifact manifest identity does not match this application')
  const expectedRuntime = Object.entries(expected.runtime).sort(([left], [right]) => left.localeCompare(right))
  const actualRuntime = Object.entries(manifest.runtime).sort(([left], [right]) => left.localeCompare(right))
  if (JSON.stringify(actualRuntime) !== JSON.stringify(expectedRuntime))
    throw new Error('Model artifact runtime is incompatible with this application')
  if (manifest.probe.dimension !== expected.expectedDimension)
    throw new Error('Model artifact probe dimension is incompatible with this application')
}

function assertIdentity(identity: ModelArtifactIdentity): void {
  if (!identity.fingerprint || !identity.model || !identity.revision || !identity.dtype)
    throw new Error('Model artifact identity is incomplete')
  if (!Number.isInteger(identity.expectedDimension) || identity.expectedDimension <= 0)
    throw new Error('Model artifact expected dimension is invalid')
}

function safeArtifactPath(root: string, candidate: string): string {
  if (!candidate || isAbsolute(candidate))
    throw new Error(`Unsafe model artifact path: ${candidate}`)
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(resolvedRoot, candidate)
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot))
    throw new Error(`Unsafe model artifact path: ${candidate}`)
  return resolvedCandidate
}

function assertRegularArtifact(path: string): void {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error(`Model artifact is not a regular file: ${path}`)
}

function portableRelativePath(path: string): string {
  return path.replaceAll('\\', '/')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolvePromise)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

function isManifest(value: unknown): value is ModelArtifactManifest {
  if (!value || typeof value !== 'object')
    return false
  const manifest = value as Partial<ModelArtifactManifest>
  return manifest.version === MODEL_ARTIFACT_MANIFEST_VERSION
    && typeof manifest.fingerprint === 'string'
    && typeof manifest.model === 'string'
    && typeof manifest.revision === 'string'
    && typeof manifest.dtype === 'string'
    && !!manifest.runtime
    && typeof manifest.runtime === 'object'
    && Object.entries(manifest.runtime).every(([key, entry]) => !!key && typeof entry === 'string')
    && Number.isInteger(manifest.expectedDimension)
    && Number(manifest.expectedDimension) > 0
    && Array.isArray(manifest.files)
    && manifest.files.length > 0
    && manifest.files.every(file => !!file
      && typeof file.path === 'string'
      && Number.isInteger(file.size)
      && file.size >= 0
      && typeof file.sha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(file.sha256))
    && !!manifest.probe
    && typeof manifest.probe.version === 'string'
    && Number.isInteger(manifest.probe.dimension)
    && typeof manifest.probe.normalized === 'boolean'
    && typeof manifest.installedAt === 'string'
    && typeof manifest.verifiedAt === 'string'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
