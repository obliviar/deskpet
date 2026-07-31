import type { StreamEvent, ToolCall } from '@deskpet/contracts'

/**
 * Aggregates incremental stream events into a structured response.
 *
 * Handles accumulation of text-delta into full content and
 * tool-call-delta into complete tool call objects.
 */
export function createResponseParser() {
  let content = ''
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

  function ingest(event: StreamEvent) {
    switch (event.type) {
      case 'text-delta':
        content += event.text
        break
      case 'tool-call-delta': {
        let idx = 0
        while (toolCalls.has(idx))
          idx++
        const existing = toolCalls.get(idx)
        toolCalls.set(idx, {
          id: existing?.id ?? event.id,
          name: existing?.name ? existing.name + event.name : event.name,
          arguments: (existing?.arguments ?? '') + event.argumentsDelta,
        })
        break
      }
    }
  }

  function finalize(): { content: string; toolCalls: ToolCall[] } {
    const calls: ToolCall[] = [...toolCalls.values()].map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }))
    return { content, toolCalls: calls }
  }

  function reset() {
    content = ''
    toolCalls.clear()
  }

  return { ingest, finalize, reset }
}