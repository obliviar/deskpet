import type { AgentToolPort, ToolDefinition, ToolExecutionContext, ToolHandler, ToolResult } from '@deskpet/contracts'

/**
 * Tool registry implementing AgentToolPort.
 *
 * Tools are registered by name; definitions are passed to the model.
 * The runtime calls execute() which delegates to the matching handler.
 */
export function createToolRegistry(handlers: ToolHandler[] = []): AgentToolPort {
  const registry = new Map<string, ToolHandler>()

  for (const h of handlers)
    registry.set(h.name, h)

  return {
    definitions(): ToolDefinition[] {
      return [...registry.values()].map(h => ({
        type: 'function',
        function: {
          name: h.name,
          description: h.description,
          parameters: h.parameters,
        },
      }))
    },

    async execute(name, args, context): Promise<ToolResult> {
      const handler = registry.get(name)
      if (!handler) {
        return {
          toolCallId: '',
          content: JSON.stringify({ error: `tool not found: ${name}` }),
          isError: true,
        }
      }
      try {
        const content = await handler.execute(args, context)
        return { toolCallId: '', content }
      }
      catch (err) {
        return {
          toolCallId: '',
          content: JSON.stringify({ error: err instanceof Error ? err.message : 'tool execution failed' }),
          isError: true,
        }
      }
    },

    hasTools(): boolean {
      return registry.size > 0
    },
  }
}