import { describe, expect, it } from 'vitest'
import { migrateV3PayloadToV4 } from '../migration/v3-to-v4'
import { createMemoryV4Repository } from '../repository/memory-v4-repository'
import {
  DEFAULT_MEMORY_V4_RECALL_ABSTENTION_CALIBRATION,
  MEMORY_V4_LOCAL_CALIBRATION_DATASET_FINGERPRINT,
  createMemoryV4ShadowRetriever,
} from '../retrieval/memory-v4-shadow-retriever'
import {
  fitMemoryV4LocalCalibration,
  type MemoryV4CalibrationObservation,
} from './memory-v4-local-calibration'

const NOW = Date.UTC(2026, 7, 25)
const CALIBRATION_OWNERS = 50
const VALIDATION_OWNERS = 80
const DATASET_VERSION = 'deskpet-v4-local-synthetic-calibration-v2'

interface LocalCase {
  id: string
  query: string
  ownerId: string
  relevantFactIds: string[]
}

describe('Memory V4 local absolute-evidence calibration', () => {
  it('fits on 700 cases and validates on an ID-disjoint 1,120-case retrieval set', () => {
    const repository = seededRepository(CALIBRATION_OWNERS + VALIDATION_OWNERS)
    const fallbackRetriever = createMemoryV4ShadowRetriever(repository, { now: () => NOW })
    const calibrationCases = buildCases('calibration', 0, CALIBRATION_OWNERS, false)
    const validationCases = buildCases('validation', CALIBRATION_OWNERS, VALIDATION_OWNERS, true)
    const calibration = observe(calibrationCases, fallbackRetriever)
    const validation = observe(validationCases, fallbackRetriever)

    const artifact = fitMemoryV4LocalCalibration(calibration, validation, {
      datasetVersion: DATASET_VERSION,
      createdAt: NOW,
      minimumIntentSamples: 50,
      falsePositiveCost: 3,
      falseNegativeCost: 1,
    })
    expect(artifact).toMatchObject({
      calibrationSamples: 700,
      validationSamples: 1_120,
      model: {
        version: `memory-v4-local-calibration-v2:${DATASET_VERSION}`,
        datasetVersion: DATASET_VERSION,
        sampleCount: 700,
      },
    })
    expect(artifact.datasetFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(artifact.datasetFingerprint).toBe(MEMORY_V4_LOCAL_CALIBRATION_DATASET_FINGERPRINT)
    expect(artifact.model).toEqual(DEFAULT_MEMORY_V4_RECALL_ABSTENTION_CALIBRATION)
    expect(artifact.validationMetrics.recall).toBeGreaterThanOrEqual(0.98)
    expect(artifact.validationMetrics.precision).toBeGreaterThanOrEqual(0.98)
    expect(artifact.validationMetrics.specificity).toBeGreaterThanOrEqual(0.99)
    expect(artifact.validationMetrics.falsePositiveRate).toBeLessThanOrEqual(0.01)
    expect(artifact.validationMetrics.balancedAccuracy).toBeGreaterThanOrEqual(0.985)

    const calibratedRetriever = createMemoryV4ShadowRetriever(repository, {
      now: () => NOW,
      abstentionCalibration: artifact.model,
    })
    const quality = evaluateCases(validationCases, calibratedRetriever)
    expect(quality).toMatchObject({
      answerableCases: 560,
      abstentionCases: 560,
      recall: 1,
      precision: 1,
      abstentionAccuracy: 1,
    })

    console.info(JSON.stringify({
      stage: 'memory-v4-local-calibration',
      externalEvidence: false,
      datasetVersion: artifact.datasetVersion,
      datasetFingerprint: artifact.datasetFingerprint,
      calibrationSamples: artifact.calibrationSamples,
      validationSamples: artifact.validationSamples,
      thresholds: artifact.model,
      calibrationMetrics: artifact.calibrationMetrics,
      validationMetrics: artifact.validationMetrics,
      retrievalQuality: quality,
    }))
  })

  it('rejects overlapping calibration and validation identities', () => {
    const samples: MemoryV4CalibrationObservation[] = [
      { id: 'shared', intent: 'specific', bestScore: 0.9, relevant: true },
      { id: 'negative', intent: 'specific', bestScore: 0.1, relevant: false },
    ]
    expect(() => fitMemoryV4LocalCalibration(samples, [
      { id: 'shared', intent: 'specific', bestScore: 0.8, relevant: true },
      { id: 'validation-negative', intent: 'specific', bestScore: 0.2, relevant: false },
    ], {
      datasetVersion: 'overlap-test',
      minimumCalibrationSamples: 2,
      minimumValidationSamples: 2,
    })).toThrow(/overlap/u)
  })
})

function seededRepository(ownerCount: number) {
  const items: Record<string, unknown>[] = []
  for (let index = 0; index < ownerCount; index++) {
    const ownerId = `local-owner-${index}`
    items.push(
      item(ownerId, 'name', `用户姓名/名字：本地用户${index}`, 'profile.name'),
      item(ownerId, 'door', `用户的门禁码：${4_000 + index}`, 'private.door-code'),
      item(ownerId, 'drink', `用户喜欢喝手冲饮品${index}`, 'preference.drink', {
        metadata: { kind: 'preference', cardinality: 'multiple' },
      }),
      item(ownerId, 'color', `用户喜欢的颜色：本地色${index}`, 'preference.color'),
      item(ownerId, 'project-current', `用户当前项目：DeskPet-${index}`, 'project.current'),
      item(ownerId, 'project-old', `用户以前的项目：Archive-${index}`, 'project.current', {
        status: 'superseded',
        validFrom: Date.UTC(2024, 0, 1),
        validTo: Date.UTC(2025, 0, 1),
        invalidatedAt: Date.UTC(2025, 0, 2),
        createdAt: Date.UTC(2024, 0, 1),
        updatedAt: Date.UTC(2025, 0, 2),
      }),
    )
  }
  const repository = createMemoryV4Repository({ now: () => NOW })
  repository.replace(migrateV3PayloadToV4(JSON.stringify({ version: 3, items }), { now: () => NOW }))
  return repository
}

function item(
  ownerId: string,
  suffix: string,
  content: string,
  memoryKey: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = `${ownerId}-${suffix}`
  return {
    id,
    content,
    metadata: { kind: memoryKey.split('.')[0], cardinality: 'single' },
    status: 'active',
    origin: 'manual',
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    memoryKey,
    sourceMessageIds: [`source-${id}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope: { ownerId, agentId: 'deskpet', sessionId: 'local-calibration' },
    embedding: [],
    embeddingModel: 'local-hash-v3',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...patch,
  }
}

function buildCases(
  split: string,
  ownerOffset: number,
  ownerCount: number,
  validationWording: boolean,
): LocalCase[] {
  const cases: LocalCase[] = []
  for (let offset = 0; offset < ownerCount; offset++) {
    const index = ownerOffset + offset
    const ownerId = `local-owner-${index}`
    const fact = (suffix: string) => `${ownerId}-${suffix}`
    const add = (suffix: string, query: string, relevantFactIds: string[], scopeOwner = ownerId) => {
      cases.push({ id: `${split}-${index}-${suffix}`, query, ownerId: scopeOwner, relevantFactIds })
    }

    add('name-positive', validationWording ? '你记得应该怎么称呼我吗？' : '我的名字是什么？', [fact('name')])
    add('door-positive', validationWording ? '进入大门要用的门禁码是什么？' : '我的门禁码是多少？', [fact('door')])
    add('drink-positive', validationWording ? '我通常会选哪种饮品？' : '我平时喝什么饮品？', [fact('drink')])
    add('multi-positive', validationWording ? '告诉我名字以及偏爱的颜色' : '我的姓名和喜欢的颜色分别是什么？', [fact('name'), fact('color')])
    add('temporal-positive', validationWording ? '在 2024 年我当时开发哪个项目？' : '2024 年我做的项目是什么？', [fact('project-old')])
    add('timeline-positive', validationWording ? '这些年我的项目经历了什么变化？' : '回顾这些年我的项目变化', [fact('project-current'), fact('project-old')])
    add('enumerative-positive', validationWording ? '列出你记得我的所有信息' : '总结你记得的关于我的所有信息', [
      fact('name'), fact('door'), fact('drink'), fact('color'), fact('project-current'),
    ])

    add('shoe-negative', validationWording ? '我穿多大尺码的鞋？' : '我的鞋码是多少？', [])
    add('pet-negative', validationWording ? '我养的宠物叫什么？' : '我的宠物是什么？', [])
    add('multi-negative', validationWording ? '我的鞋码以及宠物分别是什么？' : '告诉我鞋码和宠物信息', [])
    add('temporal-negative', validationWording ? '2024 年我当时住在哪座城市？' : '2024 年我的居住地在哪里？', [])
    add('timeline-negative', validationWording ? '这些年我的居住地如何变化？' : '回顾这些年我的居住地变化', [])
    add('external-negative', validationWording ? '明天气温大概是多少？' : '明天会不会下雨？', [])
    add('enumerative-negative', validationWording ? '列出你记得我的所有信息' : '总结你记得的关于我的所有信息', [], `empty-${split}-${index}`)
  }
  return cases
}

function observe(
  cases: readonly LocalCase[],
  retriever: ReturnType<typeof createMemoryV4ShadowRetriever>,
): MemoryV4CalibrationObservation[] {
  return cases.map((testCase) => {
    const recalled = retriever.recall(testCase.query, {
      scope: { ownerId: testCase.ownerId, agentId: 'deskpet' },
      limit: 10,
    })
    return {
      id: testCase.id,
      intent: recalled.queryIntent,
      bestScore: recalled.abstention?.bestScore ?? 0,
      relevant: testCase.relevantFactIds.length > 0,
    }
  })
}

function evaluateCases(
  cases: readonly LocalCase[],
  retriever: ReturnType<typeof createMemoryV4ShadowRetriever>,
) {
  let relevantFacts = 0
  let retrievedRelevantFacts = 0
  let retrievedFacts = 0
  let abstentionSuccesses = 0
  let answerableCases = 0
  let abstentionCases = 0
  const missingCases: Array<{ id: string; missing: string[]; retrieved: string[] }> = []
  for (const testCase of cases) {
    const recalled = retriever.recall(testCase.query, {
      scope: { ownerId: testCase.ownerId, agentId: 'deskpet' },
      limit: 10,
    })
    const retrieved = new Set(recalled.hits.map(hit => hit.sourceMemoryId ?? hit.factId))
    if (testCase.relevantFactIds.length === 0) {
      abstentionCases += 1
      if (retrieved.size === 0)
        abstentionSuccesses += 1
      continue
    }
    answerableCases += 1
    relevantFacts += testCase.relevantFactIds.length
    retrievedFacts += retrieved.size
    retrievedRelevantFacts += testCase.relevantFactIds.filter(id => retrieved.has(id)).length
    const missing = testCase.relevantFactIds.filter(id => !retrieved.has(id))
    if (missing.length > 0 && missingCases.length < 10)
      missingCases.push({ id: testCase.id, missing, retrieved: [...retrieved] })
  }
  return {
    answerableCases,
    abstentionCases,
    recall: ratio(retrievedRelevantFacts, relevantFacts),
    precision: ratio(retrievedRelevantFacts, retrievedFacts),
    abstentionAccuracy: ratio(abstentionSuccesses, abstentionCases),
    missingCases,
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}
