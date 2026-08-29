import {
  MEMORY_V4_READ_ROUTER_VERSION,
  createMemoryV4ReadRouter,
  normalizeMemoryV4ReadMode,
} from '@deskpet/memory'
import type {
  MemoryV4ReadDecision,
  MemoryV4ReadDecisionContext,
  MemoryV4ReadFallbackReason,
  MemoryV4ReadMode,
  MemoryV4ReadRouter,
  MemoryV4ReadRouterOptions,
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4RetrievalPolicyIdentity,
} from '@deskpet/memory'

type ReadArguments = Parameters<MemoryV4ReadRouter['read']>
type AdaptiveMemoryRecallResult = MemoryV4ReadDecision['result']

export const MEMORY_V4_READ_CONTROLLER_VERSION = 'memory-v4-read-controller-v1'
export const DEFAULT_MEMORY_V4_READ_MODE: MemoryV4ReadMode = 'auto'

/** Environment wins over file config; absence now explicitly enables safe auto mode. */
export function resolveMemoryV4ReadMode(
  environmentValue: unknown,
  fileValue: unknown,
): MemoryV4ReadMode {
  const environmentMode = nonEmptyString(environmentValue)
  const fileMode = nonEmptyString(fileValue)
  return normalizeMemoryV4ReadMode(environmentMode ?? fileMode ?? DEFAULT_MEMORY_V4_READ_MODE)
}

export interface MemoryV4ReadControllerStatus {
  version: typeof MEMORY_V4_READ_CONTROLLER_VERSION
  routerVersion: typeof MEMORY_V4_READ_ROUTER_VERSION
  configuredMode: MemoryV4ReadMode
  reads: number
  v3Reads: number
  v4Reads: number
  fallbacks: number
  fallbackReasons: Partial<Record<MemoryV4ReadFallbackReason, number>>
  last?: {
    requestedMode: MemoryV4ReadMode
    authoritativeReadSource: 'v3' | 'v4'
    fallbackReason?: MemoryV4ReadFallbackReason
    injectedMemoryIds: string[]
    injectedFactIds: string[]
    snapshotRevision?: number
    retrievalPolicy?: MemoryV4RetrievalPolicyIdentity
    latencyMs: number
  }
}

export interface MemoryV4ReadController {
  recallAdaptive: (
    query: ReadArguments[0],
    scope: ReadArguments[1],
    options?: ReadArguments[2],
  ) => Promise<AdaptiveMemoryRecallResult>
  status: () => MemoryV4ReadControllerStatus
}

export interface MemoryV4ReadControllerOptions {
  mode: MemoryV4ReadMode | (() => MemoryV4ReadMode)
  recallV3: MemoryV4ReadRouterOptions['recallV3']
  recallV4?: (
    query: string,
    options: MemoryV4ShadowRecallOptions,
  ) => Promise<MemoryV4ShadowRecallResult>
  isV4Ready?: () => boolean
  onDecision?: (decision: MemoryV4ReadDecision, context: MemoryV4ReadDecisionContext) => void
  now?: () => number
}

/**
 * Desktop read boundary. It tracks only bounded identifiers and routing
 * outcomes; query text and recalled content are never retained in status.
 */
export function createMemoryV4ReadController(
  options: MemoryV4ReadControllerOptions,
): MemoryV4ReadController {
  let reads = 0
  let v3Reads = 0
  let v4Reads = 0
  let fallbacks = 0
  const fallbackReasons: Partial<Record<MemoryV4ReadFallbackReason, number>> = {}
  let last: MemoryV4ReadControllerStatus['last']

  function configuredMode(): MemoryV4ReadMode {
    return normalizeMemoryV4ReadMode(typeof options.mode === 'function' ? options.mode() : options.mode)
  }

  function record(decision: MemoryV4ReadDecision, context: MemoryV4ReadDecisionContext): void {
    reads += 1
    if (decision.authoritativeReadSource === 'v4')
      v4Reads += 1
    else
      v3Reads += 1
    if (decision.fallbackReason) {
      fallbacks += 1
      fallbackReasons[decision.fallbackReason] = (fallbackReasons[decision.fallbackReason] ?? 0) + 1
    }
    last = {
      requestedMode: decision.requestedMode,
      authoritativeReadSource: decision.authoritativeReadSource,
      ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
      injectedMemoryIds: [...decision.result.injectedMemoryIds],
      injectedFactIds: [...(decision.evidenceBundle?.selectedFactIds ?? [])],
      ...(decision.evidenceBundle
        ? {
            snapshotRevision: decision.evidenceBundle.snapshotRevision,
            retrievalPolicy: { ...decision.evidenceBundle.retrievalPolicy },
          }
        : {}),
      latencyMs: decision.latencyMs,
    }
    options.onDecision?.(decision, context)
  }

  const router = createMemoryV4ReadRouter({
    mode: configuredMode,
    recallV3: options.recallV3,
    ...(options.recallV4 ? { recallV4: options.recallV4 } : {}),
    ...(options.isV4Ready ? { isV4Ready: options.isV4Ready } : {}),
    onDecision: record,
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    async recallAdaptive(query, scope, recallOptions) {
      const decision = await router.read(query, scope, recallOptions)
      return decision.result
    },
    status: () => ({
      version: MEMORY_V4_READ_CONTROLLER_VERSION,
      routerVersion: MEMORY_V4_READ_ROUTER_VERSION,
      configuredMode: configuredMode(),
      reads,
      v3Reads,
      v4Reads,
      fallbacks,
      fallbackReasons: { ...fallbackReasons },
      ...(last
        ? {
            last: {
              ...last,
              injectedMemoryIds: [...last.injectedMemoryIds],
              injectedFactIds: [...last.injectedFactIds],
              ...(last.retrievalPolicy ? { retrievalPolicy: { ...last.retrievalPolicy } } : {}),
            },
          }
        : {}),
    }),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
