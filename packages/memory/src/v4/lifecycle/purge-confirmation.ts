import { randomBytes, timingSafeEqual } from 'node:crypto'

export interface MemoryPurgeChallenge {
  token: string
  expiresAt: number
  phrase: string
}

export interface MemoryPurgeConfirmationGate {
  prepare: (memoryId: string) => MemoryPurgeChallenge
  consume: (memoryId: string, token: string, phrase: string) => boolean
  clear: () => void
}

export function createMemoryPurgeConfirmationGate(options: {
  now?: () => number
  ttlMilliseconds?: number
  phrase?: string
  createToken?: () => string
} = {}): MemoryPurgeConfirmationGate {
  const now = options.now ?? Date.now
  const ttl = Number.isFinite(options.ttlMilliseconds) && Number(options.ttlMilliseconds) > 0
    ? Number(options.ttlMilliseconds)
    : 60_000
  const requiredPhrase = options.phrase?.trim() || '彻底清除'
  const createToken = options.createToken ?? (() => randomBytes(24).toString('hex'))
  const challenges = new Map<string, { token: string; expiresAt: number }>()

  function discardExpired(timestamp: number): void {
    for (const [memoryId, challenge] of challenges) {
      if (challenge.expiresAt < timestamp)
        challenges.delete(memoryId)
    }
  }

  return {
    prepare(memoryId) {
      const normalizedId = memoryId.trim()
      if (!normalizedId)
        throw new Error('Memory purge confirmation requires a memory id')
      const token = createToken()
      if (!token)
        throw new Error('Memory purge confirmation token cannot be empty')
      const timestamp = now()
      discardExpired(timestamp)
      const expiresAt = timestamp + ttl
      challenges.set(normalizedId, { token, expiresAt })
      return { token, expiresAt, phrase: requiredPhrase }
    },
    consume(memoryId, token, phrase) {
      const timestamp = now()
      discardExpired(timestamp)
      const normalizedId = memoryId.trim()
      const challenge = challenges.get(normalizedId)
      // Every confirmation attempt is single-use, including a failed one.
      challenges.delete(normalizedId)
      if (!challenge || challenge.expiresAt < timestamp || phrase.trim() !== requiredPhrase)
        return false
      return constantTimeEqual(token, challenge.token)
    },
    clear: () => challenges.clear(),
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
