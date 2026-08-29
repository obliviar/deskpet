import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMemoryV4YearScenario } from '../evaluation/memory-v4-year-scenario'
import { defaultMemoryV4PolicyCandidates, runMemoryV4PolicySearch } from './memory-v4-policy-search'

const fixturePath = fileURLToPath(new URL('../../../../../evals/memory/v4-year-scenarios-v1.json', import.meta.url))

describe('Memory V4 constrained policy search', () => {
  it('selects only a non-regressing Pareto policy on the fixed 365-day replay', async () => {
    const definition = parseMemoryV4YearScenario(readFileSync(fixturePath, 'utf8'))
    const candidates = defaultMemoryV4PolicyCandidates()
    const report = await runMemoryV4PolicySearch(definition, candidates)
    const selected = report.selected
    const selectedEvaluation = report.evaluations.find(item =>
      item.policy.fingerprint === selected?.policyFingerprint)

    console.info(JSON.stringify({
      stage: 'memory-v4-policy-search',
      selectedPolicyId: selected?.policy.policyId,
      selectedFingerprint: selected?.policyFingerprint,
      selectedSource: selected?.source,
      paretoCount: report.paretoPolicyFingerprints.length,
      evaluations: report.evaluations.map(item => ({
        policyId: item.policy.policyId,
        hardGatesPassed: item.metrics.hardGatesPassed,
        nonRegressionPassed: item.nonRegressionPassed,
        improvements: item.improvements,
        yearP95Ms: item.metrics.latencyP95Ms,
        scaleP95Ms: item.metrics.scaleLatencyP95Ms,
        scaleCandidates: item.metrics.maximumScaleCandidates,
      })),
    }))

    expect(report.evaluations).toHaveLength(5)
    expect(report.evaluations.every(item => item.metrics.hardGatesPassed)).toBe(true)
    expect(selected).toBeDefined()
    expect(selected?.policy.policyId).toBe('deskpet-v4-retrieval-budget-625-v1')
    expect(selected?.source.kind).toBe('constrained-search')
    expect(selectedEvaluation?.nonRegressionPassed).toBe(true)
    expect(selectedEvaluation?.paretoEligible).toBe(true)
    expect(selectedEvaluation?.improvements.length).toBeGreaterThan(0)
    expect(report.paretoPolicyFingerprints).toContain(selected?.policyFingerprint)
  }, 120_000)
})
