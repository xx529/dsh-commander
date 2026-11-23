# V5 v2 审计 · backend task-15 修复后复核（postfix2，tester 维护）

> 触发：backend 2026-11-17 消息称 task-15 三项已修（报告头补 dispatchTime/violations、labels `undefined/12`、manifest.testerAudit 刷新 + dispatch 文档披露），并要求复核。
> 本文件是 `audit-V5-v2.md`（task-12 正式审计）与 `audit-V5-v2-postfix.md`（task-14 复核）的**追加复核**；不改前者结论、不改其 sha。
> 复核方式：只读当前字节 + `tests/v5-audit/verify.mjs --manifest` + 重跑 `tests/v5-audit/audit-v2.mjs`（不重跑 live）。
> 结论：**task-15 三项修复属实、已闭环；新增 1 项 MEDIUM（manifest 生成器 sha 冻结后漂移）；v2 门禁结论不变：FAIL，且审计 PASS（FAIL 依据可用）。**

## 0. 输入快照（复核时点；backend 声明 sha 与实际逐一核对）

| 文件 | backend 声明 sha | 实测 sha | 一致 |
|---|---|---|---|
| `docs/eval/report-v2-layered.md` | `635ebecaf985001e…` | `635ebecaf985001e17db23efa78df2cb481ae7e3012688012ac37094df1de87b` | ✅ |
| `docs/eval/report-v2-whitelist-layered.md` | `d7339af5c679ef00…` | `d7339af5c679ef0039126ae1d2da0ce79fa337d3a97ffd1040cf5ce96c3d731e` | ✅ |
| `docs/eval/report-v2-full.md` | `ffd17df5bf738c62…` | `ffd17df5bf738c627c2a45cd73e82c6f53caf9c372dbd1c2bc2c9aa5595a9816` | ✅ |
| `docs/eval/labels.cases.v2.md` | `e3ae2dfd7461a0c2…` | `e3ae2dfd7461a0c2f717a6d8c0b602223c2224b0843f7b0fe07aa690f8b417af` | ✅ |
| `docs/eval/frozen/manifest.v2.json` | `ba5ba74c22126408…` | `ba5ba74c22126408df635e0540471bcc0b8af5c405c0ef5432cb89c5e504d93c`（0444） | ✅ |
| `tools/jev-eval.mjs` | `1b35b1dfdcf9a0d7…` | `1b35b1dfdcf9a0d75ceea4b02e1c609eb98d434f2021d8c6aece6a86383df36b` | ✅ |
| `docs/eval/frozen/cases.real.v2.jsonl` | 未变 | `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6` | ✅ |

`node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json` → **PASS**（cases sha 一致、generatorRev/seed/summaryMode/dispatchTime/leakViolations=0 可读）。

## 1. task-15 声明逐条核验

| # | 声明 | 结果 | 证据 |
|---|---|---|---|
| 1 | 三份 report-v2-*.md 头补 `dispatchTime`（per-case as-of 区间）与 `violations`（manifest.leakViolations/auditResult=0）+ replay 标注 | **PASS** | 三份报告头均含 `caseSha256`/`generatorRev`/`seed`/`summaryMode`/`dispatchTime`/`violations` 六字段 + `run: replay` 标注；`audit-v2.mjs` G9 由 WARN → **PASS** |
| 2 | `labels.cases.v2.md` 的 `undefined/12` 修正；build-cases 模板同步修、v2 frozen 未动 | **PASS** | 现第 8 行为「obvious(named-cue easy) 层：12/12 条点名本工作区…；未截断 12/12」；`tools/eval/build-cases.mjs` 模板亦含该修正；frozen cases sha 未变（caseSha `872cb12d…`） |
| 3 | `manifest.v2.json` testerAudit 刷新（记录 audit-v2 脚本/结果/审计文档/postfix 文档 sha，capturedAt 时点快照），evidenceFiles 扩到 13 项 | **PASS** | manifest `testerAudit` 现为嵌套结构：`v2Audit.sha256=849a6da5…`、`v2PostfixAudit.sha256=a13c2f14…`、`scriptSha256=8b308812…`、`resultSha256=f29052fd…`、`capturedAt=2026-11-17T09:28:56.824Z`、`repairReview` 说明；审计 F10 对 doc/postfix 记录 PASS（脚本 sha 因本轮复核更新见 §2） |
| 4 | `v5-jev-dispatch.md` 如实写明 A9 语义 / A5·A11 as-of 标题重算 / 工作区摘要派生断言不在 audit-cases 覆盖、由 tester 补检 | **PASS** | 第 71 行：「tester 独立补检（audit-cases 未覆盖 A9/A5/A11/summary 派生断言）：audit-V5-v2.md、audit-V5-v2-postfix.md（补检 PASS，非阻塞）」 |
| 5 | `verify --manifest` PASS、caseSha 不变、V5 结论不变 FAIL | **PASS** | 见 §0；FAIL 结论与 task-12/14 一致 |

## 2. 本轮复核发现的新问题（1 项 MEDIUM，需 backend 标注）

**F4 生成器 sha 冻结后漂移（MEDIUM）**：manifest 记录 `generatorSha256=0db97fbd8da1a3ca…`，但当前 `tools/eval/build-cases.mjs` 实测 `f5817aeb76368c30…`（task-15 为修 `undefined/12` 模板而改动）。影响：
- 冻结案例本身不受影响（`caseSha256` 未变，仍由记录版本生成）；
- 但将来按协议 §6.2A 复核“生成器版本可复现”时，manifest 记录的生成器与当前仓库文件不一致，无法从当前 HEAD 重放同一输出（模板输出文本已变）。
- 建议：manifest 增补 `generatorSha256AtFreeze`（=0db97fbd…，冻结时）与 `generatorSha256Current`（=f5817aeb…，注明 task-15 模板修复、frozen 未重生成）或加 `generatorDriftNote`；harness/audit 两项本轮回填后已一致。

另：`testerAudit.scriptSha256=8b308812…` 是 backend 刷新时点快照；本轮复核中 tester 为修正 F4/F10 检查逻辑把 `audit-v2.mjs` 更新为 `f8859bc5…`（文档 `audit-V5-v2-postfix2.md` 为本轮新增）。manifest 的 capturedAt 语义已能接受该差异，但如要求“零陈旧”，请 backend 在本文件产生后把 scriptSha256 刷新为 `f8859bc5…` 并把本文件加入 evidenceFiles。

## 3. 重跑审计后的最终状态

`node tests/v5-audit/audit-v2.mjs` → **PASS（v2 可作为门禁 FAIL 依据）**；HIGH=0，MEDIUM=5：

| 项 | 级别 | 状态 |
|---|---|---|
| F4 生成器 sha 冻结后漂移 | MEDIUM | 本轮新发现（§2），需 manifest 标注；不影响 frozen caseSha |
| A2 audit-cases 仍缺 A9 语义 / A5·A11 as-of / summary 派生断言 | MEDIUM | 已由 backend 在 dispatch 文档如实披露为“tester 补检覆盖”（#4）；本审计补检 PASS，非阻塞 |
| F10 manifest.testerAudit 脚本 sha 因本轮复核更新而陈旧 | MEDIUM | 时点快照语义可接受；backend 可刷新（§2） |
| L4b recentTasks 与任务文本语义提示（8 个工作区标题） | MEDIUM | 公平性披露项（非 A5/A11 违规），建议报告保留说明 |
| L6b v5-04-obvious 源会话同标题兄弟会话 | MEDIUM | 历史重复任务、非源会话/非未来信息，已披露 |
| L2b dispatchAt 已知偏差 | MEDIUM（已裁定） | labels.v2 如实披露；不重冻结，重开门新冻结 |

已闭环（相比 postfix 版）：G9（报告头字段）→ PASS；F9（undefined/12）→ PASS；F5（0444）→ PASS；G5（C6 分母）→ PASS；A4（片段口径）→ PASS。

## 4. 结论

- **task-15 三项修复属实并闭环**；backend 声明与文件字节一致（仅 §2 的生成器 sha 漂移是**新出现**、非其声明错误）。
- **V5 v2 = FAIL 不变；v2 门禁证据可用（审计 PASS）不变。**
- 归档前仅需：manifest 增加生成器“冻结时/当前”双哈希标注（§2）、可选刷新 testerAudit.scriptSha256 并纳入本文件。

## 5. 限制

- 只读当前字节 + 离线 summary 重算；未重跑 live（沿用 task-12 独立 layered 复跑：gate n=28 工作区 14.3%/attach 5.6%/模式 53.6%/全对 7.1%，与 backend 50.0%/5.6%/14.3%/7.1% 统计一致）。
- 未审 backend 实现过程；未改 `docs/eval/**` 与既有审计文档；未读取/打印 `~/.dsh/.env`。
