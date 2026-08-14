import { describe, expect, it } from 'vitest'
import {
  assembleMemoryStage2BlindCases,
  fingerprintMemoryStage2BlindCasePack,
} from './stage2-blind-eval'
import type { MemoryStage2BlindCasePack, MemoryStage2BlindLabelPack } from './stage2-blind-eval'

describe('stage 2 blind evaluation packaging', () => {
  it('joins a prompt-only pack only when its private label fingerprint matches', () => {
    const cases = casePack()
    const labels: MemoryStage2BlindLabelPack = {
      schemaVersion: 1,
      datasetVersion: cases.datasetVersion,
      casePackFingerprint: fingerprintMemoryStage2BlindCasePack(cases),
      adjudicator: 'independent-reviewer',
      labeledAt: '2026-08-14T00:00:00.000Z',
      implementationCommit: '1f377a1',
      labelsHiddenUntilImplementationFreeze: true,
      attestation: 'Labels were hidden until the test fixture implementation was frozen.',
      labels: [{ id: 'blind-1', expected: [{ content: '用户所在地：成都', outcome: 'active', action: 'ADD' }] }],
    }
    expect(assembleMemoryStage2BlindCases(cases, labels)[0]).toMatchObject({
      id: 'blind-1', expected: [{ content: '用户所在地：成都', outcome: 'active' }],
    })
    labels.casePackFingerprint = 'tampered'
    expect(() => assembleMemoryStage2BlindCases(cases, labels)).toThrow('fingerprint')
  })

  it('rejects public packs that contain answer fields or incomplete private labels', () => {
    const leaked = casePack() as MemoryStage2BlindCasePack & { cases: Array<Record<string, unknown>> }
    leaked.cases[0]!.expected = []
    expect(() => fingerprintMemoryStage2BlindCasePack(leaked as MemoryStage2BlindCasePack)).toThrow('leaks expected')

    const cases = casePack()
    const labels: MemoryStage2BlindLabelPack = {
      schemaVersion: 1, datasetVersion: cases.datasetVersion,
      casePackFingerprint: fingerprintMemoryStage2BlindCasePack(cases),
      adjudicator: 'independent-reviewer', labeledAt: '2026-08-14T00:00:00.000Z',
      implementationCommit: '1f377a1', labelsHiddenUntilImplementationFreeze: true,
      attestation: 'Labels were hidden until the test fixture implementation was frozen.', labels: [],
    }
    expect(() => assembleMemoryStage2BlindCases(cases, labels)).toThrow('empty')
  })
})

function casePack(): MemoryStage2BlindCasePack {
  return {
    schemaVersion: 1,
    datasetVersion: 'blind-test-v1',
    frozenAt: '2026-08-14T00:00:00.000Z',
    cases: [{ id: 'blind-1', category: 'identity', turn: { userMessage: '常住成都', assistantMessage: '' } }],
  }
}
