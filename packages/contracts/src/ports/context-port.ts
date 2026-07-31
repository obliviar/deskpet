import type { ContextMessage } from '../types/context'

/**
 * Context intake boundary.
 *
 * External systems (app state, sensors, game state, ...) push context
 * envelopes here; the runtime snapshots them into the prompt at send time.
 */
export interface AgentContextPort {
  /** Ingest a context envelope tagged by its source. */
  ingest: (envelope: ContextMessage) => void
  /** Snapshot all context grouped by source for prompt injection. */
  snapshot: () => Record<string, ContextMessage[]>
  /** Clear all context. */
  reset: () => void
}
