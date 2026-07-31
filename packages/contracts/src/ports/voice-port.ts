/**
 * Voice interaction boundary.
 *
 * Split into transcription (speech-to-text) and synthesis (text-to-speech)
 * so they can be implemented and swapped independently.
 */

export interface SpeechToTextPort {
  /** Transcribe an audio buffer into text. */
  transcribe: (audio: ArrayBuffer, mimeType?: string) => Promise<string>
}

export interface TextToSpeechPort {
  /** Synthesize speech audio from text. */
  synthesize: (text: string, opts?: { voice?: string; format?: string }) => Promise<ArrayBuffer>
}

/** Convenience aggregate implementing both voice directions. */
export interface AgentVoicePort extends SpeechToTextPort, TextToSpeechPort {}
