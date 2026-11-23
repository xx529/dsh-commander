# V5 案例集 v2 标注规则（as-of-dispatch · 冻结版）

> 生成器：`tools/eval/build-cases.mjs`（generatorRev=`0db97fbd8da1a3ca`，唯一实现；改规则必须同时改本文档与 manifest）。
> 冻结副本：`docs/eval/frozen/cases.real.v2.jsonl`，`caseSha256=872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`。
> 逐条清单：`docs/eval/labels.cases.v2.md`。审计：`tools/eval/audit-cases.mjs`（A1–A12，冻结副本 violations=0）。
> ⚠️ 本地生成、含用户真实数据；`cases.real*.jsonl` 与 frozen 案例副本已加入 `.gitignore`，**不提交远端、不外发**。报告/本文件不含任务正文。
> v1 规则与方法学按 lead 裁定不成立（见 `report-v1-baseline-layered.md` 标注），仅作无效基线。

## 1. 场景与时间语义（as-of-dispatch）

每条案例 = **一次假设派发**。`dispatchAt` 的**实现口径**（按实际代码，2026-11-17 复核）：取该源会话中**最后一条 ≥12 字真实用户消息的时间**（`messages.at(-1).time`）；old-session 层例外 = 生成时刻（用于检验“相关旧会话”是否被忽略）。逐条记录在 `_provenance.dispatchAt`。

> **已知偏差（MEDIUM，tester task-12 独立审计发现）**：12/50 非 old-session 案例的 `dispatchAt` **晚于被测消息**（被测消息取首条、dispatchAt 取末条；Δ 3–2284 分钟），其快照可能包含被测消息之后活动的会话（v5-01 14 条、v5-07 21 条 `lastActiveAt > messageTime`）→ 对模型**偏利好**，因此 FAIL 结论只会更稳。若要“严格 replay-as-of 被测消息时刻”，必须按被测消息时间重新生成并**重新冻结（新 sha，不覆盖 v2）**；本轮未重冻结。

快照只允许 dispatchAt 之前可得的数据：
- `sessions[]`：仅 `createdAt <= dispatchAt` 的顶层非归档会话；**new 案例的 sessions 快照不含目标会话**（该会话在 dispatch 时尚不存在）；
- 会话标题：dispatchAt 前最后一个 `session/title` 事件；没有则回退 dispatchAt 前首条用户消息（≤40 字）；不使用会话终态标题；
- `workspaces[].recentTasks`：只取 dispatchAt 前有会话活动且不含源会话标题的标题（防 post-hoc 泄漏）；
- 工作区摘要（v2a semantic）：由 dispatchAt 前该工作区会话标题归纳（脚本 as-of 启发式，≤120 字），**不读目标消息**；v2b 对照 = 占位摘要（仅路径/计数，用于隔离摘要质量影响）。

## 2. 标签规则

| 标签 | 规则 | 类型 |
|---|---|---|
| workspaceId | `session.header.cwd` 与 `workspace.json` 的 `path` 精确匹配（非最近会话/非词面先验） | Fact |
| mode | 该消息是否为该会话首条真实用户消息：首条 → new；非首条 → attach 到该会话（回放语义） | Inference |
| attach.sessionId | 该会话 id（必须出现在 sessions 快照中，audit A9 校验） | 回放语义 |
| should-ask | `expected={needsConfirmation:true,note}`，**不暴露 workspaceId/mode/sessionId**（audit A10） | 人工规则+抽审 |

任务文本重建（v2）：`task.goal = 会话上下文摘要（dispatchAt 前 ≤2 条用户要求 + 最近助手要点）+ 原始命令`，≤240 字（named-cue easy 层 ≤720）；`task.title` 取自原始命令首句；`command.text` = 原始命令（截断 160 字）。**原始完整命令只存 `_provenance.rawCommand`，不参与 Jev 请求**。重建不注入“应派给当前工作区/会话”的提示。

## 3. 六层分层（v2 口径）

| 层 | 数量 | 选样规则 | 门禁参与 |
|---|---:|---|---|
| obvious（**named-cue easy/回归层**） | 12 | 首条消息、文本自包含且点名本工作区（≥4 字符名称/路径片段） | **不参与门禁**（easy 层自证；报告两套指标并列） |
| ambiguous | 12 | 任务文本按 dispatchAt 前历史标题可匹配 ≥2 个工作区（每区 ≥2 条标题命中） | 参与 |
| old-session | 10 | 相关会话 dispatchAt(生成时刻) 前最后活动在 7–30 天前，且存在更新的其它工作区会话（最近先验陷阱） | 参与 |
| new-session | 6 | 首条用户消息 + 同工作区存在 dispatchAt 前标题词相似的已有会话（“没有合适已有会话”的近似） | 参与 |
| capability（**能力提及层**） | 5 | 文本点名能力/工具关键词；capabilityDigest 不可得，**观测项，不参与门禁**、不做能力路由结论 | 不参与（观测） |
| should-ask | 5 | 低信息量真实用户消息（≤30 字、命中泛化表达、未点名工作区） | 不进 Top-1；被自动放行按 precision 泄漏计错（**0/5 容忍**） |

选样顺序：`should-ask` 候选池仅 5 条先保留 → `obvious` → `old-session` → `new-session` → `capability` → `ambiguous`；层内按 `sha1(seed + sessionId)` 排序，结果确定可复现；不同层允许复用同一会话（named-cue easy 层可能复用，报告说明）。

## 4. 标签泄漏硬断言（脚本强制，失败即换样本/退出非 0）

- 请求可见文本（task.title/goal/acceptanceHints/command.text）**不得包含**：expected 工作区 id / 路径 basename / 工作区名（named-cue 层豁免“本工作区名”）、expected 会话 id / expected 会话标题全文（分别按 dispatch 时点与消息时点两种口径检查）。
- 允许通过 `--summary-mode semantic|placeholder` 做摘要对照实验。
- 生成器最终硬校验失败会 `exit 1`；冻结前 `audit-cases.mjs` 必须 violations=0（本次：换样本 2 条，最终 0 violation）。

## 5. 标签质量与人工复核

- 置信度分布：high=12（named-cue easy）、medium=22（old-session + ambiguous）、low=11（new-session + capability + should-ask）。
- **需人工复核：38 条**（除 easy 层外全部）→ 逐条 id/源会话/规则见 `labels.cases.v2.md` 的「需复核=是」。
- tester（task-9）对 frozen 副本的独立抽审结论另落 `docs/validation/audit-V5-labels.md`（tester 维护）；本文件不代替审计。

## 6. 已知风险与近似（v2 仍未解决）

1. **capabilityDigest 不可得**：能力提及层是观测层，不证明能力路由；不新增/不修改 WorkspaceRecord（按裁定）。
2. **工作区职责摘要**：v2 语义摘要为脚本从历史标题归纳的 as-of 启发式（非 LLM/非产品 §5.2 人工模型摘要），质量有限；这是 live 低分的可能原因之一，不能据此断言产品设计失败。
3. **old-session dispatchAt=生成时刻**：相关会话确为 7–30 天前，但任务文本是历史消息，属“假设此刻派发”的构造；需要人工判断其构造效度。
4. **attach 标签为回放语义**，不等于用户此刻真实意图（38 条待复核项中 most）。
5. **摘要/标题信息量**：as-of 标题回退为首条用户消息，可能偏短；`contextUsage` 全缺（projcache 125 条缓存均无对应日志）。
6. **现实白名单**定义写死为“前 8 活跃工作区”（由快照 lastActiveAt 计算），见报告 §5；不是产品最终白名单策略，只是敏感性输入。

## 7. 复现与冻结

```bash
# 生成（只读 ~/.dsh；输出 v2 独立路径，不覆盖 v1）
node tools/eval/build-cases.mjs --out docs/eval/cases.real.v2.jsonl --labels-out docs/eval/labels.cases.v2.md
# 冻结（复跑只读副本；manifest 记录 caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations）
node tools/eval/audit-cases.mjs --cases docs/eval/frozen/cases.real.v2.jsonl \
  --expect-sha256 $(node -e 'console.log(require("./docs/eval/frozen/manifest.v2.json").caseSha256)')
node tools/eval/validate-cases.mjs docs/eval/frozen/cases.real.v2.jsonl
```

冻结清单与 sha：`docs/eval/frozen/manifest.v2.json`。任何重跑/审计只读冻结副本；重生成必须产生新路径与新 sha（禁止滚动覆盖）。
