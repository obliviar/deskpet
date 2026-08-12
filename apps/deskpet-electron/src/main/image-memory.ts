import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { MemoryCandidate } from '@deskpet/memory'

export interface ImageMemoryAttachment {
  type: 'image'
  data: string
  mimeType: string
  id?: string
}

export interface ImageMemoryProgress {
  status: string
  progress?: number
}

const EXPLICIT_IMAGE_MEMORY = /(?:请|帮我)?(?:记住|保存|记下).{0,16}(?:图片|图像|截图|照片)|(?:图片|图像|截图|照片).{0,16}(?:记住|保存|记下)|\b(?:remember|save).{0,20}(?:image|picture|screenshot|photo)\b/i

export function isExplicitImageMemoryRequest(message: string): boolean {
  return EXPLICIT_IMAGE_MEMORY.test(message.normalize('NFKC'))
}

export function attachmentId(attachment: ImageMemoryAttachment): string {
  return attachment.id || createHash('sha256').update(attachment.mimeType).update(attachment.data).digest('hex')
}

export function createImageMemoryService(
  cachePath: string,
  onProgress?: (progress: ImageMemoryProgress) => void,
) {
  let workerPromise: Promise<Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>> | undefined

  async function getWorker() {
    if (!workerPromise) {
      mkdirSync(cachePath, { recursive: true })
      workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker(['chi_sim', 'eng'], 1, {
        cachePath,
        logger: (message) => onProgress?.({
          status: String(message.status || 'working'),
          progress: typeof message.progress === 'number' ? message.progress : undefined,
        }),
      })).catch((error) => {
        workerPromise = undefined
        throw error
      })
    }
    return workerPromise
  }

  async function extractCandidate(attachment: ImageMemoryAttachment): Promise<MemoryCandidate | undefined> {
    const worker = await getWorker()
    const image = Buffer.from(attachment.data, 'base64')
    const result = await worker.recognize(image)
    const text = result.data.text.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 2000)
    if (!text)
      return undefined
    return {
      content: `图片中的文字：${text}`,
      metadata: {
        kind: 'image',
        origin: 'image',
        importance: 0.75,
        confidence: 0.75,
        cardinality: 'multiple',
        sensitivity: 'private',
        sharePolicy: 'local-only',
        sourceAttachmentIds: [attachmentId(attachment)],
      },
    }
  }

  async function terminate(): Promise<void> {
    if (!workerPromise)
      return
    const worker = await workerPromise
    workerPromise = undefined
    await worker.terminate()
  }

  return { cachePath, extractCandidate, terminate }
}

export type ImageMemoryService = ReturnType<typeof createImageMemoryService>
