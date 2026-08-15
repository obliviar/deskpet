import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFilePersistence, createVectorStore } from './vector-store'
import { createMemoryEmbeddingIndex } from './embedding-index'
import type { MemoryPersistenceDelta, V3MemoryCommit } from './vector-store'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('persistent vector store', () => {
  it('persists content edits as update commits and keeps suppressed memories out of recall', async () => {
    const commits: V3MemoryCommit[] = []
    const store = createVectorStore({ onCommittedChange: commit => commits.push(commit) })
    const scope = { ownerId: 'owner', agentId: 'agent' }
    const remembered = await store.remember('用户喜欢旧内容', scope, { origin: 'manual' })
    expect(remembered).toBeDefined()
    expect(await store.update(remembered!.id, scope, { content: '用户喜欢新内容', status: 'suppressed' })).toBe(true)
    expect((await store.list(scope))[0]).toMatchObject({ content: '用户喜欢新内容', status: 'suppressed' })
    expect(await store.recall('新内容', scope, 5)).toEqual([])
    expect(commits.at(-1)).toMatchObject({ reason: 'update' })
    expect(commits.at(-1)!.upserts[0]).toMatchObject({ content: '用户喜欢新内容', status: 'suppressed' })
    expect(await store.restore(remembered!.id, scope)).toBe(true)
    expect((await store.recall('新内容', scope, 5))[0]?.content).toBe('用户喜欢新内容')
  })

  it('keeps the previous content and indexes intact when re-embedding an edit fails', async () => {
    let rejectEdit = false
    const store = createVectorStore({
      minScore: 0,
      embedder: async (text) => {
        if (rejectEdit && text.includes('新内容'))
          throw new Error('simulated embedding failure')
        return text.includes('旧内容') ? [1, 0] : [0, 1]
      },
    })
    const scope = { ownerId: 'owner', agentId: 'agent' }
    const remembered = await store.remember('用户喜欢旧内容', scope, { origin: 'manual' })
    rejectEdit = true

    await expect(store.update(remembered!.id, scope, { content: '用户喜欢新内容' }))
      .rejects.toThrow('simulated embedding failure')
    expect((await store.list(scope))[0]?.content).toBe('用户喜欢旧内容')
    rejectEdit = false
    expect((await store.recall('旧内容', scope, 1))[0]?.content).toBe('用户喜欢旧内容')
  })

  it('creates an empty storage file immediately', () => {
    const storagePath = temporaryFile()

    createVectorStore({ storagePath })

    expect(existsSync(storagePath)).toBe(true)
    expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({ version: 3, items: [] })
  })

  it('persists across instances and isolates owners', async () => {
    const storagePath = temporaryFile()
    const scopeA = { ownerId: 'alice', agentId: 'deskpet' }
    const scopeB = { ownerId: 'bob', agentId: 'deskpet' }
    const options = {
      storagePath,
      embeddingModel: 'test-v1',
      minScore: 0.5,
      embedder: testEmbedder,
    }

    const first = createVectorStore(options)
    await first.remember('Alice likes coffee', scopeA)
    await first.remember('Bob likes tea', scopeB)

    const second = createVectorStore(options)
    expect(await second.count(scopeA)).toBe(1)
    expect(await second.count(scopeB)).toBe(1)
    expect((await second.list(scopeA)).map(item => item.content)).toEqual(['Alice likes coffee'])
    expect((await second.list(scopeB)).map(item => item.content)).toEqual(['Bob likes tea'])
    expect((await second.recall('coffee', scopeA))[0]?.content).toBe('Alice likes coffee')
    expect(await second.recall('coffee', scopeB)).toEqual([])
  })

  it('uses record deltas after the initial snapshot when persistence supports them', async () => {
    const snapshots: string[] = []
    const deltas: MemoryPersistenceDelta[] = []
    const store = createVectorStore({
      persistence: {
        load: () => undefined,
        save: payload => snapshots.push(payload),
        appendDelta: delta => deltas.push(delta),
      },
      embeddingModel: 'test-v1',
      minScore: 0.1,
      embedder: testEmbedder,
    })
    const scope = { ownerId: 'incremental', agentId: 'deskpet' }
    await store.remember('Alice likes coffee', scope)
    const recalled = await store.recall('coffee', scope)
    await store.forget(recalled[0]!.id, scope)

    expect(snapshots).toHaveLength(1)
    expect(deltas).toHaveLength(3)
    expect(deltas[0]?.upserts).toHaveLength(1)
    expect(deltas[1]?.upserts).toHaveLength(1)
    expect(deltas[2]?.deletes).toEqual([recalled[0]!.id])
  })

  it('deduplicates, forgets and clears within a scope', async () => {
    const store = createVectorStore({
      storagePath: temporaryFile(),
      embeddingModel: 'test-v1',
      minScore: 0.5,
      embedder: testEmbedder,
    })
    const scope = { ownerId: 'local', agentId: 'deskpet' }

    await store.remember('User likes coffee', scope)
    await store.remember('  User   likes coffee  ', scope, { importance: 1 })
    expect(await store.count(scope)).toBe(1)

    const listed = await store.list(scope)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      content: 'User likes coffee',
      metadata: { importance: 1 },
    })
    expect(listed[0]?.updatedAt).toEqual(expect.any(Number))

    const hit = (await store.recall('coffee', scope))[0]!
    await store.forget(hit.id, scope)
    expect(await store.count(scope)).toBe(0)

    await store.remember('User likes tea', scope)
    await store.clear(scope)
    expect(await store.count(scope)).toBe(0)
  })

  it('supersedes confident single-value facts and can restore lifecycle records', async () => {
    const store = createVectorStore({ storagePath: temporaryFile(), embedder: testEmbedder })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    await store.remember('用户姓名/名字：小秦', scope, {
      memoryKey: 'profile.name', cardinality: 'single', confidence: 0.95,
    })
    await store.remember('用户姓名/名字：小明', scope, {
      memoryKey: 'profile.name', cardinality: 'single', confidence: 0.95,
    })

    const memories = await store.list(scope)
    expect(memories).toHaveLength(2)
    expect(memories.find(item => item.content.includes('小明'))?.status).toBe('active')
    const old = memories.find(item => item.content.includes('小秦'))!
    expect(old.status).toBe('superseded')
    expect(old.validTo).toEqual(expect.any(Number))
    expect(old.invalidatedAt).toEqual(expect.any(Number))
    expect(await store.restore(old.id, scope)).toBe(true)
    const restored = await store.list(scope)
    expect(restored.find(item => item.id === old.id)?.status).toBe('active')
    expect(restored.find(item => item.content.includes('小明'))?.status).toBe('superseded')

    await store.remember('临时记忆', scope, { expiresAt: Date.now() - 1000 })
    const expired = (await store.list(scope)).find(item => item.content === '临时记忆')!
    expect(expired.status).toBe('expired')
    expect(await store.restore(expired.id, scope)).toBe(true)
    const restoredExpired = (await store.list(scope)).find(item => item.id === expired.id)!
    expect(restoredExpired.status).toBe('active')
    expect(restoredExpired.expiresAt).toBeUndefined()
  })

  it('requires semantic or lexical relevance instead of passing on importance and recency alone', async () => {
    const store = createVectorStore({
      storagePath: temporaryFile(),
      minScore: 0.1,
      minSemanticScore: 0.5,
      minLexicalScore: 0.2,
      embedder: relevanceEmbedder,
    })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    await store.remember('用户喜欢咖啡', scope, { importance: 1 })

    expect(await store.recall('今天天气如何', scope)).toEqual([])
  })

  it('applies privacy filters before ranking and access accounting', async () => {
    const store = createVectorStore({
      storagePath: temporaryFile(),
      minScore: 0.1,
      minSemanticScore: 0.5,
      embedder: sharedEmbedder,
    })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    await store.remember('private shared fact', scope, {
      kind: 'private-test', sensitivity: 'private', sharePolicy: 'local-only',
    })
    await store.remember('public shared fact', scope, {
      kind: 'public-test', sensitivity: 'normal', sharePolicy: 'allow-remote',
    })

    const recalled = await store.recall('shared', scope, 5, {
      sharePolicies: ['allow-remote'], sensitivities: ['normal'],
    })
    expect(recalled.map(item => item.content)).toEqual(['public shared fact'])
    const listed = await store.list(scope)
    expect(listed.find(item => item.content.startsWith('private'))?.accessCount).toBe(0)
    expect(listed.find(item => item.content.startsWith('public'))?.accessCount).toBe(1)
  })

  it('adaptively injects a narrow fact and counts only the selected memory', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'adaptive-narrow', agentId: 'deskpet' }
    await store.remember('用户姓名/名字：小秦', scope, { kind: 'identity', importance: 1 })
    await store.remember('用户当前项目：DeskPet', scope, { kind: 'project', importance: 1 })
    await store.remember('用户喜欢的饮品：乌龙茶', scope, { kind: 'preference', importance: 1 })

    const result = await store.recallAdaptive('我叫什么名字？', scope)
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]?.content).toContain('小秦')
    expect(result.injectedMemoryIds).toEqual(result.memories.map(item => item.id))
    expect(result.retrievedMemoryIds).toContain(result.memories[0]!.id)
    expect(result.stopReason).toBe('coverage-satisfied')

    const listed = await store.list(scope)
    expect(listed.find(item => item.content.includes('小秦'))?.accessCount).toBe(1)
    expect(listed.find(item => item.content.includes('DeskPet'))?.accessCount).toBe(0)
    expect(listed.find(item => item.content.includes('乌龙茶'))?.accessCount).toBe(0)
  })

  it('adaptively expands beyond five memories for a broad preference summary', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'adaptive-broad', agentId: 'deskpet' }
    const facts = [
      '用户喜欢的饮品：乌龙茶',
      '用户不喜欢的食物：香菜',
      '用户界面偏好：深色主题',
      '用户回答偏好：简洁中文',
      '用户喜欢的书：三体',
      '用户音乐偏好：爵士乐',
      '用户工作时间偏好：晚上',
      '用户喜欢的颜色：藏青',
    ]
    for (const [index, fact] of facts.entries())
      await store.remember(fact, scope, { kind: `preference-${index}`, importance: 0.9 })

    const result = await store.recallAdaptive('总结我的所有偏好', scope, {
      initialBatchSize: 4,
      continuationBatchSize: 4,
      maxBatches: 3,
      maxInjected: 10,
    })
    expect(result.memories.length).toBeGreaterThan(5)
    expect(result.batchesEvaluated).toBeGreaterThan(1)
    expect(result.injectedMemoryIds).toEqual(result.memories.map(item => item.id))
    expect((await store.list(scope)).filter(item => item.accessCount === 1)).toHaveLength(result.memories.length)
  })

  it('ranks once even when adaptive selection evaluates multiple batches', async () => {
    const embedder = vi.fn(async (text: string) => createTestVector(text))
    const store = createVectorStore({ embedder, embeddingModel: 'adaptive-once', minScore: 0.1, minSemanticScore: 0.1 })
    const scope = { ownerId: 'adaptive-once', agentId: 'deskpet' }
    const facts = [
      '用户喜欢饮品一', '用户喜欢饮品二', '用户喜欢饮品三', '用户喜欢饮品四',
      '用户喜欢饮品五', '用户喜欢饮品六', '用户喜欢饮品七', '用户喜欢饮品八',
    ]
    for (const [index, fact] of facts.entries())
      await store.remember(fact, scope, { kind: `adaptive-${index}` })
    const callsAfterWrites = embedder.mock.calls.length

    const result = await store.recallAdaptive('总结我的所有偏好', scope, {
      initialBatchSize: 2,
      continuationBatchSize: 2,
      maxBatches: 4,
    })

    expect(result.batchesEvaluated).toBeGreaterThan(1)
    expect(embedder.mock.calls.length - callsAfterWrites).toBe(1)
  })

  it('applies adaptive privacy filtering before evaluation and usage accounting', async () => {
    const store = createVectorStore({
      embeddingModel: 'adaptive-privacy',
      minScore: 0.1,
      minSemanticScore: 0.1,
      embedder: sharedEmbedder,
    })
    const scope = { ownerId: 'adaptive-privacy', agentId: 'deskpet' }
    await store.remember('private shared preference', scope, {
      kind: 'private-preference', sensitivity: 'private', sharePolicy: 'local-only', importance: 1,
    })
    await store.remember('public shared preference', scope, {
      kind: 'public-preference', sensitivity: 'normal', sharePolicy: 'allow-remote', importance: 1,
    })

    const result = await store.recallAdaptive('shared preference', scope, {
      sharePolicies: ['allow-remote'], sensitivities: ['normal'],
    })
    expect(result.memories.map(item => item.content)).toEqual(['public shared preference'])
    expect(result.retrievedMemoryIds).toEqual(result.injectedMemoryIds)
    const listed = await store.list(scope)
    expect(listed.find(item => item.content.startsWith('private'))?.accessCount).toBe(0)
    expect(listed.find(item => item.content.startsWith('public'))?.accessCount).toBe(1)
  })

  it('injects nothing when adaptive recall has no relevant memory', async () => {
    const store = createVectorStore({
      minScore: 0.1,
      minSemanticScore: 0.5,
      minLexicalScore: 0.2,
      embedder: relevanceEmbedder,
    })
    const scope = { ownerId: 'adaptive-none', agentId: 'deskpet' }
    await store.remember('用户喜欢咖啡', scope)

    const result = await store.recallAdaptive('量子纠缠如何定义', scope)
    expect(result).toMatchObject({
      memories: [], candidateCount: 0, evaluatedCount: 0,
      batchesEvaluated: 0, stopReason: 'memory-not-needed',
    })
    expect((await store.list(scope))[0]?.accessCount).toBe(0)
  })

  it('can summarize broad personal memory without requiring a field keyword', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'adaptive-personal-summary', agentId: 'deskpet' }
    await store.remember('用户姓名/名字：小秦', scope, { importance: 0.9 })
    await store.remember('用户当前项目：DeskPet', scope, { importance: 0.8 })
    await store.remember('用户喜欢乌龙茶', scope, { importance: 0.7 })

    const broad = await store.recallAdaptive('总结你记得的关于我的信息', scope)
    expect(broad.memories.length).toBeGreaterThan(1)

    const unrelated = await store.recallAdaptive('总结这篇量子物理文章', scope)
    expect(unrelated.memories).toEqual([])
  })

  it('can expand across historical versions for a broad change query', async () => {
    const store = createVectorStore({ minScore: 0.1, minSemanticScore: 0.1 })
    const scope = { ownerId: 'adaptive-history', agentId: 'deskpet' }
    const projects = ['晨曦日历', '星云记账', 'DeskPet', '长期记忆研究', '移动端伴侣', '知识图谱']
    for (const [index, project] of projects.entries()) {
      await store.remember(`用户当前项目：${project}`, scope, {
        memoryKey: 'project.current', cardinality: 'single', confidence: 0.95,
        kind: 'project', validFrom: Date.parse(`${2020 + index}-01-01T00:00:00Z`),
      })
    }

    const result = await store.recallAdaptive('总结过去几年我的项目变化', scope, {
      temporalMode: 'historical', maxInjected: 10,
    })
    expect(result.memories.length).toBeGreaterThan(1)
    expect(result.memories.some(item => item.status === 'superseded')).toBe(true)
    expect(result.memories.some(item => item.status === 'active')).toBe(true)
    expect(result.batchesEvaluated).toBeGreaterThan(1)
  })

  it('deduplicates conservative semantic paraphrases', async () => {
    const store = createVectorStore({ storagePath: temporaryFile(), embedder: sharedEmbedder })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    await store.remember('User likes coffee', scope, { kind: 'preference', sourceMessageIds: ['m1'] })
    await store.remember("Coffee is the user's preferred drink", scope, {
      kind: 'preference', sourceMessageIds: ['m2'],
    })

    expect(await store.count(scope)).toBe(1)
    expect((await store.list(scope))[0]?.sourceMessageIds).toEqual(['m1', 'm2'])
  })

  it('orphan automatic memories when deleted messages were their last evidence', async () => {
    const store = createVectorStore({ storagePath: temporaryFile(), embedder: testEmbedder })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    await store.remember('用户喜欢咖啡', scope, {
      sourceMessageIds: ['message-1'], origin: 'automatic',
    })

    expect(await store.unlinkSources(['message-1'], scope)).toEqual({ updated: 1, orphaned: 1 })
    expect((await store.list(scope))[0]?.status).toBe('orphaned')
    expect(await store.recall('咖啡', scope)).toEqual([])
  })

  it('recalls current and historical versions with real-world validity intervals', async () => {
    const store = createVectorStore({
      storagePath: temporaryFile(),
      embedder: temporalEmbedder,
      minScore: 0.1,
      minSemanticScore: 0.1,
    })
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    const beijingFrom = Date.parse('2024-01-01T00:00:00Z')
    const shanghaiFrom = Date.parse('2025-01-01T00:00:00Z')
    await store.remember('用户所在地：北京', scope, {
      memoryKey: 'profile.location', cardinality: 'single', confidence: 0.95,
      kind: 'identity', validFrom: beijingFrom,
    })
    await store.remember('用户所在地：上海', scope, {
      memoryKey: 'profile.location', cardinality: 'single', confidence: 0.95,
      kind: 'identity', validFrom: shanghaiFrom,
    })

    const versions = await store.list(scope)
    expect(versions.find(item => item.content.includes('北京'))).toMatchObject({
      status: 'superseded', validFrom: beijingFrom, validTo: shanghaiFrom,
    })
    expect((await store.recall('用户当前所在地', scope))[0]?.content).toContain('上海')
    expect((await store.recall('用户以前在北京居住', scope))[0]?.content).toContain('北京')
    expect((await store.recall('2024 年我住在哪里', scope))[0]?.content).toContain('北京')
  })

  it('stores a newly discovered closed historical interval without replacing the current fact', async () => {
    const store = createVectorStore({ minScore: 0.1, minSemanticScore: 0.1 })
    const scope = { ownerId: 'late-history', agentId: 'deskpet' }
    const boundary = Date.parse('2025-01-01T00:00:00Z')
    await store.remember('用户所在地：上海', scope, {
      memoryKey: 'profile.location', cardinality: 'single', confidence: 0.95,
      kind: 'identity', validFrom: boundary,
    })
    await store.remember('用户所在地：北京', scope, {
      memoryKey: 'profile.location', cardinality: 'single', confidence: 0.95,
      kind: 'identity', validFrom: Date.parse('2024-01-01T00:00:00Z'), validTo: boundary,
      temporalQualifier: 'historical', memoryWriteAction: 'ADD',
    })

    const versions = await store.list(scope)
    expect(versions.find(item => item.content.includes('上海'))?.status).toBe('active')
    expect(versions.find(item => item.content.includes('北京'))).toMatchObject({
      status: 'superseded', validTo: boundary,
    })
    expect((await store.recall('用户当前所在地', scope))[0]?.content).toContain('上海')
    expect((await store.recall('2024 年我住在哪里', scope))[0]?.content).toContain('北京')
  })

  it('recalls the correct monthly fact version from a natural-language date', async () => {
    const store = createVectorStore({ minScore: 0.1, minSemanticScore: 0.1 })
    const scope = { ownerId: 'monthly-history', agentId: 'deskpet' }
    const cities = ['北京', '上海', '南京']
    for (const [month, city] of cities.entries()) {
      await store.remember(`用户所在地：${city}`, scope, {
        memoryKey: 'profile.location', cardinality: 'single', confidence: 0.95,
        kind: 'identity', validFrom: Date.UTC(2025, month, 1),
      })
    }

    expect((await store.recall('2025年1月我住在哪里', scope))[0]?.content).toContain('北京')
    expect((await store.recall('2025年2月份我住在哪里', scope))[0]?.content).toContain('上海')
    expect((await store.recall('2025-03-20 我住在哪里', scope))[0]?.content).toContain('南京')
  })

  it('retains the newest write when capacity timestamps are identical', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const store = createVectorStore({
      storagePath: temporaryFile(), maxMemories: 5, embedder: testEmbedder,
    })
    const scope = { ownerId: 'capacity', agentId: 'deskpet' }
    for (let index = 0; index < 6; index++)
      await store.remember(`CAP-${index}`, scope, { kind: `capacity-${index}` })

    const retained = (await store.list(scope)).map(item => item.content)
    expect(retained).toHaveLength(5)
    expect(retained).toContain('CAP-5')
    expect(retained).not.toContain('CAP-0')
  })

  it('migrates a version 1 index to version 3 without losing memories', async () => {
    const storagePath = temporaryFile()
    writeFileSync(storagePath, JSON.stringify({
      version: 1,
      items: [{
        id: 'legacy-1', content: 'legacy coffee', scope: { ownerId: 'local', agentId: 'deskpet' },
        embedding: [1, 0, 0], embeddingModel: 'test-v1', createdAt: 1, updatedAt: 1,
      }],
    }), 'utf-8')

    const store = createVectorStore({ storagePath, embeddingModel: 'test-v1', embedder: testEmbedder })
    expect(await store.count({ ownerId: 'local', agentId: 'deskpet' })).toBe(1)
    expect(JSON.parse(readFileSync(storagePath, 'utf-8')).version).toBe(3)
  })

  it('migrates the current version 2 index to temporal version 3', async () => {
    const storagePath = temporaryFile()
    const scope = { ownerId: 'local', agentId: 'deskpet' }
    const original = createVectorStore({ storagePath, embedder: testEmbedder })
    await original.remember('用户姓名/名字：小秦', scope, {
      memoryKey: 'profile.name', cardinality: 'single', confidence: 0.95,
    })
    const versionTwo = JSON.parse(readFileSync(storagePath, 'utf-8'))
    versionTwo.version = 2
    for (const item of versionTwo.items) {
      delete item.validFrom
      delete item.validTo
      delete item.invalidatedAt
    }
    writeFileSync(storagePath, JSON.stringify(versionTwo), 'utf-8')

    const migrated = createVectorStore({ storagePath, embedder: testEmbedder })
    expect((await migrated.list(scope))[0]?.validFrom).toEqual(expect.any(Number))
    expect(JSON.parse(readFileSync(storagePath, 'utf-8')).version).toBe(3)
  })

  it('refuses a malformed version 2 index instead of silently dropping records', () => {
    const storagePath = temporaryFile()
    const malformed = JSON.stringify({ version: 2, items: [{ id: 'broken', content: 'keep me visible' }] })
    writeFileSync(storagePath, malformed, 'utf-8')

    expect(() => createVectorStore({ storagePath, embedder: testEmbedder })).toThrow('invalid version 2 item')
    expect(readFileSync(storagePath, 'utf-8')).toBe(malformed)
  })

  it('recalls local semantic field paraphrases and rejects unrelated queries', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'local-semantic', agentId: 'deskpet' }
    await store.remember('用户姓名/名字：林晨', scope, { kind: 'identity' })
    await store.remember('用户过敏信息：花生', scope, { kind: 'health' })
    await store.remember('用户当前项目：星云记账应用', scope, { kind: 'project' })
    await store.remember('用户界面偏好：dark mode', scope, { kind: 'preference' })
    await store.remember('用户工作时间偏好：晚上', scope, { kind: 'routine' })
    await store.remember('用户不喜欢的食物：香菜', scope, { kind: 'preference' })

    const nameRecall = await store.recall('我应该怎样称呼你', scope, 3)
    expect(nameRecall[0]?.content).toContain('林晨')
    expect(nameRecall).toHaveLength(1)
    expect((await store.recall('点外卖时必须避开什么', scope, 3))[0]?.content).toContain('花生')
    expect((await store.recall('手头主要在忙哪个软件', scope, 3))[0]?.content).toContain('星云记账')
    expect((await store.recall('Which interface theme do you like', scope, 3))[0]?.content).toContain('dark mode')
    expect((await store.recall('习惯白天还是夜里办公', scope, 3))[0]?.content).toContain('晚上')
    expect((await store.recall('做菜时不要加哪样东西', scope, 3))[0]?.content).toContain('香菜')
    expect(await store.recall('量子纠缠如何定义', scope, 3)).toEqual([])
  })

  it('recalls durable personal fields through colloquial cross-wording aliases', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'local-semantic-v3', agentId: 'deskpet' }
    const facts = [
      ['用户所在地：杭州滨江', 'identity'],
      ['用户职业：产品设计', 'identity'],
      ['用户当前项目：长期记忆毕业论文', 'project'],
      ['用户伴侣姓名：陈曦', 'relationship'],
      ['用户过敏信息：花生', 'health'],
      ['用户就读院校：浙江大学', 'identity'],
      ['用户常用编程语言：Rust', 'identity'],
      ['用户生日：腊月初八', 'identity'],
      ['用户喜欢的颜色：墨绿色', 'preference'],
    ] as const
    for (const [content, kind] of facts)
      await store.remember(content, scope, { kind })

    expect((await store.recall('现在定居在哪里', scope, 1))[0]?.content).toContain('杭州滨江')
    expect((await store.recall('以前在什么城市生活', scope, 2, { temporalMode: 'historical' }))[0]?.content).toContain('杭州滨江')
    expect((await store.recall('靠什么工作谋生', scope, 1))[0]?.content).toContain('产品设计')
    expect((await store.recall('手头在准备什么', scope, 1))[0]?.content).toContain('毕业论文')
    expect((await store.recall('另一半叫什么', scope, 1))[0]?.content).toContain('陈曦')
    expect((await store.recall('哪些食材要避开', scope, 1))[0]?.content).toContain('花生')
    expect((await store.recall('本科在哪读的', scope, 1))[0]?.content).toContain('浙江大学')
    expect((await store.recall('写代码的技术栈', scope, 1))[0]?.content).toContain('Rust')
    expect((await store.recall('哪天庆生', scope, 1))[0]?.content).toContain('腊月初八')
    expect((await store.recall('选衣服的色系', scope, 1))[0]?.content).toContain('墨绿色')
    expect(await store.recall('明天会不会下雨', scope, 1)).toEqual([])
  })

  it('upgrades an explicitly configured legacy local hash model without remote API use', async () => {
    const store = createVectorStore({ embeddingModel: 'local-hash-v2' })
    const scope = { ownerId: 'legacy-local-hash', agentId: 'deskpet' }
    await store.remember('用户所在地：苏州', scope, { kind: 'identity' })

    expect((await store.recall('现在定居在哪里', scope, 1))[0]?.content).toContain('苏州')
  })

  it('prepares an alternate model off the recall path and switches without re-embedding documents', async () => {
    const memoryPath = temporaryFile()
    const embeddingPath = temporaryFile()
    const scope = { ownerId: 'background-semantic', agentId: 'deskpet' }
    const sideIndex = createMemoryEmbeddingIndex({ persistence: createFilePersistence(embeddingPath) })
    const hashStore = createVectorStore({ storagePath: memoryPath, embeddingIndex: sideIndex })
    await hashStore.remember('用户所在地：杭州滨江', scope, { kind: 'identity' })
    await hashStore.remember('用户喜欢听爵士乐', scope, { kind: 'preference' })

    const calls: string[] = []
    const bgeEmbedder = async (text: string) => {
      calls.push(text)
      return text.includes('所在地') || text.includes('定居') ? [1, 0] : [0, 1]
    }
    expect(hashStore.embeddingStatus('test-bge-v1', scope)).toMatchObject({ total: 2, ready: 0, pending: 2 })
    const progress: number[] = []
    await expect(hashStore.prepareEmbeddings('test-bge-v1', bgeEmbedder, scope, {
      batchSize: 1,
      onProgress: state => progress.push(state.ready),
    })).resolves.toMatchObject({ total: 2, ready: 2, pending: 0 })
    expect(calls).toHaveLength(2)
    expect(progress.at(-1)).toBe(2)

    calls.splice(0)
    const semanticStore = createVectorStore({
      storagePath: memoryPath,
      embeddingModel: 'test-bge-v1',
      embedder: bgeEmbedder,
      embeddingIndex: createMemoryEmbeddingIndex({ persistence: createFilePersistence(embeddingPath) }),
      foregroundEmbeddingUpgrade: false,
      minScore: 0,
      minSemanticScore: 0.1,
    })
    expect((await semanticStore.recall('现在定居在哪里', scope, 1))[0]?.content).toContain('杭州滨江')
    expect(calls).toEqual(['现在定居在哪里'])
  })

  it('invalidates prepared vectors when content changes and removes them on purge', async () => {
    const sideIndex = createMemoryEmbeddingIndex()
    const store = createVectorStore({ embeddingIndex: sideIndex })
    const scope = { ownerId: 'semantic-lifecycle', agentId: 'deskpet' }
    const remembered = await store.remember('用户所在地：杭州', scope)
    await store.prepareEmbeddings('test-bge-v1', async () => [1, 0], scope)
    expect(sideIndex.hasMemory(remembered!.id)).toBe(true)

    await store.update(remembered!.id, scope, { content: '用户所在地：上海' })
    expect(sideIndex.get(remembered!.id, 'test-bge-v1', '用户所在地：上海')).toBeUndefined()
    await store.prepareEmbeddings('test-bge-v1', async () => [0, 1], scope)
    expect(sideIndex.hasMemory(remembered!.id)).toBe(true)

    await store.purge(remembered!.id, scope)
    expect(sideIndex.hasMemory(remembered!.id)).toBe(false)
  })

  it('deduplicates equivalent fact wording without merging opposite preferences', async () => {
    const store = createVectorStore()
    const scope = { ownerId: 'semantic-dedupe', agentId: 'deskpet' }
    await store.remember('用户喜欢：爵士乐', scope, { kind: 'preference' })
    await store.remember('用户偏爱爵士音乐', scope, { kind: 'preference' })
    await store.remember('用户喜欢：香菜', scope, { kind: 'preference' })
    await store.remember('用户不喜欢：香菜', scope, { kind: 'preference' })

    const items = await store.list(scope)
    expect(items.filter(item => item.content.includes('爵士'))).toHaveLength(1)
    expect(items.filter(item => item.content.includes('香菜'))).toHaveLength(2)
  })
})

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'deskpet-memory-'))
  temporaryDirectories.push(directory)
  return join(directory, 'memories.json')
}

async function testEmbedder(text: string): Promise<number[]> {
  const normalized = text.toLocaleLowerCase()
  if (normalized.includes('coffee'))
    return [1, 0, 0]
  if (normalized.includes('tea'))
    return [0, 1, 0]
  return [0, 0, 1]
}

async function relevanceEmbedder(text: string): Promise<number[]> {
  return text.includes('咖啡') ? [1, 0] : [0, 1]
}

async function sharedEmbedder(text: string): Promise<number[]> {
  return /shared|coffee|preferred|likes/i.test(text) ? [1, 0] : [0, 1]
}

async function temporalEmbedder(text: string): Promise<number[]> {
  if (text.includes('北京') || text.includes('以前') || text.includes('2024'))
    return [1, 0, 0]
  if (text.includes('上海') || text.includes('当前') || text.includes('现在'))
    return [0, 1, 0]
  return [0, 0, 1]
}

function createTestVector(text: string): number[] {
  let hash = 0
  for (const char of text)
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return [1, (hash % 17) / 17, (hash % 31) / 31]
}
