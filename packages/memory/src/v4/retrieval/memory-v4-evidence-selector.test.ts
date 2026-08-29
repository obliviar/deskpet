import { describe, expect, it } from 'vitest'
import type { MemoryFactV4 } from '../domain/types'
import { selectMemoryV4Evidence } from './memory-v4-evidence-selector'

const NOW = 1_800_000_000_000

describe('Memory V4 minimal sufficient evidence selector', () => {
  it('returns one supported fact for a specific question instead of injecting same-key duplicates', () => {
    const selection = selectMemoryV4Evidence([
      candidate(fact('coffee-new', 'preference.drink', '用户现在喜欢喝手冲咖啡'), 0.96),
      candidate(fact('coffee-duplicate', 'preference.drink', '用户偏爱手冲咖啡'), 0.91),
      candidate(fact('tea-old', 'preference.drink', '用户以前喜欢喝乌龙茶'), 0.82),
    ], {
      query: '我喜欢喝什么？', intent: 'specific', concepts: ['preference.drink'],
      maxSelected: 8, maxCharacters: 2_400,
    })

    expect(selection.selected.map(item => item.fact.id)).toEqual(['coffee-new'])
    expect(selection.stopReason).toBe('coverage-satisfied')
  })

  it('covers every independently requested concept while rejecting an unrelated high-rank extra', () => {
    const selection = selectMemoryV4Evidence([
      candidate(fact('name', 'profile.name', '用户姓名是小秦'), 0.95),
      candidate(fact('drink', 'preference.drink', '用户喜欢喝咖啡'), 0.91),
      candidate(fact('project', 'project.current', '用户正在开发 DeskPet'), 0.90),
    ], {
      query: '我的姓名和饮品偏好分别是什么？', intent: 'multi-fact',
      concepts: ['profile.name', 'preference.drink'], maxSelected: 10, maxCharacters: 3_200,
    })

    expect(selection.selected.map(item => item.fact.id)).toEqual(['name', 'drink'])
    expect(selection.coveredRequirements).toEqual(['concept:preference.drink', 'concept:profile.name'])
    expect(selection.stopReason).toBe('coverage-satisfied')
  })

  it('uses marginal diversity for broad recall and drops redundant facts', () => {
    const selection = selectMemoryV4Evidence([
      candidate(fact('coffee', 'preference.drink', '用户喜欢喝手冲咖啡'), 0.95),
      candidate(fact('coffee-copy', 'preference.drink', '用户很喜欢喝手冲咖啡'), 0.93),
      candidate(fact('project', 'project.current', '用户正在开发 DeskPet 桌宠'), 0.88),
    ], {
      query: '总结关于我的全部信息', intent: 'enumerative', maxSelected: 10, maxCharacters: 4_000,
    })

    expect(selection.selected.map(item => item.fact.id)).toEqual(['coffee', 'project'])
    expect(selection.stopReason).toBe('marginal-gain')
  })
})

function candidate(value: MemoryFactV4, evidenceScore: number) {
  return { fact: value, evidenceScore }
}

function fact(id: string, memoryKey: string, canonicalText: string): MemoryFactV4 {
  return {
    id, scope: { ownerId: 'selector-user', agentId: 'deskpet' }, subjectId: 'user',
    predicate: memoryKey, object: canonicalText, objectType: 'string', normalizedValue: canonicalText,
    canonicalText, memoryKey, cardinality: 'single', polarity: 'positive', modality: 'asserted',
    status: 'active', recordedAt: NOW, updatedAt: NOW, evidenceLinkIds: [], extractionScore: 1,
    verificationScore: 1, evidenceScore: 1, utilityScore: 0.5, importance: 0.5, accessCount: 0,
    userConfirmed: false, verificationState: 'verified', supersedesFactIds: [], conflictsWithFactIds: [],
    sensitivity: 'normal', sharePolicy: 'allow-remote', origin: 'manual',
    extractorVersion: 'test', verifierVersion: 'test',
  }
}
