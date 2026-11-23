# V5 v1 评估方法学独立复核（architect）

> 版本：v1.0　日期：2026-11-17
> 复核对象（**v1 定稿证据，不再改动**）：
> - `docs/eval/report-layered.md`（16:48，live layered 结果）
> - `docs/eval/summary-layered.json`（16:48，逐案数据，本复核的量化来源）
> - `docs/eval/cases.real.jsonl` 的 **v1 生成版**（16:47，`build-cases.mjs` 16:46 版语义：任务文本 = 原始单条用户消息；工作区摘要 = 占位文本）
> - `tools/jev-eval.mjs`（16:47 版）、`tools/eval/build-cases.mjs`（16:46 版）、`docs/eval/labels.cases.md`（16:47）、`docs/eval/labels.md`、`docs/validation/evidence-v5-layered-live.log`、`docs/validation/evidence-v5-full-mode-failure.log`
> 上游判据：`docs/architecture/validation-protocol.md` §6；`docs/ARCHITECTURE.md` v2.4 §5/§8；`docs/eval/jev-dispatch-eval.md`。
>
> **快照边界警告**：工作树在 16:51–16:52 已出现 v2 输入修复（`reconstructed-task` 标签、`docs/eval/workspace-summaries.json` 语义摘要、`cases.schema.json` 新字段、`build-cases.mjs` 重建任务与漏标签断言）。这些**不属于 v1 证据**，本复核不据此改动 v1 结论；v2 必须用修复后的工具**完整重跑**，不得把 v1 数字与 v2 输入混用。行号以 16:47/16:46 版为准，v2 改动后按符号名核对。
>
> 角色边界：architect 只做方法学复核（本文件），**不重跑 live、不改 `docs/eval/**`、不改 harness、不碰阈值门禁数值**。
>
> **复核期间观察（非本复核证据）**：工作树在 16:54–16:55 出现了 `report-v2-layered.md`、`report-v2b-placeholder-layered.md`、`report-v1-baseline-layered.md`（backend 的 v2 试跑）。粗略读到的 ws 44.4% / attach 9.1% / mode 57.8%，仍无阈值组合达标。这说明**只换任务文本与摘要不足以通过 V5**；§7 的 P0 其余项（harness 口径与请求压缩、≤20 候选域、38 条人工复核标签、full 模式重测）仍是必要条件。这些 v2 试跑文件不作为本复核的 v1 证据，也不得被当作 v2 最终结论（缺 C9，且未证明 P0 全项闭环）。

---

## 0. 结论摘要（先给裁定）

**裁定：v1 FAIL 不成立（需 v2 重跑）。**

理由分两层：

1. **v1 不满足 V5 门禁的前置条件，本身不构成一次有效评估**：
   - 工作区摘要是占位文本（`路径 …；此刻非归档历史会话 N 条；capabilityDigest 不可得`），不是 `docs/eval/jev-dispatch-eval.md` §2 与 `ARCHITECTURE` §8 要求的"语义摘要"；
   - 任务文本是**上下文依赖的原始单条用户消息**（例如「可以打 tag 和推送仓库」「打 tag，提交到远程并安装到当前 desktop profile」），不是可独立派发的任务陈述；
   - 38/50 条标签是脚本按结构规则生成、标了 `needs-review`，未做协议要求的人工判定；
   - 候选工作区 28 个，违反 `ARCHITECTURE` §5.2 的"≤20 个 allowed 工作区"设计包线；每案 251 条会话且 0 条带 `contextUsage`（关键 new/attach 信号缺失）；
   - "能力驱动层"没有能力签名可测（`capabilityDigest` 在数据源与 `WorkspaceRecord` 中都不存在），实际退化为"关键词提及层"。
2. **harness 有多处实现偏差/bug，导致数字不可归因**（详见 §3、§5）：分层模式的会话指标是工作区错误的级联值（attach 4.5% 的真实条件值是 1/4=25%）；请求构造把会话详情在 `state` 与 `criteria` 两处重复（仅会话 criteria 就多耗 ~11k tokens），同时让 full 模式突破 Jev 输入上限被 400 拒绝（**是输入侧上限，不是输出上限**）；阈值扫描用了一个协议里没有的"双 precision"口径，把本可算作 `precision=100% @ coverage=8.9%` 的行全部过滤掉；校准把 `pMax=max(pW,pS)` 当作置信度。

**同时成立的方向性观察（v2 必须保留验证，不能当结论）**：

| 观察 | v1 数值 | 可信度 |
|---|---|---|
| 高置信小集合精度高但覆盖极低 | 阈值 pW≥0.9/c≥0.7 时 served 4/4 正确、coverage 8.9% | 事实成立，样本 n=4 无统计意义 |
| 覆盖 ≥40% 时精度仅 ~33% | best row 6/18（served） | 事实成立；输入缺陷下不可归因 |
| 概率是有信息的 | 工作区正确样本 pW 均值 0.79 vs 错误 0.58 | 成立（支持门控方向） |
| obvious 层工作区 12/12、mode 6/12 | 报告逐条表 | 工作区结论成立；mode 半数偏 attach，需 v2 复核是标签歧义还是模型偏差 |
| old-session 层工作区 0/10 | 报告逐条表 | 输入缺陷直接命中该层（上下文依赖 + 无摘要），不可归因 |
| full 模式 400 | `max_tokens_exceeded` | 由 harness 重复计 token 放大；去重后估算 ~19.9k ≤24k，**必须重测** |

**不允许的下结论方式**：不得因为输入缺陷把 v1 改判 PASS；也不得在 v2 中放宽任何阈值（precision≥95%、coverage≥40%、Top-1 阈值保持不变）。

**补充复核（2026-11-17，tester 独立审计后追加）**：

1. **v1 证据链已断**：`docs/eval/cases.real.jsonl` 在审计期间被就地覆盖（16:52、16:56 两次；当前 sha256=`72d3416d…78e9`），v1 只剩 `report-layered.md` + `summary-layered.json` 派生物，**无法逐字复核**。按本文件 §9 的冻结要求，v1 轮次应记 **INVALID（不可复核）**，既不是 PASS 也不是 FAIL；三档裁定仍为「**v1 FAIL 不成立（需 v2）**」，新增的理由是"证据链不合格"。
2. **obvious 层不构成判别力**（§11 单列）：v1 选样规则本身要求"文本点名本工作区名称"（`labels.md` §3），12/12 工作区 Top-1 是构造保证；去掉 obvious 后 C2 = **6/33 = 18.2%**。报告必须把该层单列为 `named-cue`。
3. **as-of-dispatch 泄漏需要断言化**（§10 清单）：v1 的 raw 文本侧风险较小，但 v2 的"任务重建"会把目标会话的**首条用户消息（≈会话标题）**当上下文引用，当前案例文件中 10–12/25 条 attach 案例出现"预期会话标题出现在任务文本或 `recentTasks`"（见 §10 实测），必须阻断。
4. **以上均为方法学/证据完整性缺陷，与阈值无关**：不得据此放宽 95%/40%/85%/70%/3s/24k，也不得据此宣布 PASS。
5. **Lead 裁定已落地（2026-11-17，见 §12）**：obvious 改为 named-cue easy/回归层、门禁 C2 只在 **non-named-cue labeled** 上算；should-ask 自动放行容忍度 **0/5**；能力驱动层降级为「能力提及层（观测，不参与门禁）」；新增白名单敏感性诊断（非门禁）。v1 在新口径下：all-28 C2=40%（18/45）、**non-named-cue C2=6/33=18.2%**；should-ask 泄漏 1/5 → 即使忽略输入缺陷，C5 也按 0 容忍度 FAIL。

---

## 1. v1 指标复核（数字来自 `summary-layered.json`，与 `report-layered.md` 一致）

| 指标 | v1 值 | 复核意见 |
|---|---:|---|
| 工作区 Top-1 | 40.0%（18/45） | 其中 obvious 层 12/12 全对；非 obvious 仅 6/33。统计被输入缺陷与候选集规模主导，**不可归因** |
| attach 会话 Top-1 | 4.5%（1/22） | **级联指标**：22 条 attach 中仅 4 条工作区正确；工作区正确条件下为 1/4=25%。分层模式下工作区错则目标会话根本不在候选里 |
| 模式准确率 | 55.6%（25/45） | mode 标签由"是否首条消息"回放推导；obvious 层工作区全对但 mode 6/12，标签歧义与模型偏差无法分离 |
| 目标全对 | 15.6% | 受上述两项叠加 |
| 冲突 | 0 | 解析正常（无 `choice` 映射失败） |
| p95 时延 | 1444ms | <3s，**C7 时延可判 PASS** |
| tokens | input 682773 / 100 请求（≈6.8k/请求） | 单请求未超 24k，但 harness 未做逐请求预算断言（见 §3 B7） |

分层明细（`summary-layered.json` 重算）：

| 层 | n | ws 对 | mode 对 | target 对 | attach 期望 |
|---|---:|---:|---:|---:|---:|
| obvious | 12 | **12** | 6 | 6 | 0 |
| ambiguous | 12 | 4 | 7 | 0 | 7 |
| old-session | 10 | **0** | 5 | 0 | 10 |
| new-session | 6 | 1 | 3 | 0 | 0 |
| capability | 5 | 1 | 4 | 1 | 5 |
| should-ask（不进分母） | 5 | 2 | 3 | 2 | 3 |

> should-ask 层 2/5 的目标"命中"是**标签自相矛盾**的直接证据：v5-01（`看一下现在电脑为什么 cpu 负载这么高`，chosen=expected=agent-workspace/new）与 v5-05（chosen=expected=agent-workspace/attach/…a40ae44d）在报告里 target 都是 `should-ask`，但 selected 目标与标签期望一致。一个"应询问"的案例不该同时存在一个确定的期望目标；若它真有确定目标，就不该判"应询问"。该层必须人工重标。

---

## 2. 输入构造复核（v1 的硬伤，按严重度）

### 2.1 工作区摘要 = 占位文本（P0，直接违反协议前置）

`build-cases.mjs:337`（16:46 版）生成：

```js
summary: `路径 ${ws.path}；此刻非归档历史会话 ${sessions.length} 条；capabilityDigest 不可得（数据源无该字段）`
```

- `jev-dispatch-eval.md` §2 要求每条案例冻结"允许工作区（id/name/summary/capabilityDigest）"；`ARCHITECTURE` §8 要求"当时的允许工作区与摘要"。v1 摘要里唯一的语义线索是 `recentTasks`（最多 5 条会话标题），`why` 字段等于占位文本 → Jev 实际是"靠路径 basename + 最近 5 条会话标题猜工作区"。
- 这解释了 obvious 层为什么 12/12、old-session 0/10：文本点名工作区时能靠名字匹配；文本不含名字且摘要无职责描述时，没有任何可用语义信号。
- **定性**：v1 测的不是"指挥官 + 摘要 + Jev"的设计形态，而是"退化输入下 Jev 能猜多准"。协议 §6.2 前置 P1/P3 未满足。
- v2 已出现 `SUMMARY_MODE`（semantic/placeholder）与 `docs/eval/workspace-summaries.json`（LLM 生成、28 条）；这是正确方向，但必须：**同时保留 placeholder 对照组**（见 §7 清单），并在报告里写清 summaryMode；摘要生成过程不得看到 expected 标签（v2 文件已声明，需证据化）。

### 2.2 候选工作区 28 个（P0，违反冻结设计包线）

- `ARCHITECTURE` §5.2：`allowedWorkspaces = 所有 allowed === true 的工作区（≤20）`；PRODUCT-DESIGN 的工作区白名单假设是用户按需勾选（§2 假设 3–8 个工作区并行）。
- v1 每案 28 个工作区，包含 `.dsh`、`test`、`192.168.98.152 - mira-ai` 等元/运维工作区；工作量是设计包线的 1.4 倍、产品常态的 3.5–9 倍。
- 影响：choice 概率被稀释（28 选 1）；产品真实白名单下不会出现这些噪声选项；Top-1 与 confidence 都会系统性偏低 → 直接压低 C2 与覆盖。
- **注意**：这不是"放宽阈值"，而是让候选集回到冻结设计包线。建议 v2 预注册两个候选域并分开报告：**(a) 设计包线 ≤20**（如剔除 `.dsh`/`test` 等元工作区后的真实集，或按用户白名单语义抽样 8 个），**(b) 28 全量压力集**（只作压力报告，不进 C2–C6 门禁）。**候选域必须在看结果前定死**，否则就是调参凑通过。

### 2.3 任务文本上下文依赖（P0，构念效度问题）

v1 直接用历史用户消息当派发输入。抽样（本地文件，仅列片段）：

| 案例 | 层 | v1 任务文本（截断） | 独立派发是否可判 |
|---|---|---|---|
| v5-07 | old-session | `打 tag，提交到远程并安装到当前 desktop profile` | ❌ "当前 profile/仓库" 指代前文 |
| v5-06 | old-session | `@用浏览器打开 https://example.com 我在这个 session 打开了，但是还是没有` | ❌ "这个 session" 指代前文 |
| v5-03 | should-ask | `可以打 tag 和推送仓库` | ❌ 无上下文无法知道改哪个仓库 |
| v5-10 | old-session | `可以先提交到本仓库，然后给市场提 PR，然后设一个定时任务每天23:00 检查…` | ⚠️ 部分自包含，"本仓库/本插件"仍需上下文 |
| v5-38 | ambiguous | `@你现在创建如下子agent，暂不 你看看这个这个 session 为什么父 agent…` | ❌ 多段拼接、含"这个 session" |
| v5-27 | ambiguous | `使用 apifox 看一下现在项目有什么接口` | ⚠️ "现在项目"依赖 cwd |
| v5-43/44 | obvious | `# 背景 现在这个项目是 /Users/…/miraclip_ai 这个项目的延伸…`（长背景+需求） | ✅ 自包含（长文本有 4000 字上限风险） |
| v5-39/45/48 | obvious | 完整需求描述 | ✅ 自包含 |
| v5-01 | should-ask | `看一下现在电脑为什么 cpu 负载这么高` | ⚠️ 自包含但无工作区线索，可询问 |
| v5-02 | should-ask | `看一下生产服务的 docker 容器是否正常` | ⚠️ 信息不少，"生产服务"可能指向特定运维工作区，`should-ask` 标签存疑 |

- 结论：**old-session / ambiguous / should-ask 三层大面积不可独立判定**；把它们计入 C2/C3/C4 等于让 Jev 做"读心"任务。
- v2 已用 `reconstructTask`（此前 ≤2 条用户要求 + 最近助手要点 ≤80 字 + 原始命令，≤240 字）缓解，方向正确；必须：
  1. 在 `labels.md`/`report` 显式声明"任务文本 = 重建版（含会话上下文）"，否则相当于换了评测对象而不自知；
  2. 保留**原始消息对照实验**（同一批案例跑 raw vs reconstructed），报告两者差异，证明重建不是把答案喂给模型；
  3. 重建里不得出现期望工作区名/路径 basename/期望会话 id/会话标题（v2 的 `sanitizeLeak` 已覆盖前三类，**未覆盖会话标题**——快照里会话标题与重建上下文同源，可能提示正确会话；需把"标题词命中"也纳入 leak 断言）。

### 2.4 会话候选集规模与缺失信号（P1）

- 每案 251–252 条会话；`contextUsage` **0/251**（`session_projcache` 全 stale），而 `ARCHITECTURE` §5.5 明确"上下文水位"是 new/attach 的关键判据；v1 实际把 new-vs-attach 降级为"标题相似度猜"。
- `ARCHITECTURE` §5.5 要求"每会话描述压到 ≤60 字符、标题截断、criteria 只放 id、详情放 state"；v1 两处都放全文（见 §3 B4），这是 token 与准确率的双重自伤。
- v2 若拿不到 `contextUsage`，应在报告里显式标注"attach/new 判据降级"，并把 C3/C4 视为"弱证据门禁"（是否允许进 M1 由 lead 裁定，不由 architect 擅自放宽）。

### 2.5 能力层无能力签名（P1，与冻结数据模型冲突）

- `jev-dispatch-eval.md` §2 要求快照含每工作区 `capabilityDigest`；`cases.schema.json` v1 里**没有该字段**；`ARCHITECTURE` §3.3 `WorkspaceRecord` 也只有 `summary` + `capabilityPolicy`，没有能力目录摘要。
- 结论：**"能力驱动层"在当前设计里不可构建**（能力目录属于能力面板，派发 Jev 只判工作区/会话）。v1 实际是"任务文本含能力关键词"的近似层（`capability-approx` 标签），只能算普通工作区匹配的困难样本，不能作为 `jev-dispatch-eval.md` §2 的"能力驱动 5 条"。
- **Lead 已裁定取 ①（2026-11-17）**：该层改名「能力提及层」、标注**观测项、不参与门禁**、不验证能力路由；**不改冻结的 `WorkspaceRecord`、不新增 `capabilityDigest`**。该层仅作观察记录与能力面板 auto 的旁证；协议 §6.2 P2 已把分层改为"门禁层 45 + 观测层 5"。

### 2.6 should-ask 层的构念问题（P1）

- 选样规则（`build-cases.mjs` 16:46 版）：`trim ≤30 字 ∧ 命中泛化表达 ∧ 未点名工作区`。这测的是"消息像不像半句话"，不是"信息是否不足以派发"。
- 结果：5 条里至少 2 条（v5-02、v5-01 视策略）实际信息量足够，且 v5-01/v5-05 的"期望目标"被 Jev 命中——**标签与"应询问"结论自相矛盾**。
- 处置建议：should-ask 必须人工重标（保留 5 条配额、换掉不合格样本），并在 `cases.schema.json` 里允许 `expected.mode/workspaceId` 缺省（当前 schema 强制要求，逼标注者编造目标）。schema 修改属 backend 范围，architect 可在协议侧放宽"should-ask 必须有 expected 目标"的隐含要求（见 §8）。

---

## 3. Harness 实现复核（`tools/jev-eval.mjs` 16:47 版）

> 下列每条都给出符号名；行号随 v2 改动会漂移，复核时按符号核对。每条都标注对 v1 数字的影响。

| # | 位置 | 问题 | 对 v1 的影响 | v2 修法 |
|---|---|---|---|---|
| **B1** | `metricsOf` / `evaluate` | `sessionTop1Attach` 分母是全部 attach 案例，但分层模式下工作区答错时**期望会话不在第二问候选集里**（`buildSessionRequest` 只带所选工作区的会话）→ 数学上不可能对，仍计为 miss | attach Top-1 被压成 4.5%；条件值 25% 不可见 | 记录 `expectedInScope`（工作区正确才为 true）并输出条件指标；门禁 C3 定义见 §8 |
| **B2** | `buildSessionRequest` | 第一问 `choice` 映射不到候选（`chosenWorkspaceId=null`）时静默构造 `sessions:[]` 的第二问，只留 `new` 选项；无 `workspaceAnswerInvalid` 标记 | 解析失败会被伪装成"模型选了 new" | 无效答案显式标记 + 该案 C3 记 N/A 而不是 miss；报告汇总 invalid 数（v1 为 0，但必须防御） |
| **B3** | `evaluate` 的 `sessionMode` | `choice === 'new' ? 'new' : 'attach'`：`choice=null` 或未知 key 会被判成 attach | 与 B2 同源，潜在虚高/虚低 | 未知 choice → `mode='invalid'`，不入分母并计数 |
| **B4** | `sessionQuestion` + `buildFullRequest.state` | **会话详情重复计 token**：`state.sessions` 有 `title/lastActiveAt/contextUsage`，`criteria` 又重复 `title · workspaceId / 最近活动 / 上下文 %`。违反 `ARCHITECTURE` §5.2"会话详情只放 state，criteria 用 id/短标签" | 按同源快照结构重算（16:52 版 cases，会话/工作区规模与 v1 相同：251/28）：会话 criteria 单独 ≈11k tokens（state≈17.6k、questions≈12.6k 中约 11k 是会话 criteria）；full 请求 p50 ≈30.3k → 撞 400；同时重复文本稀释判据 | criteria 会话项只留 `{what: 短标题≤20字}` 或 id；详情只放 state；workspace criteria 也去掉 `path`（state 已有） |
| **B5** | `callJev` 调用处（live full） | 任何 HTTP 错误（如 `400 max_tokens_exceeded`）直接抛出终止整个 run，无逐案隔离、无预算预检、无 fallback | full 模式只得到一行崩溃日志，**没有 C9 对比结论**；`--gate` 也拿不到结构化失败 | 预检请求 token（按 §5.5 的压缩规则）；超预算记 `budget_exceeded` 并继续/自动降级 layered；逐案 try/catch，错误计入 `errors[]` |
| **B6** | `tokensOf` / `C7-tokens` gate | full 用响应 `usage`、缺 usage 才估算；`estimateTokens` 口径（CJK 1 + 其余 /4）与产品 "字符数/3" 不一致；layered 模式 C7-tokens **恒 true**，从不校验任何预算 | v1 layered 的"token 门禁通过"是同义反复；full 的 24k 判定未发生 | 统一用 `ARCHITECTURE` §5.2 的估算口径做预检，响应 usage 做实测；两种模式都断言"单请求 ≤24k"；报告 `maxTokensPerRequest` |
| **B7** | `sweep` + `thresholdRows` | 门禁筛选用**协议里不存在的双口径**：`precision(served) ≥95%` 且 `precision(含 should-ask 惩罚) ≥95%`；覆盖分母用 labeled(45)，惩罚分母用 passed(含 should-ask)，两个 universe 混用 | v1 实际最高 served precision = **100% @ coverage 8.9%**，被第二个口径（1 条 should-ask 泄漏使惩罚口径 80%）全部过滤 → 报告"没有任何组合"，与协议 C5 字面不符 | 先在协议里定死唯一口径（§8 建议）；harness 按口径实现，并同时报告 should-ask 泄漏数与 served 数 |
| **B8** | `sweep` 网格 | 只扫 `p ∈ [0.5,0.95]`、`confidence ∈ [0.3,0.7]`；v1 `pW` p25=0.53、p50=0.59，网格下限几乎贴着数据低端，**无法发现 <0.5 的可行区**；同 served 集合重复行多 | "无阈值组合"的搜索空间不完整（虽然阈值最终值不得低于为通过而调，但**可行性探查范围**应覆盖实际概率区间） | 网格扩到 `p ∈ [0.3,0.95] step 0.05`、`c ∈ [0.1,0.9] step 0.1`；按 served 集合去重；最终选阈值规则不变（precision≥95% 下 coverage 最高） |
| **B9** | `calibration` | `pMax = max(pW,pS)`，且"correct"=目标全对（含 mode/session）；门控是**合取**，弱项是 min 而非 max；分桶后 n=1/4/6，无最小样本约束 | v1 校准表"0.9–1.0 桶 14 例仅 7 对"被误读为过自信；实际 obvious 层高 pW 工作区全对，错在 mode | 用 `min(pW,pS)` 做门控相关校准；另出"工作区选择校准（pW vs workspaceCorrect）"与"会话选择校准（pS vs sessionCorrect）"两条；桶 n<5 标 N/A，不作门禁 |
| **B10** | `summary.gates` | 缺 C1（案例集有效性/标签人工复核）、C8（校准）、C9（full vs layered 结论与默认模式）；C2–C6 有，C7 token 同义反复 | v1 的"gate FAIL"列表不完整，不能直接映射协议 §6.6；也无 v1 的 C9 | 补齐 C1/C8/C9 的机器判定；C1 至少含"needsReview=0 或人工复核记录文件存在 + schema/分层" |
| **B11** | `report` | 没有**分层指标**、没有条件指标、没有 invalid/expected-in-scope 计数、没有 summaryMode、没有案例文件哈希/seed | 复核者看不到"obvious ws 12/12" vs "old-session 0/10"，只能看到总分，容易误判模型能力 | 报告加：逐层 ws/mode/session/target + 条件 C3 + invalid + summaryMode + case 文件 sha256 + seed + 每请求 max tokens |
| **B12** | `evaluate` | `layer = tags[0]` 依赖标签顺序；`shouldAsk` 只看 tags 含 `should-ask`；`expected.mode` 对 should-ask 案例无意义却被 schema 强制 | 分层计数正确（v1），但脆弱；should-ask 的伪目标污染标签可复核性 | 用 meta 字段记录层（生成器已有 `layer`）；should-ask 的 expected 目标改可选 |
| **B13** | 覆盖率/精度分母 | 见 B7：`coverage = served / labeled`；协议 C6 字面是"门控放行比例"（未定义分母）。v1 分母 45，若按全部 50 分母会更低 | 口径不统一会让"是否达标"随实现变化 | 协议 §8 定死：coverage = autoAll / 50（含 should-ask），precision = correct(auto) / autoAll（should-ask 自动放行记错），并另报 served-only 视图 |
| **B14** | `mockCase` | mock 依赖 expected 生成答案（自证式），只做 harness 自检，已标明"不是 live 结果" | 无影响（正确标注） | 保持；但 mock 不应被引用为任何指标证据，报告已挡 |
| **B15** | 复现性 | 报告未记录 key 来源/endpoint 实际响应 model 版本、case 文件 hash、生成器版本 | v1 报告无法逐位复跑核对 | 报告头部加：caseFile sha256、生成器 `git rev`、summaryMode、seed、response model、每请求 tokens/ms |

**未发现的问题（明确澄清）**：

- 两问 `choice` 协议本身符合 `ARCHITECTURE` §5.3：`questions.workspace` + `questions.session`，选项是 `w_i`/`s_i`，`new` 为固定项；`probabilities/confidence` 解析路径（`extractAnswers`/`normalizeAnswer`/`topProb`）在 v1 实测有效（0 条 `choice` 映射失败、`pW/pS` 分布合理）。
- 阈值扫描的 precision/coverage 数学本身没有错，错的是"用哪个分子分母"与"筛选条件"（B7/B13）。
- layered 第二问候选范围符合协议（所选工作区的全部非归档会话 + new）；问题在于级联与缺条件指标（B1/B2），不在范围本身。
- `full` 模式请求体积的**来源**已量化（§2.4 + B4），不是"Jev 输出上限"。

---

## 4. 标签可信度复核

### 4.1 机器统计（`labels.cases.md` 16:47 / `build-cases.mjs` stats）

| 项 | 值 |
|---|---|
| 置信度 | high=12 / medium=22 / low=16 |
| 需人工复核 | **38/50 = 76%** |
| workspace 标签来源 | 源会话 `header.cwd` 与 `workspace.json` path 精确匹配（Fact） |
| mode 标签来源 | 首条消息→new；非首条→attach（Inference，回放语义） |

**判定**：`validation-protocol.md` §6.2 前置 P3 明确要求"标签来自真实快照 + **人工判定**"。v1 的标签全部来自确定性脚本，且 76% 自标 needs-review → **P3 未满足**，这是 v1 不能作为门禁的独立理由（不管 harness 修没修）。

### 4.2 workspace = cwd Fact 的可靠性

- 作为"用户当时实际把活放在哪个工作区"的**历史事实**，可靠且可复现（路径精确匹配，无先验）；这是 v1 做对的一点。
- 但作为"此刻派发这条任务**应该**去哪个工作区"的**规范真值**，有三个缺口：
  1. **可替代目标**：跨工作区歧义层（12 条）本质可能有两个同样合理的答案；单一 Fact 会把合理答案判错。建议该层引入"可接受目标集合"（人工标注 1–2 个），C2 分母与判分按 accept-set；否则 C2 系统性低估。
  2. **元/运维工作区**：`.dsh`、`test`、`192.168.x - mira-*` 等被当作正常候选，Fact 标签会把"用户在 `.dsh` 里做了这件事"当作派发目标，产品语义上未必成立。
  3. **cwd ≠ 工作区职责**：会话 cwd 可能只是打开目录（如从上级目录启动），不保证归属语义；v1 已过滤"path 精确匹配"，风险可控但应在报告注明。

### 4.3 attach/new 回放语义是否成立

- 语义链是自洽的："这条消息在会话 X 里是第 0 条 → 重放时应新建；不是第 0 条 → 重放时应 attach 到 X"。
- 但它测的是"**能否从单条上下文依赖消息反推它当年属于哪个会话**"，而产品要的是"用户下一条自包含指令该去哪个会话"。两者只在"消息自包含且会话仍存在"时重合。
- 自证风险：attach 案例的快照里包含源会话本体，且快照使用**当前终态标题**；任务文本与标题同源 → 标题匹配可提示答案（`ARCHITECTURE` §5.5 允许标题作为判据，所以不算作弊，但会高估 attach 能力）。v1 实际 attach 很差（工作区先错），该风险没有暴露。
- 结论：attach/new 标签可作为"回放一致性"指标，但**不能单独承担 C3/C4 的产品语义**；v2 应把"自包含任务"子集（obvious+new-session 的合格样本 + 人工复核后的 old/ambiguous）作为门禁主集，把"上下文依赖"样本单列"回放专项"，不进门禁。

### 4.4 "应新建层"是否自证

- 选样：首条消息 + 同工作区存在标题词相似的已有会话 + 文本未点名本工作区；标签：new。
- "有诱惑 attach 目标但仍应新建"是一个**人为构造的陷阱**，其"应新建"结论来自规则（首条消息），不是用户意图证据。Jev 若选 attach 到相似标题会话，可能是**合理行为**（用户可能就想继续那个会话），却被判错。
- v1 报告里 v5-16（工作区对、mode 错：new→attach）就是这类；把它算进 C4 误差会系统性高估模型错误。
- 处置：该层 6 条必须人工复核"是否真的该新建"（例如上下文水位高、或任务目标与已有会话明显不同）；不能复核通过的样本应替换，而不是改判模型对。

### 4.5 "应询问层"是否标签有误/信息不足

- 选样只看"短 + 泛化开头 + 未点名工作区"，这是**语言表面特征**，不是"派发信息不足"。
- 反例（v1 实测）：v5-02 `看一下生产服务的 docker 容器是否正常`（信息其实够，可能应派到运维工作区）、v5-01 `看一下现在电脑为什么 cpu 负载这么高`（可派到 agent-workspace，也可询问）、v5-05 的期望目标被 Jev 命中。
- 且这些案例仍被 schema 强制编造 `expected.workspaceId/mode`，与"应询问"的语义冲突。
- 处置：人工重标 5 条 + schema 允许 should-ask 无期望目标；评分为"自动放行即安全错误"计数，不混入 Top-1 分母（v1 harness 已这样做，保留）。

### 4.6 抽样 8–10 条综合判断（输入公平性）

| 案例 | 层 | 任务文本可独立判定？ | 标签可复核？ | 结论 |
|---|---|---|---|---|
| v5-39 | obvious | ✅ 长需求自包含 | ✅ 文本点名工作区 | 公平样本 |
| v5-45 | obvious | ✅ `在这台远程服务器用 ollama 跑起来…` | ✅ | 公平样本 |
| v5-48 | obvious | ✅ 插件需求自包含 | ✅ | 公平样本 |
| v5-50 | obvious | ✅ `@0818…xlsx … order-center mcp …` | ✅ | 公平样本（含附件引用，符合真实） |
| v5-43/44 | obvious | ✅ 背景+需求（长文本，存在 4000 字上限风险） | ⚠️ 截断风险 | 公平但需截断公平性说明 |
| v5-27 | ambiguous | ⚠️ "现在项目"依赖 cwd | ⚠️ 可替代目标多 | 只应作 accept-set 评估 |
| v5-29 | ambiguous | ⚠️ "当前这个项目在跑这什么 docker 容器" | ⚠️ | 同 v5-27 |
| v5-07 | old-session | ❌ "当前 desktop profile"无指代 | ⚠️ attach 回放可解释但与"独立派发"不符 | 不进主门禁 |
| v5-06 | old-session | ❌ "这个 session" | ⚠️ 同上 | 不进主门禁 |
| v5-03 | should-ask | ❌ "可以打 tag 和推送仓库" | ❌ 明显是上下文依赖而非"信息不足" | 必须替换 |

**结论**：v1 的公平样本主要是 obvious 层（12 条，其中长文本存在 4000 字上限风险）+ 部分 new-session/ambiguous；其余 ~30 条不具备"可独立派发"的构念效度。用 45 条分母算 C2/C3/C4 不公平。

---

## 5. 阈值扫描数学复核（v1 "无组合达 precision≥95%"是否成立）

### 5.1 协议口径（`validation-protocol.md` §6.6）

- V5-C5：自动派发 precision ≥95%（"门控放行样本中目标正确率"）；
- V5-C6：自动派发 coverage ≥40%（"门控放行比例"）。

协议**没有**定义：should-ask 自动放行算不算 precision 错、coverage 分母是 45 还是 50、是否要求两个 precision 口径同时达标。v1 harness 自行选了"两个都要≥95%"的更严口径。

### 5.2 v1 实际扫描结果（`summary-layered.json.allSweepRows`，320 行）

| 口径 | v1 最优 |
|---|---|
| served precision（不含 should-ask 泄漏） | **100%**（4 正确 / 4 served），coverage 8.9%，pW≥0.9 & c≥0.7 |
| **裁定后 C5 口径**：`correct(auto)/autoAll` + 泄漏 0/5 | 该行 autoAll=5（含 1 条 should-ask 泄漏）→ precision **80%**、泄漏 **1/5** → **C5 FAIL**（0 容忍度） |
| coverage ≥40% 时最好 served precision | **33.3%**（6 / 18），含泄漏口径 31.6% |
| coverage 最大 | 75.6%（34 served，6 正确，precision 17.6%） |

- **"无阈值组合达 precision≥95%"的准确表述**：在 v1 harness 的"双 precision"筛法下为空；按 **Lead 裁定的 C5 口径**（`correct/autoAll` 且 should-ask 泄漏 0/5），v1 最好行 autoAll=5、correct=4、泄漏 1 → precision 80% + 泄漏违规 → C5 FAIL；即便假设泄漏为 0，该行 coverage 仅 8.9%，C6 仍 FAIL。n=4–5 无统计意义，这也是 v1 不能作为门禁依据的独立理由。
- 即使忽略 should-ask，v1 数据要同时满足 C5+C6（coverage≥40% 时 precision≥95%）需要 ≥18 served 里几乎全对；v1 在该覆盖下只有 6/18 正确 → **在 v1 输入下 C5+C6 确实无法同时达成**。这条事实成立，但归因于输入/标签缺陷（§2、§4），不能归因为"Jev 模型不达标"。
- 统计功效：n=4 的 100% 与 n=18 的 33% 都不能支撑 95% 门禁；建议协议补"自动派发样本数 ≥20 才判 C5/C6，否则记 INSUFFICIENT（BLOCKED）"——这是**补统计前提**，不是降低 95%/40% 阈值。

### 5.3 校准

- v1 校准表（pMax=max）在 0.9–1.0 桶：14 例 7 对（50%）；0.5–0.9 四桶全 0。复核发现这主要由 **mode 错误**（obvious 层 ws 全对、mode 6/12）与 should-ask 之外的高置信错误造成，不是概率本身失真：工作区选择维度上 pW 均值 0.79（正确）vs 0.58（错误），有区分度。
- 结论：v1 不能得出"Jev 过度自信"的结论；应改为分维度校准 + min(pW,pS) 门控校准（B9）。

---

## 6. `full` 模式 400 的判定

- 证据：`docs/validation/evidence-v5-full-mode-failure.log` → `Error: Jev 400: {"detail":{"error_type":"max_tokens_exceeded"}}`，在第一条 case 即崩。**这是输入侧（请求体积超模型上下文），不是输出侧，也不是网络/鉴权。**
- 体积来源（已量化，按同源 251 会话/28 工作区快照结构重算）：每案 251 会话 × 两处重复（state + criteria）→ 会话 criteria 单独 ≈11k tokens；full 请求估算 p50 ≈30.3k tokens，50/50 案例 >24k。按 `ARCHITECTURE` §5.2/§5.5 的压缩规则（会话详情只放 state、criteria 只留 id/短标签、标题≤60 字符）重算：full p50 ≈**19.9k**，**0/50 超 24k**。
- 所以 v1 的 full 400 **是 harness 请求构造缺陷放大的**，"full 模式不可行"的结论不成立。v2 按设计压缩后必须重跑 full，并与 layered 对比给出 C9 结论（`ARCHITECTURE` §8：全量明显更准且 ≤24k → 默认全量；否则两层）。
- 附带确认：v1 报告的 `tokens input=682773` 是 layered 两请求合计（≈6.8k/请求），单请求远低于预算；`C7-tokens` 对 layered 恒 true 属实现遗漏（B6），不是"通过"。

---

## 7. 给 backend 的 v2 最小必要清单（可执行、按优先级）

> 原则：**不放宽任何阈值**；只修输入构念、标签、harness 口径与统计前提。每项给出"完成标志"以便复核。

### v2 重跑前置（Lead 裁定：backend 实现，tester 对冻结副本复核；未过不得出 v2 结论）

- [ ] **F1 冻结**：v2 案例生成后立即写 `docs/eval/frozen/cases.v2.<sha12>.jsonl` + `manifest.json`（sha256/round/生成器版本/seed/summaryMode/dispatchTime/分层计数）；报告与证据只引用该副本（协议 §6.2A）。
- [ ] **F2 audit-cases**：`tools/eval/audit-cases.mjs` 只读实现 A1–A11；对冻结副本输出逐条结果 JSON；A1–A11 违规必须为 0（A11 为白名单定义可复现性，抽 5 案例重跑一致）。
- [ ] **F3 A4/A5 清零**：任务文本不得含期望会话标题全文/≥8 字片段（v1 实测 7/25）；`recentTasks` 不得列期望会话标题（v1 实测 8/25）。修法示例：重建上下文引用首条消息时把标题片段替换为"（前情）"；从 `recentTasks` 过滤期望会话标题。
- [ ] **F4 A7/named-cue**：保留点名层作 named-cue easy/回归层；报告头并列打印 `all` 与 `non-named-cue` 两套指标；**门禁 C2 取 non-named-cue**。
- [ ] tester：对 **frozen 副本**复跑 F2 并把 audit JSON 作为证据；未冻结/哈希不一致 → 记 INVALID。

### P0（不做则 v2 仍无效）

1. **语义工作区摘要**：`SUMMARY_MODE=semantic`（已有实现方向）。要求：
   - 生成时**只看**工作区名/路径/recentTasks/会话标题，不看 expected 标签；生成脚本可复现；
   - 报告与 labels 头部记录 `summaryMode`；
   - **同时跑 placeholder 对照组**（同案例、仅摘要不同），报告写清两组的 C2/C4 差异（证明摘要不是"喂答案"而是修输入）。
2. **任务文本自包含化**：`reconstructTask`（已实现方向）要求：
   - 报告/labels 声明"任务文本=重建版（含会话上下文摘要）"；
   - 对照实验：同案例 `raw` vs `reconstructed` 两跑，报告差异；
   - leak 断言扩展到**会话标题词**与**期望 sessionId/工作区路径 basename**；命中即替换并计数（`leakHits` 已覆盖部分，补标题）；
   - 无法重建为自包含的样本（如 v5-03）换样，不进主门禁。
3. **候选工作区回到设计包线**：预注册两套候选域并分开报告：
   - 主集：≤20 个工作区（剔除 `.dsh`/`test` 等元工作区后取真实集；或按白名单语义抽样 8–12 个，抽样规则在看结果前写死）；
   - 压力集：28 全量（只报告，不进 C2–C6 门禁）。
   两套都用同一批案例/标签，只换 `workspaces` 快照。
4. **标签人工复核**：38 条 needs-review 全部过一遍，产出 `docs/eval/labels.reviewed.md`（或等价复核记录）：逐条给出 期望工作区（含 accept-set 可选）、模式、会话（attach 时）、是否应询问、复核人。
   - obvious 层也至少抽 4 条复核（防止"文本点名工作区"规则本身有问题）；
   - should-ask 5 条全部重标，不合格替换；
   - capability 层按"能力提及层"重命名并在报告注明"不验证能力路由"（或按 §8 争议项由 lead 决定是否保留层）。
   - 完成标志：`needsReview=0`（或剩余项有 lead 签字的豁免）。
5. **harness 指标修正**（B1/B2/B3/B4/B5/B7/B13）：
   - 记录 `expectedInScope`、`workspaceAnswerInvalid`、`modeInvalid`；
   - 输出条件指标：`sessionTop1Attach | workspaceCorrect`；
   - 统一 precision/coverage 口径（按 §8 定稿）；
   - 请求构造按 `ARCHITECTURE` §5.2/§5.5 去重压缩（criteria 只留 id/短标签；会话描述 ≤60 字符；workspace criteria 去 path）；
   - full 模式逐案 try/catch + 预算预检 + `budget_exceeded` 记录，不崩全 run。
6. **冻结与审计链（§9，新增 P0）**：每轮生成后写 `docs/eval/frozen/` 只读副本 + manifest（sha256/round/生成器版本/seed/summaryMode）；报告与证据只引用冻结副本；冻结前不得起跑；本轮 v1 已因覆盖不可复核，v2 必须第一次就冻结。
7. **as-of-dispatch 输入审计（§10，新增 P0）**：提供只读 `tools/eval/audit-cases.mjs` 断言 A1–A12（A4 按协议 §6.2B 可执行细则；A12 为 dispatchAt 口径与披露）；当前实测 A4（任务文本含期望会话标题全文，7/25）与 A5（recentTasks 列出期望会话标题，8/25）必须修到 0；obvious 层按 §11 单列 named-cue（v2 当前只有 2/12 点名，需定方案）。
8. **重跑 v2 并产出 C9**：先 placeholder 对照，再 semantic 主跑；两种模式（full/layered）各一次；报告含 `maxTokensPerRequest`、case 文件 sha256、seed、summaryMode、response model；报告单列 named-cue/non-named 与条件 C3。

### P1（门禁可信度）

7. **统计前提**：C5/C6 的自动派发样本数 <20 时输出 `INSUFFICIENT_AUTO_SAMPLES`，不判 PASS/FAIL（交 lead）；报告给出 precision 的 Wilson 95% 区间或简单样本量说明。
8. **should-ask 安全指标单列**：`autoLeakedShouldAsk / 5`，不折进 C5 主口径（主口径按 §8）。若 lead 要求"泄漏 0 容忍"，在协议里显式写明（不是 harness 自行加严）。
9. **分维度校准 + 分层指标**：报告加逐层 ws/mode/session/target、条件 C3、`min(pW,pS)` 校准、pW↔workspaceCorrect 校准、pS↔sessionCorrect 校准；桶 n<5 标 N/A。
10. **网格扩展**：p∈[0.3,0.95] step 0.05、c∈[0.1,0.9] step 0.1；按 served 集合去重；最终选阈值规则不变。
11. **复现性头部**：case 文件 sha256、生成器版本、seed、summaryMode、endpoint、响应 model、逐请求 tokens/ms。
12. **C1/C8/C9 机器判定**：C1 含"标签人工复核完成 + schema + 分层"；C8 报告式（不作为硬门禁，除非桶 n≥5）；C9 机器比较 full/layered 并给出默认模式建议。

### P2（方法学完善，不阻塞 v2 门禁重跑）

13. 每案 `contextUsage` 缺失时的降级声明（若 projcache 仍 stale）：报告注明 new/attach 为弱证据；评估"new-session 层"时标注启发式标签。
14. accept-set 评估（ambiguous 层）：C2 用"命中 accept-set 即对"，同时报 exact-Fact 准确率。
15. 快照时间与标题时效：会话标题取当前终态（数据源无历史标题）→ 报告标注该偏差；old-session 层可加"标题快照不足以代表当时"的风险说明。

---

## 8. 与 `validation-protocol.md` §6 的判据冲突点 / 建议修订（供 lead 批准后由 architect 落协议）

| # | 冲突 | 建议修订（不降低阈值） |
|---|---|---|
| **P-1** | §6.6 V5-C3 "会话 Top-1（attach 案例）≥70%" 在分层模式下被 C2 级联；工作区错时数学上不可能 | C3 定义为 **`sessionTop1Attach | expectedInScope`**（只统计期望会话在第二问候选集内的案例），同时报告 raw 值；n<10 时标 INSUFFICIENT。阈值仍 ≥70% |
| **P-2** | §6.6 V5-C5/C6 未定义 should-ask 与分母 | **已裁定（2026-11-17）**：`precision = correct(auto) / autoAll`（should-ask 自动放行计错且**容忍度 0/5，泄漏一条即 FAIL**）；`coverage = served / labeled(45)`（与 v1 harness 一致）。阈值仍 95%/40%；已落协议 §6.6 |
| **P-3** | §6.2 P3 "人工判定" 与 v1 全自动标签冲突；C1 只看 schema+分层 | C1 增加子条件："`needsReview` 剩余为 0，或有 lead 签字的逐条复核记录"；P3 明确"确定性规则可作初标，必须人工复核后生效" |
| **P-4** | §6.2 P1 要求摘要，但未写"无摘要即无效" | 明确：主门禁必须 `summaryMode=semantic`；placeholder 仅作对照，不得作为门禁输入 |
| **P-5** | 候选工作区规模未写（v1 28，冻结设计 ≤20） | 明确主集 ≤20（且剔除元工作区的规则预注册）；28 全量仅压力报告 |
| **P-6** | §6.2 "能力驱动 5 条" 与冻结数据模型冲突（`WorkspaceRecord` 无能力摘要、schema 无 `capabilityDigest`） | **已裁定（2026-11-17）取 ①**：改名「能力提及层」、观测项不参与门禁、不验证能力路由、不改冻结模型；已落协议 §6.2 P2 / §6.6 C1 |
| **P-7** | §6.6 V5-C7 "全量请求 tokens ≤24k" 未覆盖 layered，且 token 估算口径未定 | 改为"两模式**单请求** ≤24k（预检用 §5.2 口径，实测用 usage）"；C9 默认模式由该结论决定 |
| **P-8** | §6.6 V5-C8 校准"单调不降"在 45 点/6 桶下不可判 | C8 降为"报告项 + 桶 n≥5 时检查"；不以单桶 n<5 作门禁 |
| **P-9** | §6.6 V5-C9 无机器判定，v1 因 full 崩溃缺失 | C9 改为必判项：两种模式均跑通 + 给出默认模式结论；full 崩溃记 FAIL（输入预检未过，属实现问题） |
| **P-10** | 协议未写"重跑前必须先修 harness/输入"的程序 | 增加 V5 重跑前置：`P0 清单全过 + 复核记录`；否则结论记 BLOCKED，不得直接判 FAIL |
| **P-11** | 协议缺"案例快照冻结/审计链"（v1 被覆盖即无法复核） | 新增 §6.2A：frozen 只读副本 + manifest（sha256/round/生成器版本/seed/summaryMode）+ 哈希入证 + 违规记 INVALID；只读冻结副本复跑 |
| **P-12** | 协议缺 as-of-dispatch 输入完整性断言（答案泄漏/未来信息） | 新增 §6.2B：A1–A10 断言；报告声明 replay-at-now/as-of；obvious 层 named-cue 单列 |
| **P-13** | §6.6 V5-C1 只验 schema+分层，不验冻结与输入完整性 | C1 增补"§6.2A 冻结 + §6.2B A1–A11 全 0 违规/可复现"子条件（数值判据不变） |
| **P-14** | C2 把 obvious（点名）计入门禁，虚高 | **已裁定（2026-11-17）**：obvious 改 named-cue easy/回归层；C2 只在 non-named-cue labeled 案例算；报告并列 all / non-named-cue 两套；已落协议 §6.6 V5-C2、§6.2B A7 |
| **P-15** | should-ask 无容忍度定义 | **已裁定**：0/5 严格；泄漏即计 precision 错误且直接 FAIL；已落协议 §6.6 V5-C5 |
| **P-16** | 白名单规模敏感性无诊断口径 | **已裁定新增（非门禁）**：同批冻结案例跑「现实白名单」变体（定义写死：dispatch 前 30 天活跃且含期望工作区；>8 时按活跃会话数降序取 8 并强制保留期望工作区；期望不在白名单记 needs_confirmation、不进 Top-1 分母）；两套结果并列，门禁仍用全量候选域；已落协议 §6.2C + A11 |
| **P-17** | harness/报告缺 named-cue 与白名单拆分 | 报告头必须打印 all / non-named-cue；白名单结果标"诊断，仅作 M1 配置建议" |

> 上述修订只**明确口径与前置**，不降低 85%/70%/85%/95%/40%/3s/24k 任何数值。修订需 lead 批准，再由 architect 更新 `validation-protocol.md`（本文件不直接改协议）。

---

## 9. 审计链与案例快照冻结（v1 的新增硬缺陷）

### 9.1 事实

| 项 | 观测 |
|---|---|
| v1 案例文件 | `docs/eval/cases.real.jsonl`，16:47 生成（v1 语义：raw 任务文本 + 占位摘要） |
| 覆盖事件 | 16:52（v2 重建任务/语义摘要版）与 16:56（继续修订）两次就地覆盖；当前 sha256=`72d3416d0bc3cbb032ac4ff318491d829cc5e9f10c6b7848c656a81780d178e9`，3,081,844 bytes |
| 冻结副本 | **不存在**：`docs/eval/` 无 `frozen/` 目录、无 manifest、无 v1 副本；git 中为未跟踪文件，历史不可取 |
| v1 派生物 | `report-layered.md`（16:48）、`summary-layered.json`（16:48）、`labels.cases.md`（16:47，已于 16:52 被重写） |
| 后果 | v1 的"输入—输出"对应关系不可逐字复核；tester 审计无法从证据复算任何数字，只能相信派生物 |

### 9.2 门禁硬要求（建议写入协议，条款文本见 `validation-protocol.md` §6.2A）

1. **生成即冻结**：每轮 V5（v1、v2、v3…）生成 cases 后，立即写只读副本：
   `docs/eval/frozen/cases.<round>.<sha256前12>.jsonl` + `docs/eval/frozen/manifest.json`（记录 round、sha256、cases 数、生成器 git rev/文件哈希、seed、summaryMode、数据源 `$DSH_HOME` 路径、生成时间、分层计数）。
2. **只读复跑**：harness、复核、审计**只允许读冻结副本**；`cases.real.jsonl` 仅作"最新生成"的工作指针，不得作为任何报告/证据的输入。
3. **不可覆盖**：重生成只能新增 frozen 文件；同一轮报告产出后该副本**不可修改**；修复输入须开新一轮（v2b、v3…），并在报告中声明与上一轮的差异。
4. **哈希入证据**：每份 V5 证据与报告头部必须写 `frozen 路径 + sha256`；harness 报告头加 case 文件 hash、生成器版本、seed、summaryMode。
5. **违规处置**：输入文件哈希与报告不一致、或冻结副本缺失/被改动 → 该轮 V5 结论记 **INVALID（不可复核）**，不是 FAIL、更不是 PASS；必须重跑并先补冻结。
6. **双人链**：backend 生成并冻结 → tester 独立用冻结副本复跑 → architect/lead 只读审计；任何一方不得就地改文件。

> 本条是**程序性门禁**，不改任何数值判据（95%/40%/85%/70% 等不变）。已给出应补的协议条款（`validation-protocol.md` §6.2A 新增）。

---

## 10. as-of-dispatch 输入完整性（时间语义与标签泄漏）

### 10.1 语义前提（必须先声明，否则所有泄漏断言无意义）

- v1 采用 **replay-at-now**：`dispatchTime = 生成时刻`，快照 = 生成时刻的真实工作区/会话；任务文本 = 一条历史用户消息。
- replay-at-now 下，**生成时刻的当前状态**（会话存在性、终态标题、recentTasks、语义摘要）进入输入是**合法的**（真实派发此刻确实能看到它们）；不合法的只有三类：
  1. **期望答案被直接写进输入**（expected workspace 名/id、expected session 标题/id 出现在任务文本，或 obvious 层靠点名）；
  2. **未来信息**：目标消息**之后**发生的会话事件被用来构造任务文本（v2 重建必须只用 `time < message.time` 的上下文）；
  3. **快照与标签的时间基准混用**：用"当前状态"选候选、却用"历史归属"当期望，而未在报告声明。

### 10.2 可检查清单（v1/v2 共同适用；tester 逐条断言）

| # | 断言 | 期望 | v1/v2 实测（当前工作树） |
|---|---|---|---|
| A1 | **new 案例**：源会话必须从 `sessions` 快照剔除（否则答案在候选里） | `provenance.sourceSessionId ∉ sessions[].id` | ✅ 0 违规（当前 50/50 通过） |
| A2 | **attach 案例**：期望会话必须在 `sessions` 快照内 | `expected.sessionId ∈ sessions[].id` | ✅ 0 违规 |
| A3 | 任务文本不得含期望会话 **id**（含去 `session-` 前缀形式） | 命中数 = 0 | ✅ 0 |
| A4 | 任务文本不得含期望会话 **标题全文**；不得含标题的 ≥8 字 CJK 连续片段；不得含 oracle 字段（**可执行口径以 `validation-protocol.md` §6.2B A4 细则为准**：通用技术词如 session/markdown/jev-desktop 豁免） | 违规数 = 0（按协议可执行口径判定） | ❌ 当前 **7/25** attach 案例标题全文出现在任务文本（如 v5-07/09/10/23/24/28/29/35 一类；v2 重建把首条用户消息当上下文引用，而首条消息≈会话标题） |
| A5 | `workspaces.recentTasks` 不得列出期望会话的标题（等于把答案放在选项里） | 命中数 = 0 | ❌ 当前 **8/25** attach 案例的期望会话标题出现在其工作区 `recentTasks`（如 v5-03/04/05/10/13/28/29 一类） |
| A6 | **非 obvious 层**：任务文本不得点名期望工作区 name / 路径 basename / id | 命中数 = 0 | ✅ 0（v2 的 `sanitizeLeak` 生效；v1 规则也要求不点名） |
| A7 | **obvious 层**：允许且要求点名（构成 easy class），但必须在报告中单列为 `named-cue`，不混入总 Top-1 解释 | 12/12 点名（v1 规则）/ 报告单列 | v1 按规则 12/12；**当前 v2 文件只有 2/12 命中**（`sanitizeLeak` 把 obvious 的点名也替换了）→ v2 obvious 语义已被破坏，须二选一（见 §11） |
| A8 | 期望工作区 id 不得出现在任务文本 | 命中数 = 0 | ✅ 0（uuid 形态天然不出现，仍应断言） |
| A9 | v2 重建只可使用 `time < message.time` 的上下文（此前用户消息、此前 assistant 消息） | 代码断言 + 抽样人工核对 | ✅ 代码上 `slice(0, index)` 与 `item.time < message.time`；但 A4 显示"首条消息≈标题"仍造成泄漏 |
| A10 | `dispatchAt=now` 必须在 labels/report 显式声明；摘要生成不得读取 expected | 报告字段 `dispatchTime/summaryMode/summaryInputs` | ⚠️ labels.md 已声明；summaryMode 已进 meta；需在报告头可见 |

### 10.3 tester 可执行的断言建议

1. backend 提供 `tools/eval/audit-cases.mjs`（只读）输出 JSON：逐条 A1–A10 结果 + 汇总；存在违规时 exit code ≠ 0。
2. tester 对**冻结副本**跑该脚本，把 JSON 作为证据附件；任一违规即记"输入不合格"，该轮 V5 无效（不是 FAIL）。
3. harness 报告头必须打印：`caseSha256`、`generatorRev`、`seed`、`summaryMode`、`dispatchTime`、`violations`（来自 audit）。
4. 人工抽查：把"任务文本+期望标签+v1 raw 原文"三列放在同一证据表（v1 raw 原文从 `_provenance.rawCommand` 取，冻结副本里才有），tester 抽 8–10 条确认 A4/A6/A7 语义成立。

> 结论：A4/A5/A7 是现存真实缺陷；A4/A5 来自"标题≈首条消息 + recentTasks 列标题"的结构耦合，不是偶发。修法（backend）：任务文本与 `recentTasks`/标题做双向去重（期望会话标题从 recentTasks 移除；重建文本若引用首条消息，出现标题片段即替换为"（前情）"），obvious 层保留点名并在报告单列，或用不含点名的语义化文本重建（届时层名改"职责强相关"，不再叫 obvious）。

---

## 11. obvious 层单列（不构成工作区判别力）

### 11.1 v1 事实

- `labels.md` §3：obvious 选样 = "首条用户消息 ≥20 字，且**文本点名本工作区名称**（basename/title 的小写 token，长度≥4，排除通用词）"。
- 所以 obvious 层 12/12 工作区 Top-1 是**选样规则构造出来的**，不是模型判别力；它只能证明"任务文本含工作区名时 Jev 会选它"（这一点有用，但属于 easy class）。
- 数值影响：v1 总 C2 = 40%（18/45）；**去掉 obvious 后 = 6/33 = 18.2%**；v1 报告没有这个拆分，容易把 40% 误读为模型整体水平（同理也容易掩盖 obvious 对总分的抬升）。
- lead/tester 举例的 v5-46、v5-49 属该类：v1 文本直接点名工作区（v1 文件已被覆盖，无法逐字引用；但选样规则保证 12/12 点名，可复算）。

### 11.2 报告口径（Lead 2026-11-17 裁定采用方案 (a)）

1. **保留**点名层（v1 obvious 12 条）作为 `named-cue` easy/回归层，**不作为派发判别力**。
2. 报告头必须并列打印两套指标：`all`（全部 labeled 45）与 `non-named-cue`（去掉 named-cue 层的 33 条）。
3. **门禁 C2（工作区 Top-1 ≥85%）只在 `non-named-cue` 的 labeled 案例上计算**；`all` 仅作对照展示。C3/C4 分母仍按协议原口径（all labeled），同时报告 non-named-cue 视图。
4. named-cue 层继续作回归/烟测（点名即命中是必须行为，失败说明基础匹配坏了），但**不得把它计入 C2 门禁分子分母**，也不得当作 V5 通过证据。
5. 若 v2 继续 `sanitizeLeak` 去掉点名（当前实测仅 2/12 命中），则该层不再属于 named-cue：必须要么停止对 named-cue 层做点名清洗（回到方案 a），要么该层改判为"职责强相关"并整层转入 needs-review 人工复核（不再是 easy 层）。

### 11.3 v1 在新口径下的数字

| 口径 | 工作区 Top-1 | 模式准确率 | 目标全对 |
|---|---:|---:|---:|
| all（45 labeled，旧口径） | 18/45 = **40.0%** | 25/45 = 55.6% | 7/45 = 15.6% |
| **non-named-cue（33，门禁口径）** | **6/33 = 18.2%** | 19/33 = 57.6% | 1/33 = 3.0% |

> 即：把 easy 层从门禁剔除后，v1 的工作区 Top-1 从 40% 跌到 18.2%，与 §2 的输入缺陷判断一致（也再次说明 v1 不能归因为模型能力）。

---

## 12. 白名单敏感性诊断（Lead 2026-11-17 裁定：诊断项，非门禁）

### 12.1 定义（写死、可复现；与协议 §6.2C/A11 一致）

1. 基准 `dispatchTime`：每个案例的 `dispatchTime`（replay-at-now 下 = 快照生成时刻）。
2. `active30`：以 `dispatchTime` 回溯 30 天，窗口内存在活动的会话所属工作区集合（活动 = 会话 `lastActiveAt` 或任一 `messageTime` 落在窗口内）。
3. **现实白名单变体** = `active30` 且**必须包含该案例期望工作区**：
   - 若 `|active30| ≤ 8`：直接取 `active30`（并保证期望工作区在集合内）；
   - 若 `|active30| > 8`：按"窗口内会话数降序、同数按 workspaceId 字典序"取前 8，若期望工作区不在前 8 则用它替换第 8 个。
4. 若期望工作区 **不在** `active30`：该案例在变体中记 `needs_confirmation`，**不计入 Top-1/C4 分母**，单独计数 `whitelistExpectedMissing`。
5. 两套候选域使用**同一冻结案例文件、同一标签、同一 harness**，唯一变量是每案的 `workspaces` 快照（`whitelist` 变体只保留白名单工作区；`sessions` 快照同步只保留这些工作区的会话）。
6. 报告分别给 `all-allowed`（门禁口径）与 `whitelist`（诊断）两套 C2/C4/coverage 与 `n_whitelist` 分布（min/p50/max）；**门禁只取 `all-allowed`**，`whitelist` 标"诊断，仅作 M1 配置建议"。
7. 复现性：窗口 30 天、上限 8、排序规则、`n_whitelist` 分布写入报告头与 manifest；按 A11 抽 5 案例重跑校验集合一致。

### 12.2 为什么需要它（诊断价值，不改门禁）

- 产品现实是"用户白名单 3–8 个工作区"（PRODUCT-DESIGN §2 假设、ARCHITECTURE §5.2 ≤20），而门禁用全量允许集（v1 为 28）。全量更严，利于安全；白名单更接近真实，用于回答"M1 默认白名单该多大 / 用户不配白名单时精度会怎样"。
- 但**不得**用白名单结果替代门禁结果，也不得因为"白名单下更好看"就改门禁候选域——那就是变相调参。两套并列、口径固定、事先写死。

### 12.3 v1 状态

- v1 无白名单变体结果（未跑）；v2 起必须跑并报告两套。v1 的 28 工作区全量结果中已包含 `.dsh`/`test` 等元工作区，白名单变体预计会移除它们，但**在 v2 数据出来前不得推测数值**。

---

## 13. 裁定落地汇总（Lead 2026-11-17）

| # | 裁定 | 落到 |
|---|---|---|
| 1 | obvious/点名层 → `named-cue` easy/回归层单列；门禁 C2 只在 non-named-cue labeled 上算；报告并列 all/non-named-cue | 协议 §6.2B A7、§6.6 V5-C2；本文件 §11 |
| 2 | should-ask 自动放行容忍度 **0/5**（泄漏即 precision 错误且 FAIL） | 协议 §6.6 V5-C5；本文件 §0/§5 |
| 3 | 能力驱动层 → 「能力提及层（观测项，不参与门禁）」；不改 `WorkspaceRecord`、不加 `capabilityDigest` | 协议 §6.2 P2、§6.6 C1；本文件 §2.5 |
| 4 | 白名单敏感性（诊断非门禁） | 协议 §6.2C + §6.2B A11；本文件 §12 |
| 5 | v2 重跑前置：冻结 / audit-cases / A4 / A5 / A7（backend 实现，tester 对 frozen 副本复核） | 本文件 §7「v2 重跑前置」；协议 §6.2A/§6.2B |

**阈值不变**：C2 ≥85%（non-named-cue 口径）、C3 ≥70%、C4 ≥85%、C5 ≥95%、C6 ≥40%、p95 <3s、单请求 ≤24k；冻结/输入完整性/白名单均为程序与诊断项，不改数值。

---

## 14. 复核限制（必须写进证据）

1. 本复核**未重跑 live**（architect 不执行验证、不消费 Jev 配额）；所有结论来自 v1 落盘证据与只读代码/数据检查。
2. 未验证 Jev 服务端对 `probabilities/confidence` 的精确语义；按 `ARCHITECTURE` §5.4 与能力面板文档的口径解读（p=所选概率、confidence=分布集中度），v1 解析表现与之一致。
3. 工作树在复核期间持续演进（16:51 后出现 v2 输入修复，16:54–16:55 出现 v2 试跑报告）；本文件按 §0 的快照边界引用 v1 证据，v2 改动与试跑均不作为本复核的结论依据。
4. 行号为 16:47/16:46 版参考；v2 修改后按符号名定位。
5. v1 案例文件已被就地覆盖（§9），本文件对 v1 的输入侧判断只能依据"生成器规则 + 派生物 + 当时抽样"；obvious 层"12/12 点名"由 `labels.md` §3 选样规则推出，不依赖已被覆盖的文本。
5. 案例文本抽样仅用于说明构念问题，未在证据中复制完整正文（遵循 `labels.md` 隐私边界）。

---

## 15. 一句话交付

**v1 FAIL 不成立（需 v2 重跑）**：v1 既不能满足"FAIL（系统不达标）"的证据要求（输入/标签/指标缺陷 + **案例快照未冻结、已被覆盖、无法逐字复核**），更不能改判 PASS；v2 的最小修正集已按 P0/P1/P2 列出，核心是"语义摘要 + 自包含重建 + ≤20 候选域 + 人工复核标签 + harness 口径/压缩/崩溃修复 + 完整重跑"，任何阈值不得放宽。
