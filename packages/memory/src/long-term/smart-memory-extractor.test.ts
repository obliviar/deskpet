import { describe, expect, it } from 'vitest'
import { createSmartMemoryExtractor } from './smart-memory-extractor'

describe('smart memory extractor', () => {
  it('validates structured facts and keeps sensitive memory local', async () => {
    const extractor = createSmartMemoryExtractor({
      getConfig: () => ({ apiKey: 'test', model: 'test' }),
      complete: async () => JSON.stringify({ memories: [{
        content: '用户住在杭州', kind: 'identity', memoryKey: 'profile.location',
        cardinality: 'single', confidence: 0.91, importance: 0.8,
        sensitivity: 'private', sharePolicy: 'allow-remote',
      }] }),
    })
    const result = await extractor({ userMessage: '我住在杭州', assistantMessage: '知道了' })
    expect(result).toEqual([{
      content: '用户住在杭州',
      metadata: expect.objectContaining({
        memoryKey: 'profile.location', cardinality: 'single', sensitivity: 'private', sharePolicy: 'local-only',
      }),
    }])
  })

  it('falls back without storing provider output when extraction fails', async () => {
    const extractor = createSmartMemoryExtractor({
      getConfig: () => ({ apiKey: 'test', model: 'test' }),
      fallback: () => [{ content: '本地规则事实', metadata: { kind: 'explicit' } }],
      complete: async () => { throw new Error('offline') },
    })
    expect(await extractor({ userMessage: '记住一件事', assistantMessage: '' })).toEqual([
      { content: '本地规则事实', metadata: { kind: 'explicit' } },
    ])
  })

  it('upgrades private data even when the model labels it normal', async () => {
    const extractor = createSmartMemoryExtractor({
      getConfig: () => ({ apiKey: 'test', model: 'test' }),
      complete: async () => JSON.stringify({ memories: [{
        content: '用户手机号是13800138000',
        sensitivity: 'normal',
        sharePolicy: 'allow-remote',
      }] }),
    })

    expect((await extractor({ userMessage: '手机号是13800138000', assistantMessage: '' }))[0]?.metadata)
      .toMatchObject({ sensitivity: 'private', sharePolicy: 'local-only' })
  })
})
