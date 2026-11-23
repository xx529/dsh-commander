# V5 Jev 派发 50 案例（阈值门禁）

- 结论：**FAIL**
- 独立审计（tester task-12）：**PASS（FAIL 依据可复现/可用）** — 只读 frozen v2 + `verify.mjs --manifest` + 独立 layered live 复跑 100 请求 0 失败；gate n=28 工作区 14.3%、attach 5.6%、模式 53.6%（本执行 50.0%，Δ3.6pp 抽样/判定差）、全对 7.1%；逐条 target 49/50 一致。审计报告 `docs/validation/audit-V5-v2.md`（sha256 `849a6da533add7164a51a42084f7cb6b60846a6a60feed0fe3756cc11bbc3abf`），脚本 `tests/v5-audit/audit-v2.mjs`。
- 执行人 / 执行时间：backend（task-5）/ 2026-11-17 17:08（Asia/Shanghai；live 运行 09:08Z 起）
- 环境：本机 `~/.dsh` 只读数据；DSH 未重启；端点 `https://api.typesafe.ai/v1/systemone`、模型 `jev-latest`；key 由 `/tmp/dsh-commander-probe/jev.env` 进程内注入（未打印/未落盘）；harness `tools/jev-eval.mjs`（sha256 `87c32cde266549ab03be9d64b45b6aacace57994d08073cfd5385ea97496a079`）。
- 前置检查：
  - P1 案例存在/全过 schema：**PASS** — frozen v2 50 条，`validate-cases.mjs` 退出码 0，`audit-cases.mjs` A1–A12 violations=0。
  - P2 分层 12/12/10/6/5/5：**PASS**（`docs/validation/v5-audit-cases.json`）。
  - P3 标签真实+非最近/词面先验：**部分 PASS** — cwd/消息序推导自洽、as-of 快照+泄漏硬断言 0 violation；但 38/50 标签标 needs-review，人工复核（lead 仲裁/tester 抽审）尚未完成，`labels.v2.md` §5 已列清单。
  - P4 Key 可用：**PASS**（live 请求有真实 usage 返回；未打印 key）。
- 探针形态：P-B（独立 Node 脚本，`tools/jev-eval.mjs`，零依赖）。

## 步骤与原始返回

1. **冻结与审计**（只读冻结副本；复跑只读）
   ```bash
   node tools/eval/audit-cases.mjs --cases docs/eval/frozen/cases.real.v2.jsonl \
     --expect-sha256 872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6
   # exit 0；violations=0；caseSha256=872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6
   # generatorRev=0db97fbd8da1a3ca；seed=v5；summaryMode=semantic；dispatchTime [2026-10-08T11:21:08Z, 2026-11-17T09:06:35Z]
   ```
2. **live B（layered）**
   ```bash
   node /Users/lzx/Documents/GitHub/dsh-commander/tools/jev-eval.mjs \
     docs/eval/frozen/cases.real.v2.jsonl --mode layered --criteria compact \
     --out docs/eval/report-v2-layered.md --summary-out docs/eval/summary-v2-layered.json --gate
   # exit 1（--gate：C2/C3/C4/C5/C6 不达标）；100 请求全成功
   ```
3. **live B（现实白名单变体）**：同上加 `--whitelist reality` → `report-v2-whitelist-layered.md`，exit 1（C2–C6 不达标；5/50 派生 needs_confirmation）。
4. **live A（full，容错模式）**：`--mode full --criteria compact --skip-errors` → 21/50 成功、**29 条 HTTP 400 `{"detail":{"error_type":"max_tokens_exceeded"}}`**；成功案例 avg input 22,145 tokens（>24k 预算）→ exit 1。
5. **小规模输入上限诊断**：同案例截断会话数 0/30/60/100/150 成功、200 失败；150 会话请求 usage input=32,699 / output=1,850 → 全量 251 会话必然超限（`docs/validation/evidence-v5-full-mode-diagnostics.log`）。
6. **mock 自检**（≠ live，仅为管线正确性）：`--mock` 两模式均生成报告，阈值扫描/校准/双口径/白名单路径可运行；mock 数字不进入门禁。

## 判据核对（门禁口径 = non-named-cue，n=28；coverage 分母=labeled 45）

> C6 分母按 task-14 修正为 protocol §6.6：`served/labeled(45)`（named-cue 计入、observational 不计）；C2 分母打印 non-named-cue 实际 n=28。报告由已存 live summary 离线重算（`--replay-summary`），未重跑 live，结论不变。

| ID | 判据 | 实测 | 结论 |
|---|---|---|---|
| V5-C1 | 50 条全过 schema；分层 12/12/10/6/5/5；标签可复核 | 50/50 schema OK；分层 OK；audit A1–A12 violations=0；38 条待人工复核 | PASS（复核待完成） |
| V5-C2 | 工作区 Top-1 ≥85% | **14.3%**（4/28；all 口径 30.0%，含 named-cue easy 8/12） | FAIL |
| V5-C3 | 会话 Top-1（attach） ≥70% | **5.6%**（1/18） | FAIL |
| V5-C4 | 模式准确率 ≥85% | **50.0%**（14/28） | FAIL |
| V5-C5 | auto precision ≥95% | 无组合；能放行 gate 案例的阈值均泄漏 should-ask（0/5 容忍）→ 最高含惩罚 precision **0%** | FAIL |
| V5-C6 | auto coverage ≥40%（served/labeled=45） | 无组合；coverage 最高 55.6% 处 precision 0%；precision 达标点 coverage 0% | FAIL |
| V5-C7 | p95<3s；全量 tokens≤24k | layered p95 **1,454ms** PASS；full 29/50 HTTP 400 且 22.1k tokens → FAIL（A 不可行） | FAIL |
| V5-C8 | 校准单调、无过自信 | pMax 0.9–1.0 桶 accuracy **0%**（4 条），0.8–0.9 桶 0%（11 条）→ 严重过自信 | FAIL |
| V5-C9 | 全量 vs 两层结论落地 | 结论明确：A 不可行、默认 B（layered）；B 指标不达标 | PASS |

**V5 总判据 = C1∧…∧C9 = FAIL。**

## 失败细节

- 非 named-cue 层工作区判派能力缺失：old-session 1/10、new-session 1/6、ambiguous 2/12；named-cue easy 层 8/12 → 模型主要在“读名字”。
- 会话 attach 几乎全错（1/18）：as-of 快照 + 回放语义 + 重建上下文后，模型倾向 new 或错误会话。
- confidence 不可用：高置信桶全错，模型对错误答案也给 0.9+。
- full 模式受 API 输入上限与 24k 预算双重限制；≤150 会话可过 API 但 32.7k tokens 仍超预算。
- 现实白名单（前 8 活跃）降低 tokens（8.0k/案例）但未提升准确率（门禁工作区 26.9%、模式 34.6%）。
- **A4 对齐（lead/architect 裁定）**：违规 = 期望会话标题**全文** / 标题 **≥8 连续 CJK 片段** / oracle 字段（工作区 id、路径 basename、会话 id）；通用技术词（latin 片段）不计违规。`audit-cases.mjs` 已对齐并重跑：**violations=0**，warnings=4（均为共享技术词片段，按裁定不计违规）；JSON 见 `docs/validation/v5-audit-cases.json`。
- **MEDIUM 已知偏差**：12/50 非 old-session 案例 dispatchAt 晚于被测消息（实现口径=会话最后一条 ≥12 字用户消息；Δ3–2284min），快照含被测消息之后活动的会话 → 偏利好模型、FAIL 更稳；重开门前必须按被测消息时间重新生成并重新冻结（新 sha）。另：v5-04-obvious 快照含同标题兄弟会话（历史重复任务，非源会话）；frozen cases/manifest 已设 0444。

## 停止条件映射

按 `docs/architecture/validation-protocol.md` §6.7：

- precision < 95%（任何阈值组合）→ **V5 FAIL** → **NEXT-PHASE §7.3：默认“每次派发都确认”，M1 不做自动派发**；M1 默认 `autoDispatch=false`，`ConfigRecord.jev.threshold/confidenceFloor` 仅保留为 UI 提示候选（0.90 / 0.70，不得用于放行）。
- full 不可行 → 默认模式固定为 **B（layered）**。
- 门槛重开条件见 `docs/eval/report-v2.md` §8。

- tester 独立补检（audit-cases 未覆盖 A9/A5/A11/summary 派生断言）：`docs/validation/audit-V5-v2.md`、`docs/validation/audit-V5-v2-postfix.md`（补检 PASS，非阻塞）

## 复跑审计（tester）

- 审计人 / 时间 / 结论：**待 tester（task-9）对冻结副本独立复跑并签名**（本文件不代替审计；执行人 backend 不担任本项审计人）。
- 复跑对象：`docs/eval/frozen/cases.real.v2.jsonl`（caseSha256 `872cb12d…`）；复跑命令见上；`audit-cases.mjs` 输出 `docs/validation/v5-audit-cases.json`（violations=0）。tester 已独立复跑并给 PASS（见本文件头部）。
- v1 说明：v1 案例按 lead 裁定方法学不成立（终态标题泄漏/S9 自相矛盾/obvious 自证），仅作无效基线。
  - v1 cases：`docs/eval/frozen/cases.real.v1.jsonl`，sha256 `3c588014746775f4ee52f0b679947178673d7b0237ad72c047df0117830ee966`，3,129,467B / 50 行；**无 `_meta`/`_provenance` 字段**。
  - v1 labels：`docs/eval/frozen/labels.cases.v1.md`，sha256 `5f2d3158988d750614b23fe3b98aafdba1769f73a2037266c7d517b515180bbf`；头部 dispatchTime=`2026-11-17T08:46:50.014Z`（v1 唯一时间来源；生成器日志同值）。
  - v1 数据集独立审计：`docs/validation/audit-V5-labels.md`（sha256 `d4503b0c852550bbca60f4873b547721ce145fb7c8b4e228ceb622f37604d46a`，tester 维护，E1=4/50、E2=25/50、S9=15/50）。
  - 上述元信息已同步进 `docs/eval/frozen/manifest.v2.json` 的 `v1Baseline` 块（含 cases/labels sha、bytes、lines、dispatchTime、hasMeta=false）。
