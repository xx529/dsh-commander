# V5（v1）案例标签独立审计

> 角色：**tester**（独立复核；不改实现、不改被审计文档）。
> 任务：`task-9`。审计对象：`docs/eval/cases.real.jsonl` **v1**（50 条 / 6 层）与其标签规则 `docs/eval/labels.md`、逐条清单 `docs/eval/labels.cases.md`。
> 本审计**不是**重跑 live 指标（无 key、也不需要），而是核对「标签是否可信、案例是否公平、证据是否可复查」，给 v2 与门禁裁定提供事实依据。
> 复跑命令：`node tests/v5-audit/audit.mjs`（结果 JSON：`tests/v5-audit/audit-result.json`）。

## 0. 二值裁定

**FAIL：v1 标签不可作为门禁依据。**

判据（分开看，避免把两类问题混为一谈）：

1. **标签事实层（A1–A4）噪声率 0/25 = 0%**：v1 的 expected 工作区（cwd 精确映射）、new/attach（消息序回放规则）、快照含 expected 在抽样 25 条上全部成立；全部 50 条对 v1 案例备份 + 原始日志复核也 **50/50 通过 A1/A2/A3/A4**。即 **v1 不是“随机错标”**，机械规则是自洽的。
2. **但案例集不可作门禁依据**：`明显工作区` 层 12/50（24%）是**自证题**（任务文本含期望工作区全名 4/12、含选样 token 8/12）；**18/25 抽样（50 条中 25 条）**案例的快照暴露被测文本派生标题（post-hoc 泄漏）；**15/50** 条 new 案例快照自相矛盾（源会话排除出 sessions 但标题仍在期望工作区 recentTasks）；`should-ask` 5/5 条 expected 仍带工作区+new/attach（与“期望 needs_confirmation”自相矛盾）；工作区 summary 全部为占位模板。→ live 指标**不可解释、不可外推**。
3. **证据链缺陷（独立于标签事实）**：v1 案例在审计进行中被 v2 **就地覆盖**（见 §1.3），本审计先用开工时冻结的标签表+前缀指纹完成裁定；随后 backend 补交 v1 备份（sha256 可核），本审计已**升级为逐字/快照实证**并复核一致。覆盖事故本身仍是证据链缺陷（冻结规则已落地）。

## 1. 方法与抽样

### 1.1 维度定义

| 维度 | 含义 | 判定方式 |
|---|---|---|
| A1 文本归属 | 案例任务文本 = 该源会话下第 `messageIndex` 条真实用户消息（`data.source.kind==='user'` 且文本非空） | 读原始多帧 zstd 会话日志（`tools/eval/lib/session-log.mjs`，与生成器同一实现），**逐字比对**（>4000 字截断按前缀） |
| A2 工作区归属 | `expected.workspaceId` = 消息发生时会话 `header.cwd` 与 `workspace.json` path **精确字符串相等**的工作区 | 用 `~/.dsh/storages/workspace.json`（28 个 allowed 工作区）反查 |
| A3 模式推导 | 首条真实用户消息 → `new`；非首条 → `attach` 到本会话（`expected.sessionId=源会话`） | 用 `messageIndex` 与日志消息序独立重推 |
| A4 快照含 expected | `workspaces[]` 含期望工作区；attach 的 `sessions[]` 含期望会话；new 的源会话被排除；sessions 工作区自洽 | 对 v1 案例备份**实证** |
| E1 强泄漏 | 任务文本含期望工作区**全名/标题**、`expected.sessionId`、工作区 summary | 全文查找（去重） |
| E1hint 弱提示 | 任务文本含 v1 选样 token（工作区 basename/title 分词，≥5 字符） | 复刻 `build-cases.mjs` 的 `wsKeys` 算法 |
| E2 post-hoc 标题泄漏 | v1 快照 `sessions[].title` / `workspaces[].recentTasks` 含被测文本派生标题（≥6 字子串关系） | 对 v1 案例备份实证；另读日志 `session/title` 复核机制 |
| S9 快照自相矛盾 | new 案例源会话已排除出 `sessions[]`，但其标题仍在期望工作区 `recentTasks` | 对 v1 案例备份实证 |

**标签噪声率** = 抽样中 A1–A4 至少一项不成立 / 抽样数（本审计 = **0/25**）。
**公平性缺陷** 单独计：E1 强泄漏、E1hint、E2、S9（见 §3/§4）。

### 1.2 抽样规则（task-9）

- 全部 `should-ask`（5）+ 全部 `obvious`（12）+ 其余 4 层各按 id 序前 2 条（old-session / new-session / capability / ambiguous）= **25 条**；
- 另外对**全部 50 条**做 A1/A2/A3/A4 与 S9 复核（不抽样），E1/E1hint/E2 也按全 50 条计算，报告里抽样口径为 25 条。

### 1.3 冻结输入与证据链事故（必读）

- **覆盖事故**：v1 产物在审计进行中被 v2 覆盖：`docs/eval/cases.real.jsonl` / `labels.cases.md` / `tools/eval/build-cases.mjs` mtime = 2026-11-17T16:52:00/16:52:28（v1 dispatchTime=`2026-11-17T08:46:50.014Z`；覆盖后 v2 dispatchTime 先后出现 `08:52`、`08:56`，仍在滚动）。
- **冻结输入（第一阶段）**：本审计先用 16:51:30 开工时冻结的 `tests/v5-audit/fixtures/v1-frozen.json`（v1 标签表全 50 行 + 任务文本前 90 字符指纹，sha256 `363152ed320f8e84bbb4778cfe0c51373bf3565de129579bd6d369011d35932f`）完成“A1 前 20 字符指纹 + A4 代码可证”版裁定。
- **v1 备份补交（第二阶段，已完成升级）**：backend 于 17:09 补交 v1 原样备份，本审计已改为**逐字/快照实证**并复核结果一致：
  - `docs/eval/frozen/cases.real.v1.jsonl`（sha256 `3c588014746775f4ee52f0b679947178673d7b0237ad72c047df0117830ee966`，3,129,467B，50 行）；
  - `docs/eval/frozen/labels.cases.v1.md`（sha256 `5f2d3158988d750614b23fe3b98aafdba1769f73a2037266c7d517b515180bbf`，dispatchTime=`2026-11-17T08:46:50.014Z`，与本审计冻结标签表**逐行一致，diff=0**）。
  - 注意：backend 消息中称“v1 dispatchTime=2026-11-17T08:43:23Z”与上述文件头部（`08:46:50.014Z`）不符；本审计以文件为准，并已在回执中指出（证据链元信息必须与实际字节一致）。
- **冻结规则（Lead 2026-11-17 决议，工具已交付）**：门禁产物必须 `freeze` → 只读副本 + sha256 + dispatchTime；审计/live 复跑只读冻结副本；新版本另存路径，禁止就地覆盖。`node tests/v5-audit/freeze.mjs --cases … --labels … --name v2`；`node tests/v5-audit/verify.mjs --name v2`（冒烟 PASS）。

## 2. 全部 50 条复核汇总（v1 备份实证）

| 维度 | 通过 | 说明 |
|---|---:|---|
| A1 文本归属 | **50/50** | 每条源会话日志中第 `messageIndex` 条用户消息与 v1 案例 `command.text` 逐字一致（截断案例按前缀） |
| A2 工作区=cwd 精确映射 | **50/50** | `header.cwd` 精确命中 workspace.path，工作区名与 v1 标签一致 |
| A3 new/attach 推导 | **50/50** | `messageIndex===0` ⇔ `new`；`messageIndex>0` ⇔ `attach` 且 `expected.sessionId=源会话` |
| A4 快照含 expected | **50/50** | workspaces 含期望工作区；attach 期望会话在 sessions；new 源会话被排除；sessions 工作区自洽 |
| gapDays 复算 | **50/50** | 以 v1 dispatchTime 复算“源会话最后活动距今”，与标签表“会话年龄(天)”偏差 ≤0.05 天 |
| C13 标签表↔案例备份一致 | **50/50** | 工作区名/mode/expectedSessionId 逐条一致 |
| C14 快照 summary 非占位 | **0/50（全部占位）** | 50/50 条案例的工作区 summary 仍是「路径…；此刻非归档历史会话 N 条；capabilityDigest 不可得」模板 |
| S9 快照自相矛盾 | **15/50** 命中 | new 案例源会话已排除出 sessions，但标题仍在期望工作区 recentTasks |

**标签硬噪声率 = 0/25 = 0.0%** → v1 的机械标签规则可信；问题在**公平性与表示**，不在“标错”。

## 3. 抽样逐条结果（25 条）

`A4=PASS` 为 v1 备份实证；`E2 WARN` = 快照暴露被测文本派生标题（post-hoc 泄漏）；`S9` 命中在 §4 单列。

| id | 层 | A1 | A2 | A3 | A4 | E1 | E2 | 公平性问题 |
|---|---|---|---|---|---|---|---|---|
| v5-01-should-ask | should-ask | PASS | PASS | PASS | PASS | PASS | WARN | E2 |
| v5-02-should-ask | should-ask | PASS | PASS | PASS | PASS | PASS | WARN | E2 |
| v5-03-should-ask | should-ask | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-04-should-ask | should-ask | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-05-should-ask | should-ask | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-06-old-session | old-session | PASS | PASS | PASS | PASS | PASS | WARN | E2（其他会话标题=被测文本） |
| v5-07-old-session | old-session | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-16-new-session | new-session | PASS | PASS | PASS | PASS | PASS | WARN | E2 + S9 |
| v5-17-new-session | new-session | PASS | PASS | PASS | PASS | PASS | WARN | E2 |
| v5-22-capability | capability | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-23-capability | capability | PASS | PASS | PASS | PASS | PASS | PASS | — |
| v5-27-ambiguous | ambiguous | PASS | PASS | PASS | PASS | PASS | WARN | E2 |
| v5-28-ambiguous | ambiguous | PASS | PASS | PASS | PASS | PASS | PASS | E1hint（terminal） |
| v5-39-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 |
| v5-40-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 + S9 |
| v5-41-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 + S9 |
| v5-42-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 + S9 |
| v5-43-obvious | obvious | PASS | PASS | PASS | PASS | **FAIL** | WARN | **E1 强泄漏（LiveShopping）** + E2 + S9 |
| v5-44-obvious | obvious | PASS | PASS | PASS | PASS | **FAIL** | WARN | **E1 强泄漏（LiveShopping）** + E2 + S9 |
| v5-45-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 + S9 |
| v5-46-obvious | obvious | PASS | PASS | PASS | PASS | **FAIL** | WARN | **E1 强泄漏（dsh-quick-action）** + E2 + S9 |
| v5-47-obvious | obvious | PASS | PASS | PASS | PASS | PASS | PASS | E1hint（capability） |
| v5-48-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E2 + S9 |
| v5-49-obvious | obvious | PASS | PASS | PASS | PASS | **FAIL** | WARN | **E1 强泄漏（dsh-shell-cmd）** + E2 + S9 |
| v5-50-obvious | obvious | PASS | PASS | PASS | PASS | PASS | WARN | E1hint + E2 + S9 |

## 4. 问题清单（id / 证据 / 严重级别）

### HIGH

**H1 明显工作区层自证：12/50 案例=24%，对“派发判别力”无效。**
- 选样规则就是“任务文本点名本工作区”，因此这 12 条**必然**含工作区相关信号，Top-1 高是构造使然。
- 强泄漏（全文含期望工作区**全名**）：`v5-43-obvious`、`v5-44-obvious`（文本含 `LiveShopping`）、`v5-46-obvious`（`dsh-quick-action 这个插件`）、`v5-49-obvious`（`在我的 github 中创建一个项目 dsh-shell-cmd`）→ **4/12**。
- 弱提示（含选样 token）：`v5-39/40/41/42/45/47/48/50` → **8/12**。
- 影响：该层 live 结果不能证明派发能力，只能证明“模型读得懂点名文本”；门禁指标不应把这 24% 与困难的 ambiguous/old-session 层等权混算。

**H2 post-hoc 标题泄漏：抽样 18/25，全部 50 条中 25 条被污染。**
- 机制（v1 代码+日志+快照实证）：DSH 会话 `session/title` 由用户消息截断生成；v1 `workspaceSnapshot().recentTasks` 与 `sessionSnapshot()[].title` 直接取这些终态标题。
- 实证：抽样 **18/25** 条案例的快照中含“被测文本派生标题”（`sessions[].title` 或 `recentTasks`）；例：v5-01 期望工作区 recentTasks 含「看一下现在电脑为什么 cpu 负…」；v5-39 含「# 项目需求 现在我想做一个 dsh…」；v5-46 含「根据当前目标推进未完成项，」；另有 `v5-06` 的快照里**其他会话**标题=「用浏览器打开 https://example.com」（与被测文本重复）。
- 影响：模型可从快照抄到任务/目标，或被诱导 attach 到错误会话；workspace/session 指标被污染。

**H3 new 案例快照自相矛盾（S9）：15/50。**
- v1 对 `mode===new` 的案例把源会话从 `sessions[]` 排除（`excludeSource`），但 `workspaces[].recentTasks` **不排除**该标题。快照一边说“没有可 attach 的会话”，一边在期望工作区 recentTasks 里暴露被测任务标题（v5-16/21/30/34/39/40/41/42/43/44/45/46/48/49/50 共 15 条）。
- 影响：与 expected=new 语义冲突；live 中 obvious 层多例被判 attach（v5-40/41/42/43/44/50），与此矛盾一致。

**H4 证据链：被审计产物在审计期间被就地覆盖。**
- 见 §1.3：v1 于 16:52 被覆盖，本审计先以冻结标签表完成裁定、后端补交备份后才升级为逐字实证；若没有这次补交，v1 裁定将永久不可复查。**冻结规则（只读副本+sha256+dispatchTime+新版本另存路径）必须作为门禁硬要求**。

### MEDIUM

**M1 `should-ask` 表示自相矛盾（5/5）**：规则文本要求“期望 needs_confirmation、不进 Top-1 分母”，但 `expected` 仍写 `workspaceId` + `mode: new|attach`（schema 无 needs_confirmation）；只有 `tags` 的 `should-ask` 能区分。任何按 `expected` 计分的消费者都会误判。
**M2 文档与实现措辞不一致**：`labels.md §3` 称明显工作区层“文本点名本工作区**名称**”，实现实际是“含 path basename/title 的**分词 token**”；`v5-40/41/42/50` 文本写 `order-center` 而期望 `htdot-order-demand-skill` 即例证。行为未偏离，但可复核性描述被夸大。
**M3 工作区输入信息量不足**：v1 快照 `summary` 全部为硬编码占位模板（C14 50/50），无职责/能力信息；真实 Commander 会维护 summary。→ live 指标不可外推（v2 已用 `docs/eval/workspace-summaries.json` 修正，需声明 summary 生成不含标签）。
**M4 attach 案例任务文本上下文依赖（构造效度）**：attach 层文本多为会话内续问/指代（「可以打 tag 和推送仓库」「将这个技术方案落盘到 markdown 中」「重新启动一下web 测试端」「你现在测试一下你写脚本是否可行」「现在你改的样式中…」），脱离对话历史不可派发；v1 只给标题快照、不给历史/上下文摘要 → “期望 attach 到该会话”无法从输入推断，属任务构造问题而非标签错。
**M5 38/50 needsReview 未完成人工复核**：old-session/new-session/capability/should-ask 共 38 条为 medium/low 置信（`labels.md §6` 自述“本轮未完成人工复核；这不是 PASS 证据”），本审计只验证机械规则一致性，不能替代人工真值。

### LOW

**L1 `gapDaysAtDispatch` 语义易混**：用“源会话最后活动时间”而非“消息时间”，标签表写作“会话年龄(天)”；复算一致（50/50），仅语义澄清。
**L2 单一 seed 的非随机抽样 + dispatchTime=生成时刻**：只对同 seed、同候选池确定；`Date.now()` 漂移会让重跑换案例（v2 已出现 08:52/08:56 两版）。案例集不能“凭 seed 复现”，必须冻结（已落地）。
**L3 归档会话不入快照**：243 条归档会话被排除（协议要求），历史任务若相关归档会话，标签可能偏 `new`（labels.md §5.6 已知）。

### 规则实现 vs 文档（v1 实现代码审查）

| 检查 | 结论 |
|---|---|
| 选样按 `sha1(seed+sessionId)` 排序（无 `Math.random`） | PASS（同 seed+同候选池确定） |
| 工作区标签来自 cwd 精确映射，不用词面匹配造标签 | PASS |
| 模式标签来自消息序（首条→new；非首条→attach） | PASS |
| 「最近会话」先验未进入 expected（`recencyTrap` 仅用于 old-session 选样条件） | PASS |
| `labels.md §3` 明显工作区“文本点名本工作区名称”与实现一致 | **DEFECT**（token 片段匹配，措辞夸大，M2） |
| 案例集可仅凭 seed 复现 | **DEFECT**（dispatchTime=now，必须冻结，L2） |
| `should-ask` 表示与规则一致 | **DEFECT**（expected 仍带工作区/mode，M1） |
| 工作区 summary 非占位 | **DEFECT**（v1 模板占位，M3；v2 已修） |
| new 案例快照不暴露源会话 | **DEFECT**（sessions 排除但 recentTasks 保留，H3/S9） |

## 5. 分层偏差

| 层 | 抽样 | 硬缺陷 | E1 强泄漏 | E1hint | E2 派生标题 | 主要偏差 |
|---|---:|---:|---:|---:|---:|---|
| should-ask | 5 | 0 | 0 | 0 | 2 | M1 表示矛盾；首条案例有 E2 |
| obvious | 12 | 0 | 4 | 8 | 12 | H1 自证；H2 泄漏；S9 |
| old-session | 2 | 0 | 0 | 0 | 1 | M4 上下文依赖、M5 人工未复核 |
| new-session | 2 | 0 | 0 | 0 | 2 | H2/S9 快照矛盾；启发式标签 |
| capability | 2 | 0 | 0 | 0 | 0 | M4、capabilityDigest 不可得（近似层） |
| ambiguous | 2 | 0 | 0 | 1 | 1 | 期望=cwd Fact 但文本跨工作区，靠 E1hint 可猜 |

**系统性偏弱**：`obvious`（自证 + 泄漏，几乎不可能失败）与所有“首条消息”案例（E2 泄漏 + S9）偏强/被污染；`old-session`/`new-session`/`should-ask` 偏弱（构造效度/人工未复核）。因此 v1 的**分层指标不可横向比较**，整体 40% Top-1 也不能解释为模型能力。

## 6. 对 v2 的最小要求（可验收；backend 已部分实现，待独立复核）

1. **冻结**：v2 产物必须 `cases.real.v2.jsonl` + 只读副本 + `sha256` + `dispatchTime`；审计/live 复跑只读冻结副本（工具：`tests/v5-audit/freeze.mjs`、`verify.mjs`）。禁止就地覆盖。
2. **禁止泄漏**：`task.text/goal` 不得含 expected 工作区全名/标题 token（尤其 obvious 层）；若保留 obvious 层，必须标注“易层/named-cue”、单独报告、不并入门禁判别分母。
3. **快照 as-of-dispatch**：`workspaces[].recentTasks` 与 `sessions[].title` 必须排除目标消息及其之后的标题；new 案例的源会话**不得以任何形式**（sessions/recentTasks）出现，消除 S9。
4. **should-ask 表示**：schema 增加 `needs_confirmation`（或从 cases 移除 should-ask 的 `expected.workspaceId/mode`），计分口径写死（不进 Top-1 分母、自动派发按 precision 惩罚）。
5. **任务文本重建**：attach/new 案例附会话上下文摘要（≤240 字），**不得含“应派给本工作区/本会话”提示**；保留原文可追溯。
6. **工作区 summary**：使用真实职责摘要，并在文档声明 summary 生成不读取 expected 标签。
7. **人工复核**：38 条 medium/low 完成人工抽检并留记录后，才可作为门禁依据；否则门禁只能使用 high 置信子集（v1 中即 obvious 12 条，但有 H1 自证问题）。

## 7. 限制（显式声明）

1. **v1 快照复核的时点限制**：v1 备份（sha256 `3c588014…`）的 `labels.cases.v1.md` 头部 dispatchTime=`2026-11-17T08:46:50.014Z` 与本审计冻结标签表逐行一致（diff=0）；`cases.real.v1.jsonl` 文件内**没有** `_meta` 行（backend 消息称“含 `_meta`”与实际字节不符，已在回执指出）。它是**生成后复制**的副本，不能独立证明“16:51 时磁盘上的 v1 与备份完全同字节”（无当时 sha 记录）。本审计以“标签表逐行一致 + 前缀指纹 50/50 + 逐字复核 50/50”作为交叉证据。
2. 未重跑 live（无 key、非本任务目标）；v1 live 指标（workspace Top-1 40%）引自 `docs/eval/report-layered.md`，本审计只给“指标不可解释/不可外推”的原因，不重算指标。
3. 未做 v2 独立复核（Lead 明确本任务不扩到 v2 re-run，另开任务）；本文件 §6 是对 v2 的要求清单，不是 v2 的 PASS 证据。
4. 未读取/打印 `~/.dsh/.env`；`~/.dsh` 全程只读；未改 `docs/eval/**`、未改 backend 文档。

## 8. 复跑

```bash
# v1 标签独立审计（读 v1 冻结备份 + 冻结标签表 + ~/.dsh 只读）
node tests/v5-audit/audit.mjs            # → 终端表格 + tests/v5-audit/audit-result.json

# 冻结 / 校验（门禁产物用）
node tests/v5-audit/freeze.mjs --cases docs/eval/frozen/cases.real.v2.jsonl \
  --labels docs/eval/labels.cases.v2.md --name v2
node tests/v5-audit/verify.mjs --name v2

# 兼容 backend manifest 的完整性校验（只校验冻结产物，不等于 v2 内容审计）
node tests/v5-audit/verify.mjs --manifest docs/eval/frozen/manifest.v2.json
# 实测：PASS（cases sha256 与 manifest 一致，leakViolations=0；generatorRev=0db97fbd8da1a3ca）
```

审计结果快照：`tests/v5-audit/audit-result.json`（sha256 `3196a511d7114fdec94650bb60a05c030cf362027b8da232082309239b584b8c`，实证版）。
冻结输入（第一阶段）：`tests/v5-audit/fixtures/v1-frozen.json`（sha256 `363152ed…`）。
v1 备份（第二阶段，实证源）：`docs/eval/frozen/cases.real.v1.jsonl`（sha256 `3c588014…`）、`docs/eval/frozen/labels.cases.v1.md`（sha256 `5f2d3158…`）。

### 版本记录

- 2026-11-17T17:0x 首版：冻结标签表+前缀指纹版（v1 快照覆盖不可得，A4 代码可证）。
- 2026-11-17T17:2x 修订：backend 补交 v1 备份后，升级为逐字/快照实证；E1 强泄漏由 2/50 修正为 **4/50**（新增 v5-43/44 的 `LiveShopping` 全名），E2 18/25，S9 15/50，A4 50/50 实证；结论（FAIL）不变。
