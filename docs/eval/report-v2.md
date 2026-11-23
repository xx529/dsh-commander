# V5 · Jev 派发评估报告 v2（as-of-dispatch · 冻结案例）

> 权威口径：本文取代 v1（v1 方法学不成立，仅作无效基线，见 `report-v1-baseline-layered.md` 与 §3 注）。
> 冻结案例：`docs/eval/frozen/cases.real.v2.jsonl`（`caseSha256=872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`，manifest 见 `docs/eval/frozen/manifest.v2.json`）
> 生成器 `tools/eval/build-cases.mjs`（generatorRev=`0db97fbd8da1a3ca`）、seed=`v5`、summaryMode=`semantic(as-of 启发式)`、dispatchTime ∈ [2026-10-08T11:21:08Z, 2026-11-17T09:06:35Z]（每条案例各自 dispatchAt）
> 审计：`tools/eval/audit-cases.mjs`（A1–A12；A4 按 lead/architect 裁定：标题全文 / 标题 ≥8 连续 CJK 片段 / oracle 字段 算违规，通用技术词不算）对冻结副本 **violations=0**、warnings=4（均为共享技术词片段，按裁定不计违规）（`docs/validation/v5-audit-cases.json`）
> 独立审计：tester（task-12）`docs/validation/audit-V5-v2.md`（PASS；独立 live 复跑 gate n=28 工作区 14.3%、attach 5.6%、模式 **53.6%**（本报告 50.0%，Δ3.6pp 属抽样/判定差）、全对 7.1%；逐条 target 49/50 一致）
> 工具：`tools/jev-eval.mjs`（generatorRev 见 manifest；`--mode full|layered`、`--criteria compact`、`--whitelist all|reality`、`--skip-errors`）
> **mock ≠ live**：本报告所有门禁数字来自 live；mock 仅 harness 自检。

## 0. 结论

**V5 v2 = FAIL。** live layered（50 案例 / 100 请求，frozen 副本）门禁口径（non-named-cue，n=28）：工作区 Top-1 **14.3%**、会话 Top-1(attach) **5.6%**、模式 **50.0%**、目标全对 **7.1%**；阈值扫描**没有任何组合**能同时满足 precision≥95% 与 coverage≥40%（含 should-ask 泄漏惩罚后最高 precision=0%）；校准严重过自信（pMax 0.9–1.0 桶准确率 **0%**）。全量模式 live **不可行**（21/50 请求成功、29 条 400 `max_tokens_exceeded`；成功案例平均 22,145 tokens > 24k 预算）。现实白名单变体同样 FAIL（门禁工作区 Top-1 26.9%，5/50 案例因期望不在白名单转 needs_confirmation）。
→ 按 `validation-protocol.md` §6.7 映射 **NEXT-PHASE §7.3：默认“每次派发都确认”，M1 不做自动派发**。未改阈值、未伪造 live、未为通过调标签。

## 1. 运行与环境

| 项 | 值 |
|---|---|
| 环境 | 本机 `~/.dsh` 只读；未启动/重启 DSH；未打印/落盘 key |
| 端点 / 模型 | `https://api.typesafe.ai/v1/systemone` / `jev-latest` |
| 案例 | frozen v2：50 条，分层 12/12/10/6/5/5，audit A1–A12 violations=0 |
| 快照口径 | `v2-asof-dispatch`：sessions/title/workspaces.recentTasks 均只含 dispatchAt 之前数据；new 案例快照不含目标会话；attach 期望会话标题只用 dispatch 前 session/title 事件或首条 pre-dispatch 用户消息重建 |
| layared 运行 | 2026-11-17T09:08Z 起；100 请求全部成功；退出码 1（--gate 检测 C2–C6 不达标） |

```bash
set -a; . /tmp/dsh-commander-probe/jev.env; set +a; export JEV_API_KEY="$TYPESAFE_API_KEY"
CASES=docs/eval/frozen/cases.real.v2.jsonl
node tools/jev-eval.mjs $CASES --mode layered --criteria compact \
  --out docs/eval/report-v2-layered.md --summary-out docs/eval/summary-v2-layered.json --gate                    # exit 1
node tools/jev-eval.mjs $CASES --mode layered --criteria compact --whitelist reality \
  --out docs/eval/report-v2-whitelist-layered.md --summary-out docs/eval/summary-v2-whitelist-layered.json --gate # exit 1
node tools/jev-eval.mjs $CASES --mode full --criteria compact --skip-errors \
  --out docs/eval/report-v2-full.md --summary-out docs/eval/summary-v2-full.json --gate                          # exit 1（29 条 400）
```

## 2. 指标（live layered，冻结 v2）

口径：`gate` = non-named-cue 且非观测项、非 should-ask、非派生 needs_confirmation（n=28：old 10 + new 6 + ambiguous 12）；`all` = 含 named-cue easy 层的 40 条。

| 指标 | 门禁口径（gate, n=28） | 报告口径（all, n=40） | 目标 |
|---|---:|---:|---|
| 工作区 Top-1 | **14.3%** | 30.0% | ≥85% |
| 会话 Top-1（attach） | **5.6%**（1/18） | 5.6%（1/18） | ≥70% |
| 模式（new/attach） | **50.0%** | 52.5% | ≥85% |
| 目标全对 | **7.1%** | 12.5% | — |
| workspace/session 冲突 | 0 | 0 | 0 |
| should-ask / named-cue / observational / derived | 5 / 12 / 5 / 0 | — | — |

分层（live）：old-session 工作区 1/10、new-session 1/6、ambiguous 2/12、obvious(named-cue easy) 8/12、capability(观测) 1/5。
why：named-cue easy 层（点名工作区）8/12 明显高于非点名层（4/28≈14.3%），说明模型主要读名字，而非理解职责/上下文；v2 的 as-of 快照让“同工作区近期会话”信息变少，非 named-cue 层更差。

## 3. v1 vs v2（v1 仅无效基线）

| 项 | v1（方法学不成立：占位摘要 + 原始单条消息 + 终态标题泄漏） | v2（as-of + 任务重建 + 泄漏审计 0） |
|---|---|---|
| 工作区 Top-1（总体/门禁口径） | 40.0%（含 obvious 12/12） | 30.0% overall / **14.3% gate** |
| 会话 Top-1(attach) | 4.5% | 5.6% |
| 模式 | 55.6% | 50.0% |
| 目标全对 | 15.6% | 7.1% |
| 自动派发达标组合 | 0 | 0 |
| 案例审计 | 无 as-of/泄漏审计（tester 审计发现 E2/S9 等） | A1–A12 violations=0 |
| full 模式 | 400 max_tokens_exceeded | 21/50 成功、29 条 400；成功案例 22.1k tokens 仍 >24k |

> v1 数字只作“无效基线”对照；v2 在更严格输入（无终态泄漏、无 named-cue 计入门禁）下更低，属预期：**原高分主要来自 easy 层与泄漏，而非判派能力**。

## 4. 阈值扫描与校准

- 扫描网格：pWorkspace/pSession ∈ {0.5,0.6,0.7,0.75,0.8,0.85,0.9,0.95} × confidenceFloor ∈ {0.3,0.4,0.5,0.6,0.7}。
- 口径修正（task-14）：C6 coverage 分母改为 protocol §6.6 的 **labeled=45**（含 named-cue、不含 observational；served 亦然），C2 分母仍为 **non-named-cue 实际 n=28**；本轮报告已用已存 live summary **离线重算**（`--replay-summary`，未重跑 live），结论不变。
- **无组合满足** precision≥95% 且 coverage≥40%。`precisionWithShouldAskPenalty` 最高 **0%**（任何能放行 gate 案例的阈值也会放行 should-ask，立即违反 0/5 容忍）；coverage 最高 **55.6%**（pW=pS=0.5、floor=0.3）处 precision 0%。
- 全量扫描表见 `summary-v2-layered.json` 的 `allSweepRows`；逐条结果见 `caseResults`。

校准（pMax=max(pW,pS)，gate 口径，n=28）：

| pMax 桶 | n | accuracy |
|---|---:|---:|
| <0.5 | 0 | — |
| 0.5–0.6 | 1 | 100% |
| 0.6–0.7 | 6 | 16.7% |
| 0.7–0.8 | 6 | 0% |
| 0.8–0.9 | 11 | 0% |
| 0.9–1.0 | 4 | 0% |

→ **严重过自信**：模型在高置信区间几乎全错，confidence 不可作为自动放行依据。

## 5. 白名单敏感性（M1 配置建议输入）

定义（写死可复现，A12 校验输入完备）：`--whitelist reality` = dispatch 时点前按会话最后活动排名的 **前 8 个工作区**（由快照 `sessions[].lastActiveAt` 计算，不额外加入期望工作区）。期望工作区不在白名单的案例记 `needs_confirmation`、不进 Top-1 分母。

| 项 | all 白名单 | reality 白名单（前 8） |
|---|---:|---:|
| 门禁工作区 Top-1 | 14.3%（n=28） | **26.9%**（n=26） |
| 门禁模式 | 50.0% | 34.6% |
| 门禁目标全对 | 7.1% | 11.5% |
| 派生 needs_confirmation | 0 | **5/50** |
| tokens/案例 | 9,721 | 8,024 |
| p95 时延 | 1,454ms | 1,263ms |

结论：收窄到前 8 个工作区**降低请求成本但未提升判派准确率**（模式/目标全对更差），且 5 条案例被迫询问。M1 若启用现实白名单，必须默认“每次确认”，不能据此开 auto。

## 6. 全量 vs 两层

| 项 | A 全量（--mode full） | B 两层（默认） |
|---|---|---|
| live 成功/失败 | **21/50 成功，29 条 HTTP 400 `max_tokens_exceeded`** | 50/50 成功 |
| tokens/案例（成功案例） | 22,145（仍 >24k 预算） | 9,721 |
| 已标注分母（labeled / gate n） | 19 / 10 | 45 / 28 |
| p50/p95 时延 | 522ms / 992ms（成功子集） | 870ms / 1,454ms（整体） |
| 无冲突目标全对 | 0/10（gate） | 2/28（gate，7.1%） |
| 结论 | **不可行**（API 输入上限 + 超 24k 预算） | 可运行但指标不达标 |

→ 设计必须按两层落地；A 模式从 V5 live 中淘汰（不是靠调 tokens 参数可解，需 ≤150 会话截断才能通过 API，但截断会破坏“全部非归档会话”口径）。诊断证据：`docs/validation/evidence-v5-full-mode-diagnostics.log`（150 会话=32,699 input tokens 成功；200/251 会话 400）。

## 7. 判据与停止条件

| ID | 目标 | v2 实测 | 判定 |
|---|---|---|---|
| V5-C1 | 50 条/schema/分层/标签审计 | 50；audit A1–A12 violations=0；P3 人工复核仍需 tester 抽审 | ✅（待 tester 对 frozen 副本复核） |
| V5-C2 | 工作区 Top-1 ≥85% | 14.3%（门禁口径） | ❌ |
| V5-C3 | 会话 Top-1(attach) ≥70% | 5.6% | ❌ |
| V5-C4 | 模式 ≥85% | 50.0% | ❌ |
| V5-C5 | auto precision ≥95% | 无组合；最高含惩罚 precision 0% | ❌ |
| V5-C6 | auto coverage ≥40%（分母 labeled=45；served 含 named-cue、不含 observational） | 无组合；能放行 gate 案例的阈值 precision=0；coverage 最高 55.6% 处 precision 0% | ❌ |
| V5-C7 | p95<3s；全量 tokens≤24k | layered p95 1.45s ✅；full 不可行（400 + 22.1k）❌ | ❌（A） |
| V5-C8 | 校准 | 高置信桶 0% → 过自信 | ❌ |
| V5-C9 | 全量 vs 两层结论 | 明确：default B layered；A 淘汰 | ✅ |

**V5 = FAIL** → `NEXT-PHASE §7.3`：默认每次派发都确认，M1 关闭 auto。

## 10. 独立审计与已知偏差（task-14 落地）

- **独立审计（tester task-12）**：frozen v2 完整性校验 PASS；独立 layered live 复跑 100 请求 0 失败，gate n=28 工作区 14.3%、attach 5.6%、模式 53.6%、全对 7.1%，逐条 target 49/50 与本报告一致；模式 50.0% vs 53.6% 属抽样/判定差（不翻转 FAIL）。详见 `docs/validation/audit-V5-v2.md`。
- **dispatchAt 口径偏差（MEDIUM）**：实现为“该会话最后一条 ≥12 字用户消息时间”，12/50 非 old-session 案例 dispatchAt 晚于被测消息（Δ3–2284 分钟），快照含被测消息之后活动的会话 → **偏利好模型，FAIL 更稳**。重开门前必须按“被测消息时间”重新生成并**重新冻结（新 sha，不覆盖 v2）**；`labels.v2.md` §1 已写明。
- **A4 标题片段口径**：按 lead/architect 裁定只对“标题全文 / ≥8 连续 CJK 片段 / oracle 字段”判违规；通用技术词（v5-21 markdown、v5-24 jev-desktop、v5-25 session、v5-43 dsh-diff-approval、v5-45 agent-desktop 等 5 处 latin 片段）不计违规，audit JSON 中作 warnings 披露（本工具实现为 4 处，tester 为 5 处，差异源于片段窗口实现）。
- **其他披露**：v5-04-obvious 快照含“与源会话同标题的兄弟会话”（`createdAt ≤ messageTime`，属历史重复任务，非源会话；已披露）；frozen cases 与 manifest 已设 0444 只读；report/summary 头已绑定 `caseSha256` / `generatorRev` / `seed` / `summaryMode` / `dispatchTime` / `violations`。

## 8. 建议（写回位置）

- M1 默认 `autoDispatch=false`（每次确认）；`ConfigRecord.jev.threshold / confidenceFloor` 默认常量仅作 UI 提示候选（threshold=0.90 / confidenceFloor=0.70；本轮无组合达标，不得用于放行）。
- M1 若配置现实白名单（前 8 活跃 + 期望工作区），只能降低上下文成本，不能作为自动放行依据。
- 重开门条件：① 工作区职责/能力摘要接入（当前真实数据无 summary/capabilityDigest）；② 38 条 needs-review 标签经人工/LLM 复核并冻结；③ named-cue easy 层不计门禁的前提下，非点名层 Top-1 有数量级提升；④ 在 B 模式下重跑 C2–C6 全过。

## 9. 证据清单

- `docs/eval/frozen/cases.real.v2.jsonl` + `.sha256` + `frozen/manifest.v2.json`（冻结；审计只读）
- `docs/validation/v5-audit-cases.json`（A1–A12，violations=0）
- `docs/eval/report-v2-layered.md` / `summary-v2-layered.json`（live layered 全量白名单）
- `docs/eval/report-v2-whitelist-layered.md` / `summary-v2-whitelist-layered.json`（现实白名单）
- `docs/eval/report-v2-full.md` / `summary-v2-full.json`（full + --skip-errors，29 条 400）
- `docs/validation/evidence-v5-v2-*.log`（stderr 原始日志与退出码）
- `docs/eval/labels.v2.md`、`docs/eval/labels.cases.v2.md`（规则与逐条标注）
