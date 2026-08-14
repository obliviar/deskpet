import { describe, expect, it } from 'vitest'
import { normalizeMemoryCandidate } from './memory-normalizer'

describe('memory candidate normalization', () => {
  it('canonicalizes aliases, values, polarity, modality, condition and cardinality', () => {
    const normalized = normalizeMemoryCandidate({
      content: '用户不喜欢：  香菜。 ',
      metadata: { memoryKey: 'preference.dislike', cardinality: 'multiple', condition: '点外卖时' },
    })
    expect(normalized.content).toBe('用户不喜欢： 香菜。')
    expect(normalized.metadata).toMatchObject({
      subjectId: 'owner:self',
      predicate: 'preference.dislike',
      normalizedValue: '香菜',
      polarity: 'negative',
      modality: 'asserted',
      condition: '点外卖时',
      cardinality: 'set',
      normalizerVersion: 'structured-normalizer-v1',
    })
    expect(normalized.metadata.entityAliases).toEqual(['香菜。', '香菜'])
  })

  it('forces known single-valued predicates and normalizes programming aliases', () => {
    expect(normalizeMemoryCandidate({
      content: '用户所在地：上海市', metadata: { memoryKey: 'location', cardinality: 'multiple' },
    }).metadata).toMatchObject({ predicate: 'profile.location', cardinality: 'single', normalizedValue: '上海' })
    expect(normalizeMemoryCandidate({
      content: '用户常用编程语言：TS', metadata: { memoryKey: 'profile.programming_language' },
    }).metadata.normalizedValue).toBe('typescript')
  })
})
