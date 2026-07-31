/**
 * Audio stream helpers.
 *
 * For Node environments without a real audio output, this provides a stubbed
 * player that saves to a WAV file. Swap for actual playback in browser/desktop.
 */

export async function playAudioBuffer(buffer: ArrayBuffer, format = 'mp3') {
  const { writeFileSync } = await import('node:fs')
  const { randomUUID } = await import('node:crypto')
  const filename = `voice-output-${randomUUID()}.${format}`
  writeFileSync(filename, Buffer.from(buffer))
  console.log(`[deskpet] voice output saved to ${filename}`)
  return filename
}

/**
 * Streams audio chunks to a writable destination.
 */
export function createAudioStreamSink(onData: (chunk: ArrayBuffer) => void) {
  return {
    write(chunk: ArrayBuffer) {
      onData(chunk)
    },
  }
}