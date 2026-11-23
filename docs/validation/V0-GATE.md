# V0 验证门禁 · 最终记录（GATE）

> 版本：v1.0（final）　日期：2026-11-17 17:49（Asia/Shanghai）
> 记录人：architect（task-18；只写本文件，未修改任何被引用文档、冻结文档或实现）
> 上游依据：`docs/NEXT-PHASE.md` §3（V0 门禁）/§7（停止条件）/§4（M0/M1）；`docs/architecture/validation-protocol.md`（记录时点 sha256 `e0f9818ad1574d6d…`）；`docs/eval/jev-dispatch-eval.md`。
> 本文件只**汇总已落盘事实**并给出门禁裁定与索引，不新增验证结论、不改任何判据。

---

## 0. 一句话结论

**V0 门禁 = FAIL。** V1–V4 PASS（带 stub/分支/裁定限制），**V5 FAIL**（v2 冻结案例 live 结果不达门禁阈值）。按 `NEXT-PHASE §7.3` 降级：**默认"每次派发都确认"、M1 `autoDispatch=false`、默认模式 B（layered）**；`threshold/confidenceFloor` 仅作 UI 提示，不得用于放行。**按用户指令停在验证阶段，未启动 M0/M1。**

---

## 1. 产物索引（全部为仓库内现有文件；sha256 取记录时点，见 §8）

### 1.1 V1–V5 验证记录（执行人：devops / backend）

| V | 文档 | sha256 前 16 | 结论 | 执行人 |
|---|---|---|---|---|
| V1 | `docs/validation/v1-capability-panel.md` | `1a3ff43282c03ccc` | PASS | devops（task-3） |
| V2 | `docs/validation/v2-turn-end-last-reply.md` | `83b8d9183859314c` | PASS（stub 模型/注入 answerer） | devops（task-4） |
| V3 | `docs/validation/v3-session-controller.md` | `1328454811ea72e5` | PASS（cwd 分支；workspaceId BLOCKED） | devops（task-4） |
| V4 | `docs/validation/v4-storage-domain.md` | `6d5d134b7dd705d2` | PASS（`board_edits` 裁定，两段式） | devops（task-4） |
| V5 | `docs/validation/v5-jev-dispatch.md` | `1a90cada6d60d93b` | **FAIL** | backend（task-5） |

证据目录（原始 artifacts，只读）：

- `docs/validation/v1-artifacts/`、`v2-artifacts/`、`v3-artifacts/`、`v4-artifacts/`
- `docs/validation/v5-audit-cases.json`（A1–A12 审计结果，violations=0）
- `docs/validation/evidence-v5-*.log`（layered/whitelist/full/诊断原始日志）

### 1.2 tester 独立审计

| 文档 | sha256 前 16 | 审计对象 | 结论 |
|---|---|---|---|
| `docs/validation/audit-V1-V4.md` | `2f33d523df39aa69` | V1–V4 证据 + 独立复跑 | **PASS**（30/30 断言、parity 30/30；HIGH 0 / MEDIUM 2 / LOW 3） |
| `docs/validation/audit-V5-labels.md` | `d4503b0c852550bb` | v1 数据集标签审计（无效基线） | v1 方法学不成立（E1=4/50、E2=25/50、S9=15/50） |
| `docs/validation/audit-V5-v2.md` | `849a6da533add716` | v2 冻结案例 + live FAIL 依据 | **PASS**（FAIL 依据可复现；独立 live 复跑 gate n=28 Δ≤3.6pp；逐条 target 49/50 一致） |
| `docs/validation/audit-V5-v2-postfix.md` | `a13c2f1467ec070b` | task-14 复核 | 补检 PASS（非阻塞） |
| `docs/validation/audit-V5-v2-postfix2.md` | `7f567f92d64967df` | task-15 修复复核 | PASS；新增 1 项 MEDIUM（生成器 sha 冻结后漂移，task-16 已修） |

审计脚本：`tests/validation/run-all.mjs`、`tests/v5-audit/audit-v2.mjs`、`tests/v5-audit/verify.mjs`。

### 1.3 研究/架构输入

| 文档 | 用途 | sha256 前 16 |
|---|---|---|
| `docs/research/validation-env.md` | 隔离探针环境取证（scout） | `23b367c78845ed5a` |
| `docs/research/capability-panel-api.md` | capabilityPanel 契约（scout） | `743881dacc448602` |
| `docs/architecture/validation-protocol.md` | V1–V5 验收协议（判据源） | `e0f9818ad1574d6d` |
| `docs/architecture/implementation-plan.md` | M0/M1 实现蓝图（含 D1/D2/D9 裁定） | `ab237cee34f355c2` |
| `docs/architecture/v5-review.md` | V5 v1 方法学复核（冻结/泄漏/named-cue 来源） | `7824c7d1dabc15cb` |
| `docs/ARCHITECTURE.md` | 数据模型/工具/Jev（含 `board_edits` 修正） | `dc45f743f512cb0b` |

### 1.4 冻结案例与 V5 报告（门禁证据链）

| 产物 | sha256 | 说明 |
|---|---|---|
| `docs/eval/frozen/cases.real.v2.jsonl` | `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6` | **门禁唯一输入**，0444 只读，50 条 |
| `docs/eval/frozen/manifest.v2.json` | `c41c56f6eaabef00…`（记录时） | caseSha/generator 双哈希/seed/summaryMode/dispatchTime/leakViolations=0/liveRuns/testerAudit |
| `docs/eval/report-v2.md` | `7e4df8d3cdc1aea6…` | 权威 V5 报告（含 §8 重开门条件） |
| `docs/eval/report-v2-layered.md` | `635ebecaf985001e…` | B 模式（门禁） |
| `docs/eval/report-v2-whitelist-layered.md` | `d7339af5c679ef00…` | 现实白名单诊断（非门禁） |
| `docs/eval/report-v2-full.md` | `ffd17df5bf738c62…` | A 模式（29/50 HTTP 400，不可行） |
| `docs/eval/frozen/cases.real.v1.jsonl` | `3c588014746775f4…` | v1 无效基线（方法学不成立，仅存档） |

---

## 2. 二值结果表

| V | 判据（协议节） | 结论 | 关键实测 | 独立复核 |
|---|---|---|---|---|
| **V1** | §2 V1-C1…C5 | **PASS** | 面板 thunk 解析 `panelRawType=function, version=1.19.3`；冷会话 `rank ok、items=8`；`apply pending:true,applied:0` → `agent/created` 后 `pendingOutcome.applied=1`；二次 rank `enabledInSession=true`；面板禁用回退 `inherit/panel_unavailable` | tester PASS（8/8） |
| **V2** | §3 V2-C1…C5 | **PASS** | plain：注入 1 次 `lastSeq=17`；同键第二次 `duplicate`；未配对 `approval/asked` 时 `shouldInject=false, pendingApprovals=1`；放行后 1 次注入 + duplicate；跨 turn 新键可注入 | tester PASS（5/5） |
| **V3** | §4 V3-C1…C6 | **PASS**（限制见 §5） | `create({cwd})` 落点正确；`workspaceId+cwd` 同传被拒；bad preset 拒绝；`selectModel` 生效；stub prompt `turn/end completed`；重启后同 `sessionId` resume、`turn=2`、无新会话 | tester PASS（7/7） |
| **V4** | §5 V4-C1…C7 | **PASS**（两段式） | ① 冻结原名 `boardEdits` → `defineDomain`/json 后端双重拒绝（C1 FAIL）；② Lead 裁定改 `board_edits`；③ 改后 C1–C7 全 PASS（往返/key 规则/update+version/并发/重启持久 version=6/非法 key 拒绝） | tester PASS（4/4） |
| **V5** | §6 V5-C1…C9 | **FAIL** | gate 口径 non-named-cue **n=28**：工作区 Top-1 **14.3%**（4/28）、attach 会话 Top-1 **5.6%**（1/18）、模式 **50.0%**、目标全对 **7.1%**；无组合同时满足 precision≥95% × coverage≥40%（含 should-ask 泄漏惩罚最高 precision=0%）；校准 0.9–1.0 桶准确率 **0%**；full 模式 **29/50 HTTP 400**（`max_tokens_exceeded`）；layered p95 1454ms（C7 时延项 PASS） | tester PASS（FAIL 依据可用；n=28 Δ≤3.6pp） |

> V5 口径备注（Lead 2026-11-17 裁定，已落 `validation-protocol.md` §6.2B/§6.6）：v2 判 **FAIL 而非 INVALID**（A4 片段口径下 tester 5/50 字面命中属共享技术词，不算泄漏）；C2 分母 = non-named-cue 门禁层 labeled（v2 n=28）；C6 分母 = 门禁层 labeled（v2 n=40），v2 harness 曾用 28 属实现偏差、已对齐且**本轮无翻转**。

---

## 3. Lead 裁定时间线（2026-11-17，按发生顺序）

| # | 时点/任务 | 裁定 | 落文/证据 |
|---|---|---|---|
| R1 | task-7（下午） | **D1** `CapabilityPlan.enabled/disabled` 只写提交给 `apply` 的 plan 项 name（不增字段/不用计数）；**D2** 未决决策仅内存+TTL30m，重启/过期 `decision_expired`，不扩 `DispatchRecord` schema；**D9** 面板不可用/rank/apply 失败 → 回退 inherit 继续派发（`fallback+reason`），不 blocked（ARCHITECTURE §7 该行为旧口径）；同时对齐角色分工（V1–V4 devops、V5 backend、tester 独立审计） | `implementation-plan.md` §15.1；`validation-protocol.md` §1.1/§7 |
| R2 | task-8/task-10（V5 v1 复核后） | **obvious 层** → named-cue easy/回归层单列，门禁 C2 只在 non-named-cue labeled 算；**should-ask 自动放行容忍度 0/5**；**能力驱动层** → 「能力提及层（观测项，不参与门禁）」，不改 `WorkspaceRecord`、不加 capabilityDigest；新增**白名单敏感性**（诊断非门禁） | `validation-protocol.md` §6.2 P2/A7/§6.2C/§6.6；`v5-review.md` §11–§13 |
| R3 | task-11（V4 实测后，17:10 前后） | **`boardEdits`→`board_edits`**（per-record **表名**须匹配 `/^[a-z][a-z0-9_]*$/`；**key 规则不变**，仍为 `[a-zA-Z0-9_-]+`、`__` 复合 key 不受影响；键 `editId`、`BoardEditRecord` 字段、layout/version/语义不变；NEXT-PHASE 提法不改） | `ARCHITECTURE.md` 文首修正记录+§3.2；`implementation-plan.md` §4.1；`validation-protocol.md` V4-C1/§7 |
| R4 | task-13/task-14（V5 v2 审计后，17:2x） | **A4 片段口径**：仅标题全文 / ≥8 连续 CJK 片段 / oracle 字段算违规，通用技术词豁免 → **v2 判 FAIL 非 INVALID**；**C2/C6 分母**按 §2 口径落文（C6 用 28 属实现偏差、已对齐、无翻转）；**dispatchAt 已知偏差不重冻结**（12/50 未声明偏差 + 10/50 已声明例外，偏利好模型 → FAIL 更稳；LABELS 文案改实际口径并披露 MEDIUM；**重开门必须按被测消息时间重新冻结**） | `validation-protocol.md` §6.2B A4/A12+dispatchAt 定义/§6.6 脚注；`v5-jev-dispatch.md` MEDIUM 披露 |
| R5 | task-14/15/16（17:3x–17:4x） | **V5 v2 冻结案例与 FAIL 结论作为最终门禁依据**（不再重跑/不重冻结；v2 审计 PASS；报告头字段、labels 修、manifest 双哈希漂移均闭环） | `v5-jev-dispatch.md`；`audit-V5-v2-postfix2.md`；manifest `generatorSha256Frozen/Current`（task-16） |

> 以上裁定均"只改口径/事实，不改数值阈值与十条冻结决策"（NEXT-PHASE §2）。

---

## 4. 门禁裁定与降级

| 项 | 裁定 |
|---|---|
| **V0 门禁** | **FAIL**（V1–V4 PASS 不构成通过；V5 FAIL 是门禁项） |
| 依据 | `NEXT-PHASE` §3「V1–V5 全过才进入 M0/M1」；V5 精确映射 `NEXT-PHASE` §7.3 |
| 降级动作（已写入 V5 产物，待 M1 实现） | ① 默认**每次派发都确认**（不做自动派发）；② M1 `autoDispatch=false`；③ 派发默认模式固定 **B（layered）**（full 实测不可行）；④ `ConfigRecord.jev.threshold / confidenceFloor` 默认值（0.90 / 0.70）**仅作 UI 提示候选，不得用于自动放行** |
| M0/M1 状态 | **未启动**（按用户指令停在验证阶段）；无插件安装、无生产代码、live Desktop 未重启/未改 |
| 下一步 | 见 §6（重开门条件）与 §7（复跑入口）；由 lead/用户决定是否重开 V5 或接受"确认式派发"进入 M0 |

> 边界：本裁定不改变"不达 precision 95% 不自动派发"的冻结决策；也不因输入缺陷把 V5 改判 PASS（V5 v1 已判方法学无效，v2 是唯一有效依据）。

---

## 5. 已知限制与未闭合项

| # | 项 | 级别 | 影响 | owner / 状态 |
|---|---|---|---|---|
| L1 | V2/V3 使用探针 **stub LLM provider**（`probe-stub/stub-1`，不联网、非真实模型），审批用注入 answerer | 限制（已声明） | 真实 provider/真实审批 UI 的端到端未验证，留 M0 | devops 已声明；M0 验收项 |
| L2 | V3 **workspaceId 分支 BLOCKED**：隔离 home 的 `workspaceRegistry.list()` 为 0，仅验证 `cwd` 分支 | BLOCKED（已声明） | "新会话落在指定 workspaceId"留 M0/Desktop 只读复验 | devops 已声明；M0 |
| L3 | V2 **真实浏览器 `pendingInteraction`** 未覆盖（headless 用未配对 `approval/asked` 等价判据） | 限制 | 真实 UI 双处渲染/Owner 语义留 M0（V6） | devops 已声明 |
| L4 | V5 标签 **38/50 needs-review 未完全人工复核**（cwd/mode 推导自洽、A1–A12=0，但人工裁决未完成） | MEDIUM | 标签噪声可能影响指标绝对值；FAIL 方向不受影响 | backend/tester；V5-C1 标"复核待完成" |
| L5 | V5 v2 **dispatchAt 偏差**：12/50（8 obvious+4 new-session）晚于被测消息（实现口径=会话最后一条 ≥12 字用户消息），偏利好模型 | MEDIUM（已披露） | 使 v2 结果对模型更宽松，FAIL 更稳；重开门须按被测消息时间重冻结 | Lead 裁定不重跑；backend 已披露 |
| L6 | **验证脚本从零复跑性**：`setup-probe-env.sh` 只建 `scout` profile、run 脚本写死输出目录（tester M1/M2） | MEDIUM | 第三方"零手工"复跑证据链不成立；tester 用副本完成复跑 | devops **task-17（pending）** |
| L7 | `full` 模式受 Jev 输入上限 + 24k 预算双重限制（29/50 400；≤150 会话可过 API 但 32.7k tokens 仍超预算） | 限制 | A 模式不可用，默认 B；C9 结论已落 | 已裁定（默认 B） |
| L8 | manifest **生成器 sha 冻结后漂移**（task-15 改模板） | MEDIUM（已闭环） | frozen cases 字节未变；manifest 已改双哈希（frozen/current） | task-16 已修 |
| L9 | v1 数据集方法学不成立（终态标题泄漏/obvious 自证/占位摘要） | 已裁定（INVALID 基线） | v1 数字不得作为门禁依据，仅存档 | lead 已裁定；v2 为唯一依据 |
| L10 | V5 现实白名单为诊断项（非门禁）：gate 工作区 26.9%/模式 34.6%，5/50 转 needs_confirmation | 诊断 | 仅作 M1 配置建议，不改门禁 | 已落 §6.2C |

---

## 6. 重开门条件（reopen V5 前必须全部满足）

> 来源：`docs/eval/report-v2.md` §8（Lead 已确认写入）+ `validation-protocol.md` §6.2A/§6.2B/§6.2C/§6.6。任何一项未满足不得重开，也不得复用 v2 冻结副本。

1. **按被测消息时间重新生成并冻结**：`dispatchAt = 被测消息时间`（消除 L5 偏差）；生成后立即写 `docs/eval/frozen/cases.<round>.<sha12>.jsonl` + `manifest.json`（新 sha、generator 冻结/当前双哈希、seed、summaryMode、layerCounts、dispatchTime）；**不得复用 `872cb12d…` 副本**。
2. **输入完整性**：`audit-cases.mjs` A1–A12 **violations=0**（A4 按 §6.2B 可执行口径；A12 校验 dispatchAt 规则与偏差分布为 0）。
3. **工作区语义输入**：接入/冻结**工作区职责摘要**（当前真实数据无 `summary`/`capabilityDigest`；v2 用 as-of 启发式摘要）；能力提及层继续作观测项。
4. **标签复核**：38/50 needs-review 完成人工/LLM 复核并冻结（含 should-ask 5 条全部重判）；`needsReview=0` 或剩余项有 lead 签字豁免。
5. **口径不变**：named-cue 单列、C2=non-named-cue n、C6=门禁层 labeled、should-ask 0/5、B 模式（layered）；阈值 **≥95% precision / ≥40% coverage / ≥85% workspace / ≥70% attach / ≥85% mode / p95<3s / 单请求≤24k** 一律不放宽。
6. **重跑并落证据**：B 模式跑 C2–C6（建议同时跑 whitelist 诊断与 placeholder 对照）；报告头含 caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations；tester 只对 frozen 副本复跑并出审计（PASS 才可作为门禁依据）。
7. **C9 与默认模式**：重跑后重新确认 full 是否可行（若按 §5.5 压缩后 ≤24k 且更准则默认 A，否则 B）；结论写回报告。

---

## 7. 复跑入口（只读冻结副本，不改证据）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander

# 1) V1–V4：证据断言（只读 devops artifacts）
node tests/validation/run-all.mjs                 # 期望 30/30 PASS
# 2) V1–V4：独立复跑（隔离 home → tests/validation/runs/**；不覆盖 docs/validation 证据）
node tests/validation/run-all.mjs --run
node tests/validation/run-all.mjs --base rerun    # 断言 tester 独立复跑输出

# 3) V5：冻结副本完整性 + 输入审计（A1–A12）
node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json
node tests/v5-audit/audit-v2.mjs                  # 只读；期望 PASS

# 4) V5 指标（如需复现 live，需 /tmp/dsh-commander-probe/jev.env；不得打印 key）
set -a; . /tmp/dsh-commander-probe/jev.env; set +a; export JEV_API_KEY="$TYPESAFE_API_KEY"
node tools/jev-eval.mjs docs/eval/frozen/cases.real.v2.jsonl --mode layered \
  --out docs/eval/report-v2-layered.md --summary-out docs/eval/summary-v2-layered.json --gate
```

> 注意：`tools/validation/scripts/run-v*.sh` 默认写 `docs/validation/vN-artifacts`（会覆盖证据，L6/task-17 修）；复跑必须给 `OUTDIR` 指向 `tests/validation/runs/**` 或临时目录。任何对 `docs/validation/**`、`docs/eval/frozen/**` 的写操作都违反 `validation-protocol.md` §6.2A。

---

## 8. 冻结与只读基线（记录时点）

| 项 | 值 |
|---|---|
| V5 冻结输入 | `cases.real.v2.jsonl` sha256 `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`，50 条，0444 |
| manifest | `docs/eval/frozen/manifest.v2.json`（caseSha/generatorSha256Frozen=`0db97fbd…`/generatorSha256Current=`f5817aeb…`/generatorDriftNote/seed=`v5`/summaryMode=`semantic`/leakViolations=0/testerAudit 记录；task-16 已把脚本双哈希与漂移说明写入） |
| 报告头 | `report-v2-layered.md` 含 caseSha256/generatorRev/seed/summaryMode/dispatchTime/violations + replay 标注（task-15 已补齐） |
| 只读性 | frozen 目录与证据文件 0444；`docs/validation/**` 未被本轮记录修改（本文件为新增） |
| live 基线 | V1–V4 探针前后 live-state diff 0；未重启/未安装/未写 `~/.dsh`；V5 live 只读 `~/.dsh` samples（key 进程内注入，未打印/未落盘） |

---

## 9. 交接状态

- **生产代码/插件**：未写（`packages/dsh-commander` 不存在）。
- **M0/M1**：未启动；实现蓝图（`implementation-plan.md`）与验收映射已就绪，待门禁重开或用户接受"确认式派发"后启用。
- **阻塞下一阶段的门禁项**：V5 FAIL（唯一）；V1–V4 的限制项（L1–L3）按计划留 M0 真实验收。
- **未闭合文档/任务**：devops task-17（脚本从零复跑性，MEDIUM）；v5 标签人工复核（L4）；重开门需的新数据集（§6）。

---

## 10. 引用与不修改声明

- 本记录只汇总 `docs/validation/**`、`docs/eval/**`、`docs/research/**`、`docs/architecture/**`、`docs/ARCHITECTURE.md` 与 `tests/**` 的既有产物；未修改上述任何被引用文件、未改冻结文档（`docs/NEXT-PHASE.md`、`docs/ARCHITECTURE.md` 数据模型、`docs/PRODUCT-DESIGN.md`）、未 write 实现代码。
- 任何数字若与被引用文档冲突，以被引用文档 + 冻结副本 + tester 审计为准；本文件只作索引与裁定记录。

---

## 11. Post-gate 诊断（非门禁，不改变裁定）

> 性质：V0 门禁仍为 **FAIL**（§0/§2/§4 结论不变）、M0/M1 **未启动**。本节只把门禁失败后的**诊断产物**挂到记录上，为"是否重开 V5 / 如何重开"提供证据；**不改判据、不改 V5 结论、不构成 PASS 依据、不改冻结决策**。诊断本身不是门禁轮次，产物不得替代 `cases.real.v2.jsonl`/报告/审计。

### 11.1 产物索引（均只读引用，未修改）

| 产物 | 内容 | sha256 前 16 |
|---|---|---|
| `docs/eval/diagnostics-v3.md` | 诊断实验 D1 候选规模（28/8/4 路）、D2 逐候选打分 vs choice、D3 oracle 工作区下的会话隔离、D4 置信度/abstention；138 请求、p50 432ms/p95 609ms | `575162e2a8beaebb` |
| `docs/research/v5-failure-analysis.md` | gate 26 条错案逐案根因（可推断性判定、`.dsh` 磁吸、会话标题信号、天花板上限假设） | `a6d34011b02d0cac` |
| `docs/architecture/v5-reopen-plan.md` | 重开方案：归因假设 a–f（PENDING）、判定架构 P1–P5、数据集 v3 协议、冻结边界、A/B 排期 | `af45ad723158ee2a` |
| `docs/validation/audit-V5-rootcause.md` | tester 独立盲评（10 条 input-only 重判）+ gate 数字复算 + 对 scout Inference 的降级裁决 | `d8c35e954176ebea` |

### 11.2 可复现 Fact（tester 独立复算 7/7 一致；来源 `audit-V5-rootcause.md` §1–§2）

| # | Fact | 值 | 证据 |
|---|---|---|---|
| F1 | gate 条数（non-named-cue 门禁层 labeled） | **n=28** | `summary-v2-layered.json` / `report-v2-layered.md` |
| F2 | gate 目标全对 / 错案 | **2 / 26**（对：v5-27、v5-44） | 同上 |
| F3 | 工作区 Top-1 | **4/28 = 14.3%** | 同上 |
| F4 | attach 会话 Top-1 | **1/18 = 5.6%** | 同上 |
| F5 | 模式准确率 | **14/28 = 50.0%** | 同上 |
| F6 | 错案中选中元工作区 `.dsh` | **16/26 = 61.5%**（其中期望 Research→`.dsh` 11 条） | `v5-failure-analysis.md` §0/§2；tester 复算同值 |
| F7 | `pW ≥ 0.8` 仍判错 | **6 条**（pW 0.82–0.93） | 同上 |
| F8 | 候选数敏感性（强制含正确候选；28→8→4 路） | workspace Top-1 **14.3% → 57.1% → 71.4%**（4 路仍差 13.6pp） | `diagnostics-v3.md` D1 |
| F9 | oracle 工作区隔离下的会话层 | 会话 Top-1 **11/18 = 61.1%**、模式 **15/18 = 83.3%**（同量级、略低于 70/85） | `diagnostics-v3.md` D3 |
| F10 | 逐候选打分排序 vs 同候选集单次 choice | **25.0% vs 37.5%（n=8）**，打分法不更优、分数间隔小（中位 ~0.185） | `diagnostics-v3.md` D2 |
| F11 | 置信度方向 | 错答 pMax 均值 **0.794 >** 正确样本 **0.590**；按 pMax 取 coverage 40% 时 precision **0%** | `diagnostics-v3.md` D4；`summary-v2-layered.json` 可离线复算 |

> 口径说明：F1–F7 与 v2 报告/tester 审计直接同源；F8–F11 为诊断实验（138 请求、只读冻结案例 v2，未改任何门禁产物）。诊断的 D2 为"noul 近似"（本机无原生 `jev.rank` 源码可复刻），结论按近似口径解读。

### 11.3 不可作为决策依据的部分（MEDIUM 降级披露）

- scout 的三条关键 Inference——**「≈50% 天花板（14/28）」「可救 12 条」「F 类 11 条」**——均依赖"人类可推断性"人工判定。
- tester 以 **input-only 盲评包**（仅给 Jev 同款输入，不含 expected/不含 scout 判定）由独立评审人重判 10 条：与 scout 判定**一致率 4/10 = 40%（<80% 阈值）**，分歧方向系统性（scout 偏保守、盲评偏乐观，无反向）。
- 因此三条 Inference 及由它们派生的"85% 数学上不可达"**整体降级为方向性输入**，**不得作为重开 V5 的定量承诺**（"存在不可推断/需澄清案例"的方向仍成立，但具体条数不可承诺）。
- 重开 V5 前必须：**预注册判定 rubric（看结果前冻结）+ ≥2 名独立标注人 + 分歧由 lead/architect 裁定**；一致率 <80% 的分类不得进入定量结论。

### 11.4 结论（诊断能支持什么、不能支持什么）

- **不能支持**："换个问法（如 noul 排序）/调 Jev 参数/调阈值就能过门槛"。F10 显示逐候选打分不优于 choice、F11 显示置信度反向、F8 显示仅缩候选（4 路）仍只有 71.4%——均指向"当前 Jev 用法 + 当前候选/输入信息"无法达到 85% 量级。
- **可以支持的方向**：① 当前失败的主放大器是**候选规模 + 候选信息稀疏**（F6–F8），元工作区磁吸（`.dsh` 16/26）属可清理的系统性偏置；② **会话层在 oracle 工作区下已到门禁同量级**（F9），工作区层是主因；③ **测度本身需要修**（不可判定/需澄清案例应转 `needs_confirmation`，F1–F2 的 26 条错案中含此成分，具体条数待预注册 rubric 核定，见 11.3）。
- 因此**若重开，必须同时修"测度"与"判定架构"**：测度=预注册 rubric + 不可判定案例转 needs_confirmation + 标签复核；架构=shortlist/确认交互（其中"主模型先选 / Top-K 预筛"触碰 `NEXT-PHASE §2-6`，属产品语义变更，**需用户批准**，见 `v5-reopen-plan.md` §4）。
- **默认路径不变**：仍按 `NEXT-PHASE §7.3` 全确认（`autoDispatch=false`）；本节不改变 §4 裁定。

### 11.5 待用户决定（O1–O4）

| # | 待决定 | 说明 |
|---|---|---|
| **O1** | A / B / C 路线 | A=降级全确认先推进 M0；B=先修测度+架构再重开 V5；C=并行（M0 确认式 + 后台诊断/重开） |
| **O2** | 是否允许 **P1（主模型先给 3–5 候选，Jev 候选内排序）** | 触碰 `NEXT-PHASE §2-6`（`Jev 只判工作区/会话`、不做 Top-K 预筛）→ 改产品语义需用户批准 |
| **O3** | 是否允许 **P3（模型按上下文写 brief/候选，Jev 只做置信与 tie-break）** | 触碰 `§2-6` + `PRODUCT-DESIGN D3`（Jev 独立判定）→ 需用户批准 |
| **O4** | 是否引入 **accept-set / `inferable` 子集** 作为评估口径 | 评估语义变更（需 lead 批准；**阈值 95%/40%/85%/70%/3s/24k 一律不变**） |

> 完整方案对比与 B 路线排期见 `docs/architecture/v5-reopen-plan.md` §2/§5；本节只做门禁记录挂载，不代表任何选项已被采纳。

---

## 12. 用户决策与收口（2026-11-17）

> 记录人：architect（task-27）；只追加，不改 §0–§11 既有裁定。决策时点：2026-11-17 18:36（Asia/Shanghai）。

### 12.1 决策原文

用户在四条路线中选择 **D**：

| 选项 | 内容 | 结果 |
|---|---|---|
| A | 按 `NEXT-PHASE §7.3` 降级（默认每次确认）进入 M0 → M1 | 未选 |
| B | 先重开 V5（修测度/判定架构）再决定是否进 M0 | 未选 |
| C | M0 与 V5 修订并行（M1 仍禁 auto） | 未选 |
| **D** | **停在验证阶段，不进入 M0/M1** | **✅ 用户选择** |

### 12.2 收口状态（以仓库现状为准）

| 项 | 状态 |
|---|---|
| **V0 门禁** | **FAIL（不变）**（见 §0/§2/§4；V5 v2 冻结案例不达门禁阈值） |
| **M0/M1** | **未启动**：无插件安装、无 `packages/dsh-commander`、无 Client/UI 代码、无生产实现 |
| **V1–V4** | PASS（带 V2 stub/注入 answerer、V3 cwd 分支 + workspaceId BLOCKED、V4 `board_edits` 两段式裁定等限制，见 §2/§5） |
| **V5** | FAIL（v2 冻结案例 `caseSha256=872cb12d…`；报告/审计/诊断产物全部保留，见 §1/§11） |
| **诊断产物** | 保留（§11 索引：diagnostics-v3 / v5-failure-analysis / v5-reopen-plan / audit-V5-rootcause） |
| **live Desktop** | 未改动：未重启/未安装/未改 `~/.dsh`、未读 `.env`；V1–V4 探针前后 live-state diff=0、V5 只读采样 |
| **本轮后续工作** | 停止；不再启动验证轮次、不再产出门禁/实现结论 |

### 12.3 恢复条件（若未来恢复，先决策再动手）

1. **先按 §11.5 逐项决策 O1–O4**：路线（A/B/C/D 重新选择）、是否允许 P1（主模型先给候选）、是否允许 P3（Jev 降 tie-break）、是否引入 accept-set/`inferable` 口径。
2. **重开 V5** 必须：预注册判定 rubric（看结果前冻结）+ ≥2 人独立标注 + 分歧裁定；本轮 scout 的定量结论（≈50% 天花板/可救 12 条/F 类 11 条）已按 §11.3 降级，**不得复用为承诺**。
3. **若选 A 或 C**：M1 默认 `autoDispatch=false`／每次确认；`threshold/confidenceFloor` 仅 UI 提示；默认模式 B（layered）——均见 §4/§6 与 `v5-reopen-plan.md` §6。
4. **P1/P3 需用户批准**：改判定架构触碰 `NEXT-PHASE §2-6`（Jev 只判工作区/会话、不做 Top-K 预筛），P3 另触碰 `PRODUCT-DESIGN D3`；未获批准不得写入实现蓝图。
5. **阈值永不通过"调参"放宽**：95%/40%/85%/70%/3s/24k 不变；重开须先修测度与架构并重新冻结数据。

### 12.4 交接提示

| 项 | 提示 |
|---|---|
| 工作树 | 当前为**未提交工作树**（以 `git status` 为准；最近提交 `d8d1543`）；本轮所有验证/诊断/架构产物在树内未提交，交接前需按团队规范提交或另行归档 |
| 复跑入口 | `node tests/validation/run-all.mjs`（V1–V4 证据断言 / `--run` 复跑）；`node tests/v5-audit/audit-v2.mjs`；`node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json`；live 复现命令见 §7（需 `/tmp/dsh-commander-probe/jev.env`，不得打印 key） |
| 冻结案例 | v2 副本 `872cb12d…` **只读、不得复用重开**（其 dispatchAt 有 12/50 已知偏差）；重开必须按被测消息时间重新生成并**重新冻结新 sha**（协议 §6.2A/§6.2B） |
| 只读纪律 | `docs/validation/**`、`docs/eval/frozen/**`、`docs/eval/report-v2*.md` 与各审计文档为证据，任何复跑/诊断不得就地覆盖 |
| 未闭合项 | devops task-17（验证脚本从零复跑性 MEDIUM）；V5 标签 38/50 人工复核未完成（L4）；V3 workspaceId/真实 provider、V2 真实浏览器 pendingInteraction 留恢复后处理 |

### 12.5 边界声明

本记录不构成 M0/M1 启动、不改变 V0 门禁 FAIL 结论、不改变任何判据或冻结决策；D 为本轮最终决策，后续恢复必须以新的用户指令 + 上述 §12.3 条件为前提。

