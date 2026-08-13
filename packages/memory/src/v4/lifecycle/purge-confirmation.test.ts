import { describe, expect, it } from 'vitest'
import { createMemoryPurgeConfirmationGate } from './purge-confirmation'

describe('Memory purge confirmation gate', () => {
  it('requires the matching id, token and explicit phrase', () => {
    let counter = 0
    const gate = createMemoryPurgeConfirmationGate({ createToken: () => `token-${++counter}` })
    const first = gate.prepare('memory-1')
    expect(gate.consume('memory-2', first.token, first.phrase)).toBe(false)
    expect(gate.consume('memory-1', first.token, '普通删除')).toBe(false)

    const second = gate.prepare('memory-1')
    expect(gate.consume('memory-1', 'wrong-token', second.phrase)).toBe(false)
    const third = gate.prepare('memory-1')
    expect(gate.consume('memory-1', third.token, third.phrase)).toBe(true)
  })

  it('expires challenges and consumes successful tokens only once', () => {
    let now = 1_000
    const gate = createMemoryPurgeConfirmationGate({
      now: () => now,
      ttlMilliseconds: 50,
      createToken: () => 'one-time-token',
    })
    const expired = gate.prepare('memory-1')
    now = expired.expiresAt + 1
    expect(gate.consume('memory-1', expired.token, expired.phrase)).toBe(false)

    const active = gate.prepare('memory-1')
    expect(gate.consume('memory-1', active.token, active.phrase)).toBe(true)
    expect(gate.consume('memory-1', active.token, active.phrase)).toBe(false)
  })

  it('replaces older challenges for the same memory and can clear all pending confirmations', () => {
    let counter = 0
    const gate = createMemoryPurgeConfirmationGate({ createToken: () => `token-${++counter}` })
    const old = gate.prepare('memory-1')
    const latest = gate.prepare('memory-1')
    expect(gate.consume('memory-1', old.token, old.phrase)).toBe(false)
    const afterFailedAttempt = gate.prepare('memory-1')
    gate.clear()
    expect(gate.consume('memory-1', afterFailedAttempt.token, afterFailedAttempt.phrase)).toBe(false)
    expect(latest.token).not.toBe(old.token)
  })
})
