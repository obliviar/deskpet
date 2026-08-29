import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  fingerprintMemoryV4YearScenario,
  generateMemoryV4YearScenario,
  memoryV4YearQueriesForDay,
  parseMemoryV4YearScenario,
} from './memory-v4-year-scenario'

const fixturePath = fileURLToPath(new URL('../../../../../evals/memory/v4-year-scenarios-v1.json', import.meta.url))

describe('Memory V4 deterministic year scenario', () => {
  it('expands the compact contract into a stable 365-day event stream', () => {
    const definition = parseMemoryV4YearScenario(readFileSync(fixturePath, 'utf8'))
    const first = generateMemoryV4YearScenario(definition)
    const second = generateMemoryV4YearScenario(definition)

    expect(first.events).toHaveLength(1_826)
    expect(first.events).toEqual(second.events)
    expect(first.eventFingerprint).toBe(second.eventFingerprint)
    expect(first.definitionFingerprint).toBe(fingerprintMemoryV4YearScenario(definition))
    expect(first.eventsByDay.size).toBe(365)
    expect([...first.eventsByDay.values()].every(events => events.length >= 5)).toBe(true)
    expect(first.events.filter(event => event.expectedOperation !== 'NOOP')).toHaveLength(16)
    expect(memoryV4YearQueriesForDay(definition, 180).some(query => query.id === 'location-conflict')).toBe(true)
    expect(memoryV4YearQueriesForDay(definition, 181).some(query => query.id === 'location-conflict')).toBe(false)
  })

  it('rejects reversed validity and query windows', () => {
    const definition = parseMemoryV4YearScenario(readFileSync(fixturePath, 'utf8'))
    expect(() => parseMemoryV4YearScenario(JSON.stringify({
      ...definition,
      facts: definition.facts.map((fact, index) => index === 0 ? { ...fact, validFromDay: 10, validToDay: 2 } : fact),
    }))).toThrow(/validFromDay/)
    expect(() => parseMemoryV4YearScenario(JSON.stringify({
      ...definition,
      queries: definition.queries.map((query, index) => index === 0 ? { ...query, fromDay: 10, toDay: 2 } : query),
    }))).toThrow(/fromDay/)
  })
})
