import type { TextToSpeechPort } from '@deskpet/contracts'
import OpenAI from 'openai'

/**
 * OpenAI TTS synthesis implementing TextToSpeechPort.
 */
export interface OpenAITTSOptions {
  apiKey: string
  baseURL?: string
  model?: string
  voice?: string
  format?: string
}

export function createOpenAITTS(options: OpenAITTSOptions): TextToSpeechPort {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })

  return {
    async synthesize(text, opts = {}): Promise<ArrayBuffer> {
      const mp3 = await client.audio.speech.create({
        model: options.model ?? 'tts-1',
        voice: (opts.voice ?? options.voice ?? 'alloy') as OpenAI.Audio.Speech.SpeechCreateParams['voice'],
        input: text,
        response_format: (opts.format ?? options.format ?? 'mp3') as OpenAI.Audio.Speech.SpeechCreateParams['response_format'],
      })

      return mp3.arrayBuffer()
    },
  }
}