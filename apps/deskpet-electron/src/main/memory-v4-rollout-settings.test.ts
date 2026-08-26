import { describe, expect, it } from 'vitest'
import {
  checkMemoryV4RolloutTransition,
  normalizeMemoryV4RolloutStage,
} from './memory-v4-rollout-settings'

describe('Memory V4 rollout settings', () => {
  it('restores only non-production stages and fail-closes unknown values', () => {
    expect(normalizeMemoryV4RolloutStage('internal')).toBe('internal')
    expect(normalizeMemoryV4RolloutStage('percent-1')).toBe('shadow')
    expect(normalizeMemoryV4RolloutStage(undefined, { defaultStage: 'internal' })).toBe('internal')
  })

  it('gives an explicit environment override precedence over persisted state', () => {
    expect(normalizeMemoryV4RolloutStage('internal', { environmentOverride: 'shadow' })).toBe('shadow')
    expect(normalizeMemoryV4RolloutStage('shadow', { environmentOverride: 'internal' })).toBe('internal')
  })

  it('requires a healthy shadow store and isolated Worker before Internal', () => {
    expect(checkMemoryV4RolloutTransition({
      currentStage: 'shadow', requestedStage: 'internal', shadowAvailable: true, workerAvailable: false,
    })).toEqual({ ok: false, reason: 'runtime-unavailable' })
    expect(checkMemoryV4RolloutTransition({
      currentStage: 'shadow', requestedStage: 'internal', shadowAvailable: true, workerAvailable: true,
    })).toEqual({ ok: true, stage: 'internal' })
  })

  it('does not allow the UI to override an environment lock', () => {
    expect(checkMemoryV4RolloutTransition({
      currentStage: 'internal', requestedStage: 'shadow', environmentOverride: 'internal',
      shadowAvailable: true, workerAvailable: true,
    })).toEqual({ ok: false, reason: 'environment-locked' })
  })
})
