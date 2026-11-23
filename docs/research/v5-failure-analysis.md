# V5 FAIL 逐案根因分析（gate 26 条错案 · 可推断性 / 错误分类 / 天花板）

> 角色：scout（只读分析，只写 `docs/research/**`）。时间：2026-11-17 18:18–18:50。
> 输入（只读）：`docs/eval/frozen/cases.real.v2.jsonl`（caseSha256 `872cb12d…f7aad6`）、`docs/eval/summary-v2-layered.json`、`report-v2-layered.md`、`labels.v2.md`、`labels.cases.v2.md`、`frozen/manifest.v2.json`、`docs/validation/audit-V5-v2.md`、`docs/architecture/v5-review.md`。
> **数据边界**：案例文件含用户真实正文且已 gitignore；本文件**不复述用户原文、不复述个人主题会话标题**，只给结构化字段（工作区名、会话 id 尾号、bigram 覆盖率）与我自己的判定依据。
> 标注：**【Fact】**= 数据/脚本直接可证；**【Inference】**= 由证据推断；**【Unverified】**= 未做。
> 复跑：`docs/research/probes/extract-v5-gate-cases.mjs` + `docs/research/probes/analyze-v5-failures.mjs`（命令见 §8）。

---

## 0. 结论摘要（先给裁定用数字）

1. **gate 层是 28 条，Jev 错 26 条、对 2 条（7.1%）**。28 = ambiguous 12 + old-session 10 + new-session 6（剔除 obvious/named-cue 12、capability 观测 5、should-ask 5）。**【Fact】**
2. **主错因不是"数据领域太像"，而是三重叠加**：
   - **系统性候选偏置**：26 条错案里 **16 条（61.5%）落到 `.dsh`**（元/运维工作区），其中「期望 Research → 选中 `.dsh`」11 条（42%）——`.dsh` 是"dsh 本体/desktop profile"的引力井，凡是任务文本出现 "dsh" 就被吸走。**【Fact】**
   - **检索信号其实在输入里，但 Jev 没用**：17 条"期望 attach"错案中，**14 条**的期望会话标题与任务文本（含"此前用户要求"上下文摘要）的字符 bigram 覆盖率 **≥** 选中项（最高 1.00：期望会话标题几乎逐字出现在任务文本里），Jev 却选了 `.dsh` 的「dsh 插件安装」或直接 new。**【Fact】**
   - **少数案例标签本身不可推断/不该算错**：26 条中我判 **4 条"不能"**（输入缺会话外上下文）、**10 条"需要澄清"**（≥2 个同样合理的候选，理想行为是 should-ask）。**【Inference】**（人工判定，依据见 §4 逐案表）
3. **可推断子集 Jev Top-1 = 2/14 = 14.3%**（14 条"一个合理人类调度者能推断"的 gate 案例里，Jev 只对 2 条，且这 2 条恰是仅有的 2 条判对案例）。**【Fact】**（2/14 由数据+判定合成）
4. **当前标签口径下，理想判定器的天花板 ≈ 50%（14/28）**，**85% 数学上不可达**。只有把"不能"4 条剔除、把"需要澄清"10 条改为 `needs_confirmation`（不计入 Top-1 分母）之后，分母变 14，85% 才回到"理论上可达、实际需 13/14≈93%"的区间。**【Inference】**
5. **继续调 Jev 阈值/参数不会救回 V5**：校准表里 pMax 0.8–0.9 桶 11 案 0 正确、0.9–1.0 桶 4 案 0 正确，26 条错案中 6 条 pW≥0.8（0.82–0.93）——这是**系统性偏置**，不是概率没校准。**【Inference】**

---

## 1. 方法

### 1.1 gate 口径与分母

- `summary-v2-layered.json.caseResults[].layer` 分 6 层；门禁口径 = **排除 obvious（named-cue easy）、capability（观测）、should-ask** 三层 → n=28。**【Fact】**（与 `report-v2-layered.md:20` 的 n=28 一致）
- 判对 = `targetCorrect`（workspace + mode + session 全对）。gate 内正确 2 条：`v5-27-old-session`、`v5-44-ambiguous`。**【Fact】**

### 1.2 逐案"人类可推断性"判定规则（人工，26 条逐条）

只使用 **Jev 同样看得到的输入**：任务 title/goal（goal 含"此前用户要求…"上下文摘要 + 本次指令）、工作区 `{name,path,summary,recentTasks}`、sessions `{title,lastActiveAt,workspaceId}`。判定三档：

| 档 | 定义 |
|---|---|
| **能** | 一个合理的人类调度者，仅凭上述输入能高置信推出期望（ws+mode+session 全对） |
| **需澄清** | 存在 ≥2 个同样合理的候选（含"元工作区 vs 业务工作区"、`new` vs `attach` 都能自圆其说），理想行为是 `needs_confirmation` 而非单点判定 |
| **不能** | 输入缺少会话外/会话内上下文（无指代、无历史、依赖图片内容、期望工作区 as-of 时无任何历史），任何判定器都无法定位 |

### 1.3 错误原因标签（多标签，A–F 按任务书）

A 依赖会话外上下文不可推断；B 工作区职责重叠/命名相似；C 摘要/会话描述信息不足；D Jev 忽略/误解摘要与标题（期望项内容明显更贴近输入）；E 多候选干扰（尤其单一"磁吸"会话）；F 标签本身存疑（期望=用户习惯/回放结构，而非任务归属）。

---

## 2. 结构统计（可复跑，脚本输出）

### 2.1 gate 指标分解（n=28）**【Fact】**

| 维度 | 正确 | 备注 |
|---|---:|---|
| 工作区 Top-1 | **4 (14.3%)** | 与报告 14.3% 一致 |
| 会话 Top-1（attach 口径） | **1/18 (5.6%)** | 与 `report-v2-layered.md:22` 一致；28 条里 `sessionCorrect=7` 是因为 new 案例的 session 判空也算对 |
| 模式（new/attach） | **14 (50.0%)** | |
| 目标全对 | **2 (7.1%)** | |
| 工作区对但模式错 | 2 | `v5-32`、`v5-41`（都是"该 new 却 attach 到主题完全相同的会话"） |
| 工作区错但模式对 | 12 | 12 条里 10 条是"该 attach 却 new" |
| 选中 `.dsh` | **16** | 占错案 61.5% |
| pW≥0.8 仍错 | **6** | pW 0.82–0.93，均为 Research/agent-workspace → `.dsh` 或 → Research |

### 2.2 工作区混淆矩阵（仅错案 26 条）**【Fact】**

```
Research              -> .dsh                      11
agent-workspace       -> .dsh                       3
Research              -> agent-workspace            2
Research              -> Research  （同 ws，mode 错）2
dsh-task-gantt        -> .dsh                       1
dsh-capability-settings-> .dsh                      1
Research              -> dsh-capability-settings    1
dsh-capability-settings-> dsh-task-gantt            1
agent-workspace       -> Evoke                      1
Research              -> Evoke                      1
htdot-project         -> Research                   1
agent-workspace       -> Research                   1
```
- 只会错到 5 个工作区（`.dsh`、agent-workspace、Research、Evoke、dsh-capability-settings、dsh-task-gantt），**`.dsh` 独占 16**。**【Fact】**
- 期望工作区的分布极不均衡：26 条错案里期望 = Research **17** 条、agent-workspace 5 条、dsh-capability-settings 2 条、dsh-task-gantt 1 条、htdot-project 1 条。**Research 是用户的"调研/搜索"桶**（其摘要由历史任务标题归纳，见 §2.4 引用的 `labels.v2.md:19` 语义摘要口径），与业务工作区（dsh-* 插件仓库）在语义上高度可混。**【Inference】**

### 2.3 模式混淆矩阵（gate 28）**【Fact】**

| 期望 \ 选中 | attach | new |
|---|---:|---:|
| attach (18) | 8 | **10** |
| new (10) | **4** | 6 |

→ Jev **系统性欠 attach**（17 条 attach 错案里 10 条选了 new）；同时又有 4 条"该 new 却 attach"。**模式标签本身是回放语义**（`labels.v2.md:26`：首条消息→new，非首条→attach 到该会话），不是"最优调度"标签：4 条 new→attach 里 `v5-32`/`v5-41` 的选中会话与任务主题几乎同名，attach 未必错。**【Fact + Inference】**

### 2.4 "检索信号已在输入里"的量化证据（D 类核心）**【Fact】**

对 17 条"期望 attach"错案，计算「期望会话标题」与「选中会话标题」在任务文本里的 bigram 覆盖率（见脚本 `attachSignal`）：

| id | 期望标题↔任务文本 | 选中标题↔任务文本 | 读法 |
|---|---:|---:|---|
| v5-39 | **1.000** | 0.333 | 期望标题几乎逐字出现在"此前用户要求"里，Jev 仍选了 `.dsh`/「dsh 插件安装」 |
| v5-45 | **0.824** | —（选 new） | |
| v5-23 | 0.714 | 0.500 | |
| v5-43 | 0.700 | —（选 new） | 任务里点名的工具名 = 期望会话标题关键词 |
| v5-24 | 0.700 | —（选 new） | |
| v5-18 | 0.667 | 0.400 | |
| v5-21 | 0.611 | 0.500 | |
| v5-20 | 0.600 | —（选 new） | |
| …其余见 `/tmp/scout-v5/metrics.json` | | | |
| v5-26 | 0.267 | 0.667 | **唯一**选中项更贴近的案例（OpenUI vs intelligent-ui 指同一类） |

**14/17** 条满足"期望项比选中项更贴近任务文本"，其中 11 条期望项覆盖率 ≥0.6。**【Fact】**
→ 这不是"输入不可推断"，而是**工作区选择没有 grounded 到「该工作区会话标题/摘要」**：一旦工作区选错（多为 `.dsh`），期望会话根本不在分层模式的第二阶段候选集里（`report-v2-layered.md:11` layered=先工作区再会话）。**【Inference】**

### 2.5 与白名单变体的对照（候选集效应）**【Fact】**

`summary-v2-whitelist-layered.json`（前 8 活跃工作区；该变体 gate n=26，另有 5 条 derived-needs-confirm）：gate 工作区 Top-1 **7/26=26.9%**、目标全对 **3/26=11.5%**（`report-v2-whitelist-layered.md:18-24`）。相对全量 14.3%/7.1% 有提升，但仍远离 85%/95%。→ 缩候选集有帮助但不是解。**【Fact】**

---

## 3. 逐案表（26 条错案 · 人工判定）

> 字段：期望→选中工作区；模式 exp→cho；pW/pS 为期望项概率（Jev 的置信度）；判定 = 人类可推断性；标签 = A–F（多标签）；依据不复述用户原文。

| # | id | 层 | 期望→选中 WS | 模式 | pW/pS | 判定 | 标签 | 依据（一句） |
|---:|---|---|---|---|---|---|---|---|
| 1 | v5-18 | old | Research → `.dsh` | attach→attach | .79/.40 | **能** | D,E,B | 上下文摘要点名"防危险操作的 dcg 检索"，期望会话正是该检索会话；`.dsh`「电脑操作插件推荐」也含同类词，被吸走 |
| 2 | v5-19 | old | dsh-task-gantt → `.dsh` | attach→attach | .58/.84 | **不能** | A,C,E | 指令只说"更新推送并安装"，未点名哪个插件；期望是"某插件开发"会话，需会话外知识才知道"这个插件"=gantt |
| 3 | v5-20 | old | Research → `.dsh` | attach→new | .88/.39 | **能** | D,B | 上下文"搜 dsh 网络代理插件"与期望会话标题几乎同义，Jev 却新建并选 `.dsh` |
| 4 | v5-21 | old | Research → `.dsh` | attach→attach | .88/.91 | **能** | D,E | 上下文"markdown 美化插件选择"↔期望会话；选中 `.dsh`「插件安装」是同域干扰 |
| 5 | v5-22 | old | dsh-capability-settings → `.dsh` | attach→new | .60/.37 | **需澄清** | A,C,E | "推送到远程并用 github 重装"未点名仓库；worktree/合并 main 暗示某仓库开发，但无法唯一确定 |
| 6 | v5-23 | old | agent-workspace → `.dsh` | attach→attach | .72/.61 | **能** | D,E | 上下文"两个插件点击更新失败" ↔ 期望会话「插件点击更新失败」（复现），Jev 选 `.dsh` 插件安装 |
| 7 | v5-24 | old | Research → `.dsh` | attach→new | .61/.66 | **能** | D,E | 上下文"jev-desktop skill 与测试脚本" ↔ 期望会话「创建 jev-desktop 使用 skill 并测试」 |
| 8 | v5-25 | old | Research → `.dsh` | attach→new | .67/.73 | **能** | D | 上下文"session-query/session_search 机制" ↔ 期望会话「dsh 内部 session 之间…」 |
| 9 | v5-26 | old | Research → `.dsh` | attach→attach | .93/.96 | **能** | D,E | 上下文"intelligent-ui 安装/重启验证" ↔ 期望会话「OpenUI 的 DSH 插件整合」（同一插件族）；选中项与文本更贴近是唯一例外（见 §2.4） |
| 10 | v5-28 | new | Research → dsh-capability-settings | new→new | .71/.61 | **需澄清** | F,B,E | "去搜一下如何写高质量 skill"：Research（调研桶）与 dsh-capability-settings（SKILL 管理插件）都合理；expected=用户习惯 |
| 11 | v5-29 | new | Research → `.dsh` | new→new | .63/.47 | **需澄清** | F,B,C | "搜 genui/OpenUI 协议插件"：调研 vs dsh 本体都合理；工作区摘要全为历史任务标题，无法区分职责 |
| 12 | v5-30 | new | dsh-capability-settings → dsh-task-gantt | new→attach | .40/.77 | **不能** | A,C,E | 首条消息只有"这个插件"，无任何指代；选中项是含 Figma 原型的会话（同有 figma 关键词） |
| 13 | v5-31 | new | Research → agent-workspace | new→new | .35/.82 | **需澄清** | B,E,F | "浏览器登录 SaaS 不把密码给 LLM"：调研 vs 浏览器自动化工作区都合理 |
| 14 | v5-32 | new | Research → Research | new→attach | .60/.36 | **需澄清** | F,D | **工作区已对**，仅模式错：attach 到"调研 dsh 插件"旧会话其实更自然；new 只是用户当时的行为 |
| 15 | v5-33 | new | Research → `.dsh` | new→attach | .49/.66 | **需澄清** | B,F,E | "搜 CPU 监控插件"：dsh 插件话题→`.dsh` vs 搜索→Research，两者都讲得通 |
| 16 | v5-39 | amb | agent-workspace → `.dsh` | attach→attach | .82/.74 | **能** | E,D | 上下文"排查右侧工具栏【文件】报错"与期望会话标题**逐字重合（1.00）**；仍被 `.dsh` 插件安装吸走 |
| 17 | v5-40 | amb | agent-workspace → `.dsh` | attach→new | .53/.83 | **需澄清** | A,E,F | 任务说 smooth-stream 丢引用功能，上下文提 mermaid 临时修复；期望会话是另一插件问题（同域不同插件） |
| 18 | v5-41 | amb | Research → Research | new→attach | .46/.83 | **需澄清** | F,D | 工作区已对；"实测 dsh-markdown-input 兼容性" attach 到「dsh markdown 插件安装与样式定制」合理，new 仅因用户当时新建 |
| 19 | v5-42 | amb | agent-workspace → Evoke | attach→new | .35/.85 | **不能** | A,F,E | 首条可见文本是"请分析这张图片"，判定依赖图片内容；上下文指向的 MCP 服务在另一个候选会话（Evoke）里也出现 |
| 20 | v5-43 | amb | Research → `.dsh` | attach→new | .42/.85 | **能** | D,E,B | 任务点名 `dsh-diff-approval-comment`，期望会话就是「dsh-diff-approval 工具使用方法」；"dsh" 词面把 Jev 拉去 `.dsh` |
| 21 | v5-45 | amb | Research → Evoke | attach→new | .31/.82 | **能** | D,E | 上下文"用 agent-desktop 打开百度" ↔ 期望会话「使用 agent-desktop 打开百度」（0.824）；选中 Evoke 含同类 MCP/桌面词 |
| 22 | v5-46 | amb | Research → `.dsh` | attach→attach | .91/.78 | **能** | D,E,B | 上下文"budget 插件检索" ↔ 期望会话「查找 dsh 预算管理插件」；pW 0.91 仍错 |
| 23 | v5-47 | amb | Research → agent-workspace | new→new | .78/.46 | **能** | D,E | 上下文点名 writing-for-agents 安装到 `~/.agents/skills` ↔ 期望会话「安装 Agent 提示词技能」；选中 agent-workspace 被 `~/.agents` 路径词吸引 |
| 24 | v5-48 | amb | htdot-project → Research | attach→new | .84/.69 | **需澄清** | B,E,F | 钉钉数字员工调研：htdot-project（钉钉业务仓库）与 Research（调研桶）都合理 |
| 25 | v5-49 | amb | agent-workspace → Research | new→new | .54/1.0 | **不能** | F,C,B | 期望工作区在 as-of 时**没有任何历史**（摘要="dispatch 前无历史会话"），没有任何信号可选它；纯调研问题→Research 反而更合理 |
| 26 | v5-50 | amb | Research → `.dsh` | new→new | .53/.84 | **需澄清** | B,F,E | "dsh 内置 subagent 委派机制"：dsh 本体问题→`.dsh` vs 机制调研→Research，两者都合理 |

**判定汇总**：能 **14**（错 12 + 对 2：`v5-27`、`v5-44`）/ 需澄清 **10** / 不能 **4**。**【Inference】**（人工判定，可复核）

---

## 4. 错误分类统计（26 条错案，多标签）

| 类 | 含义 | 计数 | 典型 id |
|---|---|---:|---|
| **A** | 依赖会话外/会话内上下文，不可推断 | **6** | v5-19, v5-22, v5-30, v5-40, v5-42, v5-49 |
| **B** | 工作区职责重叠/命名相似（`.dsh` 元工作区 + Research 调研桶 + dsh-* 同质仓库） | **11** | v5-18,20,28,29,31,33,43,46,48,49,50 |
| **C** | 摘要/会话描述信息不足（工作区摘要=历史任务标题流水；空摘要） | **5** | v5-19,22,29,30,49 |
| **D** | Jev 忽略/误解摘要与标题（期望项内容明显更贴近输入） | **14** | v5-18,20,21,23,24,25,26,32,39,41,43,45,46,47 |
| **E** | 多候选干扰（`.dsh`「dsh 插件安装」等单一磁吸会话/工作区） | **20** | v5-18,19,21,22,23,24,26,28,30,31,33,39,40,42,43,45,46,47,48,50 |
| **F** | 标签本身存疑（期望=用户习惯/回放结构，非任务归属） | **11** | v5-28,29,31,32,33,40,41,42,48,49,50 |

**要点**：
- **D∩能 = 12/12**：所有"人类能推断"的错案，期望信号都能在输入里找到（§2.4），Jev 仍然错过 → **检索/接地问题，不是数据不可推断问题**。**【Fact】**
- **E 类 20 条里 16 条与 `.dsh` 相关（选中或干扰项）**：一个元工作区 + 一个高频"插件安装"会话构成强干扰。**【Fact】**
- **F 类 11 条**全部集中在 `new`/`attach` 模式或"用户习惯桶"：这类案例即使判定器完全正确也会被记错。**【Inference】**

---

## 5. 可推断子集性能与天花板

### 5.1 可推断子集（能=14 条）上的 Jev

| 指标 | 值 |
|---|---|
| 可推断案例数 | **14** |
| 其中 Jev 目标全对 | **2**（v5-27、v5-44） |
| **可推断子集 Top-1** | **14.3%（2/14）** |
| 其中工作区对 | **2**（另 2 条工作区对的是"需澄清"类 v5-32/v5-41） |
| 其中 attach 期望且会话对 | 1 |

→ **输入足够时 Jev 也只对 14%**：说明主要损失在 Jev 的候选接地/工作区判定，而不是语料构念。**【Fact】**

### 5.2 天花板估计（Evidence-based Inference）

| 口径 | 理想判定器可达 | 说明 |
|---|---:|---|
| **当前 gate 标签（n=28）** | **≈50%（14/28）** | 14 条"能"全对；10 条"需澄清"按当前 targetCorrect 定义仍记错（理想行为 needs_confirmation 不被计为 correct）；4 条"不能"无解 |
| 若把"需澄清"改为 `needs_confirmation`（不进 Top-1 分母）且剔除"不能" 4 条 | 分母 14，**理论上 100%**；保守 **13/14≈93%**（v5-22 类"弱能"仍可能错） | 这才是 85% 门槛有意义的口径 |
| 若只做候选集清理（剔除 `.dsh` 等元工作区，白名单变体实测） | **≈27% ws / 11.5% target**（仍 FAIL） | 需要同时修"接地"和"标签" |

**结论（Inference）**：
1. **在现有 50 案例/28 gate 标签上，85% 工作区 Top-1 不可达**；不是"再调 Jev 参数"能解决——标签里有 14/28 条（50%）靠输入不可推断或不该单点判定。
2. 一个**理想判定器**（人类水平、只看 Jev 同款输入）在这套语料上的上限约 **50%（14/28，当前口径）**；与 Jev 7.1% 的 **42.9pp 差距**全部落在 12 条"可推断但判错"的案例上（D/E 类），即**接地可修复**；剩下 14 条（需澄清 10 + 不能 4 = 50%）不是判定器能修的，属测度问题（分母含不可判定案例）。
3. 最高性价比的路线：**先修测度（重标/剔除/转 should-ask），再修接地（工作区职责摘要 + 会话标题检索），最后才是阈值**；V5 若要重开，必须在**看结果之前**冻结新口径与新案例集（沿用 `manifest.v2` 的冻结纪律）。**【Inference】**

### 5.3 85% 门槛现实性

- 在"用户真实习惯"数据上，**85% 工作区 Top-1 本身偏乐观**：用户自己把"搜 dsh 插件"这类任务放在 Research 桶、把"装/更新到当前 profile"放在 `.dsh`，二者在语义上不可分；这是 **F 类 11 条**的来源。若要 85%，产品侧需要一个**可解释的候选域**（用户在派发时可选的 ≤20 个工作区 + 工作区职责声明），否则标签只反映历史 cwd 习惯。**【Inference】**（与 `docs/architecture/v5-review.md:98-103,192-199` 的元工作区/候选集结论一致）

---

## 6. 对"重开 V5"的建议（按优先级，均基于证据）

| 优先级 | 建议 | 证据 |
|---|---|---|
| **P0** | **先改测度再重跑**：26 条错案中 4 条剔除（v5-19/30/42/49）、10 条转 `needs_confirmation`；否则 85% 不可达，重跑注定 FAIL | §3 判定、§5.2 |
| **P0** | **候选域剔除元/运维工作区**（`.dsh`、`test`、远程机工作区），或把它们排除在 Top-1 分母外；并给出 ≤20 的派发候选集 | 16/26 错案落 `.dsh`；白名单变体 26.9%/11.5% |
| **P1** | **工作区必须有"职责声明"摘要**（当前 `summary` 是历史任务标题流水，几乎不含领域职责；`labels.v2.md:19` 已承认是启发式） | C 类 5 条；D/E 类 14/20 条 |
| **P1** | **让判定器显式使用会话标题**（当前 layered=先工作区后会话，工作区一错全错；14/17 attach 错案期望标题可复现） | §2.4 |
| **P1** | **mode 标签降级**：把 new/attach 从"正确性"改为诊断项，或允许 attach 到主题相同的会话；否则 4 条 new→attach 属于"更好却被判错" | §2.3；v5-32/41 |
| **P2** | **不要继续调 Jev 参数/阈值**：pMax 0.8–1.0 桶 15 案 0 正确 = 系统性偏置；需要换接地方式（候选标题/摘要进入请求、或两阶段候选-确认） | `report-v2-layered.md:34-43`；6 条 pW≥0.8 错案 |
| **P2** | 若产品接受"派发前确认"，**把 precision 保证金从单次 rank 转到确认卡**：auto 只在"候选唯一且检索分差大"时触发 | C5 precision≥95% 无组合达标；`report-v2-layered.md:28-32` |

---

## 7. 与既有审计的关系（不重复造轮子）

- `docs/architecture/v5-review.md` 已从**方法学**指出：候选 28 个超出设计包线（§2.2）、工作区摘要占位/启发式（§2.1）、任务文本上下文依赖（§2.3）、元工作区被当正常候选（§2.2、§4.2）；本文件从**逐案证据**补上：错误集中在 `.dsh` 磁吸（16/26）、期望会话标题在任务文本中可复现（14/17）、可推断子集 Jev=14.3%、当前标签天花板≈50%。
- `docs/validation/audit-V5-v2.md`（tester）的数字口径以该文件为准；本文不修改任何冻结产物（cases/summary/report 均只读）。

---

## 8. 复现（一条命令级）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
# 1) 抽取 gate 26 条错案的全部上下文（输出到 /tmp，含用户正文，勿入库）
node docs/research/probes/extract-v5-gate-cases.mjs
#   -> gate=28 wrong=26 correct=2 -> /tmp/scout-v5/gate-cases.json
# 2) 结构统计 + 「期望会话标题在任务文本中的复现度」量化
node docs/research/probes/analyze-v5-failures.mjs
#   -> gate 指标 / 混淆矩阵 / attachSignal 14/17 -> /tmp/scout-v5/metrics.json
```

产物：`/tmp/scout-v5/gate-cases.json`（逐案上下文，含原文，**不提交**）、`/tmp/scout-v5/metrics.json`（结构化指标）。本文件 §3 的"判定/标签"列是人工判断（可复核，规则见 §1.2/§1.3），脚本不自动生成。

---

## 9. 结论分层

**Fact**
1. gate 28 条：目标全对 2（7.1%）、工作区 4（14.3%）、模式 14（50.0%）；26 条错案。
2. 错案中选中 `.dsh` 16 条（61.5%），「Research→`.dsh`」11 条；`pW≥0.8 仍错` 6 条。
3. 模式失衡：期望 attach 18 条中 Jev 只 attach 8 条（10 条错判 new）；4 条 new 被 attach。
4. 17 条 attach 错案中 14 条的期望会话标题比选中项更贴近任务文本（最高 1.00）。
5. 白名单变体（前 8 活跃工作区）gate 指标 26.9% ws / 11.5% target，仍远离门禁。
6. 可推断子集（14 条）Jev Top-1 = 2/14 = 14.3%。

**Inference**
1. 当前标签下理想判定器上限 ≈14/28=50%，85% 不可达；改测度后（14 条分母）才回到可达区间。
2. 主要可修复损失在"工作区接地"（D/E 类），不在"语料领域太像"（B 类只是放大器）。
3. 继续调 Jev 阈值无效（校准表高置信桶 0 正确）。
4. 标签 F 类 11 条（用户习惯/回放结构）应剔除或重标，否则门禁数字无产品含义。

**Unverified**
1. 判定列的 26 条人工标签未做第二人独立复核（建议 tester 抽 10 条盲评一致性）。
2. 未评估"工作区职责声明 + 会话标题进入请求"的实测增益（需 backend 改请求构造后重跑，属 V5 重开动作）。
3. 未验证 v2b(placeholder)/full 变体下的同一逐案结论（本轮只用 layered 主口径）。
