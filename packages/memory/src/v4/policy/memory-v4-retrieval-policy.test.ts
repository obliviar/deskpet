import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createMemoryV4PolicyArtifact,
  parseMemoryV4PolicyArtifact,
  serializeMemoryV4PolicyArtifact,
} from './memory-v4-policy-artifact'
import {
  DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
  deriveMemoryV4RetrievalPolicy,
  fingerprintMemoryV4RetrievalPolicy,
  parseMemoryV4RetrievalPolicy,
} from './memory-v4-retrieval-policy'

const artifactPath = fileURLToPath(new URL('../../../../../evals/memory/v4-retrieval-policy-v1.json', import.meta.url))

describe('Memory V4 retrieval policy artifact', () => {
  it('is immutable, deterministic and rejects tampering', () => {
    const baseline = DEFAULT_MEMORY_V4_RETRIEVAL_POLICY
    const parsed = parseMemoryV4RetrievalPolicy(JSON.stringify(baseline))
    expect(fingerprintMemoryV4RetrievalPolicy(parsed)).toBe(fingerprintMemoryV4RetrievalPolicy(baseline))
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.tierQuotas)).toBe(true)

    const artifact = createMemoryV4PolicyArtifact({ policy: parsed, source: { kind: 'baseline' } })
    const serialized = serializeMemoryV4PolicyArtifact(artifact)
    expect(parseMemoryV4PolicyArtifact(serialized)).toEqual(artifact)
    expect(Object.isFrozen(artifact.policy)).toBe(true)

    const tampered = JSON.parse(serialized)
    tampered.policy.rrfRankConstant = 12
    expect(() => parseMemoryV4PolicyArtifact(tampered)).toThrow(/fingerprint mismatch/)
  })

  it('validates the bounded search space and changes fingerprints', () => {
    const lean = deriveMemoryV4RetrievalPolicy(
      DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
      { policyId: 'lean-test', policyVersion: 'test-v1' },
      { candidateBudgetScale: { specific: 0.75 }, rrfRankConstant: 40 },
    )
    expect(lean.candidateBudgetScale.specific).toBe(0.75)
    expect(fingerprintMemoryV4RetrievalPolicy(lean))
      .not.toBe(fingerprintMemoryV4RetrievalPolicy(DEFAULT_MEMORY_V4_RETRIEVAL_POLICY))
    expect(() => deriveMemoryV4RetrievalPolicy(
      DEFAULT_MEMORY_V4_RETRIEVAL_POLICY,
      { policyId: 'invalid-test', policyVersion: 'test-v1' },
      { tierQuotas: { eagerHotFraction: 0.8, eagerColdFraction: 0.3 } },
    )).toThrow(/positive warm quota/)
  })

  it('loads the checked-in selected policy with verified provenance', () => {
    const artifact = parseMemoryV4PolicyArtifact(readFileSync(artifactPath, 'utf8'))
    expect(artifact.policy.policyId).toBe('deskpet-v4-retrieval-budget-625-v1')
    expect(artifact.policyFingerprint).toBe('341998c8631a501299571e0b552a9b902a4e0f00318d2d89ccc608fe73bc0e99')
    expect(artifact.policyFingerprint).toBe(fingerprintMemoryV4RetrievalPolicy(DEFAULT_MEMORY_V4_RETRIEVAL_POLICY))
    expect(artifact.source.kind).toBe('constrained-search')
  })
})
