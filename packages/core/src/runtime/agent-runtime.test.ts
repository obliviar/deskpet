import type {
  AgentLLMPort,
  AgentMemoryPort,
  ChatMessage,
  MemoryCapture,
  MemoryScope,
  StreamEvent,
} from '@deskpet/contracts'
import { describe, expect, it } from 'vitest'
import { createSessionManager } from '../session/session-manager'
import { createAgentRuntime } from './agent-runtime'

describe('agent runtime memory safety', () => {
  it('sends current image attachments to the model without persisting base64 in session history', async () => {
    const observed: ChatMessage[][] = []
    const session = createSessionManager(10)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }], observed),
      session,
    })

    await runtime.send('s', '看看这张图', {
      attachments: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }],
      input: { type: 'image' },
    })

    const sentUser = observed[0]?.find(message => message.role === 'user')
    expect(sentUser?.content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image', data: 'base64-image', mimeType: 'image/png' },
    ])
    expect(session.getSessionMessages('s')[0]?.content).toBe('看看这张图')
  })

  it('commits user facts even when the model request fails', async () => {
    const memory = createMemorySpy()
    const session = createSessionManager(10)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'error', error: new Error('offline') }]),
      session,
      memory: memory.port,
    })

    await expect(runtime.send('s', '我叫小秦')).rejects.toThrow('offline')
    expect(memory.captures).toHaveLength(1)
    expect(memory.captures[0]?.assistantMessage).toBe('')
    expect(memory.captures[0]?.metadata?.sourceMessageIds).toHaveLength(1)
    expect(session.getSessionMessages('s').map(message => message.role)).toEqual(['user'])
  })

  it('keeps long-term sources when the bounded session only evicts old messages', async () => {
    const memory = createMemorySpy()
    const session = createSessionManager(2)
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }]),
      session,
      memory: memory.port,
    })

    await runtime.send('s', 'first')
    const firstTurnIds = session.getSessionMessages('s').map(message => message.id)
    await runtime.send('s', 'second')

    expect(firstTurnIds).toHaveLength(2)
    expect(memory.unlinked).toEqual([])
    expect(session.getSessionMessages('s').map(message => message.content)).toEqual(['second', 'ok'])
  })

  it('uses adaptive recall by default and fixed recall when memoryTopK is explicit', async () => {
    const calls: string[] = []
    const memory = createMemorySpy()
    memory.port.recall = async (_query, _scope, topK) => {
      calls.push(`fixed:${String(topK)}`)
      return []
    }
    memory.port.recallAdaptive = async () => {
      calls.push('adaptive')
      return {
        memories: [], retrievedMemoryIds: [], injectedMemoryIds: [],
        candidateCount: 0, evaluatedCount: 0, batchesEvaluated: 0,
        stopReason: 'no-candidates',
      }
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test' },
      llm: createLlm([{ type: 'text-delta', text: 'ok' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('adaptive-session', 'first')
    await runtime.send('fixed-session', 'second', { memoryTopK: 7 })

    expect(calls).toEqual(['adaptive', 'fixed:7'])
  })

  it('reports adopted and ignored citation outcomes after the answer completes', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [
        { id: 'memory-1', content: '用户姓名：小秦', createdAt: 1 },
        { id: 'memory-2', content: '用户所在地：北京', createdAt: 1 },
      ],
      retrievedMemoryIds: ['memory-1', 'memory-2'],
      injectedMemoryIds: ['memory-1', 'memory-2'],
      candidateCount: 2,
      evaluatedCount: 2,
      batchesEvaluated: 1,
      stopReason: 'max-injected',
      evidencePack: [
        { memoryId: 'memory-1', citation: 'M1' },
        { memoryId: 'memory-2', citation: 'M2' },
      ],
    })
    const reports: unknown[] = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const observed: ChatMessage[][] = []
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '你叫小秦 [M1]。' }], observed),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '我叫什么名字')

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      query: '我叫什么名字',
      answerModel: 'test-model',
      outcomes: [
        { memoryId: 'memory-1', outcome: 'adopted' },
        { memoryId: 'memory-2', outcome: 'ignored' },
      ],
    })
    const system = observed[0]?.find(message => message.role === 'system')?.content
    expect(system).toContain('id="M1"')
    expect(system).toContain('bracketed id')
  })

  it('records an explicit uniquely matched user correction without treating other memories as denied', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [
        { id: 'memory-city', content: '用户所在地：北京', createdAt: 1 },
        { id: 'memory-drink', content: '用户喜欢咖啡', createdAt: 1 },
      ],
      retrievedMemoryIds: ['memory-city', 'memory-drink'],
      injectedMemoryIds: ['memory-city', 'memory-drink'],
      candidateCount: 2, evaluatedCount: 2, batchesEvaluated: 1, stopReason: 'max-injected',
      evidencePack: [
        { memoryId: 'memory-city', citation: 'M1' },
        { memoryId: 'memory-drink', citation: 'M2' },
      ],
    })
    const reports: Array<{ outcomes: Array<{ memoryId: string; outcome: string }> }> = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '明白，已经更正。[M1]' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '不是北京而是杭州，请更正我的所在地')

    expect(reports[0]?.outcomes).toEqual([
      { memoryId: 'memory-city', outcome: 'corrected' },
      { memoryId: 'memory-drink', outcome: 'ignored' },
    ])
  })

  it('records only a strong explicit denial that uniquely matches injected evidence', async () => {
    const memory = createMemorySpy()
    memory.port.recallAdaptive = async () => ({
      memories: [{ id: 'memory-allergy', content: '用户对花生过敏', createdAt: 1 }],
      retrievedMemoryIds: ['memory-allergy'], injectedMemoryIds: ['memory-allergy'],
      candidateCount: 1, evaluatedCount: 1, batchesEvaluated: 1, stopReason: 'max-injected',
      evidencePack: [{ memoryId: 'memory-allergy', citation: 'M1' }],
    })
    const reports: Array<{ outcomes: Array<{ memoryId: string; outcome: string }> }> = []
    memory.port.reportRecallFeedback = async (report) => {
      reports.push(report)
    }
    const runtime = createAgentRuntime({
      persona: { systemPrompt: 'test', model: 'test-model' },
      llm: createLlm([{ type: 'text-delta', text: '我会按你的要求处理。' }]),
      session: createSessionManager(10),
      memory: memory.port,
    })

    await runtime.send('s', '我从来没说过我对花生过敏，删除这条记忆')

    expect(reports[0]?.outcomes).toEqual([{ memoryId: 'memory-allergy', outcome: 'denied' }])
  })
})

function createLlm(events: StreamEvent[], observed: ChatMessage[][] = []): AgentLLMPort {
  return {
    async *stream(_model, messages) {
      observed.push(messages)
      for (const event of events)
        yield event
    },
  }
}

function createMemorySpy() {
  const captures: MemoryCapture[] = []
  const unlinked: string[][] = []
  const port: AgentMemoryPort = {
    async list() { return [] },
    async recall() { return [] },
    async remember() {},
    async capture(turn) {
      captures.push(turn)
      return 0
    },
    async forget() {},
    async update() { return true },
    async restore() { return true },
    async unlinkSources(messageIds: string[], _scope: MemoryScope) {
      unlinked.push(messageIds)
      return { updated: messageIds.length, orphaned: messageIds.length }
    },
    async clear() {},
    async count() { return 0 },
  }
  return { captures, unlinked, port }
}
