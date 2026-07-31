/**
 * Voice Activity Detection (VAD) abstraction.
 *
 * In a browser context this would use @ricky0123/vad-web; in Node this is a
 * simple energy-threshold fallback that can be swapped for a real VAD.
 */

export interface VADOptions {
  /** Energy threshold for speech detection (RMS). */
  threshold?: number
  /** Minimum silence duration in ms before firing onSilence. */
  silenceDuration?: number
  /** Cooldown after speech ends before re-triggering. */
  cooldown?: number
}

export interface VADCallbacks {
  onSpeechStart: () => void
  onSpeechEnd: (audio: Float32Array) => void
}

/**
 * Energy-based voice activity detector.
 *
 * Works with Float32Array PCM samples. For production use, swap this for
 * @ricky0123/vad-web or Silero VAD for much better accuracy.
 */
export function createVAD(options: VADOptions = {}) {
  const { threshold = 0.02, silenceDuration = 800, cooldown = 500 } = options

  let isSpeaking = false
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let cooldownActive = false
  let audioFrames: Float32Array[] = []

  function processFrame(frame: Float32Array, callbacks: VADCallbacks) {
    const rms = Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / frame.length)

    if (cooldownActive)
      return

    if (rms > threshold) {
      if (!isSpeaking) {
        isSpeaking = true
        callbacks.onSpeechStart()
      }
      audioFrames.push(frame)
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
    }
    else if (isSpeaking) {
      audioFrames.push(frame)
      if (!silenceTimer) {
        silenceTimer = setTimeout(() => {
          silenceTimer = null
          isSpeaking = false
          const combined = concatFrames(audioFrames)
          audioFrames = []
          callbacks.onSpeechEnd(combined)

          cooldownActive = true
          setTimeout(() => { cooldownActive = false }, cooldown)
        }, silenceDuration)
      }
    }
  }

  function concatFrames(frames: Float32Array[]): Float32Array {
    const totalLen = frames.reduce((s, f) => s + f.length, 0)
    const out = new Float32Array(totalLen)
    let offset = 0
    for (const f of frames) {
      out.set(f, offset)
      offset += f.length
    }
    return out
  }

  function reset() {
    isSpeaking = false
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
    audioFrames = []
  }

  return { processFrame, reset }
}