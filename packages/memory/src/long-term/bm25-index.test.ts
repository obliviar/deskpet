import { describe, expect, it } from 'vitest'
import { createMemoryBm25Index, tokenizeBm25 } from './bm25-index'

const scope = { ownerId: 'owner', agentId: 'deskpet' }

describe('independent BM25 candidate index', () => {
  it('matches the former brute-force BM25 scores without retokenizing documents at query time', () => {
    let tokenizations = 0
    const index = createMemoryBm25Index({
      tokenizer: (value) => {
        tokenizations += 1
        return tokenizeBm25(value)
      },
    })
    const contents = [
      '用户喜欢杭州的桂花拿铁',
      '用户在上海从事产品设计',
      '用户喜欢拿铁，也喜欢手冲咖啡',
    ]
    contents.forEach((content, position) => index.upsert({
      id: `memory-${position}`,
      content,
      scope,
      state: 'active',
    }))
    expect(tokenizations).toBe(contents.length)

    const hits = index.search('喜欢拿铁', { scope, limit: 10 })
    expect(tokenizations).toBe(contents.length + 1)
    const expected = bruteForceBm25('喜欢拿铁', contents)
      .map((score, position) => ({ id: `memory-${position}`, score }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    expect(hits.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (const [position, hit] of hits.entries())
      expect(hit.score).toBeCloseTo(expected[position]!.score, 12)
  })

  it('isolates owner, agent and optional session shards', () => {
    const index = createMemoryBm25Index()
    index.upsert({ id: 'global-sessionless', content: '用户喜欢咖啡', scope, state: 'active' })
    index.upsert({ id: 'session-a', content: '用户喜欢咖啡', scope: { ...scope, sessionId: 'a' }, state: 'active' })
    index.upsert({ id: 'session-b', content: '用户喜欢咖啡', scope: { ...scope, sessionId: 'b' }, state: 'active' })
    index.upsert({ id: 'other-owner', content: '用户喜欢咖啡', scope: { ownerId: 'other', agentId: 'deskpet' }, state: 'active' })

    expect(index.search('咖啡', { scope }).map(hit => hit.id).sort()).toEqual([
      'global-sessionless', 'session-a', 'session-b',
    ])
    expect(index.search('咖啡', { scope: { ...scope, sessionId: 'a' } }).map(hit => hit.id)).toEqual(['session-a'])
  })

  it('keeps superseded facts available only to historical retrieval', () => {
    const index = createMemoryBm25Index()
    index.upsert({ id: 'current', content: '当前住在南京', scope, state: 'active' })
    index.upsert({ id: 'former', content: '以前住在杭州', scope, state: 'historical' })

    expect(index.search('住在', { scope, mode: 'current' }).map(hit => hit.id)).toEqual(['current'])
    expect(index.search('住在', { scope, mode: 'historical' }).map(hit => hit.id).sort()).toEqual(['current', 'former'])
  })

  it('updates and removes postings without leaving stale candidates', () => {
    const index = createMemoryBm25Index()
    index.upsert({ id: 'fact', content: '用户喜欢咖啡', scope, state: 'active' })
    expect(index.search('咖啡', { scope })).toHaveLength(1)

    index.upsert({ id: 'fact', content: '用户喜欢绿茶', scope, state: 'active' })
    expect(index.search('咖啡', { scope })).toEqual([])
    expect(index.search('绿茶', { scope })[0]?.id).toBe('fact')
    expect(index.remove('fact')).toBe(true)
    expect(index.search('绿茶', { scope })).toEqual([])
    expect(index.stats().documents).toBe(0)
  })
})

function bruteForceBm25(query: string, documents: string[]): number[] {
  const queryTokens = [...new Set(tokenizeBm25(query))]
  const tokenized = documents.map(tokenizeBm25)
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, tokenized.length)
  const documentFrequency = new Map<string, number>()
  for (const tokens of tokenized) {
    for (const token of new Set(tokens))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  return tokenized.map((tokens) => {
    const frequency = new Map<string, number>()
    for (const token of tokens)
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const tf = frequency.get(token) ?? 0
      if (tf === 0)
        continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * tokens.length / Math.max(1, averageLength))))
    }
    return 1 - Math.exp(-score)
  })
}
