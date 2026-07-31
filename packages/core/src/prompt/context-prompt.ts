import type { ContextMessage } from '@deskpet/contracts'

/**
 * Formats context entries into a concise text block for prompt injection.
 */
export function formatContextPromptText(contexts: Record<string, ContextMessage[]>): string {
  const parts: string[] = []
  for (const [source, entries] of Object.entries(contexts)) {
    if (entries.length === 0)
      continue
    parts.push(`[${source}]`)
    for (const e of entries)
      parts.push(e.content)
  }
  return parts.join('\n')
}

/** Formats a datetime prefix for context timestamps. */
export function formatTimePrefix(ts: number): string {
  return new Date(ts).toISOString()
}
