import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SEMANTIC_MEMORY_MODEL = 'Xenova/bge-small-zh-v1.5'
export const SEMANTIC_MEMORY_REVISION = 'fcecc3c5fef6becfa2b2bdda15c1c938857be534'

export interface SemanticModelProgress {
  status: 'idle' | 'loading' | 'downloading' | 'ready' | 'error'
  progress?: number
  file?: string
  error?: string
}

export function createSemanticMemoryService(
  cacheDir: string,
  onProgress?: (progress: SemanticModelProgress) => void,
) {
  const markerPath = join(cacheDir, 'bge-small-zh-v1.5.ready.json')
  let extractorPromise: Promise<any> | undefined

  function isInstalled(): boolean {
    return existsSync(markerPath)
  }

  async function getExtractor() {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        onProgress?.({ status: 'loading' })
        mkdirSync(cacheDir, { recursive: true })
        const transformers = await import('@huggingface/transformers')
        transformers.env.cacheDir = cacheDir
        transformers.env.allowRemoteModels = true
        const extractor = await transformers.pipeline('feature-extraction', SEMANTIC_MEMORY_MODEL, {
          revision: SEMANTIC_MEMORY_REVISION,
          dtype: 'q8',
          progress_callback: (event: any) => {
            if (event?.status === 'progress' || event?.status === 'download') {
              onProgress?.({
                status: 'downloading',
                progress: typeof event.progress === 'number' ? event.progress : undefined,
                file: typeof event.file === 'string' ? event.file : undefined,
              })
            }
          },
        })
        writeFileSync(markerPath, JSON.stringify({
          model: SEMANTIC_MEMORY_MODEL,
          revision: SEMANTIC_MEMORY_REVISION,
          installedAt: new Date().toISOString(),
        }, null, 2), 'utf-8')
        onProgress?.({ status: 'ready', progress: 100 })
        return extractor
      })().catch((error) => {
        extractorPromise = undefined
        onProgress?.({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        throw error
      })
    }
    return extractorPromise
  }

  async function embed(text: string): Promise<number[]> {
    const extractor = await getExtractor()
    const tensor = await extractor(text, { pooling: 'mean', normalize: true })
    const values = tensor.tolist() as unknown
    const vector = Array.isArray(values) && Array.isArray(values[0]) ? values[0] : values
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === 'number'))
      throw new Error('本地语义模型返回了无效向量。')
    return vector as number[]
  }

  return {
    cacheDir,
    markerPath,
    isInstalled,
    install: getExtractor,
    embed,
  }
}

export type SemanticMemoryService = ReturnType<typeof createSemanticMemoryService>
