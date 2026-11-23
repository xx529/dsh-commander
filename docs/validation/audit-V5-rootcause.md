# V5 根因分析独立盲评（scout 逐案可推断性判定 + gate 数字复算）

> 角色：**tester**（独立复核；只写 `tests/**` 与 `docs/validation/audit-*.md`；未改 scout/backend 文档、未碰 live Desktop、未读 `.env`、未做实现）。
> 任务：`task-23`（非门禁；为「重开 V5 的测度修订」提供第二人证据）。时间盒 20 分钟。
> 输入（只读）：`docs/research/v5-failure-analysis.md`、`docs/research/probes/{extract-v5-gate-cases,analyze-v5-failures}.mjs`、`docs/eval/frozen/cases.real.v2.jsonl`、`docs/eval/summary-v2-layered.json`、`docs/eval/report-v2-layered.md`。
> 产出：本文件 + `tests/v5-audit/blind-review.mjs`（可复跑）+ `tests/v5-audit/blind-review.json`（盲评记录）+ `tests/v5-audit/blind-packet.json`（input-only 盲评包）+ `tests/v5-audit/blind-key.json`（sealed 对照，评审后启封）。

## 0. 二值裁定

**FAIL：scout 的 V5 根因分析不能直接作为「重开 V5（测度修订）」的定量决策依据；其 Fact 层可复算、方向性可用，但三条关键 Inference（F 类判定、≈50% 天花板、可救 12 条）在第二人盲评下一致率仅 40%（<80% 判据）→ 需整体降级。**

- **Fact 层 PASS**：gate 结构 7 个数字（gate=28、错 26/对 2、工作区 4=14.3%、模式 14=50.0%、attach 1/18、错案选中 `.dsh` 16、pW≥0.8 仍错 6）独立复算 **7/7 一致**。
- **判定层 FAIL（决定任务结论）**：从 scout 26 条逐案判定中固定 seed 分层抽 10 条，由**未看 scout 判定**的独立评审人用 input-only packet（仅 Jev 同款输入）重判：一致 **4/10 = 40%**（<80%）。分歧全部在「能 ↔ 需澄清 ↔ 不能」边界，且方向系统性（scout 偏保守/评审人偏乐观）。
- **直接后果**：`≈50% 天花板`、`可救 12 条`、`F 类 11 条` 都**依赖同一套人工判定**，不能作为重开 V5 的量化依据；`85% 数学上不可达` 这一最强论断**未获得第二人支持**（独立评审更倾向"可推断"，意味着在更好接地下上限可能明显高于 50%，85% 是否可达需重新测度）。重开前必须先做**预注册判定 rubric + 多人独立标注 + 分歧裁定**。

## 1. gate 结构数字复算（task-23 第 1 项）

独立脚本（`tests/v5-audit/blind-review.mjs`，只读 cases+summary；另跑 scout 两脚本交叉核对）：

| 指标 | scout 声明 | tester 独立复算 | 一致 |
|---|---:|---:|---|
| gate 条数 | 28 | 28 | ✅ |
| 目标全对 / 错案 | 2 / 26 | 2（v5-27、v5-44）/ 26 | ✅ |
| 工作区 Top-1 | 4（14.3%） | 4（14.3%） | ✅ |
| 模式准确率 | 14（50.0%） | 14（50.0%） | ✅ |
| attach 会话 Top-1 | 1/18（5.6%） | 1/18 | ✅ |
| 错案中选中 `.dsh` | 16/26（61.5%） | 16/26 | ✅ |
| pW≥0.8 仍错 | 6 | 6（pW 0.82–0.93） | ✅ |

复跑 scout 脚本（`extract-v5-gate-cases.mjs` → `/tmp/scout-v5/gate-cases.json`；`analyze-v5-failures.mjs` → `/tmp/scout-v5/metrics.json`）输出同值；`metrics.gate` = `{n:28,targetCorrect:2,workspaceCorrect:4,modeCorrect:14,sessionCorrect:7,workspaceWentToDotDsh:16,confidentButWrong:6}`。**结构统计层 scout 无夸大/错算。**

## 2. 派生数字核验（scout §2.4/§5/§9）

| 派生结论 | 独立核验 | 结果 |
|---|---|---|
| 17 条 attach 错案中 14 条「期望会话标题比选中项更贴近任务文本」 | `metrics.attachSignal={attachWrong:17,signalPresentInGoalText:14}`，逐行 bigram 可复算 | ✅ 数字一致 |
| 可推断子集 Jev Top-1 = 2/14 = 14.3% | 2 条全对（v5-27、v5-44）落在 scout 标"能"的 14 条内 → 数学一致 | ✅ 数字一致（但分母依赖 scout 判定 → 见 §3） |
| pMax 0.8–1.0 桶 15 案 0 正确 | `summary-v2-layered.json.calibration`：0.8–0.9=11/0、0.9–1.0=4/0 | ✅ |
| 白名单变体 gate 26 条 26.9% / 11.5% | `report-v2-whitelist-layered.md`；scout 引用与报告一致（7/26、3/26） | ✅（该变体有 5 条 derived-needs-confirm，分母 26 不与我本地 28 冲突） |

→ **Fact 与由 Fact 直接算术得到的数字可信**；涉及"人类可推断性"的判定类结论不可直接采信（§3）。

## 3. 盲评设计与结果（task-23 第 2 项，核心）

### 3.1 方法（可复跑）

- **抽样**：gate 26 条错案中，固定 `seed = 'tester-blind-2026-11-17'`，按 `sha1(seed:id)` 层内排序，按 scout 三档配额 **能 4 / 需澄清 3 / 不能 3** 抽 10 条：`v5-46, v5-39, v5-20, v5-21, v5-28, v5-40, v5-31, v5-49, v5-30, v5-19`。
- **盲评包**：`tests/v5-audit/blind-packet.json` 仅含 **Jev 同款输入**（task title/goal/command + workspaces name/path/summary/recentTasks + sessions 紧凑快照），**不含 expected、不含 scout 判定**；判定 rubric 仅给出"能/需澄清/不能"定义（同 scout §1.2 口径）。
- **评审人**：独立 subagent（`blind-rater`，独立上下文，明确禁止读 scout 文档/expected/`blind-key.json`），只读 packet 后落 `tests/v5-audit/blind-judgments.json`。
- **对照**：评审完成后启封 `blind-key.json`，`node tests/v5-audit/blind-review.mjs --compare` 计算一致率（task 规则：<80% 则降级）。

### 3.2 结果：一致率 4/10 = **40%**（< 80% 阈值）

| 指标 | 值 |
|---|---|
| 一致 | **4 / 10 = 40%** |
| 分歧 | **6 / 10** |
| scout 抽样档位分布 | 能 4 / 需澄清 3 / 不能 3 |
| 评审人判定分布 | 能 8 / 需澄清 2 / 不能 0 |

**分歧条目（scout → 评审人）**：

| id | scout | 盲评 | 盲评理由摘要 |
|---|---|---|---|
| v5-28-new-session | 需澄清 | 能 | 纯检索，Research 有同类检索历史；htdot 技能仓库是落地开发而非调研 → new+Research 可推定 |
| v5-31-new-session | 需澄清 | 能 | 明确"搜可行方案"，Research 有 MCP/浏览器自动化调研前例 → new+Research 最匹配 |
| v5-40-ambiguous | 需澄清 | 能 | 前置要求"引用功能临时修复、待升级替换"唯一对应既有 agent-workspace 会话 → attach 可推定 |
| v5-30-new-session | 不能 | 能 | "这个插件"的 skill/MCP 两页对应 dsh-capability-settings 历史任务 → new 可推定 |
| v5-49-ambiguous | 不能 | 需澄清 | 无历史、多工作区（Research/Evoke/LiveShopping/空白 agent-workspace）均可自圆其说 → 宜先问 |
| v5-19-old-session | 不能 | 需澄清 | 快照无 0.2.0→0.2.1 会话，但有多个适配/发布类会话 → 多候选需澄清 |

- **一致项**：v5-46、v5-39、v5-20、v5-21（scout 与盲评都判"能"）。
- **系统性方向**：分歧 6 条全部是 scout 更保守（scout 判"需澄清/不能"，盲评判"能/需澄清"）；**没有一条反向**（盲评判"不能"而 scout 判"能"）。说明判定边界对 reviewer/rubric 敏感，不是随机噪声。
- **对分母的直接影响**：若按盲评口径，样本中"能"从 4→8、"不能"从 3→0 → scout 的 14 条"能"、4 条"不能"、10 条"需澄清"分类不稳；由它算出的 `天花板 14/28=50%`、`可救 12 条`、`F 类 11 条` 均不可复现为稳定数字。

## 4. 对 scout 三条核心 Inference 的裁决

| scout Inference | 盲评证据 | 裁决 |
|---|---|---|
| 当前标签下理想天花板 ≈50%（14/28），85% 数学上不可达 | 一致率 40%；独立评审认为更多案例可推断（样本内"能"翻倍），因此上限**可能显著高于 50%**；"85% 不可达"未被第二人支持 | **降级**：不能作为定量依据；"85% 不可达"需以预注册 rubric 重新测度验证 |
| 可救的是 12 条"能"错案（接地可修复） | "能"的边界不稳定（样本 4 条被盲评判为"能"的，scout 记为需澄清/不能；反向一致为 0） | **降级**：方向（存在可推断但判错的案例）有支持，但"12 条"数量不可承诺 |
| F 类 11 条（标签存疑/用户习惯）应剔除或改 should-ask | 依赖同一套人工判定；盲评显示边界敏感（v5-30/49 等），未达一致 | **降级**：须先出预注册 rubric（≥2 reviewer 独立标注 + 分歧裁定）再定量 |

**仍可采信/可用的部分**：
1. **Fact 层结构数字**（§1、§2 表格）——可直接引用；
2. **方向性结论**：输入里确实存在不可推断/需澄清案例（盲评也判 2/10 需澄清），"先改测度再重跑"的 P0 方向仍有支持；`pW 0.8–1.0 桶 0 正确`、`16/26 落 .dsh` 等系统性偏置证据坚实；
3. **不能采信**：`≈50% 天花板`、`可救 12 条`、`F 类 11 条` 的具体数字，以及"85% 数学上不可达"的断言。

## 5. 对「重开 V5」的建议（修订 scout §6 的 P0）

1. **先预注册判定 rubric**：给出"能/需澄清/不能"的可操作判据（例：任务文本是否含期望会话标题 ≥N 字片段/工作区职责声明是否唯一/是否存在 ≥2 个同分候选），**在看新结果前冻结**。
2. **多人独立标注 + 分歧裁定**：至少 2 名评审独立标 26 条（本次盲评即示范：单评审一致率 40% 说明必须多评审），分歧由 Lead/architect 裁定；一致率 <80% 的分类不进定量结论。
3. **测度修订后再算天花板**：先按裁定后的 rubric 重算"不可判定集合"，再决定剔除/转 should-ask 的条数；**不要用本轮的 14/28、12 条作为承诺**。
4. 候选域/元工作区清理、职责摘要、会话标题接地等 P0/P1 建议方向可保留（它们由 Fact 层支持，不依赖判定层）。

## 6. 严重级别计数

| 级别 | 数量 | 条目 |
|---|---:|---|
| HIGH | **1** | H1：三条决定重开结论的 Inference（天花板/可救/F 类）在第二人盲评下一致率 40%（<80% 判据）→ 需整体降级，不可作定量决策依据 |
| MEDIUM | **2** | M1：判定边界系统性偏移（scout 偏保守、盲评偏乐观，6 条分歧方向单一）且无预注册 rubric，导致"能力/不能"分类不可比较；M2：`85% 不可达` 断言被独立证据削弱（上限可能高于 50%，是否可达需重测） |
| LOW | **1** | L1：scout 已在 §9 Unverified 自述"26 条人工标签未做第二人复核（建议 tester 抽 10 条）"——该风险已披露，本次即执行该抽检并确认风险实质化 |

## 7. 限制

1. 盲评为**单一独立评审人**（LLM，非人类调度者；与 scout 不同上下文但同模型族）；严格意义需 ≥2 独立评审 + 人工仲裁。本次结论只证明"分类对评审口径敏感、<80% 一致"，不证明某一边绝对正确。
2. 样本 10/26（时间盒限制），一致率 40% 的 95% 置信区间宽（约 12–74%）；但即便取上界也 <80% 阈值附近，且分歧方向单一，足以触发降级。
3. 分层抽样用 scout 的档位标签（仅用于抽样的分层，不进入盲评包）；若 scout 档位本身错，抽样覆盖率会偏——这属于待降级的问题本身。
4. 未重跑 live；未改动 `docs/eval/**`、`docs/research/**`；未读 `.env`。

## 8. 复跑与证据

```bash
node tests/v5-audit/blind-review.mjs            # 生成盲评包 + 复算 gate 7 数字 + sealed key
# （独立评审人只读 blind-packet.json 产出 blind-judgments.json）
node tests/v5-audit/blind-review.mjs --compare  # 启封对照 → 一致率/降级结论 → blind-review.json
```

| 证据 | 路径 | sha256 |
|---|---|---|
| 盲评记录 | `tests/v5-audit/blind-review.json` | 生成时见文件（含 metrics/agreement/disagreements/conclusion） |
| 盲评包（input-only） | `tests/v5-audit/blind-packet.json` | 279KB；含用户正文，**勿入库/外发** |
| sealed key | `tests/v5-audit/blind-key.json` | 评审后启封 |
| 盲评脚本 | `tests/v5-audit/blind-review.mjs` | 可复跑 |

**最终回答（task-23）：scout 根因分析的 Fact/结构数字可复算（7/7）；但关键判定类 Inference（≈50% 天花板、可救 12 条、F 类 11 条）在第二人盲评下一致率仅 40% → scout 根因分析不可作为重开 V5 的定量决策依据（FAIL），仅可作为方向性输入；重开前须先预注册 rubric + 多人独立标注。**
