export const MEMORY_V4_ROLLOUT_SETTINGS_VERSION = 'memory-v4-rollout-settings-v1'

/** Only non-production stages can be selected from the desktop UI. */
export type MemoryV4RolloutStageSetting = 'shadow' | 'internal'

export function normalizeMemoryV4RolloutStage(
  value: unknown,
  options: {
    defaultStage?: MemoryV4RolloutStageSetting
    environmentOverride?: MemoryV4RolloutStageSetting
  } = {},
): MemoryV4RolloutStageSetting {
  const requested = value === 'internal' || value === 'shadow'
    ? value
    : options.defaultStage ?? 'shadow'
  return options.environmentOverride ?? requested
}

export type MemoryV4RolloutTransitionCheck =
  | { ok: true; stage: MemoryV4RolloutStageSetting }
  | { ok: false; reason: 'environment-locked' | 'runtime-unavailable' }

/**
 * Fail-closed guard for the UI transition. It cannot express percent stages,
 * cannot bypass an environment override and cannot enter Internal without both
 * the shadow store and the isolated recall Worker.
 */
export function checkMemoryV4RolloutTransition(input: {
  currentStage: MemoryV4RolloutStageSetting
  requestedStage: MemoryV4RolloutStageSetting
  environmentOverride?: MemoryV4RolloutStageSetting
  shadowAvailable: boolean
  workerAvailable: boolean
}): MemoryV4RolloutTransitionCheck {
  if (input.environmentOverride !== undefined && input.requestedStage !== input.environmentOverride)
    return { ok: false, reason: 'environment-locked' }
  if (input.requestedStage === 'internal'
    && input.currentStage !== 'internal'
    && (!input.shadowAvailable || !input.workerAvailable))
    return { ok: false, reason: 'runtime-unavailable' }
  return { ok: true, stage: input.requestedStage }
}
