import type { AgentContextPort, ContextMessage } from '@deskpet/contracts'

/**
 * In-memory context registry implementing AgentContextPort.
 *
 * Context sources push envelopes tagged by `source`; the runtime snapshots
 * them grouped by source at send time to inject into the system prompt.
 */
export function createContextRegistry(): AgentContextPort {
  const registry = new Map<string, ContextMessage[]>()

  return {
    ingest(envelope) {
      const list = registry.get(envelope.source) ?? []
      list.push(envelope)
      // Keep only the latest N entries per source to avoid unbounded growth.
      if (list.length > 50)
        list.splice(0, list.length - 50)
      registry.set(envelope.source, list)
    },
    snapshot() {
      const out: Record<string, ContextMessage[]> = {}
      for (const [source, list] of registry)
        out[source] = [...list]
      return out
    },
    reset() {
      registry.clear()
    },
  }
}
