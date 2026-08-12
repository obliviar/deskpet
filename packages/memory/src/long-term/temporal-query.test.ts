import { describe, expect, it } from 'vitest'
import { planTemporalQuery } from './temporal-query'

describe('temporal query planner', () => {
  it('detects current and historical intent in Chinese and English', () => {
    expect(planTemporalQuery('我现在住在哪里')).toEqual({ mode: 'current' })
    expect(planTemporalQuery('我以前住在哪里')).toEqual({ mode: 'historical' })
    expect(planTemporalQuery('Where did I live previously?')).toEqual({ mode: 'historical' })
  })

  it('turns a named year into a deterministic point-in-time query', () => {
    expect(planTemporalQuery('2024 年我住在哪里')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2024, 6, 1),
    })
  })

  it('lets explicit caller policy override inferred intent', () => {
    expect(planTemporalQuery('我以前住在哪里', { temporalMode: 'all' })).toEqual({ mode: 'all' })
    expect(planTemporalQuery('现在的位置', {
      temporalMode: 'historical',
      asOf: Date.UTC(2023, 0, 1),
    })).toEqual({ mode: 'historical', asOf: Date.UTC(2023, 0, 1) })
  })
})
