import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MemoryRecallOptions } from '@deskpet/contracts'
import { createVectorStore } from '../long-term/vector-store'
import { createMemoryEmbeddingIndex } from '../long-term/embedding-index'
import { runMemoryStage3RetrievalEval } from './stage3-retrieval-eval'
import type { MemoryStage3RetrievalEvalCase } from './stage3-retrieval-eval'
import { assembleMemoryStage3BlindCases } from './stage3-blind-eval'
import type { MemoryStage3BlindCasePack, MemoryStage3BlindFact, MemoryStage3BlindLabelPack } from './stage3-blind-eval'

const BGE_MODEL = 'Xenova/bge-small-zh-v1.5'
const BGE_REVISION = 'fcecc3c5fef6becfa2b2bdda15c1c938857be534'
const BGE_FINGERPRINT = `${BGE_MODEL}@${BGE_REVISION}:q8:mean-normalized:v1`
const BGE_EXPECTED_DIMENSION = 512
const BGE_MANIFEST = 'bge-small-zh-v1.5.manifest.json'

const modelDir = process.env.DESKPET_BGE_MODEL_DIR ?? join(process.cwd(), 'DeskPetData', 'models', 'memory')
const devFixturePath = process.env.DESKPET_BGE_DEV_FIXTURE
const blindCasePath = process.env.DESKPET_MEMORY_STAGE3_BLIND_CASES
const blindLabelPath = process.env.DESKPET_MEMORY_STAGE3_BLIND_LABELS
const expectedCaseSha256 = process.env.DESKPET_MEMORY_STAGE3_BLIND_CASE_SHA256
const expectedLabelSha256 = process.env.DESKPET_MEMORY_STAGE3_BLIND_LABEL_SHA256

interface BgeExtractor {
  (text: string, options: { pooling: 'mean'; normalize: true }): Promise<{ tolist: () => unknown }>
  dispose?: () => Promise<void>
}

async function loadBgeExtractor(cacheDir: string): Promise<BgeExtractor> {
  // @huggingface/transformers is an optional dependency available in the
  // Electron app workspace. The dynamic import is typed as any so the memory
  // package does not need to declare it as a direct dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transformers: any = await (Function('m', 'return import(m)')('@huggingface/transformers'))
  transformers.env.cacheDir = cacheDir
  transformers.env.allowRemoteModels = false
  const extractor = await transformers.pipeline('feature-extraction', BGE_MODEL, {
    revision: BGE_REVISION,
    dtype: 'q8',
    cache_dir: cacheDir,
    local_files_only: true,
  })
  return extractor as unknown as BgeExtractor
}

async function embedWithBge(extractor: BgeExtractor, text: string): Promise<number[]> {
  const tensor = await extractor(text, { pooling: 'mean', normalize: true })
  const values = tensor.tolist()
  const vector = Array.isArray(values) && Array.isArray(values[0]) ? values[0] : values
  if (!Array.isArray(vector) || vector.length !== BGE_EXPECTED_DIMENSION)
    throw new Error(`BGE returned dimension ${Array.isArray(vector) ? vector.length : 'unknown'}, expected ${BGE_EXPECTED_DIMENSION}`)
  return vector as number[]
}

interface FixtureData {
  datasetVersion: string
  facts: MemoryStage3BlindFact[]
  cases: MemoryStage3RetrievalEvalCase[]
}

function loadDevFixture(): FixtureData {
  if (!devFixturePath || !existsSync(devFixturePath))
    throw new Error(`DESKPET_BGE_DEV_FIXTURE not set or file missing: ${devFixturePath ?? '(unset)'}`)
  const raw = JSON.parse(readFileSync(devFixturePath, 'utf-8')) as {
    datasetVersion: string
    facts: Array<{ key: string; content: string; kind: string; importance?: number; memoryKey?: string; validFrom?: string; suppressAfterWrite?: boolean }>
    cases: Array<{ id: string; category: string; query: string; relevantKeys: string[]; temporalMode?: string }>
  }
  return {
    datasetVersion: raw.datasetVersion,
    facts: raw.facts,
    cases: raw.cases.map(item => ({
      id: item.id,
      category: item.category,
      query: item.query,
      relevantKeys: item.relevantKeys,
      ...(item.temporalMode ? { options: { temporalMode: item.temporalMode as 'current' | 'historical' | 'all' } } : {}),
    })),
  }
}

function loadBlindFixture(): FixtureData {
  if (!blindCasePath || !blindLabelPath || !expectedCaseSha256 || !expectedLabelSha256)
    throw new Error('Blind fixture env vars not set')
  const caseBytes = readFileSync(blindCasePath)
  const labelBytes = readFileSync(blindLabelPath)
  const caseSha256 = createHash('sha256').update(caseBytes).digest('hex')
  const labelSha256 = createHash('sha256').update(labelBytes).digest('hex')
  expect(caseSha256).toBe(expectedCaseSha256.toLocaleLowerCase())
  expect(labelSha256).toBe(expectedLabelSha256.toLocaleLowerCase())
  const casePack = JSON.parse(caseBytes.toString('utf-8')) as MemoryStage3BlindCasePack
  const labelPack = JSON.parse(labelBytes.toString('utf-8')) as MemoryStage3BlindLabelPack
  const assembled = assembleMemoryStage3BlindCases(casePack, labelPack)
  const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim().toLocaleLowerCase()
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim()
  expect(dirty, 'BGE blind comparison requires a clean worktree').toBe('')
  expect(labelPack.implementationCommit.toLocaleLowerCase()).toBe(implementationCommit)
  return { datasetVersion: assembled.datasetVersion, facts: assembled.facts, cases: assembled.cases }
}

async function populateStore(
  store: ReturnType<typeof createVectorStore>,
  scope: { ownerId: string; agentId: string },
  facts: readonly MemoryStage3BlindFact[],
): Promise<void> {
  for (const fact of facts) {
    const metadata: Record<string, unknown> = {
      evalKey: fact.key,
      kind: fact.kind,
      importance: fact.importance ?? 0.85,
      confidence: 0.95,
      ...(fact.memoryKey ? { memoryKey: fact.memoryKey, cardinality: 'single' } : {}),
      ...(fact.validFrom ? { validFrom: Date.parse(fact.validFrom) } : {}),
      ...(fact.sensitivity ? { sensitivity: fact.sensitivity } : {}),
      ...(fact.sharePolicy ? { sharePolicy: fact.sharePolicy } : {}),
    }
    const remembered = await store.remember(fact.content, scope, metadata)
    if (fact.suppressAfterWrite && remembered)
      await store.update(remembered.id, scope, { status: 'suppressed' })
  }
}

async function runComparison(fixture: FixtureData, bgeExtractor: BgeExtractor, label: string) {
  const hashScope = { ownerId: `bge-compare-${label}-hash`, agentId: 'deskpet' }
  const hashStore = createVectorStore()
  await populateStore(hashStore, hashScope, fixture.facts)

  const hashReport = await runMemoryStage3RetrievalEval(
    fixture.cases,
    (query: string, topK: number, options?: MemoryRecallOptions) => hashStore.recall(query, hashScope, topK, options),
    { datasetVersion: fixture.datasetVersion, topK: 5 },
  )

  const bgeScope = { ownerId: `bge-compare-${label}-bge`, agentId: 'deskpet' }
  const bgeEmbedIndex = createMemoryEmbeddingIndex()
  const bgeStore = createVectorStore({
    embeddingModel: BGE_FINGERPRINT,
    embedder: async (text: string) => embedWithBge(bgeExtractor, text),
    embeddingIndex: bgeEmbedIndex,
    foregroundEmbeddingUpgrade: false,
  })
  await populateStore(bgeStore, bgeScope, fixture.facts)
  await bgeStore.prepareEmbeddings(BGE_FINGERPRINT, async (text: string) => embedWithBge(bgeExtractor, text), bgeScope, { batchSize: 8 })

  const bgeReport = await runMemoryStage3RetrievalEval(
    fixture.cases,
    (query: string, topK: number, options?: MemoryRecallOptions) => bgeStore.recall(query, bgeScope, topK, options),
    { datasetVersion: fixture.datasetVersion, topK: 5 },
  )

  return { hash: hashReport, bge: bgeReport }
}

const bgeAvailable = existsSync(join(modelDir, BGE_MANIFEST))
  || existsSync(join(modelDir, BGE_MODEL, BGE_REVISION))
  || existsSync(join(modelDir, `models--${BGE_MODEL.replace('/', '--')}`, 'snapshots', BGE_REVISION))
const blindLatencyTargetMs = Number(process.env.DESKPET_MEMORY_STAGE3_BLIND_P95_TARGET_MS ?? 100)

describe('stage 3 BGE vs local-hash embedding comparison', () => {
  it.skipIf(!bgeAvailable || !devFixturePath)('compares BGE and local-hash on the development fixture', async () => {
    const fixture = loadDevFixture()
    const extractor = await loadBgeExtractor(modelDir)
    const { hash, bge } = await runComparison(fixture, extractor, 'dev')
    console.log(JSON.stringify({
      stage: 'memory-stage3-bge-comparison-dev',
      datasetVersion: fixture.datasetVersion,
      model: BGE_MODEL,
      hash: { recallAt5: hash.recallAtK, top1Accuracy: hash.top1Accuracy, ndcgAt5: hash.ndcgAtK, p95LatencyMs: hash.p95LatencyMilliseconds },
      bge: { recallAt5: bge.recallAtK, top1Accuracy: bge.top1Accuracy, ndcgAt5: bge.ndcgAtK, p95LatencyMs: bge.p95LatencyMilliseconds },
      delta: {
        recallAt5: bge.recallAtK - hash.recallAtK,
        top1Accuracy: bge.top1Accuracy - hash.top1Accuracy,
        ndcgAt5: bge.ndcgAtK - hash.ndcgAtK,
      },
    }, null, 2))
    await extractor.dispose?.()
  }, 300_000)

  it.skipIf(!bgeAvailable || !blindCasePath)('compares BGE and local-hash on the frozen blind fixture', async () => {
    const fixture = loadBlindFixture()
    expect(fixture.cases.length, 'Blind comparison requires >= 300 cases').toBeGreaterThanOrEqual(300)
    const extractor = await loadBgeExtractor(modelDir)
    const { hash, bge } = await runComparison(fixture, extractor, 'blind')
    console.log(JSON.stringify({
      stage: 'memory-stage3-bge-comparison-blind',
      datasetVersion: fixture.datasetVersion,
      model: BGE_MODEL,
      caseCount: fixture.cases.length,
      factCount: fixture.facts.length,
      hash: { recallAt5: hash.recallAtK, top1Accuracy: hash.top1Accuracy, mrrAt5: hash.mrrAtK, ndcgAt5: hash.ndcgAtK, abstentionAccuracy: hash.abstentionAccuracy, p95LatencyMs: hash.p95LatencyMilliseconds },
      bge: { recallAt5: bge.recallAtK, top1Accuracy: bge.top1Accuracy, mrrAt5: bge.mrrAtK, ndcgAt5: bge.ndcgAtK, abstentionAccuracy: bge.abstentionAccuracy, p95LatencyMs: bge.p95LatencyMilliseconds },
      delta: {
        recallAt5: bge.recallAtK - hash.recallAtK,
        top1Accuracy: bge.top1Accuracy - hash.top1Accuracy,
        ndcgAt5: bge.ndcgAtK - hash.ndcgAtK,
      },
      byCategoryHash: hash.byCategory,
      byCategoryBge: bge.byCategory,
    }, null, 2))
    await extractor.dispose?.()
    expect(bge.recallAtK, 'BGE Recall@5 must meet the release gate').toBeGreaterThanOrEqual(0.90)
    expect(bge.top1Accuracy, 'BGE Top-1 must meet the release gate').toBeGreaterThanOrEqual(0.85)
    expect(bge.abstentionAccuracy, 'BGE abstention accuracy must meet the release gate').toBeGreaterThanOrEqual(0.95)
    const temporal = bge.byCategory.temporal
    if (temporal && temporal.answerableCases > 0)
      expect(temporal.top1Accuracy, 'BGE temporal Top-1 must meet the release gate').toBeGreaterThanOrEqual(0.95)
    if (Number.isFinite(blindLatencyTargetMs) && blindLatencyTargetMs > 0)
      expect(bge.p95LatencyMilliseconds, `BGE P95 latency must be < ${blindLatencyTargetMs} ms`).toBeLessThan(blindLatencyTargetMs)
    expect(bge.recallAtK, 'BGE Recall@5 must not be worse than local-hash').toBeGreaterThanOrEqual(hash.recallAtK)
    expect(bge.top1Accuracy, 'BGE Top-1 must not be worse than local-hash').toBeGreaterThanOrEqual(hash.top1Accuracy)
  }, 600_000)
})
