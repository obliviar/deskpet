export const MEMORY_RRF_VERSION = 'memory-rrf-v1'

export interface MemoryRankedRouteItem<T> {
  id: string
  item: T
}

export interface MemoryRankedRoute<T> {
  name: string
  items: MemoryRankedRouteItem<T>[]
}

export interface MemoryRrfResult<T> {
  id: string
  item: T
  score: number
  normalizedScore: number
  routes: string[]
  routeRanks: Record<string, number>
}

/** Combine incompatible retrieval scores by rank, not by raw score scale. */
export function reciprocalRankFusion<T>(
  routes: readonly MemoryRankedRoute<T>[],
  options: { rankConstant?: number; windowSize?: number } = {},
): MemoryRrfResult<T>[] {
  const rankConstant = clampInteger(options.rankConstant, 1, 1000, 60)
  const windowSize = clampInteger(options.windowSize, 1, 10_000, 100)
  const fused = new Map<string, {
    item: T
    score: number
    routes: string[]
    routeRanks: Record<string, number>
  }>()

  for (const route of routes) {
    const seen = new Set<string>()
    for (const [offset, entry] of route.items.slice(0, windowSize).entries()) {
      if (seen.has(entry.id))
        continue
      seen.add(entry.id)
      const rank = offset + 1
      const current = fused.get(entry.id) ?? { item: entry.item, score: 0, routes: [], routeRanks: {} }
      current.score += 1 / (rankConstant + rank)
      current.routes.push(route.name)
      current.routeRanks[route.name] = rank
      fused.set(entry.id, current)
    }
  }

  const ordered = [...fused.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const best = ordered[0]?.score ?? 0
  return ordered.map(entry => ({
    ...entry,
    normalizedScore: best > 0 ? entry.score / best : 0,
  }))
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}
