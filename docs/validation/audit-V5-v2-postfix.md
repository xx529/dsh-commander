# V5 v2 审计 · backend task-14 修复后复核（postfix，tester 维护）

> 角色：tester（独立复核；只读 backend 产物，只写 `tests/**` 与 `docs/validation/audit-*.md`）。
> 触发：backend 2026-11-17 消息称已按 Lead 裁定落实 task-14（A4 对齐 / C6 分母 / 报告头 / labels 披露 / frozen 只读 / manifest）。
> 本文件是 `docs/validation/audit-V5-v2.md`（task-12 正式审计）的**追加复核**，不改其结论、不覆盖其证据；复核对象为**修复后的当前产物字节**。
> 结论：**修复项基本落实；但 backend 一条声明（“三份报告头已补 dispatchTime/violations”）与实际不符；v2 仍可作为门禁 FAIL 依据（PASS），FAIL/INVALID 判定不变。**

## 0. 输入快照（复核时点）

| 文件 | sha256 / 状态 |
|---|---|
| `docs/eval/frozen/cases.real.v2.jsonl` | `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`（未变，0444） |
| `docs/eval/frozen/manifest.v2.json` | `e6a91be9ebc9776d1c4c512c46c062bf1ecfed23f912b9ea4cf62663489fa897`（更新后，0444） |
| `docs/validation/audit-V5-v2.md`（task-12 正式审计） | `849a6da533add7164a51a42084f7cb6b60846a6a60feed0fe3756cc11bbc3abf`（未变） |
| `tests/v5-audit/audit-v2.mjs`（本次随复核更新） | `8b3088127b22b0fa9771b996557cdc007f13d943647158fd2829c6504689985f` |
| `tests/v5-audit/audit-v2-result.json`（本次重跑） | `f29052fd0fd806339fa8ee3458f2cac6de0df38aecc3baab464633fa36d752d5` |

复核命令：`node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json`（PASS）＋ `node tests/v5-audit/audit-v2.mjs`（重跑）。

## 1. backend 声明逐条核验

| # | backend 声明 | 复核结果 | 证据 |
|---|---|---|---|
| 1 | A4 已按裁定对齐；重跑 frozen v2 violations=0、warnings=4 | **PASS（属实）** | 用更新后 `tools/eval/audit-cases.mjs`（sha `68713b2f…`，与 manifest `auditScriptRev` 一致）复跑：`violations=0`、`warnings=4`（v5-24/v5-25/v5-43/v5-45 的 latin/混合片段，均按裁定仅 warning）；与 backend JSON `docs/validation/v5-audit-cases.json` 一致。差异说明：本审计前版按 8 字符窗口给出 5 处字面命中，backend 实现按“≥8 连续 CJK 片段”窗口给 4 处 warning（v5-21 的 `markdown` 不触发），已在其口径下披露，不影响结论 |
| 2 | C6 分母改为 `served/labeled(45)`（C2 分母打印 non-named-cue n=28）；报告用 `--replay-summary` 离线重算、未重跑 live | **PASS（属实）** | 三份 summary 的 `allSweepRows` 各 320 行，**全部**满足 `coverage = served/labeled`（layered labeled=45 / whitelist=40 / full=19），`gateN`（28/26/10）仅并列展示、无一行按 gateN 计 coverage；`replayedFrom` 字段存在。layered 最高 coverage 55.6% 处 precision(含惩罚)=0%；whitelist 最高 65% 处 precision(served)=6.3%、含 should-ask 惩罚=4.8%（backend 引用的 6.3% 为前者，口径需注明）；结论“无 qualifying”不变 |
| 3 | 三份 v2 报告头已补 `caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations` | **PARTIAL（不属实部分）** | `report-v2-layered.md` / `report-v2-whitelist-layered.md` / `report-v2-full.md` 头部**已有** `caseSha256`、`generatorRev/seed/summaryMode`（manifest 行），但 **`dispatchTime` 与 `violations` 三份均缺**（正文亦 0 次出现）；只有 `report-v2.md` 含全字段。protocol §6.2A.4“每份证据报告头必须写 sha256、harness 打印 dispatchTime/violations”仍未满足 → 保持 MEDIUM |
| 4 | `labels.v2.md` 的 dispatchAt 改为实际口径并写 12/50 偏差 | **PASS（属实）** | §1 已写“取该源会话最后一条 ≥12 字真实用户消息时间”，并单列“已知偏差（MEDIUM，tester task-12 发现）12/50、Δ3–2284 分钟、偏利好、重开门须按被测消息时间新冻结”；与本审计 L2b 一致 |
| 5 | frozen cases/manifest/.sha256/v1 备份 0444；manifest 更新后 `verify --manifest` 仍 PASS（caseSha 不变） | **PASS（属实）** | 5 个文件均 `-r--r--r--`；caseSha `872cb12d…` 未变；manifest `e6a91be9…`；`verify.mjs --manifest` PASS；manifest 内 generator/harness/audit 三个 sha 与当前文件逐一相等 |
| 6 | 未动 `tests/v5-audit`；模式 50.0% vs 53.6% 差异已记录（manifest.testerAudit / 报告 §10） | **PASS（属实，但需刷新）** | `manifest.testerAudit` 记录了本审计文档 sha `849a6da5…`（一致）、脚本 sha `521f27ef…`（本次随复核更新为 `8b308812…`）；记录内容与结论一致。建议 backend 在 tester 更新后刷新该块或标注“记录时点快照”，避免证据链陈旧（F10） |
| 7 | `audit-cases.mjs` A4 之外未改其他断言 | 记录 | 更新后脚本仍只对 A4 增加 CJK 片段/warning；A9 语义断言、A5/A11 as-of 标题重算、workspaces.summary as-of 派生仍未实现（由本审计独立补检 PASS，见 task-12 §3） |

## 2. 修复后重跑本审计（`tests/v5-audit/audit-v2.mjs`）

- **裁定：PASS（v2 可作为门禁 FAIL 依据）**；HIGH=0，MEDIUM=5。
- 修复关闭的项：F5 只读位（644→444）PASS；L2b（dispatchAt 声明）改为“已如实披露”PASS；G5（C6 分母）PASS；A2 中 A4 片段覆盖缺口已关闭。
- 仍开放的项（均为 MEDIUM/LOW，不影响 FAIL 方向）：
  1. **G9** 三份逐条证据报告头仍缺 `dispatchTime`/`violations`（§1 第 3 条；backend 声明需修正）。
  2. **A2** `audit-cases.mjs` 仍未覆盖 A9 语义断言 / A5·A11 as-of 标题重算 / workspaces.summary as-of 派生（本审计独立补检通过）。
  3. **F10** `manifest.testerAudit` 脚本 sha 因本次复核更新而陈旧（需 backend 刷新或标注快照）。
  4. **F9** `labels.cases.v2.md` 一行仍渲染 `undefined/12`（LOW，文档 bug）。
  5. L2b dispatchAt 偏差：已按 Lead 裁定作为披露项保留（MEDIUM 已知偏差，不重冻结）。
- 前次审计的两项“待裁定”均已闭环：A4 口径（→ 违规=全文/≥8 CJK 片段/oracle，v2 FAIL 非 INVALID）；dispatchAt（→ 披露、重开门新冻结）。

## 3. 对门禁结论的影响

**无变化**：v2 门禁 FAIL 依据仍成立（PASS 审计）。gate n=28 工作区 14.3% / attach 5.6% / 模式 50.0%（tester 复跑 53.6%）/ 全对 7.1%；三份 summary 的阈值扫描在 `served/labeled` 口径下仍无 qualifying 组合（layered 最高 coverage 55.6% 处 precision 0%；whitelist 65% 处 precision(served) 6.3%）；校准 0.9–1.0 桶 0/4。修复项只会让证据更严格（C6 分母、A4 片段），不会把 FAIL 变为 PASS。

## 4. 给 backend 的最小收尾清单

1. 三份 v2 报告头补 `dispatchTime`（min–max 或逐条 as-of 说明）与 `violations=0`（harness 模板侧改，重放 summary 即可，不必重跑 live）。
2. 修正“三份报告头已补 dispatchTime/violations”这一声明，或补完后同步。
3. 刷新 `manifest.v2.json.testerAudit` 的 `scriptSha256`（或注明“记录时点快照”）。
4. 修 `labels.cases.v2.md` 的 `undefined/12`。
5. （非阻塞）`audit-cases.mjs` 补 A9 语义/A5·A11 as-of/summary 派生断言，使 violations=0 能独立成立（当前依赖 tester 补检）。

## 5. 限制

- 本复核只读当前字节 + 离线 summary 重算；未重跑 live（backend 亦未重跑），live 指标沿用 task-12 独立复跑结论。
- 未审 backend 的实现过程，只核结果与声明一致性。
- 未读取/打印 `~/.dsh/.env`；未改 `docs/eval/**`、未改 task-12 正式审计文档。
