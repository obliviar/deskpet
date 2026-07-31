/**
 * Voice chat mode placeholder.
 *
 * For a full voice pipeline:
 * 1. Record mic input (node-record-lpcm16 or sox)
 * 2. VAD → detect speech segments
 * 3. STT → transcribe speech to text
 * 4. Agent runtime → process text
 * 5. TTS → synthesize response audio
 * 6. Play output audio
 *
 * This module provides the wiring; actual recording/playback depends on
 * the platform (web AudioContext, node speaker, etc.).
 */
import type { AgentRuntime } from '@deskpet/core'
import { createOpenAISTT, createOpenAITTS, createVAD, playAudioBuffer } from '@deskpet/voice'

export interface VoiceChatOptions {
  runtime: AgentRuntime
  sessionId: string
  apiKey: string
  voice?: string
}

export function createVoiceChat(options: VoiceChatOptions) {
  const { runtime, sessionId, apiKey, voice = 'alloy' } = options
  const stt = createOpenAISTT({ apiKey })
  const tts = createOpenAITTS({ apiKey, voice })
  const vad = createVAD()

  async function processVoiceAudio(audio: Float32Array): Promise<string> {
    // Convert Float32Array to WAV-like ArrayBuffer for the STT API
    const wavBuffer = float32ToWav(audio)
    const text = await stt.transcribe(wavBuffer)
    return text
  }

  async function speakResponse(text: string): Promise<void> {
    const audio = await tts.synthesize(text)
    await playAudioBuffer(audio)
  }

  return {
    vad,
    processVoiceAudio,
    speakResponse,
    runtime,
    sessionId,
  }
}

function float32ToWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  // WAV header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }

  return buffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i))
}