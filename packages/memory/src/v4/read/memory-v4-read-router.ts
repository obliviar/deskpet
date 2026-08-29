import type {
  AdaptiveMemoryRecallOptions,
  AdaptiveMemoryRecallResult,
  MemoryScope,
} from '@deskpet/contracts'
import type {
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
} from '../retrieval/memory-v4-shadow-retriever'
import {
  buildMemoryV4EvidenceBundle,
  memoryV4EvidenceBundleToAdaptiveResult,
  type MemoryV4EvidenceBundle,
} from './memory-v4-evidence-bundle'

export const MEMORY_V4_READ_ROUTER_VERSION = 'memory-v4-read-router-v1'

export type MemoryV4ReadMode = 'v3' | 'v4-beta' | 'auto'
export type MemoryV4ReadSource = 'v3' | 'v4'
export type MemoryV4ReadFallbackReason = 'v4-unavailable' | 'v4-not-ready'
  | 'v4-error' | 'v4-empty' | 'v4-abstained'

export interface MemoryV4ReadDecision {
  version: typeof MEMORY_V4_READ_ROUTER_VERSION
  requestedMode: MemoryV4ReadMode
  authoritativeReadSource: MemoryV4ReadSource
  result: AdaptiveMemoryRecallResult
  evidenceBundle?: MemoryV4EvidenceBundle
  fallbackReason?: MemoryV4ReadFallbackReason
  latencyMs: number
}

/** Ephemeral callback context. Routers do not retain or expose it in status. */
export interface MemoryV4ReadDecisionContext {
  query: string
  scope: MemoryScope
}

export interface MemoryV4ReadRouter {
  read: (
    query: string,
    scope: MemoryScope,
    options?: AdaptiveMemoryRecallOptions,
  ) => Promise<MemoryV4ReadDecision>
}

export interface MemoryV4ReadRouterOptions {
  mode: MemoryV4ReadMode | (() => MemoryV4ReadMode)
  recallV3: (
    query: string,
    scope: MemoryScope,
    options?: AdaptiveMemoryRecallOptions,
  ) => Promise<AdaptiveMemoryRecallResult>
  recallV4?: (
    query: string,
    options: MemoryV4ShadowRecallOptions,
  ) => Promise<MemoryV4ShadowRecallResult>
  /** Auto mode skips V4 when its host says the lazy index/Worker is unavailable or busy. */
  isV4Ready?: () => boolean
  onDecision?: (decision: MemoryV4ReadDecision, context: MemoryV4ReadDecisionContext) => void
  now?: () => number
}

export function normalizeMemoryV4ReadMode(value: unknown): MemoryV4ReadMode {
  return value === 'v4-beta' || value === 'auto' ? value : 'v3'
}

export function createMemoryV4ReadRouter(
  options: MemoryV4ReadRouterOptions,
): MemoryV4ReadRouter {
  const now = options.now ?? performance.now.bind(performance)

  function emit(
    decision: MemoryV4ReadDecision,
    context: MemoryV4ReadDecisionContext,
  ): MemoryV4ReadDecision {
    try {
      options.onDecision?.(decision, context)
    }
    catch {
      // Read diagnostics must never affect the answer path.
    }
    return decision
  }

  async function fallback(
    startedAt: number,
    mode: MemoryV4ReadMode,
    query: string,
    scope: MemoryScope,
    recallOptions: AdaptiveMemoryRecallOptions | undefined,
    reason?: MemoryV4ReadFallbackReason,
  ): Promise<MemoryV4ReadDecision> {
    const result = await options.recallV3(query, scope, recallOptions)
    return emit({
      version: MEMORY_V4_READ_ROUTER_VERSION,
      requestedMode: mode,
      authoritativeReadSource: 'v3',
      result,
      ...(reason ? { fallbackReason: reason } : {}),
      latencyMs: Math.max(0, now() - startedAt),
    }, { query, scope })
  }

  return {
    async read(query, scope, recallOptions) {
      const startedAt = now()
      const mode = typeof options.mode === 'function'
        ? normalizeMemoryV4ReadMode(options.mode())
        : normalizeMemoryV4ReadMode(options.mode)
      if (mode === 'v3')
        return fallback(startedAt, mode, query, scope, recallOptions)
      if (!options.recallV4)
        return fallback(startedAt, mode, query, scope, recallOptions, 'v4-unavailable')
      if (mode === 'auto' && options.isV4Ready?.() === false)
        return fallback(startedAt, mode, query, scope, recallOptions, 'v4-not-ready')

      let recall: MemoryV4ShadowRecallResult
      try {
        recall = await options.recallV4(query, {
          scope,
          limit: recallOptions?.maxInjected,
          sharePolicies: recallOptions?.sharePolicies,
          sensitivities: recallOptions?.sensitivities,
          temporalMode: recallOptions?.temporalMode,
          asOf: recallOptions?.asOf,
        })
      }
      catch {
        return fallback(startedAt, mode, query, scope, recallOptions, 'v4-error')
      }

      const evidenceBundle = buildMemoryV4EvidenceBundle(recall)
      if (evidenceBundle.entries.length === 0) {
        const reason = recall.abstention?.abstained ? 'v4-abstained' : 'v4-empty'
        return fallback(startedAt, mode, query, scope, recallOptions, reason)
      }
      return emit({
        version: MEMORY_V4_READ_ROUTER_VERSION,
        requestedMode: mode,
        authoritativeReadSource: 'v4',
        result: memoryV4EvidenceBundleToAdaptiveResult(evidenceBundle),
        evidenceBundle,
        latencyMs: Math.max(0, now() - startedAt),
      }, { query, scope })
    },
  }
}
