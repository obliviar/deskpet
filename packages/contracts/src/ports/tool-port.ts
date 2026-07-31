import type { ToolDefinition, ToolResult } from '../types/tool'
import type { ToolExecutionContext } from '../types/tool'

/**
 * Tool registry and execution boundary.
 *
 * The runtime queries definitions to pass to the model and delegates
 * execution back to the registry, keeping tool wiring out of core.
 */
export interface AgentToolPort {
  /** List all registered tool definitions for the model. */
  definitions: () => ToolDefinition[]
  /** Execute a tool call by name with serialized arguments. */
  execute: (name: string, args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>
  /** Whether any tools are registered. */
  hasTools: () => boolean
}
