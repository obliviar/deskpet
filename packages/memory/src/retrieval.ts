import type { MemoryFragment } from '@deskpet/contracts'

/**
 * RAG retrieval strategy: picks the most relevant memories for a query.
 *
 * Options control how memories are selected and formatted for the prompt.
 */
export interface RetrievalOptions {
  /** Minimum relevance score threshold in [0, 1]. Memories below this are filtered out. */
  minScore?: number
  /** Maximum context length for the combined memory text. */
  maxContextLength?: number
}

/**
 * Filters and formats recalled memories into a single context string.
 */
export function formatMemoriesForPrompt(
  fragments: MemoryFragment[],
  options: RetrievalOptions = {},
): { formatted: string; used: MemoryFragment[] } {
  const { minScore = 0, maxContextLength = 2000 } = options

  const relevant = fragments
    .filter(f => (f.score ?? 1) >= minScore)
    .slice(0, 10)

  const used: MemoryFragment[] = []
  const parts: string[] = []

  for (const f of relevant) {
    const line = `- ${f.content}`
    const candidate = [...parts, line].join('\n')
    if (candidate.length > maxContextLength)
      break
    parts.push(line)
    used.push(f)
  }

  return { formatted: parts.join('\n'), used }
}