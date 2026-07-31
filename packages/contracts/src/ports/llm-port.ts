import type { ChatMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'

/**
 * LLM streaming boundary.
 *
 * Implementations translate this into a specific provider call (OpenAI,
 * Anthropic, local, ...) and yield normalized stream events.
 */
export interface AgentLLMPort {
  /**
   * Stream a completion for the given messages.
   *
   * @param model  Provider model identifier, e.g. `gpt-4o`.
   * @param messages Normalized chat messages forming the prompt.
   * @param options Tools, temperature, max tokens, provider passthrough.
   * @returns An async iterable of normalized stream events.
   */
  stream(
    model: string,
    messages: ChatMessage[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent>
}
