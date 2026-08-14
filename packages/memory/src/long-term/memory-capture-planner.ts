import { createHash } from 'node:crypto'
import type { MemoryCapture } from '@deskpet/contracts'

export const MEMORY_CAPTURE_PLANNER_VERSION = 'capture-segment-planner-v1'
export const DEFAULT_MEMORY_SEGMENT_CHARACTERS = 1800

export interface PlannedMemoryCapture {
  turn: MemoryCapture
  segmentIndex: number
  segmentCount: number
  captureId: string
}

/** Split oversized turns at sentence boundaries; no candidate-count truncation is applied. */
export function planMemoryCapture(
  turn: MemoryCapture,
  maximumCharacters = DEFAULT_MEMORY_SEGMENT_CHARACTERS,
): PlannedMemoryCapture[] {
  const original = turn.userMessage.slice(0, 100_000)
  const normalized = sanitize(original, 100_000)
  if (!normalized)
    return []
  const limit = Math.max(256, Math.min(6000, Math.floor(maximumCharacters)))
  const chunks = splitText(normalized, limit)
  const captureId = captureIdentifier(turn, normalized)
  return chunks.map((userMessage, segmentIndex) => ({
    segmentIndex,
    segmentCount: chunks.length,
    captureId,
    turn: {
      ...turn,
      userMessage,
      originalUserMessage: original,
      metadata: {
        ...turn.metadata,
        memoryCaptureId: captureId,
        memoryCaptureSegmentIndex: segmentIndex,
        memoryCaptureSegmentCount: chunks.length,
        memoryCapturePlannerVersion: MEMORY_CAPTURE_PLANNER_VERSION,
      },
    },
  }))
}

function splitText(value: string, limit: number): string[] {
  if (value.length <= limit)
    return [value]
  const sentences = value.split(/(?<=[。！？!?；;\n])/u).map(item => item.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences.length > 0 ? sentences : [value]) {
    for (const part of hardSplit(sentence, limit)) {
      if (current && current.length + 1 + part.length > limit) {
        chunks.push(current)
        current = ''
      }
      current = current ? `${current} ${part}` : part
    }
  }
  if (current)
    chunks.push(current)
  return chunks
}

function hardSplit(value: string, limit: number): string[] {
  if (value.length <= limit)
    return [value]
  const parts: string[] = []
  for (let offset = 0; offset < value.length; offset += limit)
    parts.push(value.slice(offset, offset + limit))
  return parts
}

function captureIdentifier(turn: MemoryCapture, original: string): string {
  const sourceIds = Array.isArray(turn.metadata?.sourceMessageIds)
    ? turn.metadata.sourceMessageIds.filter(value => typeof value === 'string').join('\u0000')
    : ''
  return createHash('sha256').update(`${sourceIds}\u0000${original}`, 'utf-8').digest('hex')
}

function sanitize(value: string, limit: number): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit)
}
