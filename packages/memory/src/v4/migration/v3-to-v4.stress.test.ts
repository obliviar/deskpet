import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { parseMemoryV4Snapshot } from '../repository/memory-v4-repository'
import { migrateV3PayloadToV4 } from './v3-to-v4'

const NOW = 1_800_000_000_000
const ITEM_COUNT = readStressItemCount()

describe('V3 to V4 migration scale and losslessness', () => {
  it(`migrates and validates ${ITEM_COUNT.toLocaleString()} varied records without loss`, () => {
    const sourceItems = Array.from({ length: ITEM_COUNT }, (_, index) => v3Item(index))
    const payload = JSON.stringify({ version: 3, items: sourceItems })
    const sourceHashBefore = sha256(payload)
    const startedAt = performance.now()

    const migrated = migrateV3PayloadToV4(payload, { now: () => NOW })
    const migrationMilliseconds = performance.now() - startedAt
    const encoded = JSON.stringify(migrated)
    const validationStartedAt = performance.now()
    const reparsed = parseMemoryV4Snapshot(encoded)
    const validationMilliseconds = performance.now() - validationStartedAt

    expect(sha256(payload)).toBe(sourceHashBefore)
    expect(reparsed.facts).toHaveLength(ITEM_COUNT)
    expect(reparsed.factVersions).toHaveLength(ITEM_COUNT)
    expect(reparsed.legacyImports).toHaveLength(ITEM_COUNT)
    expect(reparsed.migrationManifests[0]?.mappings).toHaveLength(ITEM_COUNT)
    expect(new Set(reparsed.facts.map(fact => fact.id))).toHaveLength(ITEM_COUNT)
    expect(reparsed.legacyImports[0]?.raw).toEqual(sourceItems[0])
    expect(reparsed.legacyImports[Math.floor(ITEM_COUNT / 2)]?.raw).toEqual(sourceItems[Math.floor(ITEM_COUNT / 2)])
    expect(reparsed.legacyImports.at(-1)?.raw).toEqual(sourceItems.at(-1))
    expect(reparsed.facts.filter(fact => fact.origin === 'automatic' && fact.status === 'active')).toHaveLength(0)
    expect(migrationMilliseconds).toBeLessThan(60_000)
    expect(validationMilliseconds).toBeLessThan(60_000)

    console.info(JSON.stringify({
      stage: 'memory-v4-stage1-stress',
      itemCount: ITEM_COUNT,
      episodeCount: reparsed.episodes.length,
      evidenceCount: reparsed.evidenceLinks.length,
      encodedBytes: Buffer.byteLength(encoded),
      migrationMilliseconds: Math.round(migrationMilliseconds),
      validationMilliseconds: Math.round(validationMilliseconds),
    }))
  }, 130_000)
})

function v3Item(index: number) {
  const owner = `owner-${index % 7}`
  const agent = `agent-${index % 3}`
  const origin = index % 4 === 0 ? 'manual' : index % 9 === 0 ? 'image' : 'automatic'
  const status = ['active', 'active', 'superseded', 'expired', 'conflicted', 'orphaned'][index % 6]
  const supersedes = index >= 21 && index % 13 === 0 ? `memory-${index - 21}` : undefined
  return {
    id: `memory-${index}`,
    content: index % 2 === 0 ? `用户第 ${index} 项偏好：茶-${index % 17}` : `Project ${index}: DeskPet`,
    metadata: {
      kind: index % 2 === 0 ? 'preference' : 'project',
      cardinality: index % 5 === 0 ? 'single' : 'multiple',
      nested: { index, retained: true },
    },
    status,
    origin,
    importance: (index % 11) / 10,
    confidence: (index % 9) / 8,
    accessCount: index % 100,
    validFrom: 1_700_000_000_000 + index,
    ...(status !== 'active' ? { validTo: 1_710_000_000_000 + index } : {}),
    ...(supersedes ? { supersedes } : {}),
    memoryKey: index % 5 === 0 ? `profile.key.${index % 23}` : undefined,
    sourceMessageIds: index % 3 === 0 ? [`message-${index % 101}`] : [],
    sourceAttachmentIds: index % 17 === 0 ? [`attachment-${index % 31}`] : [],
    sharePolicy: index % 10 === 0 ? 'local-only' : 'allow-remote',
    sensitivity: index % 19 === 0 ? 'private' : 'normal',
    scope: { ownerId: owner, agentId: agent, ...(index % 5 === 0 ? { sessionId: `session-${index % 4}` } : {}) },
    embedding: [index / Math.max(ITEM_COUNT, 1), 0.5],
    embeddingModel: 'stage1-stress',
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_100_000 + index,
    unknownFutureField: { index, preserve: ['all', true, null] },
  }
}

function readStressItemCount(): number {
  const parsed = Number(process.env.DESKPET_V4_STRESS_ITEMS ?? 2000)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20_000)
    throw new Error('DESKPET_V4_STRESS_ITEMS must be an integer in [1, 20000]')
  return parsed
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
