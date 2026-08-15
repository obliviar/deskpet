import {
  buildModelArtifactManifest,
  inspectModelArtifactManifest,
  type ModelArtifactIdentity,
  type ModelArtifactProbeRecord,
  verifyModelArtifactManifest,
  writeModelArtifactManifestAtomic,
} from '@deskpet/memory'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const SEMANTIC_MEMORY_MODEL = 'Xenova/bge-small-zh-v1.5'
export const SEMANTIC_MEMORY_REVISION = 'fcecc3c5fef6becfa2b2bdda15c1c938857be534'
export const SEMANTIC_MEMORY_FINGERPRINT = `${SEMANTIC_MEMORY_MODEL}@${SEMANTIC_MEMORY_REVISION}:q8:mean-normalized:v1`
export const SEMANTIC_MEMORY_EXPECTED_DIMENSION = 512
export const SEMANTIC_MEMORY_PROBE_VERSION = 'bge-small-zh-probe-v1'

const SEMANTIC_MEMORY_DTYPE = 'q8'
const SEMANTIC_MEMORY_RUNTIME = {
  transformers: '3.8.1',
  onnxRuntimeNode: '1.21.0',
}

export type SemanticModelIntegrityState = 'missing' | 'unverified' | 'verifying'
  | 'ready' | 'corrupt' | 'incompatible'

export interface SemanticModelProgress {
  status: 'idle' | 'loading' | 'downloading' | 'verifying' | 'indexing' | 'ready' | 'error'
  progress?: number
  file?: string
  error?: string
  total?: number
  ready?: number
  pending?: number
  integrity?: SemanticModelIntegrityState
  checkedFiles?: number
  checkedBytes?: number
}

interface SemanticExtractor {
  (text: string, options: { pooling: 'mean'; normalize: true }): Promise<{ tolist: () => unknown }>
  dispose?: () => Promise<void>
}

export function createSemanticMemoryService(
  cacheDir: string,
  onProgress?: (progress: SemanticModelProgress) => void,
) {
  const manifestPath = join(cacheDir, 'bge-small-zh-v1.5.manifest.json')
  const identity: ModelArtifactIdentity = {
    fingerprint: SEMANTIC_MEMORY_FINGERPRINT,
    model: SEMANTIC_MEMORY_MODEL,
    revision: SEMANTIC_MEMORY_REVISION,
    dtype: SEMANTIC_MEMORY_DTYPE,
    runtime: SEMANTIC_MEMORY_RUNTIME,
    expectedDimension: SEMANTIC_MEMORY_EXPECTED_DIMENSION,
  }
  let extractorPromise: Promise<SemanticExtractor> | undefined
  let installPromise: Promise<SemanticExtractor> | undefined
  let verificationPromise: Promise<boolean> | undefined
  let integrityError: string | undefined
  let integrityState: SemanticModelIntegrityState = initialIntegrityState()

  function isInstalled(): boolean {
    const inspection = inspectModelArtifactManifest(cacheDir, manifestPath, identity)
    if (inspection.state === 'present')
      return true
    if (integrityState !== 'verifying') {
      integrityState = inspection.state === 'missing' ? 'missing' : 'corrupt'
      integrityError = inspection.error
    }
    return false
  }

  function isVerified(): boolean {
    return integrityState === 'ready' && !!extractorPromise
  }

  function integrity() {
    return {
      state: integrityState,
      ...(integrityError ? { error: integrityError } : {}),
      manifestPath,
    }
  }

  async function verify(): Promise<boolean> {
    if (isVerified())
      return true
    if (verificationPromise)
      return verificationPromise
    verificationPromise = (async () => {
      integrityState = 'verifying'
      integrityError = undefined
      onProgress?.({ status: 'verifying', integrity: integrityState })
      const verification = await verifyModelArtifactManifest(cacheDir, manifestPath, identity)
      if (!verification.ok) {
        integrityState = verification.state === 'incompatible' ? 'incompatible'
          : verification.state === 'missing' ? 'missing'
            : 'corrupt'
        integrityError = verification.error
        throw new Error(verification.error ?? '本地语义模型完整性校验失败。')
      }
      const extractor = await loadExtractor(true)
      try {
        await runProbe(extractor)
      }
      catch (error) {
        await extractor.dispose?.().catch(() => undefined)
        throw error
      }
      extractorPromise = Promise.resolve(extractor)
      integrityState = 'ready'
      onProgress?.({
        status: 'ready',
        progress: 100,
        integrity: integrityState,
        checkedFiles: verification.checkedFiles,
        checkedBytes: verification.checkedBytes,
      })
      return true
    })().catch((error) => {
      extractorPromise = undefined
      if (integrityState === 'verifying')
        integrityState = 'corrupt'
      integrityError = errorMessage(error)
      onProgress?.({ status: 'error', integrity: integrityState, error: integrityError })
      return false
    }).finally(() => {
      verificationPromise = undefined
    })
    return verificationPromise
  }

  async function install(): Promise<SemanticExtractor> {
    if (installPromise)
      return installPromise
    installPromise = (async () => {
      mkdirSync(cacheDir, { recursive: true })
      integrityState = 'unverified'
      integrityError = undefined
      const downloadedFiles = new Set<string>()
      let onlineExtractor: SemanticExtractor | undefined
      let offlineExtractor: SemanticExtractor | undefined
      try {
        onlineExtractor = await loadExtractor(false, downloadedFiles)
        const probe = await runProbe(onlineExtractor)
        await onlineExtractor.dispose?.()
        onlineExtractor = undefined
        const manifest = await buildModelArtifactManifest(
          cacheDir,
          identity,
          [...downloadedFiles],
          probe,
        )

        // Prove that the cache can initialize from a cold pipeline with remote
        // access forbidden. A successful online pipeline alone is insufficient:
        // it can hide an incomplete cache behind already-loaded model state.
        offlineExtractor = await loadExtractor(true)
        await runProbe(offlineExtractor)
        writeModelArtifactManifestAtomic(manifestPath, manifest)
        extractorPromise = Promise.resolve(offlineExtractor)
        integrityState = 'ready'
        onProgress?.({
          status: 'ready',
          progress: 100,
          integrity: integrityState,
          checkedFiles: manifest.files.length,
          checkedBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        })
        return offlineExtractor
      }
      catch (error) {
        await onlineExtractor?.dispose?.().catch(() => undefined)
        await offlineExtractor?.dispose?.().catch(() => undefined)
        extractorPromise = undefined
        integrityState = 'corrupt'
        integrityError = errorMessage(error)
        onProgress?.({ status: 'error', integrity: integrityState, error: integrityError })
        throw error
      }
    })().finally(() => {
      installPromise = undefined
    })
    return installPromise
  }

  async function loadExtractor(localFilesOnly: boolean, observedFiles?: Set<string>): Promise<SemanticExtractor> {
    onProgress?.({
      status: localFilesOnly ? 'verifying' : 'loading',
      integrity: localFilesOnly ? 'verifying' : integrityState,
    })
    const transformers = await import('@huggingface/transformers')
    transformers.env.cacheDir = cacheDir
    if (!localFilesOnly)
      transformers.env.allowRemoteModels = true
    const extractor = await transformers.pipeline('feature-extraction', SEMANTIC_MEMORY_MODEL, {
      revision: SEMANTIC_MEMORY_REVISION,
      dtype: SEMANTIC_MEMORY_DTYPE,
      cache_dir: cacheDir,
      local_files_only: localFilesOnly,
      progress_callback: (event: any) => {
        if (event?.status === 'done' && typeof event.file === 'string')
          observedFiles?.add(cacheRelativePath(event.file))
        if (!localFilesOnly && (event?.status === 'progress' || event?.status === 'download')) {
          onProgress?.({
            status: 'downloading',
            progress: typeof event.progress === 'number' ? event.progress : undefined,
            file: typeof event.file === 'string' ? event.file : undefined,
            integrity: integrityState,
          })
        }
      },
    })
    return extractor as unknown as SemanticExtractor
  }

  async function getExtractor(): Promise<SemanticExtractor> {
    if (extractorPromise)
      return extractorPromise
    if (!isInstalled())
      throw new Error('请先下载并校验本地语义模型。')
    if (!await verify())
      throw new Error(integrityError ?? '本地语义模型完整性校验失败。')
    return extractorPromise!
  }

  async function embed(text: string): Promise<number[]> {
    const extractor = await getExtractor()
    return embedWithExtractor(extractor, text)
  }

  return {
    cacheDir,
    markerPath: manifestPath,
    manifestPath,
    isInstalled,
    isVerified,
    integrity,
    verify,
    install,
    embed,
  }

  function initialIntegrityState(): SemanticModelIntegrityState {
    const inspection = inspectModelArtifactManifest(cacheDir, manifestPath, identity)
    integrityError = inspection.error
    return inspection.state === 'present' ? 'unverified'
      : inspection.state === 'missing' ? 'missing'
        : 'corrupt'
  }
}

export type SemanticMemoryService = ReturnType<typeof createSemanticMemoryService>

async function runProbe(extractor: SemanticExtractor): Promise<ModelArtifactProbeRecord> {
  const first = await embedWithExtractor(extractor, '用户长期喜欢安静地阅读。')
  const second = await embedWithExtractor(extractor, '用户长期喜欢安静地阅读。')
  const similarity = cosineSimilarity(first, second)
  if (similarity < 0.9999)
    throw new Error(`本地语义模型重复探针不稳定：${similarity.toFixed(6)}`)
  return {
    version: SEMANTIC_MEMORY_PROBE_VERSION,
    dimension: first.length,
    normalized: true,
  }
}

async function embedWithExtractor(extractor: SemanticExtractor, text: string): Promise<number[]> {
  const tensor = await extractor(text, { pooling: 'mean', normalize: true })
  const values = tensor.tolist()
  const vector = Array.isArray(values) && Array.isArray(values[0]) ? values[0] : values
  if (!Array.isArray(vector)
    || vector.length !== SEMANTIC_MEMORY_EXPECTED_DIMENSION
    || !vector.every(value => typeof value === 'number' && Number.isFinite(value)))
    throw new Error(`本地语义模型返回了无效向量，预期维度 ${SEMANTIC_MEMORY_EXPECTED_DIMENSION}。`)
  const numeric = vector as number[]
  const norm = Math.sqrt(numeric.reduce((sum, value) => sum + value * value, 0))
  if (Math.abs(norm - 1) > 0.02)
    throw new Error(`本地语义模型返回了未归一化向量：${norm.toFixed(6)}`)
  return numeric
}

function cacheRelativePath(file: string): string {
  return join(SEMANTIC_MEMORY_MODEL, SEMANTIC_MEMORY_REVISION, file).replaceAll('\\', '/')
}

function cosineSimilarity(first: readonly number[], second: readonly number[]): number {
  let dot = 0
  let firstNorm = 0
  let secondNorm = 0
  for (let index = 0; index < first.length; index++) {
    dot += first[index]! * second[index]!
    firstNorm += first[index]! * first[index]!
    secondNorm += second[index]! * second[index]!
  }
  return dot / Math.max(Number.EPSILON, Math.sqrt(firstNorm) * Math.sqrt(secondNorm))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
