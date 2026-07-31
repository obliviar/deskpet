import type { ChatMessage } from '@deskpet/contracts'

/**
 * Multimodal attachment helpers for OpenAI messages.
 */

export interface ImageAttachment {
  type: 'image'
  data: string
  mimeType: string
}

/**
 * Wraps a text message with optional image attachments into a multimodal content array.
 */
export function buildMultimodalContent(
  text: string,
  images?: ImageAttachment[],
): ChatMessage['content'] {
  if (!images || images.length === 0)
    return text

  const parts: ChatMessage['content'] = [{ type: 'text', text }]
  for (const img of images)
    parts.push({ type: 'image', data: img.data, mimeType: img.mimeType })

  return parts
}

/**
 * Reads a file from disk and encodes it as a base64 data URL for image attachments.
 */
export async function loadImageAttachment(filePath: string, mimeType = 'image/png'): Promise<ImageAttachment> {
  const { readFileSync } = await import('node:fs')
  const buffer = readFileSync(filePath)
  return {
    type: 'image',
    data: buffer.toString('base64'),
    mimeType,
  }
}