import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion } from './reciprocal-rank-fusion'

describe('reciprocal rank fusion', () => {
  it('promotes a document supported by multiple incompatible ranking routes', () => {
    const results = reciprocalRankFusion([
      { name: 'lexical', items: [{ id: 'a', item: 'A' }, { id: 'shared', item: 'S' }] },
      { name: 'semantic', items: [{ id: 'b', item: 'B' }, { id: 'shared', item: 'S' }] },
    ])
    expect(results[0]).toMatchObject({ id: 'shared', routes: ['lexical', 'semantic'] })
    expect(results[0]!.normalizedScore).toBe(1)
  })

  it('deduplicates repeated ids inside one route', () => {
    const results = reciprocalRankFusion([
      { name: 'lexical', items: [{ id: 'a', item: 'A' }, { id: 'a', item: 'A' }] },
    ], { rankConstant: 10 })
    expect(results).toHaveLength(1)
    expect(results[0]!.routeRanks.lexical).toBe(1)
  })

  it('uses deterministic ids to break exact ties', () => {
    const results = reciprocalRankFusion([
      { name: 'semantic', items: [{ id: 'b', item: 'B' }, { id: 'a', item: 'A' }] },
      { name: 'lexical', items: [{ id: 'a', item: 'A' }, { id: 'b', item: 'B' }] },
    ])
    expect(results.map(item => item.id)).toEqual(['a', 'b'])
  })
})
