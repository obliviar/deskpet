import { describe, expect, it } from 'vitest'
import { planMemoryQuery } from './memory-query-planner'

describe('memory query planner', () => {
  it('uses a small bounded plan for a specific personal query', () => {
    const plan = planMemoryQuery('我现在住在哪里')
    expect(plan).toMatchObject({
      intent: 'specific',
      requiresMemory: true,
      temporalMode: 'current',
      candidateBudget: 24,
      routes: ['lexical', 'semantic', 'structured'],
    })
  })

  it('expands the candidate pool for broad and timeline queries without expanding injection equally', () => {
    const broad = planMemoryQuery('总结你记得的关于我的所有信息')
    const timeline = planMemoryQuery('回顾过去几年我的项目变化')
    expect(broad.intent).toBe('enumerative')
    expect(broad.candidateBudget).toBe(80)
    expect(broad.selection.maxInjected).toBe(10)
    expect(timeline.intent).toBe('timeline')
    expect(timeline.routes).toContain('temporal')
    expect(timeline.candidateBudget).toBeGreaterThan(24)
  })

  it('adds a temporal route for point-in-time questions', () => {
    const plan = planMemoryQuery('2024 年我住在哪里')
    expect(plan.intent).toBe('temporal')
    expect(plan.temporalMode).toBe('historical')
    expect(plan.asOf).toBeTypeOf('number')
    expect(plan.routes).toContain('temporal')
  })

  it('conservatively bypasses personal memory for clear external knowledge', () => {
    expect(planMemoryQuery('量子纠缠如何定义')).toMatchObject({
      intent: 'external', requiresMemory: false, routes: [], candidateBudget: 0,
    })
    expect(planMemoryQuery('为什么我不喜欢咖啡').requiresMemory).toBe(true)
  })

  it('honours explicit temporal options', () => {
    const plan = planMemoryQuery('项目是什么', { temporalMode: 'all' })
    expect(plan.temporalMode).toBe('all')
    expect(plan.intent).toBe('temporal')
  })
})
