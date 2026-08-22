import { describe, expect, it } from 'vitest'
import { decomposeQuery, planMemoryQuery } from './memory-query-planner'

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

  it('adds a correction route for correction-cue queries', () => {
    const plan = planMemoryQuery('我不是说过我的手机号换了吗')
    expect(plan.routes).toContain('correction')
    expect(plan.reasonCodes).toContain('correction-cue')
  })

  it('adds an episode route for conversation-recall cues only', () => {
    const plan = planMemoryQuery('我们上次聊过的咖啡偏好是什么')
    expect(plan.routes).toContain('episode')
    expect(plan.reasonCodes).toContain('episode-cue')
    expect(planMemoryQuery('我的咖啡偏好是什么').routes).not.toContain('episode')
    expect(planMemoryQuery('In our last conversation we discussed coffee').routes).toContain('episode')
  })

  it('propagates a parsed time window into the plan', () => {
    const plan = planMemoryQuery('2023年到2025年我在哪里工作')
    expect(plan.validBetween).toEqual({ from: Date.UTC(2023, 0, 1), to: Date.UTC(2026, 0, 1) })
    expect(plan.routes).toContain('temporal')
  })

  it('decomposes multi-fact queries and keeps single-fact queries intact', () => {
    expect(decomposeQuery('我的生日是什么时候以及我最喜欢的颜色是什么')).toEqual([
      '我的生日是什么时候',
      '我最喜欢的颜色是什么',
    ])
    expect(decomposeQuery('我住在哪里')).toEqual([])
  })
})
