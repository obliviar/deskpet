import type { SpeechToTextPort } from '@deskpet/contracts'
import OpenAI from 'openai'

/**
 * OpenAI Whisper transcription implementing SpeechToTextPort.
 *
 * Sends raw audio buffers to the OpenAI /v1/audio/transcriptions endpoint.
 */
export interface OpenAISTTOptions {
  apiKey: string
  baseURL?: string
  model?: string
}

export function createOpenAISTT(options: OpenAISTTOptions): SpeechToTextPort {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })

  return {
    async transcribe(audio, mimeType = 'audio/webm'): Promise<string> {
      const file = new File([audio], 'input.audio', { type: mimeType })
      const res = await client.audio.transcriptions.create({
        file,
        model: options.model ?? 'whisper-1',
        response_format: 'text',
      })
      return res as unknown as string
    },
  }
}