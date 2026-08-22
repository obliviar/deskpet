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
      asOf: Date.UTC(2024, 6, 1, 12),
    })
  })

  it('parses Chinese, ISO and English month or day precision', () => {
    expect(planTemporalQuery('2025年3月我住在哪里')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2025, 2, 15, 12),
    })
    expect(planTemporalQuery('2025 年 3 月 2 日我住在哪里')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2025, 2, 2, 12),
    })
    expect(planTemporalQuery('Where did I live on 2025-03-02?')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2025, 2, 2, 12),
    })
    expect(planTemporalQuery('Where did I live in March 2025?')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2025, 2, 15, 12),
    })
    expect(planTemporalQuery('Where did I live in 2025 March?')).toEqual({
      mode: 'historical',
      asOf: Date.UTC(2025, 2, 15, 12),
    })
  })

  it('rejects invalid calendar dates instead of rolling into another month', () => {
    expect(planTemporalQuery('2025-02-31 我住在哪里')).toEqual({ mode: 'current' })
  })

  it('lets explicit caller policy override inferred intent', () => {
    expect(planTemporalQuery('我以前住在哪里', { temporalMode: 'all' })).toEqual({ mode: 'all' })
    expect(planTemporalQuery('现在的位置', {
      temporalMode: 'historical',
      asOf: Date.UTC(2023, 0, 1),
    })).toEqual({ mode: 'historical', asOf: Date.UTC(2023, 0, 1) })
  })

  it('parses explicit start-end ranges as half-open windows', () => {
    expect(planTemporalQuery('2023年到2025年我在哪里工作')).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2023, 0, 1), to: Date.UTC(2026, 0, 1) },
    })
    expect(planTemporalQuery('2025年3月到5月我住了哪里')).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2025, 2, 1), to: Date.UTC(2025, 5, 1) },
    })
    expect(planTemporalQuery('2025-01-10到2025-02-20的行程')).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2025, 0, 10), to: Date.UTC(2025, 1, 21) },
    })
  })

  it('parses relative time windows anchored at a deterministic asOf', () => {
    const asOf = Date.UTC(2025, 5, 15, 12)
    expect(planTemporalQuery('去年我在哪里工作', { asOf })).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
    })
    expect(planTemporalQuery('上个月我做了什么', { asOf })).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2025, 4, 1), to: Date.UTC(2025, 5, 1) },
    })
    expect(planTemporalQuery('最近30天我学到了什么', { asOf })).toEqual({
      mode: 'historical',
      validBetween: { from: asOf - 30 * 86_400_000, to: asOf },
    })
    expect(planTemporalQuery('过去两年我的项目变化', { asOf })).toEqual({
      mode: 'historical',
      validBetween: { from: asOf - Math.round(2 * 365.25 * 86_400_000), to: asOf },
    })
    // Chinese relative years anchor to calendar-year boundaries.
    expect(planTemporalQuery('前年我在哪里工作', { asOf })).toEqual({
      mode: 'historical',
      validBetween: { from: Date.UTC(2023, 0, 1), to: Date.UTC(2024, 0, 1) },
    })
    // Vague wording must not invent a window.
    expect(planTemporalQuery('过去几年我的项目变化', { asOf })).toEqual({ mode: 'historical', asOf })
  })
})
