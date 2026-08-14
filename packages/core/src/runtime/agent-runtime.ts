import type {
  AgentContextPort,
  AgentForegroundStreamPort,
  AgentLLMPort,
  AgentMemoryPort,
  MemoryScope,
  AgentSessionPort,
  AgentToolPort,
  ChatHookRegistry,
  ChatHistoryItem,
  ChatMessage,
  ChatStreamEventContext,
  StreamEvent,
  StreamingAssistantMessage,
  ToolCall,
} from '@deskpet/contracts'

import { createChatHooks } from './hooks'
import { buildSystemPrompt } from '../prompt/system-prompt'

/** Persona/character configuration for the agent. */
export interface AgentPersona {
  /** Base system prompt describing the character identity. */
  systemPrompt: string
  /** Default model identifier to use when none is provided per-send. */
  model: string
  /** Optional extra dynamic instructions appended to the system prompt. */
  extraInstructions?: string[]
}

/** Dependencies injected into the runtime — all are Port interfaces. */
export interface AgentRuntimeDeps {
  persona: AgentPersona
  llm: AgentLLMPort
  session: AgentSessionPort
  context?: AgentContextPort
  memory?: AgentMemoryPort
  /** Resolve a stable, isolated memory owner for a session. */
  resolveMemoryScope?: (sessionId: string) => MemoryScope
  tools?: AgentToolPort
  stream?: AgentForegroundStreamPort
  hooks?: ChatHookRegistry
}

/** Options for a single send. */
export interface AgentSendOptions {
  /** Override the persona's default model. */
  model?: string
  /** Image attachments appended to the user message content parts. */
  attachments?: { type: 'image'; data: string; mimeType: string }[]
  /** Transport input metadata. */
  input?: { type: 'text' | 'voice' | 'image' }
  /** Fixed legacy recall size. Omit it to use adaptive batched recall. */
  memoryTopK?: number
}

/** Result of a completed chat turn. */
export interface AgentTurnResult {
  text: string
  toolCalls: ToolCall[]
}

/**
 * Creates the agent runtime that orchestrates a complete chat turn.
 *
 * Call stack for one turn:
 *
 *   send(sessionId, message)
 *     -> recall memories (memory port)
 *     -> build system prompt (persona + memories + context)
 *     -> stream completion (llm port)
 *       -> for each token: patch foreground stream, emit token hooks
 *     -> if tool calls: execute (tool port), append results, recurse
 *     -> append assistant message, emit after-send hooks
 */
export function createAgentRuntime(deps: AgentRuntimeDeps) {
  const hooks = deps.hooks ?? createChatHooks()
  const maxToolRounds = 5

  async function runLLMRound(
    sessionId: string,
    messages: ChatMessage[],
    model: string,
    ctx: ChatStreamEventContext,
  ): Promise<AgentTurnResult> {
    const streamOpts = deps.tools && deps.tools.hasTools()
      ? { tools: deps.tools.definitions() }
      : undefined

    let assistantText = ''
    const toolCalls: ToolCall[] = []
    const assistantId = crypto.randomUUID()
    const streaming: StreamingAssistantMessage = { id: assistantId, role: 'assistant', content: '', done: false }
    deps.stream?.reset()

    for await (const event of deps.llm.stream(model, messages, streamOpts)) {
      await handleStreamEvent(event, streaming, toolCalls, ctx)
    }

    assistantText = streaming.content
    streaming.toolCalls = toolCalls.length > 0 ? toolCalls : undefined
    streaming.done = true
    deps.stream?.patch(streaming)
    await hooks.emitStreamEndHooks(ctx)
    await hooks.emitAssistantMessageHooks(streaming, assistantText, ctx)

    return { text: assistantText, toolCalls }
  }

  async function handleStreamEvent(
    event: StreamEvent,
    streaming: StreamingAssistantMessage,
    toolCalls: ToolCall[],
    ctx: ChatStreamEventContext,
  ): Promise<void> {
    switch (event.type) {
      case 'text-delta': {
        streaming.content += event.text
        deps.stream?.patch({ ...streaming })
        await hooks.emitTokenLiteralHooks(event.text, ctx)
        break
      }
      case 'tool-call': {
        toolCalls.push({
          id: event.id,
          type: 'function',
          function: { name: event.name, arguments: event.arguments },
        })
        break
      }
      case 'error': {
        console.error('[deskpet] stream error:', event.error)
        throw event.error instanceof Error ? event.error : new Error(String(event.error))
      }
    }
  }

  async function executeToolCalls(
    sessionId: string,
    toolCalls: ToolCall[],
    ctx: ChatStreamEventContext,
  ): Promise<ChatMessage[]> {
    if (!deps.tools || toolCalls.length === 0)
      return []

    const results: ChatMessage[] = []
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      }
      catch {
        args = {}
      }
      const result = await deps.tools.execute(call.function.name, args, { sessionId })
      results.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        name: call.function.name,
      })
    }
    return results
  }

  function appendSessionMessage(sessionId: string, item: ChatHistoryItem): void {
    // A bounded session may evict old messages only to control the active
    // context size. That retention event is not a user deletion: durable facts
    // must keep their provenance and remain recallable. Explicit chat deletion
    // and editing are handled by the application through memory.unlinkSources.
    deps.session.appendSessionMessage(sessionId, item)
  }

  /** Execute one chat turn: user message -> assistant response (with tool rounds). */
  async function send(
    sessionId: string,
    userMessage: string,
    options?: AgentSendOptions,
  ): Promise<AgentTurnResult> {
    deps.session.ensureSession(sessionId)
    const generation = deps.session.getSessionGeneration(sessionId)
    const ctx: ChatStreamEventContext = {
      sessionId,
      generation,
      input: options?.input ?? { type: 'text' },
    }

    const model = options?.model ?? deps.persona.model
    const memoryScope = deps.resolveMemoryScope?.(sessionId) ?? { ownerId: sessionId, agentId: 'default' }
    await hooks.emitBeforeMessageComposedHooks(userMessage, ctx)

    const memoryContext = buildMemoryCaptureContext(deps.session.getSessionMessages(sessionId))

    // Build the user message content (possibly multimodal).
    const userContent: ChatMessage['content'] = options?.attachments && options.attachments.length > 0
      ? [{ type: 'text', text: userMessage }, ...options.attachments]
      : userMessage

    // Persist the user message.
    const userItem: ChatHistoryItem = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      createdAt: Date.now(),
    }
    appendSessionMessage(sessionId, userItem)

    // Recall long-term memories relevant to this message.
    let memories
    if (deps.memory) {
      try {
        memories = options?.memoryTopK !== undefined || !deps.memory.recallAdaptive
          ? await deps.memory.recall(userMessage, memoryScope, options?.memoryTopK ?? 5)
          : (await deps.memory.recallAdaptive(userMessage, memoryScope)).memories
      }
      catch (err) {
        console.error('[deskpet] memory recall failed:', err)
      }
    }

    // Start durable fact extraction before the model call so an API failure
    // cannot discard facts from the user's message. Provider failures are
    // handled inside the configured extractor and this promise never rejects.
    const capturePromise = deps.memory
      ? deps.memory.capture({
          userMessage,
          assistantMessage: '',
          context: memoryContext,
          attachments: options?.attachments,
          metadata: {
            sessionId,
            sourceMessageIds: [userItem.id],
            inputType: ctx.input?.type ?? 'text',
          },
        }, memoryScope).catch((err) => {
          console.error('[deskpet] memory write failed:', err)
          return 0
        })
      : Promise.resolve(0)

    // Assemble the system prompt.
    const systemPrompt = buildSystemPrompt({
      persona: deps.persona.systemPrompt,
      memories,
      contexts: deps.context?.snapshot(),
      extra: deps.persona.extraInstructions,
    })

    // Assemble the full message list from history.
    const history = deps.session.getSessionMessages(sessionId)
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({
        role: h.role,
        content: h.id === userItem.id ? userContent : h.content,
        toolCallId: h.toolCallId,
        toolCalls: h.toolCalls,
        name: h.name,
      })),
    ]

    try {
      await hooks.emitAfterMessageComposedHooks(userMessage, ctx)
      await hooks.emitBeforeSendHooks(userMessage, ctx)

      // Run LLM rounds, executing tools until no more tool calls or limit reached.
      let round = 0
      let result: AgentTurnResult = { text: '', toolCalls: [] }
      let currentMessages = messages

      while (round <= maxToolRounds) {
        result = await runLLMRound(sessionId, currentMessages, model, ctx)

        if (result.toolCalls.length === 0)
          break

        // Append assistant message with tool calls, then tool results.
        currentMessages = [
          ...currentMessages,
          {
            role: 'assistant' as const,
            content: result.text,
            toolCalls: result.toolCalls,
          },
        ]
        const toolResults = await executeToolCalls(sessionId, result.toolCalls, ctx)
        currentMessages = [...currentMessages, ...toolResults]
        round++
      }

      // Commit the user fact before persisting the completed assistant turn.
      await capturePromise

      // Persist the final assistant message.
      const assistantItem: ChatHistoryItem = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        createdAt: Date.now(),
      }
      appendSessionMessage(sessionId, assistantItem)

      await hooks.emitAfterSendHooks(result.text, ctx)
      return result
    }
    finally {
      await capturePromise
    }
  }

  return { send, hooks }
}

function buildMemoryCaptureContext(history: ChatHistoryItem[]): NonNullable<import('@deskpet/contracts').MemoryCapture['context']> {
  const messages = history
    .filter((item): item is ChatHistoryItem & { role: 'user' | 'assistant' } =>
      item.role === 'user' || item.role === 'assistant')
    .slice(-6)
  let remaining = 2400
  const bounded = messages.reverse().flatMap((item) => {
    if (remaining <= 0)
      return []
    const content = item.content.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(-Math.min(600, remaining))
    remaining -= content.length
    return content ? [{ id: item.id, role: item.role, content, createdAt: item.createdAt }] : []
  }).reverse()
  return { recentMessages: bounded, ...(bounded.length > 0 ? { topicSummary: summarizeLocalTopics(bounded.map(item => item.content)) } : {}) }
}

function summarizeLocalTopics(contents: string[]): string {
  const stop = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '还是', 'please', 'about', 'that', 'this', 'with'])
  const counts = new Map<string, number>()
  for (const content of contents) {
    const tokens = content.normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Han}]{2,6}|[a-z][a-z0-9+#.-]{2,}/gu) ?? []
    for (const token of tokens) {
      if (!stop.has(token))
        counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([token]) => token)
    .join('、')
    .slice(0, 200)
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>
