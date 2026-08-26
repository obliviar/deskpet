import { describe, expect, it } from 'vitest'
import { createDenseVectorCandidateIndex } from './dense-vector-candidate-index'

describe('dense vector candidate index', () => {
  it('performs deterministic exact cosine search over normalized vectors', () => {
    const index = createDenseVectorCandidateIndex()
    index.upsert('exact', [1, 0, 0])
    index.upsert('near', [0.8, 0.6, 0])
    index.upsert('opposite', [-1, 0, 0])

    expect(index.search([1, 0, 0], { limit: 3, minScore: 0 })).toEqual([
      { id: 'exact', score: 1 },
      { id: 'near', score: expect.closeTo(0.8, 6) },
    ])
    expect(index.dimension()).toBe(3)
  })

  it('applies scope predicates before scoring and supports replacement/removal', () => {
    const index = createDenseVectorCandidateIndex()
    index.upsert('a', [1, 0])
    index.upsert('b', [0, 1])
    expect(index.search([1, 0], { allow: id => id === 'b' })).toEqual([{ id: 'b', score: 0 }])

    index.upsert('a', [0, 1])
    expect(index.search([0, 1], { limit: 1 })[0]).toEqual({ id: 'a', score: 1 })
    expect(index.remove('a')).toBe(true)
    expect(index.size()).toBe(1)
    index.clear()
    expect(index.dimension()).toBeUndefined()
  })

  it('rejects mixed dimensions, non-finite values and unnormalized vectors', () => {
    const index = createDenseVectorCandidateIndex()
    index.upsert('a', [1, 0])
    expect(() => index.upsert('bad-dimension', [1, 0, 0])).toThrow(/dimension mismatch/u)
    expect(() => index.upsert('bad-number', [Number.NaN, 0])).toThrow(/non-finite/u)
    expect(() => index.upsert('bad-norm', [0.2, 0.2])).toThrow(/normalized/u)
  })
})
