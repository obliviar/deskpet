import { describe, expect, it } from 'vitest'
import { createSparseVectorCandidateIndex } from './sparse-vector-candidate-index'

describe('sparse local vector candidate index', () => {
  it('matches exact dot-product ordering while skipping vectors without shared dimensions', () => {
    const index = createSparseVectorCandidateIndex()
    index.upsert('best', [0.8, 0.6, 0, 0])
    index.upsert('second', [0.6, 0.8, 0, 0])
    index.upsert('orthogonal', [0, 0, 1, 0])

    expect(index.search([1, 0, 0, 0], { minScore: 0.1 })).toEqual([
      { id: 'best', score: 0.8 },
      { id: 'second', score: 0.6 },
    ])
  })

  it('supports scope filters, replacement, removal and deterministic ties', () => {
    const index = createSparseVectorCandidateIndex()
    index.upsert('b', [1, 0])
    index.upsert('a', [1, 0])
    index.upsert('opposite', [-1, 0])
    expect(index.search([1, 0], { allow: id => id !== 'b' })).toEqual([{ id: 'a', score: 1 }])

    index.upsert('a', [0, 1])
    expect(index.search([1, 0])).toEqual([{ id: 'b', score: 1 }])
    expect(index.remove('b')).toBe(true)
    expect(index.search([1, 0])).toEqual([])
    expect(index.size()).toBe(2)
    index.clear()
    expect(index.size()).toBe(0)
  })
})
