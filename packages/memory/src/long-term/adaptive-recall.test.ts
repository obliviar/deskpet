import type { MemoryFragment } from '@deskpet/contracts'
import { describe, expect, it } from 'vitest'
import type { AdaptiveRankedMemory } from './adaptive-recall'
import { isBroadPersonalMemoryQuery, selectAdaptiveRecall } from './adaptive-recall'

describe('adaptive memory recall selection', () => {
  it('recognizes broad personal-memory intent without matching ordinary summaries', () => {
    expect(isBroadPersonalMemoryQuery('总结你记得的关于我的信息')).toBe(true)
    expect(isBroadPersonalMemoryQuery('你还记得我哪些事情？')).toBe(true)
    expect(isBroadPersonalMemoryQuery('Summarize what you remember about me')).toBe(true)
    expect(isBroadPersonalMemoryQuery('总结这篇文章')).toBe(false)
    expect(isBroadPersonalMemoryQuery('总结量子纠缠的历史')).toBe(false)
  })
  it('stops after a single strong fact satisfies a narrow semantic concept', () => {
    const candidates = [
      ranked('name', '用户姓名/名字：小秦', 0.92),
      ranked('project', '用户当前项目：DeskPet', 0.84),
      ranked('drink', '用户喜欢乌龙茶', 0.81),
    ]

    const result = selectAdaptiveRecall('我叫什么名字？', candidates)
    expect(result.selectedMemoryIds).toEqual(['name'])
    expect(result.evaluatedMemoryIds).toEqual(['name', 'project', 'drink'])
    expect(result.stopReason).toBe('coverage-satisfied')
  })

  it('continues into later batches for broad summaries and stops on marginal gain', () => {
    const candidates = [
      ranked('drink', '用户喜欢乌龙茶', 0.91),
      ranked('food', '用户不喜欢香菜', 0.88),
      ranked('theme', '用户界面偏好：深色主题', 0.85),
      ranked('reply', '用户回答偏好：简洁', 0.82),
      ranked('book', '用户喜欢的书：三体', 0.75),
      ranked('noise-a', '无关的随机记录甲', 0.60, 0.1),
      ranked('noise-b', '无关的随机记录乙', 0.58, 0.1),
      ranked('noise-c', '无关的随机记录丙', 0.56, 0.1),
    ]

    const result = selectAdaptiveRecall('总结我的所有偏好', candidates, {
      initialBatchSize: 4,
      continuationBatchSize: 4,
      maxBatches: 3,
    })
    expect(result.selectedMemoryIds).toEqual(['drink', 'food', 'theme', 'reply', 'book'])
    expect(result.evaluatedMemoryIds).toHaveLength(8)
    expect(result.batchesEvaluated).toBe(2)
    expect(result.stopReason).toBe('candidates-exhausted')
  })

  it('covers multiple requested concepts without injecting other high-ranked fields', () => {
    const candidates = [
      ranked('name', '用户姓名/名字：小秦', 0.92),
      ranked('noise', '用户喜欢的书：三体', 0.91),
      ranked('project', '用户当前项目：DeskPet', 0.76),
      ranked('drink', '用户喜欢乌龙茶', 0.74),
    ]

    const result = selectAdaptiveRecall('我的名字和当前项目是什么？', candidates)
    expect(result.selectedMemoryIds).toEqual(['name', 'project'])
    expect(result.stopReason).toBe('coverage-satisfied')
  })

  it('enforces prompt character and injection-count budgets', () => {
    const contents = [
      `用户喜欢的饮品：${'乌龙茶'.repeat(60)}`,
      `用户不喜欢的食物：${'香菜'.repeat(60)}`,
      `用户界面偏好：${'深色主题'.repeat(50)}`,
      `用户回答偏好：${'简洁中文'.repeat(50)}`,
      `用户喜欢的书：${'三体小说'.repeat(50)}`,
      `用户音乐偏好：${'爵士音乐'.repeat(50)}`,
      `用户喜欢的颜色：${'藏青颜色'.repeat(50)}`,
      `用户工作时间偏好：${'夜间工作'.repeat(50)}`,
    ]
    const candidates = contents.map((content, index) =>
      ranked(`memory-${index}`, content, 0.95 - index * 0.03))

    const byCharacters = selectAdaptiveRecall('总结我的所有偏好', candidates, {
      maxCharacters: 256,
      initialBatchSize: 4,
    })
    expect(byCharacters.selectedMemoryIds).toHaveLength(1)
    expect(byCharacters.stopReason).toBe('character-budget')

    const byCount = selectAdaptiveRecall('总结我的所有偏好', candidates, {
      maxInjected: 2,
      initialBatchSize: 4,
    })
    expect(byCount.selectedMemoryIds).toHaveLength(2)
    expect(byCount.stopReason).toBe('max-injected')
  })
})

function ranked(id: string, content: string, score: number, semanticScore = score): AdaptiveRankedMemory {
  const memory: MemoryFragment = { id, content, createdAt: 1, score }
  return { memory, score, semanticScore, lexicalScore: semanticScore }
}
