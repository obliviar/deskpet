/** Privacy-preserving local embedding used by default by the desktop app. */
export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1'

const DEFAULT_DIMENSIONS = 384

/**
 * Produce a deterministic feature-hashed vector from Latin words and Chinese
 * unigrams/bigrams. It is intentionally lightweight: good enough for a local
 * personal fact store while avoiding an extra remote API call.
 */
export function createLocalEmbedding(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []

  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    tokens.push(`w:${word}`)
    if (word.length >= 4) {
      for (let i = 0; i <= word.length - 3; i++)
        tokens.push(`g:${word.slice(i, i + 3)}`)
    }
  }

  const han = normalized.match(/[\u3400-\u9fff]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    tokens.push(`c:${han[i]}`)
    if (i + 1 < han.length)
      tokens.push(`b:${han[i]}${han[i + 1]}`)
  }

  const vector = Array.from<number>({ length: dimensions }).fill(0)
  for (const token of tokens) {
    const hash = fnv1a(token)
    const index = hash % dimensions
    const sign = (hash & 0x80000000) === 0 ? 1 : -1
    vector[index] = (vector[index] ?? 0) + sign
  }

  let norm = 0
  for (const value of vector)
    norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++)
      vector[i] = (vector[i] ?? 0) / norm
  }
  return vector
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
