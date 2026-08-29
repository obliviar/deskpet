import {
  createMemoryV4RetrievalPolicy,
  fingerprintMemoryV4RetrievalPolicy,
  type MemoryV4RetrievalPolicy,
} from './memory-v4-retrieval-policy'

export const MEMORY_V4_POLICY_ARTIFACT_SCHEMA_VERSION = 1 as const
export const MEMORY_V4_POLICY_ARTIFACT_VERSION = 'memory-v4-policy-artifact-v1'

export interface MemoryV4PolicyArtifactSource {
  readonly kind: 'baseline' | 'constrained-search'
  readonly scenarioFingerprint?: string
  readonly baselinePolicyFingerprint?: string
  readonly searchVersion?: string
}

export interface MemoryV4PolicyArtifact {
  readonly schemaVersion: typeof MEMORY_V4_POLICY_ARTIFACT_SCHEMA_VERSION
  readonly artifactVersion: typeof MEMORY_V4_POLICY_ARTIFACT_VERSION
  readonly policyFingerprint: string
  readonly policy: MemoryV4RetrievalPolicy
  readonly source: MemoryV4PolicyArtifactSource
}

/** Build a detached, immutable artifact. Runtime code receives no write API. */
export function createMemoryV4PolicyArtifact(input: {
  policy: MemoryV4RetrievalPolicy
  source: MemoryV4PolicyArtifactSource
}): MemoryV4PolicyArtifact {
  const policy = createMemoryV4RetrievalPolicy(input.policy)
  validateSource(input.source)
  return deepFreeze({
    schemaVersion: MEMORY_V4_POLICY_ARTIFACT_SCHEMA_VERSION,
    artifactVersion: MEMORY_V4_POLICY_ARTIFACT_VERSION,
    policyFingerprint: fingerprintMemoryV4RetrievalPolicy(policy),
    policy,
    source: { ...input.source },
  })
}

export function parseMemoryV4PolicyArtifact(value: unknown): MemoryV4PolicyArtifact {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('Memory V4 policy artifact must be an object')
  const artifact = parsed as MemoryV4PolicyArtifact
  if (artifact.schemaVersion !== MEMORY_V4_POLICY_ARTIFACT_SCHEMA_VERSION
    || artifact.artifactVersion !== MEMORY_V4_POLICY_ARTIFACT_VERSION)
    throw new RangeError('Unsupported Memory V4 policy artifact version')
  const rebuilt = createMemoryV4PolicyArtifact({ policy: artifact.policy, source: artifact.source })
  if (artifact.policyFingerprint !== rebuilt.policyFingerprint)
    throw new Error('Memory V4 policy artifact fingerprint mismatch')
  return rebuilt
}

export function serializeMemoryV4PolicyArtifact(artifact: MemoryV4PolicyArtifact): string {
  return `${JSON.stringify(parseMemoryV4PolicyArtifact(artifact), null, 2)}\n`
}

function validateSource(source: MemoryV4PolicyArtifactSource): void {
  if (!source || (source.kind !== 'baseline' && source.kind !== 'constrained-search'))
    throw new TypeError('Policy artifact source kind is invalid')
  for (const [name, value] of Object.entries(source)) {
    if (name !== 'kind' && value !== undefined && (typeof value !== 'string' || value.length === 0))
      throw new TypeError(`Policy artifact source ${name} must be a non-empty string`)
  }
  if (source.kind === 'constrained-search'
    && (!source.scenarioFingerprint || !source.baselinePolicyFingerprint || !source.searchVersion))
    throw new TypeError('Constrained-search artifacts require scenario, baseline and search provenance')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
