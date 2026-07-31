/**
 * LLM streaming event and option types.
 *
 * The runtime consumes a normalized async iterable of these events so it does
 * not depend on any provider SDK's stream shape.
 */

/** A normalized event emitted while streaming a completion. */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; id: string; name: string; argumentsDelta: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' }
  | { type: 'error'; error: unknown }

/** Options passed to the LLM port for a single stream request. */
export interface StreamOptions {
  /** Tool definitions exposed to the model. */
  tools?: ToolDefinitionRef[]
  /** Force a specific tool or let the model decide. */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string }
  /** Sampling temperature. */
  temperature?: number
  /** Maximum output tokens. */
  maxTokens?: number
  /** Provider-specific passthrough options. */
  providerOptions?: Record<string, unknown>
}

/** Minimal tool definition reference used by the stream options. */
export interface ToolDefinitionRef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
