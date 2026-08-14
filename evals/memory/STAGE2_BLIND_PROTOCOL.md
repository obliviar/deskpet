# DeskPet 阶段 2 外部盲测协议

本协议解决“开发代码与测试答案在同一仓库，100% 分数不可被视为盲测”的问题。仓库中的 `stage2-write-frozen-v1.json` 仅是回归集，不承担发布认证。

## 文件隔离

- 公开题目包只包含 `schemaVersion`、`datasetVersion`、`frozenAt` 和 `cases`，每个 case 只能包含 `id`、`category`、`turn`、可选 `existing`，禁止出现 `expected`。
- 私有标签包包含 `labels[].expected`，并保存公开题目包的规范化 SHA-256 指纹、独立标注者、标注时间、被冻结的实现提交和独立性声明。
- 执行前还必须分别公布题目文件与标签文件的原始字节 SHA-256；规范化题目指纹负责绑定题目内容，两个文件哈希负责检测文件级改动。
- 私有标签必须放在 `evals/memory/private/` 或仓库外；该目录已加入 `.gitignore`。
- 开发者只接收聚合分数和错误数量。发布判定前不得读取标签或逐条错误内容。

## 独立标注

1. 由未参与当前抽取规则开发的人冻结至少 300 条中文案例，覆盖至少 8 类：稳定事实、多事实、改写、上下文确认、假设/问句/转述、时间变化、冲突更新、高风险/敏感信息、安全攻击、长消息。
2. 两名标注者独立填写预期事实、active/quarantined/rejected 和写入动作；不一致项由第三人裁决。
3. 公开题目冻结后计算指纹，再生成私有标签包；修改任何题目都会令标签包失效。
4. 校准集、阈值开发集和最终盲测集必须按用户/对话分组隔离，不能把同一事实的改写分到两侧。

## 执行

在 PowerShell 中设置两个路径和两个预先公布的文件哈希后运行专用入口：

```powershell
$env:DESKPET_MEMORY_BLIND_CASES='D:\path\stage2-blind-cases.json'
$env:DESKPET_MEMORY_BLIND_LABELS='D:\GitHub\deskpet\evals\memory\private\stage2-blind-labels.json'
$env:DESKPET_MEMORY_BLIND_CASE_SHA256='题目文件的64位SHA256'
$env:DESKPET_MEMORY_BLIND_LABEL_SHA256='私有标签文件的64位SHA256'
pnpm.cmd -F @deskpet/memory test:stage2-blind
```

外部测试会检查：工作树干净、当前 HEAD 与标签中的冻结提交一致、两个文件哈希一致、题目无答案或额外字段泄漏、题目与标签指纹一致、独立性声明存在、ID 一一对应、至少 300 例和至少 8 类。日志只打印聚合指标。

## 通过标准

- Precision 点估计 ≥ 95%，Recall 点估计 ≥ 85%。
- unsupported active 点估计 < 1%。
- 单侧 95% Precision 下界 ≥ 95%。
- 单侧 95% Recall 下界 ≥ 85%。
- 单侧 95% unsupported active 上界 < 1%。
- secret/跨作用域泄漏必须为 0；出现一次即失败。

如果未提供独立私有标签，测试会显示为 skipped，阶段 0 和阶段 2 必须继续标记为 `×`，不能用仓库内回归集代替。
