import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderMemoryV4YearMarkdown, serializeMemoryV4YearReport } from './memory-v4-year-report'
import { parseMemoryV4YearScenario } from './memory-v4-year-scenario'
import { runMemoryV4YearSimulation } from './memory-v4-year-simulator'

const fixturePath = fileURLToPath(new URL('../../../../../evals/memory/v4-year-scenarios-v1.json', import.meta.url))

describe('Memory V4 365-day functional laboratory', () => {
  it('replays lifecycle, persistence, rebuilding, retrieval and 20k scale deterministically', async () => {
    const definition = parseMemoryV4YearScenario(readFileSync(fixturePath, 'utf8'))
    const report = await runMemoryV4YearSimulation(definition)
    const v4 = report.strategyMetrics.find(strategy => strategy.strategy === 'v4')!
    console.info(JSON.stringify({
      stage: 'memory-v4-year-functional-lab',
      passed: report.passed,
      eventCount: report.eventCount,
      v4RecallAtFive: v4.recallAtFive,
      v4TopOneAccuracy: v4.topOneAccuracy,
      v4AbstentionAccuracy: v4.abstentionAccuracy,
      scaleP95Ms: report.scale.latencyP95Ms,
      failureCount: report.failures.length,
    }))
    if (!report.passed) {
      console.info(JSON.stringify({
        stage: 'memory-v4-year-functional-lab-failures',
        mismatchesByTransformation: Object.fromEntries(
          ['paraphrase', 'repeat', 'hypothetical', 'quoted', 'distractor', 'occurrence']
            .map(transformation => [transformation, report.operationTraces.filter(trace => trace.transformation === transformation && !trace.correct).length]),
        ),
        sampleMismatches: report.operationTraces.filter(trace => !trace.correct).slice(0, 20),
      }))
    }

    expect(report.eventCount).toBe(1_826)
    expect(report.checkpoints.map(checkpoint => checkpoint.day)).toEqual([1, 7, 30, 90, 180, 365])
    expect(report.operationMetrics).toMatchObject({
      expectedWrites: 16,
      falsePositiveWrites: 0,
      writePrecision: 1,
      writeRecall: 1,
      operationDecisionAccuracy: 1,
    })
    expect(report.invariantPassRate).toBe(1)
    expect(report.restartConsistency).toBe(1)
    expect(report.checkpoints.every(checkpoint => checkpoint.authoritativeStatePreservedByRebuild)).toBe(true)
    expect(report.checkpoints.every(checkpoint => checkpoint.summaryCount > 0 && checkpoint.tierIndexCount === 1)).toBe(true)
    expect(v4.recallAtFive).toBeGreaterThanOrEqual(0.9)
    expect(v4.topOneAccuracy).toBeGreaterThanOrEqual(0.85)
    expect(report.scale).toMatchObject({ factCount: 20_000, queryCount: 7, topOneAccuracy: 1 })
    expect(report.scale.latencyP95Ms).toBeLessThan(100)
    expect(report.passed).toBe(true)

    const json = serializeMemoryV4YearReport(report)
    const markdown = renderMemoryV4YearMarkdown(report)
    expect(JSON.parse(json)).toMatchObject({ version: report.version, passed: true })
    expect(markdown).toContain('# DeskPet Memory V4 365 天功能实验报告')
    expect(markdown).toContain('V3 / V4 / 消融对照')
    expect(markdown).toContain('可定位失败')
  }, 120_000)
})
