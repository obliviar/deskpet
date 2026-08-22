# DeskPet 阶段 3 外部盲测协议

本协议解决"开发代码与测试答案在同一仓库，检索分数不可被视为盲测"的问题。仓库中的 `stage3-retrieval-dev-v1.json` 仅是回归集，不承担发布认证。

> `scripts/generate-stage3-blind-dataset.mjs` 同时包含查询和答案标签，只用于合成开发/压力回归。测试入口会拒绝其 `repository-generated:*` 标注者身份；它不能替代独立人员在仓库外制作的冻结标签包。

## 文件隔离

- 公开案例包只包含 `schemaVersion`、`datasetVersion`、`frozenAt`、`facts` 和 `cases`。每个 case 只能包含 `id`、`category`、`query`、可选 `options`，禁止出现 `relevantKeys`。`facts` 是供加载到记忆库中的完整事实语料（含干扰项），公开但不包含答案标注。
- 私有标签包包含 `labels[].relevantKeys`（每条查询应召回的事实 key 列表），并保存公开案例包的规范化 SHA-256 指纹、独立标注者、标注时间、被冻结的实现提交和独立性声明。
- 执行前还必须分别公布案例文件与标签文件的原始字节 SHA-256；规范化案例指纹负责绑定案例内容，两个文件哈希负责检测文件级改动。
- 私有标签必须放在 `evals/memory/private/` 或仓库外；该目录已加入 `.gitignore`。
- 开发者只接收聚合分数和错误数量。发布判定前不得读取标签或逐条错误内容。

## 独立标注

1. 由未参与检索规则和查询规划器开发的人冻结至少 300 条中文查询，覆盖至少 8 类：改写召回、时间区间、多事实、长程回忆、选择性遗忘、拒答/无需记忆、时间线回顾、宽泛概览。
2. 标注者编写不少于 200 条事实语料（含目标事实和干扰事实），每条事实有唯一的 `key`；为每条查询标注 `relevantKeys`（应召回的正确事实 key 列表，空数组表示该查询不应召回任何个人记忆）。
3. 两名标注者独立标注；不一致项由第三人裁决。
4. 公开案例包冻结后计算指纹，再生成私有标签包；修改任何案例或事实都会令标签包失效。
5. 校准集、阈值开发集和最终盲测集必须按用户/对话分组隔离，不能把同一事实的改写分到两侧。

## 执行

在 PowerShell 中设置两个路径和两个预先公布的文件哈希后运行专用入口：

```powershell
$env:DESKPET_MEMORY_STAGE3_BLIND_CASES='D:\path\stage3-blind-cases.json'
$env:DESKPET_MEMORY_STAGE3_BLIND_LABELS='D:\GitHub\deskpet\evals\memory\private\stage3-blind-labels.json'
$env:DESKPET_MEMORY_STAGE3_BLIND_CASE_SHA256='案例文件的64位SHA256'
$env:DESKPET_MEMORY_STAGE3_BLIND_LABEL_SHA256='私有标签文件的64位SHA256'
# 可选：覆盖 P95 延迟门槛（默认 100 ms）
$env:DESKPET_MEMORY_STAGE3_BLIND_P95_TARGET_MS='100'
pnpm.cmd -F @deskpet/memory test:stage3-blind
```

外部测试会检查：工作树干净、当前 HEAD 与标签中的冻结提交一致、两个文件哈希一致、案例无答案或额外字段泄漏、案例与标签指纹一致、独立性声明存在、ID 一一对应、标签引用的 fact key 全部存在、至少 300 例和至少 8 类。日志只打印聚合指标和分类指标。

## 通过标准

- Recall@5 点估计 ≥ 90%。
- Top-1 点估计 ≥ 85%。
- 拒答准确率 ≥ 95%。
- 时间类 Top-1 ≥ 95%（当时间类可回答案例数 > 0 时）。
- P95 延迟 < 100 ms（可通过 `DESKPET_MEMORY_STAGE3_BLIND_P95_TARGET_MS` 覆盖；在目标发布硬件上校准）。
- suppressed 事实的普通召回泄漏为 0（选择性遗忘）。

如果未提供独立私有标签，测试会显示为 skipped，阶段 3 必须继续标记为 `×`，不能用仓库内回归集代替。
