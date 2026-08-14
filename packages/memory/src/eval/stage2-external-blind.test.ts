import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assembleMemoryStage2BlindCases } from './stage2-blind-eval'
import type { MemoryStage2BlindCasePack, MemoryStage2BlindLabelPack } from './stage2-blind-eval'
import { runMemoryStage2WriteEval } from './stage2-write-eval'

const casePath = process.env.DESKPET_MEMORY_BLIND_CASES
const labelPath = process.env.DESKPET_MEMORY_BLIND_LABELS
const expectedCaseSha256 = process.env.DESKPET_MEMORY_BLIND_CASE_SHA256
const expectedLabelSha256 = process.env.DESKPET_MEMORY_BLIND_LABEL_SHA256
const externalConfigured = Boolean(casePath || labelPath || expectedCaseSha256 || expectedLabelSha256)

describe('externally administered stage 2 blind evaluation', () => {
  it.skipIf(!externalConfigured)('meets statistical release gates without exposing private labels', async () => {
    expect(casePath, 'DESKPET_MEMORY_BLIND_CASES is required').toBeTruthy()
    expect(labelPath, 'DESKPET_MEMORY_BLIND_LABELS is required').toBeTruthy()
    expect(expectedCaseSha256, 'DESKPET_MEMORY_BLIND_CASE_SHA256 is required').toMatch(/^[a-f0-9]{64}$/iu)
    expect(expectedLabelSha256, 'DESKPET_MEMORY_BLIND_LABEL_SHA256 is required').toMatch(/^[a-f0-9]{64}$/iu)
    const caseBytes = readFileSync(casePath!)
    const labelBytes = readFileSync(labelPath!)
    const caseSha256 = createHash('sha256').update(caseBytes).digest('hex')
    const labelSha256 = createHash('sha256').update(labelBytes).digest('hex')
    expect(caseSha256).toBe(expectedCaseSha256!.toLocaleLowerCase())
    expect(labelSha256).toBe(expectedLabelSha256!.toLocaleLowerCase())
    const casePack = JSON.parse(caseBytes.toString('utf-8')) as MemoryStage2BlindCasePack
    const labelPack = JSON.parse(labelBytes.toString('utf-8')) as MemoryStage2BlindLabelPack
    const cases = assembleMemoryStage2BlindCases(casePack, labelPack)
    const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim().toLocaleLowerCase()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim()
    expect(dirty, 'External blind certification requires a clean worktree').toBe('')
    expect(labelPack.implementationCommit.toLocaleLowerCase()).toBe(implementationCommit)
    expect(cases.length, 'The external blind pack is too small for release certification').toBeGreaterThanOrEqual(300)
    expect(new Set(cases.map(item => item.category)).size, 'The external blind pack lacks category diversity').toBeGreaterThanOrEqual(8)
    const report = await runMemoryStage2WriteEval(cases, { datasetVersion: casePack.datasetVersion })
    console.log(JSON.stringify({
      stage: 'memory-stage2-external-blind',
      datasetVersion: report.datasetVersion,
      casePackSha256: caseSha256,
      labelPackSha256: labelSha256,
      casePackFingerprint: labelPack.casePackFingerprint,
      implementationCommit,
      adjudicator: labelPack.adjudicator,
      caseCount: report.caseCount,
      precision: report.precision,
      recall: report.recall,
      unsupportedActiveRate: report.unsupportedActiveRate,
      confidence95: report.confidence95,
      qualityGate: report.qualityGate,
      errorCount: report.errors.length,
    }))
    expect(report.qualityGate.pointTargetsPassed).toBe(true)
    expect(report.qualityGate.confidenceBoundTargetsPassed).toBe(true)
  })
})
