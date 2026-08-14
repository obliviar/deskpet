import { describe, expect, it } from 'vitest'
import { planMemoryCapture } from './memory-capture-planner'

describe('memory capture planner', () => {
  it('segments long input without losing content and creates stable checkpoint metadata', () => {
    const source = Array.from({ length: 30 }, (_, index) => `第${index}条事实是内容${index}。`).join('')
    const first = planMemoryCapture({
      userMessage: source, assistantMessage: '', metadata: { sourceMessageIds: ['m-long'] },
    }, 256)
    const second = planMemoryCapture({
      userMessage: source, assistantMessage: '', metadata: { sourceMessageIds: ['m-long'] },
    }, 256)
    expect(first.length).toBeGreaterThan(1)
    expect(first.map(item => item.turn.userMessage).join('').replace(/\s/gu, '')).toBe(source.normalize('NFKC'))
    expect(first[0]?.turn.originalUserMessage).toBe(source)
    expect(first[0]?.turn.metadata).not.toHaveProperty('originalUserMessage')
    expect(first.map(item => item.captureId)).toEqual(first.map(() => second[0]!.captureId))
    expect(first.at(-1)?.turn.metadata).toMatchObject({
      memoryCaptureSegmentIndex: first.length - 1,
      memoryCaptureSegmentCount: first.length,
      memoryCapturePlannerVersion: 'capture-segment-planner-v1',
    })
  })
})
