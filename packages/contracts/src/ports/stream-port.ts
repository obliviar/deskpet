import type { StreamingAssistantMessage } from '../types/chat'

/**
 * Foreground stream output boundary.
 *
 * Lets the runtime push incremental assistant message updates without
 * knowing whether they render to a CLI, a web UI, or a chat platform.
 */
export interface AgentForegroundStreamPort {
  /** Patch the current streaming assistant message. */
  patch: (message: StreamingAssistantMessage) => void
  /** Reset the foreground stream state for a new turn. */
  reset: () => void
}
