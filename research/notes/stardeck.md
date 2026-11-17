# stardeck（舰桥 / dsh-plugin-stardeck）调研笔记

> 用途：为「DSH 指挥官」插件做产品与技术参考。
> 调研对象：`/Users/lzx/Documents/GitHub/dsh-commander/research/stardeck`（v0.20.7，2026-11-12，MIT）。
> 路径约定：下文所有 `research/stardeck/...` 均相对工作区根 `/Users/lzx/Documents/GitHub/dsh-commander/`；省略前缀的 `src/...`、`tests/...`、`README.md`、`AGENTS.md`、`CHANGELOG.md`、`PRODUCT.md` 一律指 `research/stardeck/` 下的同名文件。`:行号` 为证据锚点。
> 结论一律附文件行号；凡属推断均标 **（推断）**。

---

## 0. 一页结论

1. **它不是一个 agent，而是一层"编排账本 + 宿主会话驱动器"**：宿主侧（Node 进程内）只有 append-only JSONL 账本、纯函数状态机（fold）、定时引信和 `war_*` 工具；**一行 LLM 调用都没有**（`research/stardeck/src/*.ts` 内无任何 `fetch`/`chat/completions`/apiKey）。所有智能都在三个 DSH 会话里：大副会话、外勤小队会话、外勤组员子代理（`research/stardeck/src/index.ts:1-16`）。
2. **主语是"命令"，不是"会话"**：session 只是命令的执行体；一条命令 = 一张卡 = 一段四阶段生命条（命令→任务→执行→任务回报）。这是它最有价值的产品判断（`README.md:39-50`，`PRODUCT.md:27-31`）。
3. **三层角色严格不互相越权**：舰长（人）只下命令+定夺；大副（XO）只分诊/成书/呈报/代记判定、**不执行不指挥组员**；外勤小队（away-team）是**顶层 DSH 会话**（不是子代理），在工作区里执行并可用 `war_deploy_unit` 派组员（`research/stardeck/src/persona.ts:27-51,54-83`，`AGENTS.md:60`）。
4. **验收是双层的**：`war_submit` 有硬门（证据不全直接拒收）；`KillCredit 机械全绿` 只是"自动收官"的判据，而 2026-09-01 起该自动收官**默认关闭**，一切回报强制舰长人工验收（`research/stardeck/src/flags.ts:43-63`，`CHANGELOG.md:117`）。
5. **最值得抄的三件事**：命令全生命周期读投影（含四段生命条/收件箱/悬停族系）、账本 fold + 令牌制（attemptId/subtask attempt）防并发错乱、身份门（谁能收官/谁能下令由代码判，不靠提示词）。
6. **最该避开的三个坑**：把"强制人工验收"写成提示词约束（实测无效，后补五道身份门，`CHANGELOG.md:32`）；全自动收官（机械全绿≠正确，被迫反转）；会话通道与宿主私有面硬耦合（宿主删 `apiProxy` → 全链断但 UI 探针全绿，`AGENTS.md:96`）。
7. **形态已有天花板**：作者 2026-09-01 把内核 1:1 移植成 agent 无关的独立 `stardeck`（daemon + MCP），本仓转守护态（`README.md:23`，`AGENTS.md:3`）。对我们是重要信号：**DSH 插件形态适合"读投影+会话驱动"，但要为"执行器可替换"留接口**。

---

## 1. 指挥链角色建模

### 1.1 三角色职责边界（谁做什么 / 谁不做什么）

| 角色 | 载体 | 做 | **明确不做**（有代码或提示词证据） |
|---|---|---|---|
| 舰长 Captain | 人（web 看板） | 下达自然语言命令；批准/驳回计划；升降档；答澄清；翻回报；定夺收官/打回/作废；归档战线 | 不进执行会话指挥组员；不直接改任务账（板是读投影，唯一写入例外是"挂载外部会话"，`AGENTS.md:24`） |
| 大副 XO（贴身大副） | 每命令一个 DSH 会话（`大副·<摘要>`） | 分诊档位、起草任务书（六要素+可判定验收）、呈计划/拆解待批、发布任务、消化外勤回报并呈报、代记舰长判定（war_close_task）、回推批注 | "**不直接执行任务，也不指挥外勤组员**"（`research/stardeck/src/persona.ts:31`）；"不替舰长做战略决策""不替外勤小队做战术拆解"（`persona.ts:43`） |
| 外勤小队 away-team（commander） | 每任务一个**顶层 DSH 会话**，绑任务工作区 | 领令（war_claim 拿令牌）、在工作区内全能力执行、按编制派外勤组员、汇总回报、带证据交卷（war_submit）、失败上报（war_fail） | "**你不与用户对话**"（`persona.ts:58`）；不能给自己发令牌（令牌只由 war_claim 发）；不能跨任务操作（身份门，`src/tools.ts:951-955,997-998,1029-1030`） |
| 外勤组员 troops | 外勤小队的 continuable 子代理（`startContinuable`，`src/tools.ts:184-223`） | 在自己 `front` 目录前缀内干活、回报摘要 | 不能再委派（deny `subagent/subagent_fork/send_message`，`src/units.ts:19-28`）；深度封死（maxDepth=2，`tools.ts:200`） |

补充：`maxUnits`（单任务在役组员）默认 6、`maxAttempts` 默认 2、`maxCommanders`（跨工作区并行任务）默认 3（`research/stardeck/src/config.ts:59-62`）。

### 1.2 命令（command）如何被转成任务（task）

一条命令的完整落地链（每一步都有账本事件）：

1. **下达**：`POST /warroom/api/commands`（text ≤2000 字，可选 cron / 战线名 / continuesFrom）→ 落 `directive_created`（`src/dashboard.ts:556-645`，id 形如 `cmd-YYYYMMDD-HHMMSS-8hex`，`src/directives.ts:371-375`）。
2. **引信转达**：15s `commandFuse` 扫描 `draft` 命令 → 为**该命令**开一个大副会话（`workspace.create(warRoot)` 幂等 + `sessions.create({workspaceId})` + rename）→ `directive_session_opened` 先落账，再投 `relayPromptFor()` 文本 → `directive_received`（`src/relay.ts:75-185`，重点 `142-182`）。
   - 失败只跳过自己、保持 draft 下一 tick 重投同一会话（毒命令不中断同批，`relay.ts:162-165`）。
   - 在途守卫防"立即 tick × 15s tick"双开大副会话（`relay.ts:206-219`）。
3. **分诊**：大副调 `war_triage` 报档位 L0/L1/L2（每命令只一次；舰长文本标记 `!!直接做`→L0 / `??先看方案`→L2 由宿主强制改档）（`src/tools.ts:1272-1317`，标记解析 `src/directives.ts:30-34`）。
4. **计划/拆解呈批**（L1/L2）：`war_plan` 落 `directive_plan_opened`(pending)，或 `war_decompose` 落 `directive_decomposed`+一页纸计划（`tools.ts:1319-1397`）。
5. **舰长定夺**：`POST /warroom/api/commands/plan {approve|reject}` → `directive_plan_approved|rejected` + 把结论 push 回大副会话（`src/dashboard.ts:771-809`，模板 `src/persona.ts:178-184`）。
6. **发布成任务**：大副调 `war_publish`，**必须带 `commandId`**（`tools.ts:449`；缺 commandId 会成孤儿任务，工具直接拒收）。执行顺序（`tools.ts:468-572`）：
   lint（staff-triage 旗）→ cron 可满足性校验 → deps 存在性校验 → **工作区路由前置**（bound/@new:/auto）→ 命令终态与计划硬门 → `directive_approved{taskId}` → `task_created`+`task_published`（**单次 write 原子**，`tools.ts:544-556`）→ `registerPlanet` → `war.active=true` → `conscript` 征召外勤小队。
7. **领取执行**：被征召会话读简报 → `war_claim` 把 published→in_progress 并发令牌 `attemptId`（`tools.ts:638-694`，令牌 `randomUUID()`，`tools.ts:668`）。
8. **交卷/失败**：`war_submit`（令牌匹配 + 证据校验）→ reported；或 `war_fail` → requeue（未到上限）／failed（用尽）（`tools.ts:696-800`）。
9. **收官**：大副（或 HQ）`war_close_task` 记录判定；打回/作废即终局，重做须重新立案（`tools.ts:887-923`）。

**关键设计**：命令 ↔ 任务严格 1:1（链式拆解是 1:N 但只挂链头），见 `directive_approved` 记录 `taskId`（`src/directives.ts:100`）与 `war_publish:529` 的"已批准过任务，不要重复发布"守卫。

### 1.3 状态机（四层，全部由 fold 派生）

**(a) 命令 directive**（`src/directives.ts:18,108,137-237`）

```
draft ──received──> received ──talking──> talking ──directive_approved──> approved（终态）
  │                     │                    │
  └─ cancelled（终态）   └─ plan: pending ─approved/rejected─> pending 可再呈（多轮收敛）
                                              └─ grade: triaged(首落) / regraded(舰长升降档)
archived 是叠在终态之上的第二维度（唯一允许终态后改账的事件）
```

- 终态守卫：`approved|cancelled` 之后任何事件不再改状态（`directives.ts:108,164`）。
- `pivot` 续战令特殊：引信不新开大副会话，直接把指令插进父任务**活体执行会话**队列，并**一次批量写** `received`+`approved`（`src/relay.ts:120-141`）。

**(b) 任务 campaign**（`src/types.ts:143`，fold `src/events.ts:57-300`）

```
draft ─task_published─> published ─task_claimed─> in_progress
                                        │  ├─task_submitted─> reported ─task_closed─> closed
                                        │  ├─task_attempt_failed + task_requeued─> 回 published（换令牌）
                                        │  └─task_failed（重试用尽）─> failed（人肉终态：须重新立案）
                                        └─quotaPaused = true 只做"原地暂停位"，不改 status/attempt
task_schedule_triggered(skipped=false) → 新一轮：status 回 published、rounds+1、保留历史产出
```

**(c) 尝试 attempt**（`src/types.ts:57-68`，fold `events.ts:74-81,102-117,242-247`）：`undefined(在役)` → `reported | succeeded | failed`。`closed` 判定若被 `isPassVerdict` 认可才升 `succeeded`，打回则停在 `reported`。

**(d) 队内子任务 subtask**（`src/types.ts:124-139`）：`open → in_progress → completed`；`blocked` 回池（保留 note）；`parked` 保留令牌（撤退≠吊销，`tools.ts:1037-1047`）；显式换手才吊销（`war_troop_reassign`，`tools.ts:1749-1783`）。

---

## 2. 任务看板的数据模型

### 2.1 存储布局（无数据库，全靠 append-only）

| 位置 | 内容 | 证据 |
|---|---|---|
| `<stateDir>/campaigns/<taskId>.jsonl` | 每个任务一条事件流（fold 成 CampaignState） | `src/events.ts:14-41` |
| `<stateDir>/directives.jsonl` | 命令事件流（共享单文件） | `src/directives.ts:110-130` |
| `<stateDir>/state.json` | 微小指针态（active / hqSessionId / commanderChildId / quotaBlocked），**原子写 tmp+rename** | `src/state.ts:1-49`，`src/types.ts:237-248` |
| `<stateDir>/planets.jsonl` | 注册的"星球"=真实工作区 | `src/planets.ts:1-44` |
| `<stateDir>/threads.jsonl` | 挂载的外部会话（唯一写入口之一） | `src/threads.ts`，路由 `dashboard.ts:646-673` |
| `<stateDir>/orphans.json` | 简报投递失败留下的孤儿会话（重启后复用） | `src/index.ts:79-90,140-148` |
| `<stateDir>/dossiers/<slug>.md` | 工作区履历档案（收官/失败时宿主写入，征召时注入简报） | `src/dossier.ts:1-61` |
| 事件类型全集 | 31 种 WarEvent（created/published/claimed/submitted/closed/requeued/paused/goal/wake/workspace_released…） | `src/types.ts:188-233` |

### 2.2 task（CampaignState）字段表

`src/types.ts:71-118`：

| 字段 | 说明 |
|---|---|
| `campaignId` | 任务 id（`YYYYMMDD-HHMMSS-4hex`，`src/state.ts:72-77`） |
| `title` / `intent` / `brief` / `acceptance` | 标题、任务书正文、验收标准（**都是自由文本**，acceptance 约定用「；」分隔可判定项） |
| `priority`(`normal|high`) / `quality`(common…legendary) / `deps[]` / `schedule{cron,enabled}` / `rounds` | 优先级、稀有度色档、前置任务链、日常任务令、重开轮次 |
| `workspacePath` / `workspaceKind` | 任务工作区绝对路径；绑定形态 `bound|bound-worktree|instance|auto-worktree|auto-dir`（`types.ts:90`，写侧 `tools.ts:101-113`） |
| `status` | 六态（见 1.3） |
| `claimedBy` | **当前执行会话 id**（= attempt.sessionId） |
| `publishedBy` | 发布者（大副会话 id） |
| `attempt{id,n}` / `attempts` | 当前令牌（UUID）与第几次尝试 |
| `attemptLog[]` | `{id,n,sessionId,startedAt,endedAt,outcome}` —— **看板"执行中/任务回报"两列的卡片单元**（`types.ts:54-68`，`dashboard.ts:261-271`） |
| `lastError` / `closedVerdict` | 最新败因 / 收官判词 |
| `deliverables[]` | `{kind: files|tests|diffstat|note, summary, detail, ts}` 任务产出（`types.ts:170-176`） |
| `reports[]` | `{ts, from, text, evidence}` 汇报+证据（`types.ts:107`） |
| `comments[]` / `messages[]` | 舰长批注 / 组员直讯（含 delivered 位） |
| `subtasks: Map` | 队内子任务图（`types.ts:111-139`） |
| `units: Map` | 已派组员 `{childId, unitName, label, mission, front, writes, orders[], lastReport, recalled, settled}`（`types.ts:39-52`） |
| `quotaPaused` / `workspaceReleased` | 配额熔断原地暂停 / worktree 释放投影 |

### 2.3 与 DSH session 怎么关联

1. **任务 ↔ 执行会话**：`claimedBy` = 会话 id；每次尝试在 `attemptLog` 里留一条（`sessionId` + 起止 + 结局）。`task_claimed.claimedBy` 直接来自 tool exec 的 `exec.agent.id`（`tools.ts:158-163,670`）。
2. **任务 ↔ 工作区 ↔ 会话沙箱根**：征召时先 `workspaceRegistry.create(path)` 拿 workspaceId，再 `agents.create({meta:{cwd}})` + `workspace.attachSession(sessionId)`。这样会话的 cwd / 写权限根**正好是任务工作区**（`src/index.ts:173-187,835-899`）。这是硬约束："in-process continuable 子代理继承父会话 write root，写不进任务工作区"（`AGENTS.md:60`）。
3. **命令 ↔ 大副会话**：`directive.staffSessionId`（`directives.ts:44`）；全局兜底 `state.hqSessionId`（早期"唯一大副部"形态的遗留）。
4. **组员 ↔ 会话**：`units[childId].childId` 就是子代理会话 id，靠宿主 `session/event`（`source.kind = subagent-report|subagent-settled`）自动回填 `report_received`/`unit_settled`（`src/report-capture.ts:20-37`，`index.ts:434-465`）。
5. **外部会话挂载**：`threads.jsonl` 记录 `{sessionId, note}`，只做导航，从不写会话（`dashboard.ts:646-662`）。

### 2.4 命令与任务的溯源怎么存

- **正向**：`directive_approved` 事件同时携带 `directiveId` + `taskId`（`directives.ts:100`，写入点 `tools.ts:536`）。因此"这条命令变成了哪个任务"是一条不可变账本事实。
- **反向**：任务的 `task_summary` / 板投影不含命令号；反向靠 `loadDirectives().find(d => d.taskId === taskId)`（`src/wake.ts:77-82`，`tools.ts:273-279`），以及 UI 的 `lineage` chip（`client/views.tsx:1684-1693`）。
- **调试面**：`GET /warroom/api/trace?commandId=` 一次给全：命令摘要 + 原始 directive 事件时间线 + 关联任务投影 + 该任务原始 campaign 事件 + 引信/征召视角（是否待转达、是否被 spawn-once 守卫挡住及拒因）（`src/dashboard.ts:378-425`）。
- **多代战线**：`continuesFrom` + 冻结的 `continuation.mode`（deepen/retry/pivot）+ `foldChains()` 算代际/链根/链色槽（`directives.ts:255-306,322-333`）；`pivot` 会把新命令直接挂到父任务上（`relay.ts:133-136`）。

---

## 3. 会话创建 / 复用 / 投递 / 回收

### 3.1 大副会话：一命令一会话

- 首见该命令时创建，`directive_session_opened` **先落账再投提示**，投递失败重试仍进同一会话（不会漏出第二个会话）（`relay.ts:142-174`）。
- 会话标题 `大副·<命令前 12 字>`；首个大副会话会被记成 `hqSessionId`（`relay.ts:168-173`）。
- 为什么"一命令一会话"：话题干净、失败重试幂等；代价是会话数量膨胀（见 §7）。

### 3.2 外勤小队会话：按任务新建（征召制），不是复用

`createConscriptor`（`src/index.ts:106-425`）的征召闸门依次是：

1. 任务必须 `published`（`index.ts:162`）
2. 会话通道已绑定（`relay`/`workspaceApi` 存在，`163`）
3. **spawn-once 守卫**：同任务只允许一个待命外勤小队（lazy prune：任务离开 published 即释放，`164-168`）
4. 工作区空闲（`workspaceConflict`，同区任务排队，`169-170`）
5. 全局在役上限 `maxCommanders`（`171-172`）
6. **孤儿复用**：上一轮"会话建好但简报投递失败"的会话直接从 `orphans.json` 续用（`175-187`）
7. 建会话 → rename `外勤·<任务前 14 字>` → 组装征召令 `commanderOrderFor()`（含条令+简报+履历+战线前情，`216-226`）→ `relay.prompt(mode:'queue')` 投递（`227`）；失败则记孤儿待复用并如实回执（`228-232`）

**新会话 vs 已有会话的判断**：
- 绝大多数情况**新建**（一条命令一个新任务一个新执行会话），这是它的核心取舍——干净、可隔离、可并发。
- 复用只发生在三种场景：① 孤儿会话重投（`index.ts:175-187`）；② 失败重派时 requeue 后重新征召（`tools.ts:771-786`，先 `releaseSpawned` 再征召，否则死锁）；③ `pivot` 续战令直插**活体执行会话**队列，不新建（`relay.ts:120-141`）。
- `deepen/retry` 续接**不**复用执行会话：它们是新一代任务+新会话，靠**链档案注入**传递前情（`buildCommanderChainBrief` cap 600 字，`src/chain-note.ts`，`index.ts:196-215`）。

### 3.3 怎么把"任务令"送进会话

- 通道：`sessions.prompt({mode:'queue'})` → 适配器落到宿主 `agent.followup()`（持久 next-turn 收件箱，重启重放，`index.ts:870-879`）。
- 文本资产全部在宿主侧单一源 `src/prompts.ts`：`relayPromptFor`（给大副的命令转达+分诊纪律+起草法全文内嵌，`prompts.ts:31-70`）、`commanderOrderFor`（外勤征召令，`144-164`）、`rescueNudgeFor`/`staffRescueNudgeFor`（续行提示，`104-112`）、`chainArchiveSection`（战线档案，`96-98`）。
- 为什么要"内嵌起草法"：`apiProxy` 形态的大副会话**看不到**编程注册的 skill，只能把 `bountyDraftingSkillContent()` 全文拼进提示词（`prompts.ts:50-53,68-69`，`src/skill.ts:20-66`）。这是一条很实际的教训（见 §7）。

### 3.4 怎么回收会话产出

三条独立通道，互相兜底：

1. **结构化交卷（主路）**：`war_submit` 落 `task_submitted{report, evidence, deliverables}`；证据经 `parseEvidence` 严格校验，产出列表缺失时从证据自动派生（`tools.ts:718-726,1859-1890`）。
2. **组员回报自动记账（宿主事件路）**：监听 `session/event`，从 `source.kind = subagent-report|subagent-settled` + 文本里的 `Background subagent <id>` 解析出 childId，写 `report_received` / `unit_settled`（`src/report-capture.ts:17-37`，`index.ts:434-465`）。注意载荷在 `.data` 下（上游形状），旧实现读顶层字段曾"静默全灭"（`report-capture.ts:4-8`）。
3. **会话活动流（读投影路）**：`session/event` → `ActivityTracker` 内存滚动表 → 板投影给 live attempt 附 `activity.verb`（思考中/探索中/编辑中/运行命令），SSE 只推 revision 变化（`src/activity.ts:1-60`，`index.ts:693-701`，`dashboard.ts:119-156,261-271`）。

### 3.5 定时器与自愈（"AFK 也能跑"的骨架）

| 周期 | 职责 | 证据 |
|---|---|---|
| 15s | 命令引信：draft 命令转达大副 | `relay.ts:226-231` |
| 30s | 日常任务令到期触发 + 定时命令补 dispatched | `index.ts:725-742` |
| 30s | 队内调度兜底（`kickIdleTroops`） | `index.ts:600-612` |
| 60s | goal 补武装（领取时武装失败的补偿） | `index.ts:627-635` |
| 90s | 征召巡检：死会话 rescue（`agents.resume`）、published 任务补征、拒因去抖日志 | `index.ts:283-423,717-719` |
| 90s | 大副唤醒补推（reported/failed 未醒的） | `index.ts:616-622`，`src/wake.ts:139-156` |

自愈策略要点：死会话 resume **连败 2 次才判死回栏**（防持久层瞬时打嗝烧 attempt），**连败 8 次进隔离集**不再重试（防历史 541 连败刷日志），`quotaPaused` 任务豁免（`index.ts:289-352`）。

---

## 4. 分诊 / 拆解 / 计划呈批 / 人工验收

### 4.1 分诊（triage）

- 动词：`war_triage(commandId, grade=L0|L1|L2, reason, confidence)`（`tools.ts:1272-1317`）。
- L0=轻任务书直发（无需批准）；L1=先呈计划后发布；L2=先澄清再收敛。
- **舰长文本标记优先且宿主强制**：命令正文含 `!!直接做` → L0，含 `??先看方案` → L2；被改档时"建议"与"生效"都入账（`directives.ts:30-34`，`tools.ts:1293-1302`）。设计意图注释写得很直白："不信任模型自觉"。
- 每命令只分诊一次，之后再调直接报错；升降档走舰长 UI 路由 `POST /commands/regrade`（`tools.ts:1291`，`dashboard.ts:735-769`）。
- L2 会给大副开一个**永远 disarm 的 goal**（`tools.ts:1303-1310`）——"大副 goal 永远 disarm，round driver 不驱动大副"是硬红线。

### 4.2 拆解（decompose）

- `war_decompose`：一页纸总计划 + **≥2 个子任务书**，逐个过 `lintPublish`；落 `directive_decomposed`（机器可读）+ `directive_plan_opened`（人读，**复用计划卡，舰长侧零新增 UI**）（`tools.ts:1344-1397`）。
- `war_publish_chain`：硬门 = 拆解在场 + 计划已批；落 N 个任务，`task i` 的 `deps=[task i-1]`，**全链共用一个工作区**，命令卡只挂链头；只为链头征召，后续环由"收官接力"自动续（`tools.ts:1399-1495`，接力见 `closeTaskInternal:342-355`）。
- 一个细节坑：原本 `bound` 分支在循环里引用了块内 `const abs`，导致"绑定既有工作区成链"100% 抛 `ReferenceError`，潜伏到审计才修（`CHANGELOG.md:22`，`tools.ts:1449-1472`）。

### 4.3 计划呈批（plan approval）

- 呈：`war_plan` 只校验长度 ≥10 字，落 `plan.pending`（`tools.ts:1319-1342`）。
- 批/驳：`POST /warroom/api/commands/plan`，要求当前必须是 `pending`（防重放），approve/reject 各落一条事件，随后 **push 回大副会话**（"批准了，去 war_publish"／"驳回了，按意见改"）（`dashboard.ts:771-809`，`persona.ts:178-184`）。
- 硬门：发布时若命令档位是 L1/L2 且 `plan.status !== 'approved'`，`war_publish` 直接抛错（`tools.ts:531-535`）。这是"呈批"真正有约束力的地方——不是提示词，是代码。
- 计划态 fold 支持"多轮收敛"：`opened` 覆盖待批稿；`approved/rejected` 只对 pending 生效；被驳后重呈回到 pending（`directives.ts:199-218`）；驳回理由进 fold（`CHANGELOG.md:19-21`）。

### 4.4 人工验收（强制）

- 政策：`staff-auto-close` 移出默认开清单 → 即使 KillCredit 机械全绿也**不自动收官**，任务停在 `reported` 等舰长（`flags.ts:43-63`，`CHANGELOG.md:117`）。
- 唤醒：`war_submit` 非自动收官时 `wakeStaff(taskId,'reported',…)`，分级推 + 30s 去抖 + 90s 巡检补推，唤醒文本带板摘要防重复立案（`tools.ts:741`，`src/wake.ts:56-67`）。
- 定夺：
  - 大副代记：`war_close_task`。**身份门**：只有"该任务所属命令绑定的大副会话"或 HQ 会话能记录判定；并且 **"通过"类判词只能记在 `reported` 状态**（防止对 in_progress 任务直接"通过"）（`tools.ts:903-918`）。
  - 播种收官：`POST /warroom/api/tasks/close`，只接受 `reported|failed`，走与 `war_close_task` 同一条 `closeTaskInternal`（含 dossier、goal 结算、同区接力征召）（`dashboard.ts:811-846`，`tools.ts:327-356`）。
- 判词语义化：`isPassVerdict()` 用"词头+句读边界"识别通过/合格/验收合格等，**明确不认**"未通过/不通过/通过性"（`events.ts:43-50`）；这是从一个真实误判（`includes('通过')` 把"打回：验收未通过"记成胜局）改出来的（`CHANGELOG.md:32`）。

### 4.5 LLM 调用在哪一层 / prompt 在哪

**答案：全部在宿主侧的 DSH 会话里，插件本身不调 LLM。**

- 插件（Host 侧）只做：账本读写、fold、工具注册、定时器、会话创建/投递、HTTP/SSE 路由（`src/index.ts:475-1095`）。
- 实际"思考"发生在：① 大副会话（DSH agent）调用 `war_triage/war_plan/war_publish`；② 外勤小队会话调用 `war_claim/war_deploy_unit/war_submit`；③ 组员子代理干活。三者都是 DSH 自己的 agent loop。
- **Client 侧只读**：前端只有 `data.ts` 的 fetch/SSE 与少量写路由调用（下达命令、答澄清、批计划、改档、归档、挂载），没有任何模型调用，也不提供"改任务账"的写操作（`AGENTS.md:24`，`src/client/data.ts:149-260`）。
- Prompt 组装点（全在 `src/`）：
  | 资产 | 位置 | 谁消费 |
  |---|---|---|
  | 大副条令（身份+纪律+语气） | `persona.ts:27-51`，经 `systemPrompt.section()` 全局注入（`index.ts:685-689`） | 所有会话（旗开时） |
  | 命令转达+分诊纪律+起草法全文 | `prompts.ts:31-70` | 大副会话（引信投递） |
  | 起草法（技能体） | `skill.ts:20-66` | 编程注册 skill + 内嵌提示词双通道 |
  | 外勤条令+任务简报+履历+战线前情 | `persona.ts:54-99` + `prompts.ts:144-164` | 外勤小队会话（征召投递） |
  | 组员条令/回报纪律/直讯/调度纪律 | `persona.ts:102-150` + `units.ts:35-118` | 组员子代理（persona 字段） |
  | 唤醒/续行/判定回推 | `wake.ts:56-67`，`prompts.ts:104-112`，`persona.ts:178-184` | 大副会话 |
- **提示词有快照门**：`tests/prompts-snapshot.test.ts` + `tests/prompts-snapshots/`，改任何措辞必须显式更新快照，且"出口协议段（令牌/证据/失败语义）"被点名断言不可裁剪（`prompts.ts:1-13`）。

---

## 5. KillCredit 机械复核 & 验收标准建模

### 5.1 两层判据（容易被误读成一层）

| 层 | 函数 | 何时生效 | 判据 |
|---|---|---|---|
| ① 交卷硬门 | `parseEvidence`（`tools.ts:1799-1854`） | **每次** `war_submit` 都跑 | `checks` 非空且逐项格式合法；**任一项 passed=false 直接拒收**；`tests.exit_code` 必须 0；`tests.failed` 必须 0；证据走 **JSON 字符串**通道（dsh 会丢 `type:'json'` 参数） |
| ② 自动收官判据 | `killCreditAllGreen`（`tools.ts:301-323`） | 仅 `staff-auto-close` 旗开时 | 在①之上再加：`tests` 必须存在；`failed===0` 一票否决（防"退出码 0 但 3 项失败"）；`files[]` 必须全在任务工作区内（**越界一票否决**，相对路径先锚定 workspace 再判） |

`killCreditAllGreen` 的 `why` 会写进收官判词（"自动收官：KillCredit 机械全绿（…）"），可审计（`tools.ts:735`）。

### 5.2 为什么强制人工验收

- 直接原因：政策令 2026-09-01"所有回报强制人工验收"，`staff-auto-close` 默认 OFF，机制保留为 opt-in 供 e2e 考题使用（`flags.ts:48-52`，`CHANGELOG.md:117`，`cordis.smoke.yml:16-19`）。
- 深层原因（可从证据推出的）：机械全绿只能证明"外勤自己声明的那几项过了"，不能证明"任务书要的东西做对了"。作者在 2026-09-23 审计里又补了两刀，恰恰说明这点：
  - `KillCredit 不否决 tests.failed>0` → 曾被 `exit_code:0` 蒙过（`CHANGELOG.md:32`）；
  - **"强制人工验收此前只靠提示词维持"** → 任意 agent 都能调 `war_close_task` 对 in_progress 任务记"通过"、伪造舰长批注，于是补了五道身份/状态门（同条，`tools.ts:903-918`）。
- 也就是说：**"人工验收"必须由"状态门（只有 reported 才能通过）+ 身份门（只有主公会话能记判定）+ 默认关自动收官"三者共同保证**，光写提示词不算。

### 5.3 验收标准（acceptance criteria）怎么建模

- **存储形态：一个自由文本字段**（`task_created.acceptance`，`types.ts:189`），不是结构化数组。
- **形态约束**：`lintPublish` 要求标题 ≥4 字、brief ≥10 字、acceptance ≥10 字，且必须是"可核对的列举"（含换行/`；`/`、`）或 ≥30 字的明确完成定义，否则拒发（`tools.ts:381-393`；调用点 `war_publish:471-475`、拆解逐项 `war_decompose:1386-1389`）。
- **向证据的映射靠提示词纪律，不靠代码**：起草法要求"acceptance 一律用「；」分隔检查项（外勤小队会逐项变成 `evidence.checks`）"（`skill.ts:64`），外勤条令要求"checks 逐项核对验收标准且全部 passed"（`persona.ts:67`）。
- **没有的**（对我们重要）：系统不会校验 `checks[].item` 是否真的覆盖了 acceptance 的每一项，也不校验条数是否匹配。所以"漏项"在机械层是**不可见**的，只能靠人看。这是它验收模型最大的缺口 **（推断，基于 `parseEvidence` 只校验 shapes 与 passed）**。
- 另外 `deliverables` 若不填，会从 evidence 自动派生三条（tests/diffstat/files），保证卡片上"交付了什么"不为空（`tools.ts:1859-1890`）。

---

## 6. UI 结构（值得借鉴的部分）

### 6.1 看板分区（自上而下）

```
┌ 灵动岛（顶部胶囊：收件箱计数 / 到访摘要 / 聚焦 / 下达 / 挂载 / 设置 / 皮肤）
├ 三列局势墙 .war-ops
│   ├ 任务列     = 命令"成形卡"（plan/talking/drafting ghost）+ 任务书卡（含终局调暗）
│   ├ 执行中列   = **会话卡**（每个 live attempt 一张，常驻不随页签切片）+ 可选 3D 星域/2D 雷达
│   └ 任务回报列 = **会话卡**（reported/failed/succeeded 的尝试，纯时间序，成功失败合列）
└ 命令调度条 .war-dispatch（全宽横滚：所有命令卡，活跃优先+新→旧，每卡四段生命条）
   └ 点任一卡 → 聚焦页（一条命令的四段故事线：命令→任务→执行→任务回报）
```

证据：`src/client/views.tsx:3266-3308`（三列+Zone）、`3355-3384`（调度条）、`2207-2290`（DispatchStrip）、`1959-2115`（WarIsland）、`1063-1591`（FocusPage）。

### 6.2 卡片信息层级

| 卡 | 一行 | 二行 | 三行（解释行） |
|---|---|---|---|
| 命令卡 CommandCard | 命令正文/战线名 + 状态 chip | 四段生命条（命令/任务/执行/任务回报）+ **状态行一句话** | 世代 pip / 链色 |
| 任务卡 TaskCard | 状态点+状态 chip + 溯源 chip `↩ cmd-xxx` + 星球 chip + 标题 | 第 N 次尝试 + 相对时间 | **等待解释行**（排队第几/等领令/配额暂停）或**败因行** |
| 会话卡 SessionCard | 结果 chip（在役/已交稿/失败/成功）+ 第 N 次 + 时间 | 任务标题 | **实时活动行**（呼吸点+动词）/「你 N 前亲自入会」/败因/待翻阅 |

证据：`views.tsx:478-593`（CommandCard）、`1666-1725`（TaskCard）、`1743-1789`（SessionCard）、`1727-1739`（EvidenceBlock）。

值得注意的两条纪律：
- **卡片保守瘦身**：品质/高优先/deps/cron/工作区/任务书/产出全部挪进聚焦页浮层，卡上只留"标记+状态+溯源+标题+解释行"（`views.tsx:1701-1702`）。
- **卡面只做导航**：V20 起所有"账面变更类按钮"从卡面撤走，动作只住在能读到上下文的聚焦页定夺点（`CHANGELOG.md:76`）。中间经历了一次"加钮→撤钮"的摇摆（`CHANGELOG.md:53,56`）。

### 6.3 不进会话也能看到进度（这是它的核心价值）

| 手段 | 数据来源 | 证据 |
|---|---|---|
| 四段生命条（已完成绿/当前蓝呼吸/未到灰；失败红收尾） | 客户端纯函数 `lifecycleOf()` 从命令+任务链推导 | `views.tsx:242-320` |
| "已阅"语义：回报卡看过才转全绿 | localStorage `warroom-report-seen` 与最近结算时间比较 | `views.tsx:200-220,274-277` |
| 实时活动动词 | 宿主 `session/event` → ActivityTracker → 板投影 `activity` | `src/activity.ts:1-60` |
| "为什么还没动" | 板投影加料 `queueAhead`（同区排队位次）+ `quotaPaused` | `src/dashboard.ts:253-256`，`src/client/waithint.ts:13-21` |
| 收件箱（等你定夺） | 纯客户端聚合四类：答澄清(talking)/批计划(pending)/翻回报(reported)/决重试(failed)，等最久的排最前，30min warn / 2h err，err 档还要挑"最老一条"领跑 | `src/client/inbox.ts:12-16,30-34,52-72,77-80` |
| 到访摘要（你离开时变了什么） | last-seen 快照 delta | `views.tsx:1930-1958`（VisitBanner），`src/client/visit.ts` |
| 悬停族系高亮 | 一条战线的命令/任务/执行/回报卡一起亮，其余压暗（零 SVG 几何的早期方案，后期 V17 才加管网） | `views.tsx:154-173`（CardTrace），`DESIGN.md:663` |
| 链色/世代 pip | 服务端 `foldChains` 算好 `hueSlot/generation`，前端不复算 | `directives.ts:299-306`，`views.tsx:413-477` |

### 6.4 值得借鉴的交互（按性价比排序）

1. **收件箱 + 老化**：不问"进展如何"，只列"现在需要你做什么"，并按等待时长染色。AFK 产品最该抄的第一件。
2. **命令调度条作为唯一入口**：所有卡片点击都路由到"这条命令的聚焦页"，心智模型是"一个命令卡的多种形态"，而不是"四列各管各的"（`DESIGN.md:103`）。
3. **决策带置顶**：聚焦页顶部常驻"等你定夺"，批准/驳回各带一句后果说明（`views.tsx:1063+`，`DESIGN.md:156`）。
4. **板上直接作答**：talking 卡下行内输入框，Ctrl+Enter 送达大副会话（走持久队列，不抢宿主提问卡），使"答澄清"不必跳会话（`views.tsx:1592-1632`，`dashboard.ts:691-733`）。
5. **打回/重试 = 播种而非下令**：点"打回重做"只是预填起草器文本+预选续接，舰长过目改完提交才入账（`CHANGELOG.md:53`）。这个"备书不下令"的分寸值得抄。
6. **批量定夺**：收件箱 plan 行加复选框，批量批/驳仍逐条走既有 API（`CHANGELOG.md:65`）。
7. **SSE 只推 revision 指纹**，客户端收到才拉全量投影（`dashboard.ts:109-156,962-995`）。省流量且天然幂等。

---

## 7. 踩过的坑 / 局限（按"值得引以为戒"排序）

### 7.1 治理类（最贵的三课）

1. **"强制人工验收"写成提示词 = 没有**。审计发现任意 agent 可越权收官/伪造舰长批注，事后补五道身份+状态门；原话："强制人工验收此前只靠提示词维持"（`CHANGELOG.md:32`）。→ 对我们：**权限必须在工具 handler 里判，不在 prompt 里求**。
2. **全自动收官被推翻**。V5 曾以"KillCredit 全绿自动收官"为卖点，2026-09-01 舰长令改为默认关（`flags.ts:43-63`，`CHANGELOG.md:117`）。→ 机械可验证≠任务达成，自动收尾是高风险默认。
3. **判词用子串匹配**。`includes('通过')` 把"打回：验收未通过"折成 `succeeded`，双路独立发现才修（`CHANGELOG.md:32`，`events.ts:43-50`）。→ 语义判词必须结构化（枚举/词头+边界），不要字符串包含。

### 7.2 并发与生命周期

4. **spawn-once 守卫 + requeue = 重派死锁**：任务回 published 后守卫不释放，重派被静默吞掉且回执虚报"已派遣"（`CHANGELOG.md:32`，修复 `tools.ts:771-786`，`index.ts:265-267`）。→ 任何"一次性守卫"都必须和状态机迁移点成对写。
5. **收尾接力/巡检/发布三处都要触发征召**，少一处就有"任务永远没人领"的静默空洞（`tools.ts:342-355`，`index.ts:399-419`）。
6. **同工作区串行是吞吐上限**：互斥单位是 workspace，同区任务排队（`rules.ts:149-158,190-212`）。同 repo 想并行只能靠 `@new:` 副本 / auto worktree。
7. **孤儿会话必须落盘**：会话建好但简报投递失败 → 重启后变永久垃圾；后来加 `orphans.json` 复用（`index.ts:136-148`）。
8. **死会话 rescue 要退避**：曾有同一会话 resume 连败 541 次、90s 一轮永久重试（`index.ts:149-156,330-334`）。→ 重试必须有连败上限 + 隔离集。

### 7.3 与宿主耦合（对我们最关键）

9. **会话通道一旦变化，全链静默断**：宿主 master 删除 `apiProxy` 整包 → `ctx.inject(['apiProxy'])` 永不触发 → 命令永远卡 `draft`（POST 200 入账但无人征召），**而板 UI 探针全绿**（读投影+种子数据不经过会话通道）。原话："UI 探针绿≠适配，真实命令链才是写通道判据"（`AGENTS.md:96`，`CHANGELOG.md:52`）。→ 我们必须有"写通道端到端探针"，并把会话面收敛成**单一适配器**（他们后来正是这么做的，`index.ts:779-937`）。
10. **执行者必须是顶层会话**，不能是被征召者的子代理——子代理继承父会话 write root，写不进任务工作区（`AGENTS.md:60`，`index.ts:92-105`）。
11. **`maxDepth` 是子代自身 depth**，压到 1 会封死外勤派兵（`AGENTS.md:61`）。
12. **工具名漂移让权限剥夺 fail-open**：`toolFilter.deny` 里的名字宿主不认识时整条被裁掉，只读员变全权（`tools.ts:205-222`，`CHANGELOG.md:32` 的 loud warn 修复）。→ 权限最好用 allowlist 或运行时校验，而不是 deny 名单。
13. **cordis 生命周期细节**：`ctx.effect` 是 setup-returns-cleanup（单箭头会立刻执行清理杀掉自己的 interval）；`/war` 经 `prompt` 不会被当斜杠命令拦截，激活必须在代码里翻 store（`AGENTS.md:62-63`，`index.ts:753-778`）。

### 7.4 产品与形态

14. **每命令一会话 → 会话膨胀**：命令越多，宿主侧栏越多"大副·xxx""外勤·xxx"。它用归档（`archiveSession` 扇出）+ 三页签收敛，但成本真实存在（`dashboard.ts:848-936`，`CHANGELOG.md:52`）。
15. **上下文连续性靠"摘要接力"而非真记忆**：跨代只注入 cap 600/1500/400 字的链档案（`chain-note.ts:1-12`）。任务复杂度一上来，信息必然损失。
16. **三档分诊在"无对话"形态下站不住**：作者把内核移植成独立 stardeck 后，v0.2.3 直接**退役 L2、改两档**，理由是无头大副无法对话；本仓保留三档是因插件形态有持久会话（`AGENTS.md:3`）。→ 分诊档位数应与"能否对话"绑定，不能照抄。
17. **UI 反复摇摆**：卡面加处理钮（V19.7）→ 全撤（V20）→ 又把"打回/重试"塞回聚焦页（V19.7.2）。教训是：**动作入口要一次定在"能读到上下文的地方"**（`CHANGELOG.md:53,56,76`）。
18. **性能天花板在线性投影**：500 命令 = board API 197-210ms / 727KB，冷挂载 2.8-3.6s，页签 141-226ms（20 命令时 12ms/513ms）（`CHANGELOG.md:66`）。JSONL + 全量 fold + 全量投影，在"三个月量级"可用，再大就必须分页/增量。
19. **反参考（作者自己写的）**：拒绝角色扮演感（词表降温、头衔只作指代）、拒绝 SaaS 模板脸（hero 大数字卡/渐变字/玻璃拟态）、拒绝"工具就该黑"的深色终端风（跟随宿主明暗主题）（`PRODUCT.md:19-23`）。这三条对我们的「指挥官」UI 直接可用。
20. **板是只读投影**：唯一例外是"挂载外部会话"。好处是零写竞态；代价是"想在板上直接改任务书/改优先级"做不到，只能回命令或改账本（`AGENTS.md:24`，`PRODUCT.md:28`）。
21. **中文军事词表 + 皮肤派生的工程债**：词表是运行时派生（bundle 里只有军事源串），静态断言不能断 trek 字面量；词表顺序敏感（"作战日志"必须排在"作战→执行"之前）；函数字段（计数模板）纯字符串遍历会漏派生（`AGENTS.md:9`）。→ 我们要做"舰队语气"就必须一开始就把词表做成**纯数据 + 单点派生**，并给派生写机检。

### 7.5 明确的"还不知道/没做"

- `tests/` 无 governance 命名的测试；治理是靠 `tests/tools.test.ts:280-386`（B3 身份门）+ `dashboard-routes.test.ts`（路由闸）分散覆盖的。
- 验收项与 evidence.checks 的**覆盖度**没有机检（见 5.3）。
- 板无"人工改任务状态"的合法通道（除播种收官）；出问题时作者的做法是"改账本做手术"，他自己在 V15.1 里把这条记为事故（`AGENTS.md` 首段 V15.1 条目：第一轮考题"参谋真的去改账本被元首叫停"，于是把工作区路由前置成零写入）。

---

## 8. 对「DSH 指挥官」的直接取舍建议

**必抄**
1. 命令为第一公民 + 四段生命条 + 聚焦页：这是它全部产品价值的来源（`PRODUCT.md:27`）。
2. 账本 + fold + 令牌制：`attemptId` 防陈旧提交、子任务令牌防所有权漂移；append-only 让崩溃可恢复、可复盘。
3. 收件箱 + 老化 + 到访摘要：AFK 场景的最小可用"人机接口"。
4. 权限三层落地法：**状态门**（只有 reported 能通过）→ **身份门**（只有主公会话能定夺）→ **默认关的自动化**。
5. 单一提示词资产源 + 快照门（`prompts.ts` + `tests/prompts-snapshot.test.ts`）。

**必避**
1. 不要用提示词保证纪律；不要用 deny 名单做权限；不要用字符串包含判语义。
2. 不要把执行者做成子代理（写权限根继承会毁掉隔离）。
3. 不要默认自动收官；不要默认"机械全绿=完成"。
4. 会话通道必须有适配器层 + 端到端写通道探针（UI 探针不算）。
5. 不要每命令开一个会话就完事——先想清楚会话膨胀与归档策略。

**可以做得更好**
1. 把 `acceptance` 从自由文本升级为**结构化验收项数组**（id/text/verify 方式），`evidence.checks` 按 id 回填，系统才能查"漏项"——这是它 5.3 的缺口。
2. 把"人审"做成**一等动作**（通过/打回/要求补证 三态 + 理由 + 一键续战），而不是让大副代记一句话判词。
3. 会话/工作区映射做成显式配置（哪个任务用哪个 workspace、是否 worktree），而不是靠路径前缀 + 启发式（`workspaceKind` 的 5 种形态 + 客户端 `isSyntheticWs` 启发式说明这块很脆）。

---

## 附录 A：关键文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `research/stardeck/src/index.ts` | 1129 | 插件装配、征召器（含孤儿/救援/巡检）、事件监听、定时器、宿主面适配器 |
| `research/stardeck/src/tools.ts` | 1914 | 全部 `war_*` 工具 + KillCredit + 发布 lint + 队内调度 |
| `research/stardeck/src/dashboard.ts` | 1034 | HTTP/SSE 路由、板投影、trace、文件守卫 |
| `research/stardeck/src/events.ts` | 310 | 战役事件 fold（任务/尝试/组员）+ 判词识别 |
| `research/stardeck/src/directives.ts` | 375 | 命令事件 fold、档位、计划态、拆解、战线链 |
| `research/stardeck/src/rules.ts` | 248 | 前沿/工作区互斥、征召计划、领取门 |
| `research/stardeck/src/types.ts` | 259 | 领域类型 + 31 种事件 |
| `research/stardeck/src/relay.ts` | 241 | 命令引信（一命令一会话） |
| `research/stardeck/src/prompts.ts` / `persona.ts` / `skill.ts` | 165/184/76 | 宿主侧提示词单一资产源 |
| `research/stardeck/src/client/views.tsx` | 3511 | 看板全部 UI（三列/调度条/聚焦页/灵动岛） |
| `research/stardeck/src/client/inbox.ts` | 93 | 收件箱聚合 + 老化 |
| `research/stardeck/src/client/data.ts` | ~372 | 客户端板模型（BoardCommand/Task/Attempt） |

## 附录 B：工具面按旗装配（`tools.ts:1531-1543`）

| 默认 | 工具 |
|---|---|
| 恒开 | `war_publish` `war_board` `war_claim` `war_submit` `war_fail` `war_abandon_command` `war_conscript` `war_comment` `war_close_task` `war_deploy_unit` `war_orders` `war_recall` `war_status` `war_log_report` |
| `troop-mailbox` | `war_message` |
| `troop-scheduler` | `war_troop_task` `war_troop_claim` `war_troop_update` |
| `troop-park` | `war_troop_reassign` |
| `staff-triage` | `war_triage`（+ publish lint） |
| `staff-plan` | `war_plan`（+ 发布硬门） |
| `staff-goal` | `war_set_goal`（+ 领取武装/收官结算） |
| `staff-decompose` | `war_decompose` `war_publish_chain` |
| `staff-auto-close` | **默认 OFF**（开则机械全绿自动收官） |
| `staff-wake` / `quota-recovery` / `troop-llm-routing` | 非工具面（唤醒/熔断/组员 LLM 路由） |

旗政策：开发期默认全开，`WARROOM_FEATURES=!name` 显式关，`extraFeatures` 装配层附加开（`flags.ts:43-82`）。
