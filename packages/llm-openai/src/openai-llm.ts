import type { AgentLLMPort, ChatMessage, StreamEvent, StreamOptions } from '@deskpet/contracts'
import OpenAI from 'openai'
import type { ProviderConfig } from './providers'
import { resolveProvider } from './providers'

/**
 * OpenAI implementation of AgentLLMPort.
 *
 * Translates normalized ChatMessage[] into OpenAI chat completions streaming
 * and yields normalized StreamEvent items that the runtime consumes.
 */
export function createOpenAILlm(config: ProviderConfig): AgentLLMPort {
  const { apiKey, baseURL } = resolveProvider(config)
  const client = new OpenAI({ apiKey, baseURL })

  return {
    async *stream(model, messages, options = {}): AsyncIterable<StreamEvent> {
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: messages.map(toOpenAIMessage),
          tools: options.tools?.map(t => ({ type: 'function' as const, function: t.function })),
          tool_choice: options.toolChoice as any,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens,
          stream: true,
          ...options.providerOptions,
        })

        const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta

          if (delta?.content) {
            yield { type: 'text-delta', text: delta.content }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!pendingToolCalls.has(idx)) {
                pendingToolCalls.set(idx, { id: tc.id || '', name: '', arguments: '' })
              }
              const entry = pendingToolCalls.get(idx)!
              if (tc.id)
                entry.id = tc.id
              if (tc.function?.name)
                entry.name = tc.function.name
              if (tc.function?.arguments)
                entry.arguments += tc.function.arguments
            }
          }

          if (chunk.choices[0]?.finish_reason) {
            for (const [, tc] of pendingToolCalls) {
              if (tc.id) {
                yield { type: 'tool-call', id: tc.id, name: tc.name, arguments: tc.arguments }
              }
            }
            yield {
              type: 'finish',
              reason: chunk.choices[0].finish_reason === 'tool_calls'
                ? 'tool-calls'
                : chunk.choices[0].finish_reason === 'length'
                  ? 'length'
                  : 'stop',
            }
          }
        }
      }
      catch (err) {
        yield { type: 'error', error: err }
      }
    },
  }
}

function toOpenAIMessage(m: ChatMessage): any {
  const content = typeof m.content === 'string'
    ? m.content
    : m.content.map(p => {
        if (p.type === 'text')
          return { type: 'text' as const, text: p.text }
        return { type: 'image_url' as const, image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
      })

  const result: Record<string, unknown> = { role: m.role, content }

  if (m.toolCalls) {
    result.tool_calls = m.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }))
  }
  if (m.toolCallId)
    result.tool_call_id = m.toolCallId
  if (m.name)
    result.name = m.name

  return result
}