# Jev 派发评估（开发前门禁）

> 目标：在写代码前，用约 **50 个真实派发案例**校准 `pWorkspace / pSession / confidence` 阈值，并验证"全量覆盖 vs 两层"的准确率差异。能力选择不在本评估内（由能力面板范围 + CapabilityResolver 单测覆盖）。
> 工具：`tools/jev-eval.mjs`（无依赖，Node 18+）
> 案例：`docs/eval/cases.real.jsonl`（需用真实工作区/会话快照生成）；示例见 `cases.sample.jsonl`

---

## 1. 为什么必须做

- Jev 的 `confidence` 是分布集中度，不是"目标正确概率"；阈值不能拍脑袋。
- 20 个工作区、800+ 会话时，"全量覆盖"是否比"先工作区后会话"更准，需要数据回答。
- 自动派发的代价是错误派发；门禁必须证明 **precision ≥ 95%** 才允许自动。

---

## 2. 案例集（50 条）

| 分层 | 数量 | 说明 |
|---|---|---|
| 明显工作区 | 12 | 任务与工作区职责强相关，期望 new 或 attach 清晰 |
| 跨工作区歧义 | 12 | 任务横跨两个工作区（例如"导出后接入检索"） |
| 旧会话相关 | 10 | 相关会话在 7–30 天前，验证"不按时间过滤" |
| 应新建 | 6 | 上下文 > 85%、或没有合适已有会话 |
| 能力驱动 | 5 | 目标工作区由能力签名/未启用能力决定 |
| 应询问用户 | 5 | 没有足够信息、两个目标都合理；期望 `needs_confirmation` |

**快照要求**

每条案例冻结当时的：
- 任务文本（title / goal / command）
- 允许工作区（id/name/summary/capabilityDigest）
- **全部非归档会话**（id/workspaceId/title/lastActiveAt/contextUsage）
- 期望目标（workspaceId / mode / sessionId）；能力选择不在 Jev 评估内

不要用"最近会话"或词面匹配先验去构造标签；否则评估会自我实现。

---

## 3. 运行

```bash
# 1) 用真实快照生成 cases.real.jsonl（每行一条）
# 2) 跑评估
JEV_API_KEY=... node tools/jev-eval.mjs docs/eval/cases.real.jsonl \
  --out docs/eval/report.md

# 3) 无 Key 时先用样例验证 harness
node tools/jev-eval.mjs docs/eval/cases.sample.jsonl --mock
```

输出：
- 工作区 Top-1、模式、会话 Top-1、目标正确率
- 阈值扫描：`pWorkspace × pSession × confidence` 下 precision ≥95% 的最高 coverage
- 逐条 case 的 chosen/expected/概率

---

## 4. 指标与门禁

| 指标 | 目标 |
|---|---|
| 工作区 Top-1 | ≥ 85% |
| 会话 Top-1（attach 案例） | ≥ 70% |
| 模式（new/attach） | ≥ 85% |

| **自动派发 precision** | **≥ 95%** |
| 自动派发 coverage | ≥ 40% |
| 校准 | 按 pMax 分桶的正确率单调，不过度自信 |
| p95 时延 | < 3s |
| 全量覆盖请求 tokens | ≤ 24k（默认预算） |

**阈值选择规则**：在 precision ≥95% 的组合里取 coverage 最高；若没有组合达标，默认"每次派发都确认"，不降低正确率。

---

## 5. 全量 vs 两层

同一批 50 案例，分别跑：

- **A 全量一波**：20 工作区 + 全部非归档会话 + 能力 noul；
- **B 两层**：先工作区，再该工作区全部会话。

记录：目标正确率、tokens、p50/p95 时延。若 A 明显更准且 ≤24k，默认 A；否则 B。若 A 的准确率不升反降（上下文过长导致注意力分散），也要记录，避免盲目"全量"。

---

## 6. 当前状态

- ✅ `tools/jev-eval.mjs` 已就绪，支持 live / `--mock`、阈值扫描、Markdown 报告。
- ✅ `cases.schema.json` 与 6 条 `cases.sample.jsonl` 示例。
- ⬜ `cases.real.jsonl` 的 50 条需用你的真实工作区/会话快照补齐（**开发前门禁**）。
- ⬜ 门禁通过后，把最终阈值写回 `ConfigRecord.jev.threshold / confidenceFloor` 默认值。
