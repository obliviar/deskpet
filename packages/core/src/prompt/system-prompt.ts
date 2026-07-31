import type { ContextMessage, MemoryFragment } from '@deskpet/contracts'

/** Character/system prompt configuration assembled at send time. */
export interface SystemPromptInput {
  /** Base persona instructions. */
  persona: string
  /** Optional recalled long-term memories. */
  memories?: MemoryFragment[]
  /** Optional live context snapshots grouped by source. */
  contexts?: Record<string, ContextMessage[]>
  /** Optional dynamic extra instructions. */
  extra?: string[]
}

/**
 * Assembles the final system prompt from persona, memories, context and extras.
 *
 * Order matters: persona first (sets identity), then memories (sets prior
 * knowledge), then live context (sets current situation), then extras.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = [input.persona]

  if (input.memories && input.memories.length > 0) {
    parts.push('\n## Relevant memories')
    for (const m of input.memories)
      parts.push(`- ${m.content}`)
  }

  if (input.contexts) {
    for (const [source, entries] of Object.entries(input.contexts)) {
      if (entries.length === 0)
        continue
      parts.push(`\n## Context: ${source}`)
      for (const e of entries)
        parts.push(`- ${e.content}`)
    }
  }

  if (input.extra) {
    for (const e of input.extra)
      parts.push(`\n${e}`)
  }

  return parts.join('\n')
}
