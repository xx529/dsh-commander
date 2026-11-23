# V5 v2 冻结评估独立审计

> 角色：**tester**（独立复核；不改 backend 产物：cases/report/labels/manifest 均只读）。
> 任务：`task-12`。审计对象：V5 v2 冻结案例 `docs/eval/frozen/cases.real.v2.jsonl`（`caseSha256=872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`）+ manifest + backend live 结论 + 门禁口径。
> 交付：本文件 + `tests/v5-audit/audit-v2.mjs`（可复跑）+ `tests/v5-audit/audit-v2-result.json` + `tests/v5-audit/live/`（独立 live 复跑 report/summary）。
> 隐私：不含任务正文；证据片段 ≤40 字；live key 由 `/tmp/dsh-commander-probe/jev.env` 进程内注入，未打印/未落盘。

## 0. 二值结论

**PASS：v2 冻结案例与 live FAIL 结论可以作为门禁 FAIL 的依据（证据链可复查、指标可复现、FAIL 方向在口径偏差下依然稳固）；按 Lead 2026-11-17 对 A4 片段的修正口径，v2 判 FAIL（非 INVALID）。**

- 冻结/哈希/清单/审计链完整可复核（F1–F9；`audit-cases.mjs` A1–A12 violations=0 可复现）。
- 独立 layered live 复跑（100 请求、0 失败）复现 backend 门禁数字：workspace **14.3%**、attach **5.6%**、模式 **53.6% vs 50.0%（Δ3.6pp）**、目标全对 **7.1%**；逐条 target 49/50 一致。阈值扫描两套口径均 **0 组合**达标；校准 0.9–1.0 桶 **0/4**（严重过自信）。距门禁阈值（85%/70%/85%/95%/40%）差距为数量级，**结论不可能被 3.6pp 级复跑波动翻转**。
- **口径裁定（Lead 2026-11-17，已生效）**：① A4 片段按修正口径判定——标题全文 / 期望会话标题 **≥8 CJK 连续片段** / oracle 字段（工作区名/id、会话 id/标题、摘要原文）才算违规，共享通用技术词（markdown/session/jev-desktop/agent-desktop 等）不算 → 本审计 5/50 字面命中**不构成泄漏**，**v2 判 FAIL（非 INVALID）**；architect 写入协议 §6.2B，backend 对齐 audit 脚本。② `dispatchAt` 实际=「会话最后一条 ≥12 字用户消息时间」，裁定**不重冻结重跑**（偏差偏利好模型，FAIL 更稳），但必须在 `labels.v2.md` / `report-v2.md` / `v5-jev-dispatch.md` 披露为 **MEDIUM 已知偏差**；重开门时按被测消息时间重新冻结。
- 同时如实记录 backend 侧其余 MEDIUM 证据完整性问题（§6：C6 coverage 分母、报告缺哈希头、frozen 只读位、audit-cases 覆盖缺口、文档渲染/同标题兄弟会话/语义提示），供正式门禁归档前修正。

## 1. 输入与冻结完整性（F 组）

| 检查 | 结果 | 证据 |
|---|---|---|
| F1 cases sha256 vs manifest / `.sha256` | PASS | 均为 `872cb12d…`；2,263,955B / 50 行 |
| F2 `.sha256` 副文件 | PASS | 内容一致 |
| F3 manifest 分层计数 | PASS | 12/12/10/6/5/5 与冻结文件一致 |
| F4 manifest 生成器/harness/审计脚本字节 | PASS | generator `0db97fbd…`、harness `87c32cde…`、audit `8ef3bb23…` 与当前文件一致 |
| F5 frozen cases 只读位 | **WARN** | mode=`644`；protocol §6.2A 要求“只读副本”（建议 `chmod 444`；内容未改，sha 可证） |
| F6 manifest dispatchTime min/max | PASS | 与 cases `_provenance.dispatchAt` 首尾一致：[2026-10-08T11:21:08.533Z, 2026-11-17T09:06:35.059Z] |
| F7 labels.cases.v2.md 行/字段 vs 冻结 cases | PASS | 50/50 一致（源会话/dispatchAt/期望工作区/模式/会话） |
| F8 标签计数声明 | PASS | 12/22/11、needsReview=38 与文件一致 |
| F9 文档渲染质量 | **WARN** | labels.cases.v2.md 一行渲染 `undefined/12`（`不点名任何工作区：undefined/12`，LOW，文档 bug） |

## 2. backend `audit-cases.mjs` 复现（A 组）

- 只读复跑（`--cases frozen --expect-sha256 manifest.caseSha256 --out tests/…`）：**violations=0 / pass=true**，caseSha256 一致，与 `docs/validation/v5-audit-cases.json` 完全一致 → **A1–A12 可复现**。
- **但审计脚本覆盖度 < protocol §6.2B 字面要求**（MEDIUM，A2）：A4 只查“期望会话标题全文”，未实现“标题 ≥8 字连续片段”；A9 只查 attach 会话存在/lastActive，未断言“请求文本只使用 pre-dispatch 事件”（本审计用日志独立重算补检，结果 PASS）；A5/A11 recentTasks 只做 full-title/源会话标题相等，未做 as-of 标题重算（本审计补检，结果 PASS）。→ **violations=0 不能单独作为“输入完整性 0 违规”的证据**，必须叠加本审计 §3。

## 3. as-of / 泄漏实证（L 组）

### 3.1 全部 50 条廉价检查

| 检查 | 结果 |
|---|---|
| **L1a** 请求文本无硬泄漏（非 named-cue 工作区 name/basename/id、期望会话 id、期望会话标题全文；named-cue 层按裁定豁免本工作区名/basename，id 仍禁止） | **PASS 50/50** |
| **L1b** protocol A4 片段（修正口径：标题全文 / ≥8 CJK 连续片段 / oracle 字段；Lead 2026-11-17 裁定） | **PASS 0 违规**。字面 8 字符命中 5/50（v5-21「markdown」、v5-24「jev-desktop/-desktop」、v5-25「session 之」、v5-43「dsh-diff-approval」、v5-45「agent-desktop」），均为标题与任务文本共享通用技术词；CJK ≥8 连续片段命中 0 → 按修正口径不计违规。backend `audit-cases.mjs` 尚未实现该条，需对齐 |
| **L2** `task.goal` 上下文摘要可由目标消息之前日志事件独立重算（A9 实证） | **PASS 50/50**（`contextSummary` 与重算逐字一致；goal 以摘要开头；rawCommand 空白归一化后与日志第 `messageIndex` 条消息一致） |
| **L2b** `dispatchAt` 语义 vs labels.v2「dispatchAt=该真实用户消息时间」声明 | **12/50 不一致（MEDIUM，需修正文案/下一轮）**：实际 `dispatchAt = 会话最后一条 ≥12 字用户消息时间`。非 old-session 案例中：v5-01（Δ1560min）、v5-02（50）、v5-04（5）、v5-05（50）、v5-07（2284）、v5-10（1242）、v5-11（869）、v5-12（169）、v5-29-new（26）、v5-30-new（247）、v5-32-new（71）、v5-33-new（3）；这些快照含 lastActiveAt>messageTime 的会话（v5-01 14 条、v5-07 21 条等）→ **相对“目标消息时刻”属 future info，对模型偏利好，故 FAIL 更稳**；old-session 层 dispatchAt=生成时刻（labels §1 已声明的例外，合法） |
| **L3** sessions 快照 as-of 自洽 | **PASS 50/50**：所有 `lastActiveAt ≤ dispatchAt`；new 案例不含源会话；attach 期望会话标题 = dispatchAt 前最后一个 `session/title`（或回退首条 pre-dispatch 用户消息）重算一致 |
| **L4** workspaces summary/recentTasks 由 as-of recentTasks 重算、无 A5/A11 违规 | **PASS 50/50**：summary 可由 `recentTasks.slice(0,3)` 逐字重算（摘要不读目标消息）；recentTasks 不含期望会话标题/源会话 as-of 标题/未命名占位 |
| **L4b** recentTasks 与请求文本的语义提示（门禁外公平性） | **8 个工作区标题与任务文本共享 ≥8 字符片段**（如「销售预测单提交业务流程」）；属 as-of 历史标题、客观存在，建议报告披露（MEDIUM） |
| **L5** should-ask 只记 `needs_confirmation`、不暴露 workspaceId/mode/sessionId | **PASS 5/5** |
| L7 抽样覆盖 | 25 条：should-ask=5（全部）/ new-session=6（全部）/ obvious=4 / old-session=4 / ambiguous=4 / capability=2，覆盖 6 层 |

### 3.2 抽样 25 条深检（原始日志独立重算）

- **L6 PASS 25/25**：attach 期望会话标题与 as-of 重算一致；消息时点期望会话标题不进入任务文本；each `recentTasks` 标题都能对应快照内某会话，且该会话 as-of 标题与之一致（来源可复查）。
- **L6b 1 条残留痕迹（MEDIUM）**：`v5-04-obvious` 的 sessions 快照含“源会话同标题兄弟会话”`…bbcdad94`（同首条消息的历史重复任务）；其 `createdAt ≤ messageTime`，非源会话、非未来信息、非 oracle 泄漏，但会诱导 attach（live 中该案例确实 attach 到该会话而 expected=new）。A8/A11 未覆盖此类，建议报告中披露或下一轮排除同标题兄弟会话。

## 4. 独立 live layered 复跑（tester 自跑，冻结副本）

命令（key 进程内注入，不打印；输出到 `tests/v5-audit/live/`，不写 `docs/eval/`）：

```bash
set -a; . /tmp/dsh-commander-probe/jev.env; set +a; export JEV_API_KEY="$TYPESAFE_API_KEY"
node tools/jev-eval.mjs docs/eval/frozen/cases.real.v2.jsonl --mode layered --criteria compact \
  --out tests/v5-audit/live/report-v2-layered-rerun.md \
  --summary-out tests/v5-audit/live/summary-v2-layered-rerun.json --gate   # exit 1
```

| 指标（gate=non-named-cue, n=28） | backend `summary-v2-layered.json` | tester 复跑 | Δ |
|---|---:|---:|---:|
| 工作区 Top-1 | 14.3% | **14.3%** | 0.0pp |
| 会话 Top-1（attach, n=18） | 5.6% | **5.6%** | 0.0pp |
| 模式准确率 | 50.0% | **53.6%** | +3.6pp |
| 目标全对 | 7.1% | **7.1%** | 0.0pp |
| all 口径（n=40）工作区 Top-1 | 30.0% | 32.5% | +2.5pp |
| 请求数 / 失败 | 100 / 0 | **100 / 0** | — |
| tokens input / output | 486,042 / 22,458 | 489,542 / 22,651 | 噪声级 |
| p95 延迟 | 1,454ms | 1,404ms | — |
| 逐条 target 判定一致 | — | **49/50（98%）** | — |

→ **backend 门禁数字可复现**；模式 3.6pp 差异属模型非确定性（请求级采样），不影响结论。

## 5. 门禁口径/数学核对（§6.6）

| 检查 | 结果 |
|---|---|
| G2 gate 分母 n=28 | PASS：45 labeled − 12 named-cue(easy) − 5 capability(观测) = 28；attach n=18 |
| G1/G3 report 数字 = summary 独立重算 | PASS（14.3/5.6/50.0/7.1 与 summary、report 三方一致） |
| G4 阈值扫描数学（`precision=correct(auto)/autoAll`，含 should-ask 泄漏；coverage 同 v1 分母口径） | PASS：320 组合全部枚举，**0 组合** precision≥95%（含惩罚 0%）；与协议“找不到组合→FAIL”一致 |
| G5 **C6 coverage 分母偏差（MEDIUM）** | harness 用 `served / gateSet(28)`，protocol §6.6 要求 `served / labeled(45)` → 同一 served 下 harness coverage 被放大 **1.61×**。本轮无 qualifying 组合，故不改 FAIL；但若未来有组合，coverage 判定会偏松，需修 harness |
| G6 protocol §6.6 口径复算 | PASS：按 `precision=correct/autoAll`、`coverage=served/45` 复算同样 0 组合达标 |
| G7/G8 校准 | PASS 复算一致：0.9–1.0 桶 0/4、0.8–0.9 桶 0/11 → 严重过自信，C8 不可过 |
| G9 **证据报告哈希入证（MEDIUM）** | `report-v2-layered.md`（逐条证据报告）头部**缺** `caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations`；`report-v2.md` 有、`summary-v2-layered.json` 无 caseSha256。protocol §6.2A.4 要求“每份证据与 report*.md 头部必须写 frozen 路径+sha256；harness 报告头打印 caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations” → 归档前应补（harness 侧或报告模板侧） |
| G10 full 模式不可行证据 | PASS：`evidence-v5-v2-full-live.log` 中 `max_tokens_exceeded` **29** 次，与报告 21/50 成功一致；A 模式不可行、默认 B 的结论有据 |
| 门禁口径合规（C1–C9 映射） | C1 证据链：frozen+manifest+sha+A1–A12 复现 PASS（报告头缺哈希为 G9 MEDIUM）；C2–C8 按 §6.6 复现 FAIL；C9 结论落地（默认 layered + 每次确认）与 §6.7 一致 |

## 6. 问题清单与裁定建议

### 已由 Lead 裁定（记录在案）

1. **A4 片段口径（L1b，已裁定）**：修正口径 = 标题全文 / 期望会话标题 ≥8 CJK 连续片段 / oracle 字段才算违规；共享通用技术词不算。→ 本审计 5/50 字面命中不构成泄漏，v2 判 **FAIL（非 INVALID）**；architect 更新协议 §6.2B、backend 对齐 `audit-cases.mjs`。
2. **`dispatchAt` 声明 vs 实现（L2b，已裁定为 MEDIUM 已知偏差，不重冻结）**：labels.v2/provenance 的 `snapshotSpec` 写“dispatchAt=message.time”，实际为“会话最后一条 ≥12 字用户消息时间”，12/50 非 old-session 案例受影响（快照含被测消息之后的会话活动，future info 偏利好模型）。Lead 裁定：本轮不重冻结重跑，但 `labels.v2.md`→（v2 已冻结，改为在 report/validation 文档）与 `report-v2.md`、`v5-jev-dispatch.md` 必须披露；重开门时按被测消息时间重新冻结。

### backend 侧证据完整性 MEDIUM（不改变结论，归档前修正）

3. **G5** C6 coverage 分母（harness 28 vs protocol 45）。
4. **G9** 逐条证据报告/摘要缺冻结哈希与生成器元信息（§6.2A.4）。
5. **F5** frozen cases 权限 0644（要求只读副本 0444）。
6. **A2** `audit-cases.mjs` 覆盖度低于 §6.2B（A4 片段、A9 语义、A5/A11 as-of 重算、summary as-of 派生均未覆盖；本审计已补检通过）。
7. **F9/L6b/L4b** 文档渲染 `undefined/12`；v5-04 同标题兄弟会话；8 个 recentTasks 语义提示 — 建议披露。

### 为什么不翻转 FAIL

- 复跑与 backend 指标在统计噪声内一致（最大 Δ3.6pp），距阈值差距 30–80pp；
- 阈值扫描在 **harness 与 protocol 双口径**下均无组合达标（最高含惩罚 precision 0%），C8 校准严重过自信，A 模式因 API 上限不可行；
- 上述口径问题若修正，只会让输入**更严格/更少 future info**，不会使 14.3% 提升到 85%。

## 7. v1→v2 差异：是否“调标签/调阈值”

- v2 样本与 v1 冻结样本（`tests/v5-audit/fixtures/v1-frozen.json`）按（源会话, 消息序）重叠 **16/50**；其余为换样本（v2 用 dispatchAt 参与 sha1 排序 + 泄漏硬断言换样本 2 条，规则在生成前冻结）。
- 重叠样本上标签变化 **5 条**，全部是 v1 `should-ask` 案例改为 v2 `{needsConfirmation:true}` 表示（v1 用 expected workspace/mode + tag），**不是**把错标改成对标；未发现“为通过调标签”。
- 阈值：backend 报告中的阈值组合仅作扫描/配置建议，门禁判定用固定 §6.6 阈值（C2 85%/C3 70%/C4 85%/C5 95%/C6 40%）；扫描未选任何组合，无“调阈值通过”痕迹。
- “因泄漏换样本 2 条”无独立日志可复算（LOW，不可验证；建议生成器输出 skipped 摘要进 stats）。

## 8. 限制

1. 25 条深检只对期望会话/源会话做标题 as-of 重算；快照内其余 ~250 条会话的标题未逐条读日志重算（由 L3 的 lastActiveAt ≤ dispatchAt + audit-cases A11 交叉覆盖），属抽样而非全量。
2. live 复跑为一次性采样，模型非确定性导致模式/工作区 0–3.6pp 波动；结论稳健但“精确数字”不可逐位复现。
3. 未审 backend 在本轮对 `tools/jev-eval.mjs`/`build-cases.mjs` 的改动过程（只核对当前字节与 manifest 一致）；不判断其设计合理性。
4. 未读取/打印 `~/.dsh/.env`；`~/.dsh` 只读；未改 `docs/eval/**`、`docs/validation/v5-*` 等 backend 产物（审计输出均在 `tests/v5-audit/**`）。
5. V1–V4 独立复跑属 task-6，等 devops/task-4 完成后另行 claim；本文件不涉。

## 9. 复跑与证据

```bash
# 完整 v2 独立审计（含复跑 backend audit-cases，写 tests/ 下结果）
node tests/v5-audit/audit-v2.mjs
# 只读不跑 audit-cases
node tests/v5-audit/audit-v2.mjs --no-audit-rerun
# 冻结副本完整性（manifest 模式）
node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json
# 独立 live layered 复跑（见 §4；输出 tests/v5-audit/live/）
```

| 证据 | 路径 | sha256 |
|---|---|---|
| 审计结果 JSON | `tests/v5-audit/audit-v2-result.json` | `9ccb1cbdd1856ed145a5e53b4d4fb6b661e49c0c14ac787fdd215b7894680573` |
| 审计脚本 | `tests/v5-audit/audit-v2.mjs` | `521f27eff36b44e224570519fe66a630584fc30db8a11a6195d1f6b15f55ecc3` |
| 独立复跑 summary | `tests/v5-audit/live/summary-v2-layered-rerun.json` | `ee7a769cee71c21399622f86faf6e8489e5d9a414c44fbd8c0c0e9f44bbeeb07` |
| 独立复跑 report | `tests/v5-audit/live/report-v2-layered-rerun.md` | `f546d76a5d779a4a8d596dd510d7ff081444ce552f5f3bfd986a1ef99bd014fd` |
| v2 冻结案例 | `docs/eval/frozen/cases.real.v2.jsonl` | `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6` |
| manifest | `docs/eval/frozen/manifest.v2.json` | 见 F1–F4 |

**最终回答（task-12）：v2 可以作为门禁 FAIL 的依据（PASS，FAIL 非 INVALID）；正式门禁记录中须披露 §6 的 1 项已知偏差（dispatchAt，MEDIUM）+ 其余证据完整性 MEDIUM（C6 分母、报告缺哈希头、frozen 只读位、audit-cases 覆盖缺口、文档渲染/同标题兄弟会话/语义提示）。**
