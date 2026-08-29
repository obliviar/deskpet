import type {
  MemoryV4YearGateCheck,
  MemoryV4YearSimulationReport,
  MemoryV4YearStrategyMetrics,
} from './memory-v4-year-simulator'

export const MEMORY_V4_YEAR_REPORT_VERSION = 'memory-v4-year-report-v1'

/** Stable machine-readable artifact for CI, local comparison and later replay. */
export function serializeMemoryV4YearReport(report: MemoryV4YearSimulationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** Compact human-readable view; the JSON artifact remains the source of truth. */
export function renderMemoryV4YearMarkdown(report: MemoryV4YearSimulationReport): string {
  const v4 = report.strategyMetrics.find(item => item.strategy === 'v4')
  const lines = [
    '# DeskPet Memory V4 365 天功能实验报告',
    '',
    `- 报告版本：${MEMORY_V4_YEAR_REPORT_VERSION}`,
    `- 模拟器：${report.version}`,
    `- 场景：${report.scenarioVersion}`,
    `- 场景指纹：\`${report.scenarioFingerprint}\``,
    `- 事件指纹：\`${report.eventFingerprint}\``,
    `- 检索策略：\`${report.policy.policyId}@${report.policy.policyVersion}#${report.policy.fingerprint}\``,
    `- 种子 / 天数 / 事件：${report.seed} / ${report.days} / ${report.eventCount}`,
    `- 结论：**${report.passed ? '通过' : '未通过'}**`,
    '',
    '## 核心结果',
    '',
    '| 指标 | 结果 |',
    '|---|---:|',
    `| 写入精确率 | ${percent(report.operationMetrics.writePrecision)} |`,
    `| 写入召回率 | ${percent(report.operationMetrics.writeRecall)} |`,
    `| 操作判定准确率 | ${percent(report.operationMetrics.operationDecisionAccuracy)} |`,
    `| 不变量通过率 | ${percent(report.invariantPassRate)} |`,
    `| 重启一致率 | ${percent(report.restartConsistency)} |`,
    `| V4 Recall@5 | ${percent(v4?.recallAtFive ?? 0)} |`,
    `| V4 Top-1 | ${percent(v4?.topOneAccuracy ?? 0)} |`,
    `| V4 时间正确率 | ${percent(v4?.temporalCorrectness ?? 0)} |`,
    `| 20k P95 | ${fixed(report.scale.latencyP95Ms)} ms |`,
    `| 普通上下文估算 | ${fixed(v4?.estimatedMeanContextTokens ?? 0)} tokens |`,
    '',
    '## V3 / V4 / 消融对照',
    '',
    '| 策略 | 查询 | Recall@5 | Top-1 | 完整覆盖 | 时间正确 | P95 (ms) |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.strategyMetrics.map(strategyRow),
    '',
    '## 检查点',
    '',
    '| 天 | 事实 | 版本 | 摘要 | 日志回放 | 重启 | 压缩重启 | 派生重建不改权威事实 |',
    '|---:|---:|---:|---:|---:|:---:|:---:|:---:|',
    ...report.checkpoints.map(checkpoint => `| ${checkpoint.day} | ${checkpoint.factCount} | ${checkpoint.factVersionCount} | ${checkpoint.summaryCount} | ${checkpoint.journalEntriesReplayed} | ${mark(checkpoint.restartConsistent)} | ${mark(checkpoint.compactedRestartConsistent)} | ${mark(checkpoint.authoritativeStatePreservedByRebuild)} |`),
    '',
    '## 门槛',
    '',
    '| 门槛 | 实际 | 条件 | 硬门槛 | 结果 |',
    '|---|---:|---:|:---:|:---:|',
    ...report.gateChecks.map(gateRow),
    '',
    '## 可定位失败',
    '',
  ]
  if (report.failures.length === 0)
    lines.push('无。')
  else {
    lines.push(...report.failures.slice(0, 100).map(failure =>
      `- Day ${failure.day} / ${failure.phase}${failure.operationId ? ` / ${failure.operationId}` : ''}${failure.queryId ? ` / ${failure.queryId}` : ''}${failure.strategy ? ` / ${failure.strategy}` : ''}: ${failure.message}`))
    if (report.failures.length > 100)
      lines.push(`- 其余 ${report.failures.length - 100} 条请查看 JSON 报告。`)
  }
  return `${lines.join('\n')}\n`
}

function strategyRow(metrics: MemoryV4YearStrategyMetrics): string {
  return `| ${metrics.strategy} | ${metrics.queryCount} | ${percent(metrics.recallAtFive)} | ${percent(metrics.topOneAccuracy)} | ${percent(metrics.exactCoverage)} | ${percent(metrics.temporalCorrectness)} | ${fixed(metrics.latencyP95Ms)} |`
}

function gateRow(check: MemoryV4YearGateCheck): string {
  return `| ${check.id} | ${fixed(check.actual)} | ${check.operator} ${fixed(check.threshold)} | ${check.hard ? '是' : '否'} | ${mark(check.passed)} |`
}

function percent(value: number): string {
  return `${fixed(value * 100)}%`
}

function fixed(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a'
}

function mark(value: boolean): string {
  return value ? '✅' : '❌'
}
