/**
 * Tool definition and result types.
 *
 * Tools are described with a JSON Schema parameters object so any provider
 * accepting OpenAI-style function calling can consume them.
 */

/** A tool definition ready to be sent to the model. */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Result returned by a tool executor. */
export interface ToolResult {
  /** The tool call id this result answers. */
  toolCallId: string
  /** Serialized result content, usually JSON. */
  content: string
  /** Whether the tool execution failed. */
  isError?: boolean
}

/** A handler function that executes a single tool call. */
export type ToolHandler = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>
}

/** Optional context handed to tool handlers. */
export interface ToolExecutionContext {
  sessionId: string
}
