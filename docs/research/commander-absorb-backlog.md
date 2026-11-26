# dsh-commander 可吸收优化清单（基于 DSH-projects 对比报告）

> 性质：**评估与建议**，不是实现契约。本轮不改代码、不改插件配置、不安装 DSH-projects。
> 输入：上一轮对比报告 `/Users/lzx/Documents/research/dsh-projects-vs-commander/findings.md`（2026-11-24）+ 本机 commander working tree。
> 基线：`master` @ `4ae9865` **加上未提交的 board-redesign 改动**（`git status --short` 见 §8）。行号以 2026-11-24 的 working tree 为准。
> 标注：【Fact】= 源码/文档直接可证；【Inference】= 由证据推断；【Unverified】= 未验证。
> 方法：MoSCoW（必做 / 可选 / 不建议）+ P0–P2 优先级；每条给「改什么 / 为什么 / 成本 / 风险 / 验收」。

---

## 0. 结论先行

1. **报告的核心判断成立，但吸收路径要改写。** 报告 §7.3 的结论是「缺 project 作为上下文、会话归属、看板分组、策略边界的持久容器」；本机硬约束是「**不新增表/事件类型**」（`docs/HANDOVER.md` §7.2 第 2 条）。所以不能按报告 §7.2 直接加第 8 张 `projects` 表；**报告 §7.1 的 5 个缺口里，#1（上下文继承）与 #3（看板/查询分组）能在现有 7 表内零 schema 变更补上**，#2（会话归属）只能做「风险显式化」，#4（策略边界）与 #5（项目级生命周期）留到契约解冻。【Fact + Inference】
2. **必做 4 条，零表变更、单条 ≤0.5 人日**：brief 注入工作区说明、brief 注入用户原话、`commander_task_list` 加工作区过滤（Host 先行、UI 后接）、`commander_task_get` 补齐上下文包；其中 3 条纯 Host、可立即开工。【Inference，成本估算】
3. **报告 §6.2 的「6 个不该搬项」全部采纳**，并补两条：**验收即 git 落地**（报告 §6.1#5 列为可借鉴，本案判不做）与**当前冻结期新增 projects 表**（报告 §7.2#1）。【Inference】
4. **报告有一处事实需要修正**：§4.2 把 `modelSuggestion` 当作「模型建议」；本机实现写入的是 `workspaceId/mode` 字符串（`src/host/dispatch/service.ts:314`），且 `TaskRecord` 无模型字段、`spawnDispatch` 不传任何模型参数（`src/host/dispatch/spawn.ts:61-84`）。所以「任务级模型覆盖」不是「续派钉不住模型」，而是**完全不存在**；这影响 C1 的成本判断。【Fact】
5. **与在改的 board-redesign 有 3 处文件重叠**（M3 的 UI 部分、S1、S2），实施顺序必须排在看板改版合入之后；Host 侧 4 条必做项不冲突，可立即做。【Fact】

---

## 1. 输入口径与节号对照

任务描述里的「第 8 节八维差异表 / 薄 project 最小方案 / 6 个不该搬项」，在报告中的实际位置如下（报告 §8 是「证据索引」，不是八维表；据此对齐，避免后续引用错节）：

| 任务里的说法 | 报告实际节 | 内容 |
|---|---|---|
| 八维差异表 | **§4.0**（逐维展开 §4.1–§4.7） | 8 个维度：实体粒度 / 归属 / 状态机 / 派发路径 / session 绑定 / 验收 / 依赖并发 / UI |
| 薄 project 最小方案 | **§7.2**（缺口在 §7.1） | 6 条：projects 表、projectId、brief 注入、sessions.projectId、UI 分组、不做清单 |
| 6 个不该搬项 | **§6.2**（正好 6 条） | 事件溯源、自治派发、取消 dependsOn、执行者自置 done、per-project store+mira、三列看板 |
| （附带）7 个可借鉴点 | §6.1 | 上下文边界、上下文包字段、派生状态词、终态+后续任务、验收落地、待你决定聚合、任务级执行者/模型 |

### 1.1 commander 侧硬约束（决定「能不能吸收」）

| # | 约束 | 出处 | 对本清单的影响 |
|---|---|---|---|
| G1 | 不新增表、不新增事件类型 | `docs/HANDOVER.md` §7.2 第 2 条；`docs/NEXT-PHASE.md` §2 第 5 条「任务记录就是唯一真相」 | **排除** projects 表；吸收点必须落在 7 表现有字段 |
| G2 | 任务状态只有一个写入口，边/actor/守卫不可绕 | `src/host/tasks/state-machine.ts:50-80`、`:111-139`；`src/host/schema.ts:39-49` | 所有吸收点不得新增状态/actor |
| G3 | 派发先确认；`done` 只允许人 | `src/host/dispatch/service.ts:703`（`autoDispatch` 默认关）、`:823`（首次恒返回 `needs_confirmation`）、`src/host/config.ts:84`；`src/host/tasks/state-machine.ts:72`（`review>done` 仅 `user_accept`） | 不吸收任何「模型自治/自动派发/自置 done」 |
| G4 | 工具 `output.schema` 必须与真实返回逐字段一致，`render` 必填 | `docs/HANDOVER.md` §5 第 3 条 | M4 是高风险项，必须补「经真实 defineTool 校验」的测试 |
| G5 | 两半零运行时依赖；Host 不能 import Client | `AGENTS.md`「不可违反」；`src/host/query/board-columns.ts:1-3` | 派生 read model 只能「双份实现 + drift 测试」 |
| G6 | 一期只在 DSH 内；无 scheduler/轮询 | `docs/NEXT-PHASE.md` §2 第 10、4 条 | 排除 git 落地、常驻聚合服务 |

---

## 2. 判断框架：什么样的差异值得吸收

对报告 §6.1 的 7 个借鉴点 + §7.1 的 5 个缺口，逐条过 4 道闸门，全过才进「必做」：

- **Q1 零表变更**：能否只用现有 7 表字段（`workspace.summary`、`task.goal/acceptance/round`、`dispatch.userRequest/brief`、`sessions.*`）表达？→ 不能则降级为「可选/不建议」。
- **Q2 不动状态机**：是否触碰迁移图、actor 白名单、守卫、唯一写入口？→ 触碰则不吸收。
- **Q3 不推翻三前提**：人确认派发、done 仅人、任务记录唯一真相。
- **Q4 可验收**：能否给出一个「在旧代码上会失败」的测试断言。

结果：12 个候选项 → 必做 4、可选 3（Should）+ 2（Could）、不建议 10（含报告已列的 6 条）。

---

## 3. 总表（MoSCoW）

成本口径：**S** ≤0.5 人日；**M** 1–2 人日；**L** ≥3 人日（含契约 patch 与全量回归）。优先级：P0 本轮 / P1 下一轮 / P2 条件触发。

| 编号 | 吸收点 | 报告依据 | commander 落点 | 成本 | 风险 | 优先级 | 结论 |
|---|---|---|---|---|---|---|---|
| **M1** | brief 注入「工作区说明」 | §7.1#1、§6.1#1、§7.2#3 | `dispatch/brief.ts` + `dispatch/spawn.ts` | S | 低 | P0 | **必做** |
| **M2** | brief 注入「用户原话」 | §4.3 传递内容、§6.1#2 | `dispatch/brief.ts` + `dispatch/spawn.ts` + `dispatch/service.ts` | S | 低 | P0 | **必做** |
| **M3** | 任务查询/看板按工作区过滤 | §4.1、§7.1#3 | `query/tasks.ts` + `tools/index.ts`（+ `BoardPage.tsx` 等） | S（Host）/ M（UI） | 中低 | P0（Host）/ P1（UI） | **必做** |
| **M4** | `commander_task_get` 补齐上下文包 | §6.1#2 | `tools/index.ts`（task_get 输出） | S | 中 | P0 | **必做** |
| **S1** | 统一派生 read model（阶段 / 原因 / 下一步） | §6.1#3 | 新增 Host+Client 平行纯函数 + drift 测试 | M | 中 | P1 | 可选（Should） |
| **S2** | 看板「待我处理」只读聚合 | §6.1#6 | `BoardPage.tsx`（筛选条，不加视图切换） | M | 中低 | P1 | 可选（Should，形态待用户定） |
| **S3** | attach 会话占用风险显式化 | §7.1#2 | `dispatch/service.ts` attach 分支文案 | S | 中 | P1 | 可选（Should，轻量版） |
| **C1** | 任务级模型/执行者钉住 | §6.1#7 | `TaskRecord` 新字段 + `sessionController.selectModel` | M–L | 高 | P2 | 可选（Could，需先探针） |
| **C2** | `relatedTaskId` 后续任务链接 | §6.1#4 | `TaskRecord` 新字段 + create 参数 + 抽屉 | S–M | 中 | P2 | 可选（Could，需契约 patch） |
| **W1–W6** | 报告 §6.2 的 6 个「不借」 | §6.2 | — | — | — | 不做 | **不建议** |
| **W7** | 验收即 git 落地/合并 | §6.1#5 | — | — | — | 不做 | **不建议**（报告未覆盖，本案补） |
| **W8** | 当前冻结期新增 `projects` 表 | §7.2#1 | — | — | — | 不做 | **不建议**（冻结期；长期见 §7.1） |

---

## 4. 必做（Must / P0）

### M1 brief 注入「工作区说明」——project.instructions 的零表替代

**要改什么**

- `src/host/dispatch/brief.ts`：`BriefInput` 增 `workspaceNote?: string`；在「任务/目标」之后输出一段
  `工作区说明：<clip(note, 300)>`；**只在 `sameSession !== true` 时输出**（续派同一会话不重复，沿用现有 `src/host/dispatch/brief.ts:31` 的 sameSession 逻辑）。
- `src/host/dispatch/spawn.ts`：`SpawnInput` 增 `workspaceNote?: string`，在 `buildDispatchBrief({...})`（`src/host/dispatch/spawn.ts:99-110`）传入。
- `src/host/dispatch/spawn.ts`：`src/host/dispatch/spawn.ts:61` 已经读 `stores.workspaces.get(target.workspaceId)`，直接在 spawn 内取 `workspaceRecord?.summary` 传给 `buildDispatchBrief`（`src/host/dispatch/spawn.ts:99-110`）即可，**service 不需要改**（工作区不存在或 summary 为空则传 undefined）。
- 测试：`tests/unit/dispatch-core.test.ts`（现有 `buildDispatchBrief` 用例在 `:86`）+ `tests/e2e/m23-e2e.mjs` 断言。

**为什么（依据）**

- 报告 §7.1 缺口 1「上下文继承」：commander 每次 dispatch 只发 brief（标题/目标/本轮要求/上一轮结论/验收提示/约束），没有可继承的说明（`src/host/dispatch/brief.ts:29-44` 逐行可证）。
- 报告 §7.2#3 建议注入 `project.instructions`；本机已有等价载体 **`WorkspaceRecord.summary`**（`src/host/schema.ts:128`，上限 500 字），且设置页可手填（`src/client/SettingsSection.tsx:713-719`，`summarySource: manual|model`）。→ 零 schema 变更。
- 报告 §6.1#1 的价值判断：有 project 后可继承「项目说明/默认验收口径」；**验收口径本次不吸收**（属于策略边界，见 W8），只吸收「说明」。

**成本与风险**

- 成本 S：1 个 Host 文件 + 1 个测试 + 1 条 e2e 断言。
- 风险低：①说明可能过期 → 文案明确标「工作区说明（背景，不是本轮要求）」；②`summary` 常为空 → 空串不输出（与 `reportSummary` 同模式）；③brief 总长仍受 `DISPATCH_BRIEF_MAX_CHARS`（8KB）截断（`src/host/dispatch/brief.ts:45`），300 字说明余量足够。

**验收方式**

- 单测：`summary` 非空 → brief 含「工作区说明：…」；空/undefined → 不含；`sameSession` 续派 → 不含；加说明后总长仍 ≤ 8KB。
- e2e：`node packages/dsh-commander/tests/e2e/m23-e2e.mjs` 断言工作会话首条 prompt 含说明段（fixture 给一个非空 summary 的工作区）。
- 命令：`pnpm --filter dsh-commander typecheck && pnpm --filter dsh-commander test`。

---

### M2 brief 注入「用户原话」——`cited` 的零表替代

**要改什么**

- `src/host/dispatch/brief.ts`：`BriefInput` 增 `userQuote?: string`；输出 `用户原话：<clip(quote, 500)>`，位置在「目标」之后、「本轮要求」之前；与 `instruction` 相同则跳过（去重）。
- `src/host/dispatch/spawn.ts`：`SpawnInput` 增 `userQuote?`，传入 `buildDispatchBrief`。
- `src/host/dispatch/service.ts`：commit 处已有 `userRequest = pickUserRequest(...)`（`src/host/dispatch/service.ts:261`），**目前只落 `DispatchRecord.userRequest`，没有进 spawn**（`src/host/dispatch/spawn.ts:12-28` 的入参无该字段）。把它传给 spawn 即可。
- 测试：`tests/unit/dispatch-core.test.ts` + e2e 断言。

**为什么（依据）**

- 报告 §4.3 对照表「传递内容」：DSH-projects 的事件流带用户原话 id（`cited`）+ brief + note，执行者自读；commander 只有一条 brief 文本，**没有用户原话原文**，只有 `userRequest` 审计记录。
- 本机证据：`DispatchRecord.userRequest?: {text,at,source:'chat'|'board'}`（`src/host/schema.ts:315-316`）；service 已算出该值（`src/host/dispatch/service.ts:261`）；工作会话看不到它 → 工作会话只能看指挥官转述，容易丢约束。
- 报告 §6.1#2「上下文包」把「用户原话」列为三个缺失的可审计字段之一（另两个是边界 note、读过的文件 inputs）。

**成本与风险**

- 成本 S。
- 风险低—中：①原话可能长 → clip 500；②来源是 `chat|board`，board 来源可能是「返工批注」而非用户原话 → 输出前按 `source` 决定前缀（board → 「用户在看板的批注」），避免误标；③不新增外泄面（工作会话与指挥官同宿主、同用户）。

**验收方式**

- 单测：有原话 → 含原话段；`instruction` 与之相同 → 不重复输出；超长 → 截断；`source='board'` → 前缀不同。
- e2e：派发后工作会话首条 prompt 含用户原话片段；`commander_task_get` / 看板抽屉仍能从 `dispatch.userRequest` 读到（现有能力，不回归）。
- 命令：同 M1 + `node packages/dsh-commander/tests/e2e/m1r-e2e.mjs`（attach 续派路径）。

---

### M3 任务查询与看板按工作区过滤

**要改什么**

- Host（P0，可立即做）：
  - `src/host/query/tasks.ts:41` 的 `QUERY_PARAMETERS` 增 `workspaceId`；`TaskQueryFilter` 增 `workspaceId?: string`；`parseTaskQueryArgs` 校验收参（非空、≤128）；`queryTasks` 在 `matched` 循环里过滤（`task.workspaceId === filter.workspaceId`）。
  - `src/host/tools/index.ts` `commander_task_list` 参数表 + `description` 增 `workspaceId`（输出 schema 不变）。
  - 单测：`tests/unit/task-query.test.ts`；集成：`tests/integration/m2-board.test.ts` 参照既有 `q/status/workspace/from-to` 用例。
- Client（P1，**必须等 board-redesign 合入**）：
  - `src/client/board.ts` 增纯函数 `filterTasksByWorkspace(tasks, workspaceId)`。
  - `src/client/BoardPage.tsx` 头部加一个工作区 `select`（**复用 `src/client/ArchivePane.tsx:191-194` 的筛选范式与样式**），筛选只作用于六列渲染与计数。
  - `src/client/locales.ts` zh/en 各补 1–2 个 key（`board.filter.workspace` / `board.filter.workspaceAll`），`locales.test.ts` 会兜底。
  - `tests/client/harness/interact.mjs` 增断言。

**为什么（依据）**

- 报告 §4.1：commander「任务全局唯一，靠 `workspaceId` 弱归属；`commander_task_list` 不支持按 workspace 过滤」，而 DSH-projects 的任务天然归属 project、UI 按项目分组。
- 报告 §7.1 缺口 3「看板/查询分组」；报告 §7.2#5 建议「看板加项目分组/筛选、`commander_task_list` 加 `projectId` 过滤」。→ 裁剪为 `workspaceId` 过滤（workspace 是 commander 现有的唯一分组维度，零表变更）。
- 本机证据：`src/host/query/tasks.ts:41` 只接受 9 个参数，传 `workspaces` 会被显式拒绝（`:44-51`）；`TaskListRow` 已带 `workspaceId/workspaceName`（`:230-250`），加过滤不需要改行投影；回收站已经实现同款筛选（`src/client/ArchivePane.tsx:49`、`:74`、`:191-194`），有现成范式。

**成本与风险**

- 成本：Host S，UI M。
- 风险中低：①`additionalProperties:false` 的输出不变，但入参校验必须同步拒绝未知参数（现有机制，别绕过）；②client 三个文件都在 board-redesign 未提交改动里（`git status` 可证）→ **先合入再改**，否则冲突；③筛选状态不持久化（内存 state，与回收站一致）；④空工作区（`workspaceId=''`）的任务：默认「全部」可见，选择具体工作区时不显示（需在单测里固定口径）。
- 产品口径提醒：这是「筛选」，不是「分组泳道」；不要顺手做成报告 §6.2#6 反对的三列重排。

**验收方式**

- 单测：过滤命中/不命中、计数（`columns`/`counts`）只统计过滤后、未知参数仍 400/拒绝、`workspaceId=''` 口径固定。
- 集成：`GET /commander/board` 不涉及；`commander_task_list` 工具调用返回行全部属于该工作区；回收站既有 4 个筛选参数不回归。
- harness：切换 select 后只渲染该工作区卡片、列计数与 tab 徽标同步、切回「全部」恢复。
- 命令：`pnpm --filter dsh-commander test`、`pnpm --filter dsh-commander build:client`、`node packages/dsh-commander/tests/client/harness/run-harness.mjs`。

---

### M4 `commander_task_get` 补齐上下文包

**要改什么**

- `src/host/tools/index.ts`（`:412-477`）：输出对象增
  - `goal`（string，≤2000）
  - `acceptance`：`[{text, state, verify?, evidence?}]`，最多 5 条（避免输出膨胀）
  - `reportSummary`（`{text, at}`，可选）
  - `lastUserRequest`（`{text, at, source}`，可选；取 `dispatch.userRequest`）
  - `workspaceName`（string；从 workspace 目录解析）
- 同步 `output.schema`（`additionalProperties:false` 下必须逐字段声明，含 `required`）与 `render` 文本。
- 测试：`tests/unit/tools.test.ts`（现有）+ 一条「经真实 `defineTool` 注册后校验返回值」的用例（HANDOVER §5#3 的教训）。

**为什么（依据）**

- 报告 §6.1#2：commander 的 task「只有 goal + acceptance；缺用户原话、边界、读过的文件三个可审计字段」——本机进一步确认：**连 `goal` 都不在 `task_get` 的输出里**（`src/host/tools/index.ts:426-450` 只有 id/version/title/status/round/workspaceId/priority/dependsOn/waitingFor/ready/primarySessionId/block/pendingDispatch/acceptanceCount/evidenceInsufficientCount/updatedAt）。
- 直接后果【Inference】：指挥官要写 report/brief 或向用户汇报「这个任务到底要什么」时，只能靠会话记忆或再调 `commander_task_list`（行投影也不含 goal，`src/host/query/tasks.ts:230-250`）→ 上下文漂移风险。
- 报告 §6.1#2 的另一半「读过的文件 inputs」：本机无对应数据，**不吸收**（无来源可补）。

**成本与风险**

- 成本 S。
- 风险中：①DSH 运行时严格校验（HANDOVER §5#3 真实事故）→ schema 必须与返回逐字段一致，且加「真实 defineTool」测试；②输出体积：acceptance 限 5 条、summary 已是 ≤800（`config.ts` 的 `REPORT_SUMMARY_MAX`），避免撑爆工具结果；③`lastUserRequest` 要从 `dispatches` 表取（`task.dispatchId` 或最新 dispatch），取不到就不输出（不要伪造空对象）。

**验收方式**

- 单测：字段齐全/缺省字段不输出；schema `safeParse` 通过；旧任务（无 reportSummary）不炸。
- e2e：`m1-e2e.mjs` 或 `m1r-e2e.mjs` 里指挥官调 `task_get` 后能拿到 goal 与 acceptance 文本（stub 模型路径）。
- 回归：`tasks.changed`/`task.updated` 广播不受影响（只读工具）。

---

## 5. 可选（Should / P1）

### S1 统一派生 read model（阶段 / 原因 / 下一步）

**要改什么**：新增 `src/host/query/task-stage.ts` 与 `src/client/task-stage.ts`（平行实现，Host 不能 import Client，沿用 `board-columns.ts` 的双份 + drift 测试模式）：输入 `TaskRecord`/`TaskView` + 依赖状态，输出 `{stage, reasonKey, nextActionKey, tone}`；`query/tasks.ts` 的 `TaskListRow` 增 `stage/reason/nextAction`（需同步工具行 schema）；看板卡片与抽屉文案改为读同一套 key。

**为什么**：报告 §6.1#3——DSH-projects 用 `taskExperience()` 统一算 `group/reason/next`，UI 不再自己拼；commander 现在状态列（`src/host/query/board-columns.ts:13-20`）与抽屉（`src/client/BoardPage.tsx`）各自拼文案（例如 `src/client/board.ts:67-70` 的 `statusLabelKey` + 各处 `blockReason`/`stale` 判断）。

**成本与风险**：M。风险中：①「下一步」容易滑成「指挥官替人决策」——只给**陈述式**（「等待你验收」「还差 2 个前置」），不给推荐动作；②双份实现漂移 → 必须加 `tests/unit/task-stage-drift.test.ts`；③i18n 双字典。
**优先级**：P1（下一轮；需 board-redesign 合入后）。
**验收**：drift 测试逐项一致；单测覆盖 9 状态 × 有/无依赖 × stale；harness 断言卡片与抽屉读同一 key；`commander_task_list` 行字段与看板一致。

### S2 看板「待我处理」只读聚合

**要改什么**：纯 Client。数据来自现有快照（`state.tasks` + `pendingTaskIds`）：待验收（review）+ 被阻塞且需人（blocked）+ 待确认派发（pendingDispatch）+ 依赖就绪可派发。呈现为**头部一行 chips 筛选**（`review 3 / blocked 1 / 待确认 1`），点击过滤六列，**不新增视图切换、不加 tab、不改路由**。

**为什么**：报告 §6.1#6——DSH-projects 的 dock 跨项目聚合「等你的事」；commander 有六列但没有「今天等我做什么」的聚合（看板头部现在只有「看板/回收站」两个 tab，`src/client/BoardPage.tsx:217-238`）。

**成本与风险**：M。风险中低：①board-redesign 15:00 的追加明确「不再有六列/依赖视图切换」→ 形态必须是**筛选条**而不是第三个 tab，否则与刚定稿的方向冲突；②计数口径要固定（只读、不推导，避免「猜测用户该做什么」）。
**优先级**：P1（形态需用户确认：chips 筛选 vs 不做）。
**验收**：harness（chips 计数、点击过滤、清空恢复、无 review/blocked 时不显示）；不改 Host。

### S3 attach 会话占用风险显式化（不改 link 键）

**要改什么**：`src/host/dispatch/service.ts` attach 分支（`:900-912`，现有注释明确「不检查已被其它任务占用」）：当目标会话已有一条**活跃**（非终态任务、非本任务）的 work link 时，在 `needs_confirmation` 的 `reason` 与候选展示里加一句「该会话当前关联任务 <id>，attach 会替换其状态跟踪」。不改数据模型、不改 link 键。

**为什么**：报告 §7.1 缺口 2「会话归属与连续性」——link 键是 `workspaceId__sessionId`（`src/host/store/base.ts:17-20`），同一会话只能挂一个 taskId，跨任务 attach 会覆盖；`src/host/trigger/status.ts:34-49` 的注释与 HANDOVER §5#25 的真实事故都记录了该竞态。

**成本与风险**：S（轻量版）/ L（真改 link 模型 → 不做）。风险中：①误报（同任务续派 attach 是合法的）→ 判定要排除 `taskId === 当前任务`；②文案噪音 → 只在确认卡出现，不写 timeline；③**不要**顺手改键或新增 link 表（G1 禁止）。
**优先级**：P1。
**验收**：单测（已占用 → reason 含提示；同任务续派不提示；终态占用不提示）；集成（确认卡字段集不变，只改 `reason` 文案）。

---

## 6. 可选（Could / P2，条件触发）

### C1 任务级模型 / 执行者钉住

**要改什么**：`TaskRecord` 增 `modelRef?: {provider, model, reasoningEffort?}`（schema + 契约 patch）；派发时若任务指定则 `sessionController.selectModel`（`src/host/dsh-types.ts:89` 存在但未验证）或 `create({model})`；`DispatchRecord` 记录实际生效模型。

**为什么**：报告 §6.1#7（任务可单独换 runner/模型、换回能续接）。**注意报告事实需修正**：本机 `modelSuggestion` 写入的是 `workspaceId/mode` 标签（`src/host/dispatch/service.ts:314`），`TaskRecord` 无模型字段（`src/host/schema.ts:230-270`），`spawn.create` 只传 `workspaceId`（`src/host/dispatch/spawn.ts:61-84`）——所以不是「钉不住」，是**从来没有**。
**成本与风险**：M–L；风险高：①`selectModel` 真实语义未知（NEXT-PHASE V3 只验证了 `create({agentPreset})`）；②模型切换可能导致会话重建/上下文断裂；③schema 变更需先改 `docs/architecture/**`。
**优先级**：P2（触发条件：用户明确要「同一任务固定模型」且探针通过）。
**验收（前置）**：先在隔离 `DSH_HOME` 跑 `selectModel` 探针，结论写 `docs/validation/`；通过后再契约 patch → 实现 → e2e 断言 `create/selectModel` 收到指定模型。

### C2 `relatedTaskId` 后续任务链接

**要改什么**：`TaskRecord` 增 `relatedTaskId?`（≤1，禁自指/悬空）；`commander_task_create` 增参数；`task_get`/看板抽屉显示「前序/后续任务」。
**为什么**：报告 §6.1#4——「后续一律新开任务并 `related_thread_id` 链接」；本机只有前置 `dependsOn`（`src/host/schema.ts:258-261`），没有后续链接，`review` 之后的追加工作只能靠人记。
**成本与风险**：S–M；风险中：契约 patch、环/悬空校验、`archived` 目标是否允许链接要定口径。
**优先级**：P2（触发条件：用户明确要「后续任务链」；需先契约 patch）。
**验收**：单测（自指/重复/悬空拒绝；归档目标允许但标记）；集成（create → 抽屉/工具可见）；回归 `dependsOn` 闸门不受影响。

---

## 7. 不建议（Won't）

### 7.1 报告 §6.2 的 6 条（全部采纳）

| # | 不借 | 本案补充理由 |
|---|---|---|
| W1 | 事件溯源 + inbox 唤醒替代 DSH turn/injection | 违反 NEXT-PHASE §2 第 5 条（任务记录唯一真相，无事件表/投影）；commander 的价值在 `turn/end` 注入链路（`src/host/trigger/injection.ts`），换掉等于重写宿主集成 |
| W2 | 模型自治派发 / 取消确认 | 违反 G3；`needs_confirmation` 是产品决策（HANDOVER §7 第 7 条），不是可调参数 |
| W3 | 取消 `dependsOn` | commander 的 DAG + 闸门 + `[task-unblocked]` 提醒是它相对 DSH-projects 多出的硬能力（`src/host/tasks/dependencies.ts`），删掉是倒退 |
| W4 | 执行者自置 `done` | `review>done` 的 actor 白名单只有 `user_accept`（`src/host/tasks/state-machine.ts:72`）；DSH-projects 自己在 GitLab 项目上也补了平台校验 |
| W5 | per-project `ProjectStore` + mira 记忆助理 | 成本高（hub/memory/dream 等数万行）；commander 的单指挥官 + 7 表结构不需要第二套 store |
| W6 | 三列「执行中/未解决/已解决」看板 | 丢掉六列与状态机的一一对应（`src/host/query/board-columns.ts:13-20`），不利状态审计；**且 board-redesign 刚定稿六列 + 依赖悬停，不能回头** |

### 7.2 本案新增的不建议

| # | 不借 | 理由 |
|---|---|---|
| W7 | **验收即 git 落地/合并**（报告 §6.1#5 列为可借鉴） | ①一期只在 DSH 内（NEXT-PHASE §2 第 10 条），commander 不拥有 git 工作流；②DSH-projects 的做法依赖「每任务 worktree + 任务分支」，而 commander 的设计是「派到已有工作区/已有会话、任务共享目录」（报告 §4.2 取舍），加 worktree 等于改派发模型；③产物已有 `reportMaterials`（`src/host/schema.ts:170-185`）+ present 文件归并，能覆盖「看得到产出」的需求。**替代**：验收时在抽屉提示「产物在材料区/会话里」，或在材料里附加 git commit sha 元数据（低成本，不进本清单） |
| W8 | **当前冻结期新增 `projects` 表**（报告 §7.2 全量） | HANDOVER §7.2 明确「不新增表/事件类型」；7 表 per-record 是唯一契约（`src/host/domain.ts:47-59`）。**§7.2 的 6 条逐条裁决见下表** |

**报告 §7.2 薄 project 的逐条消化**

| 报告 §7.2 | 本案裁决 | 依据 |
|---|---|---|
| 1. 新增第 8 表 `projects` | **不做（冻结期）** | G1 |
| 2. `TaskRecord` 加可选 `projectId` | **不做**（依赖 1） | G1 |
| 3. brief 注入 `project.instructions` + `acceptanceDefaults` | **裁剪为 M1**（注入 `workspace.summary`）；验收默认值不做 | 零表变更；验收默认值属于策略边界（报告 §7.1#4），无载体 |
| 4. `sessions` 加 `projectId`，允许多任务按轮 attach 不覆盖 | **不做**；只做 S3（风险显式化） | 需改键/表（G1）；且真改 link 模型是 L 成本、高风险 |
| 5. UI 加项目分组/筛选、`task_list` 加 `projectId` | **裁剪为 M3**（工作区筛选） | 复用现有 `workspace` 维度与回收站范式 |
| 6. 不做事件溯源/inbox/memory/自治派发/项目对话 session | **同意** | 与 W1/W2/W5 一致 |

**长期方向（非本轮）**：若将来契约解冻且用户确有跨工作区「项目」需求，最小增量是「**给 `WorkspaceRecord` 加 `instructions`/`acceptanceDefaults` 字段**」（比新增表轻，改的是已有记录类型），而不是报告 §7.2 的 `projects` 表；触发条件与契约 patch 需 Lead 批准。

---

## 8. 与未提交 board-redesign 改动的关系（实施顺序前置）

当前 working tree 有 15 改 6 增（`git status --short` 实测；含 board-redesign 文档与 2 张截图）：

- 改：`docs/architecture/m2m3-contract-patch.md`、`package.json`、`client/{BoardPage.tsx,board.ts,locales.ts,state.ts,store.ts,styles.ts,types.ts}`、`host/api/routes/handlers.ts`、`host/api/server.ts`、`host/board/service.ts`、`tests/client/board.test.ts`、`tests/client/harness/interact.mjs`、`tests/integration/m2-board.test.ts`
- 增：`client/ArchivePane.tsx`、`client/BoardDependencies.tsx`、`prototype/board-redesign/`、`docs/validation/board-redesign.md` + 2 张截图

**冲突面**：M3 的 UI 部分、S1、S2 都会碰 `BoardPage.tsx`/`board.ts`/`locales.ts`/`styles.ts`（都是被改文件）。→ **实施顺序：Host 侧的 M1/M2/M3(Host)/M4 可立即做；任何 Client 改动必须等 board-redesign 合入后再开分支**。

**建议批次**

| 批次 | 内容 | 前置 | 预期回归 |
|---|---|---|---|
| 0 | M1、M2（M1 改 `src/host/dispatch/brief.ts` + `src/host/dispatch/spawn.ts`；M2 另需在 `src/host/dispatch/service.ts` 的 spawn 调用处传原话，合成一次改动） | 无 | `test` + `m23-e2e` |
| 1 | M4（`task_get` 字段 + 契约测试） | 无 | `test` + `m1/m1r-e2e` |
| 2 | M3 Host（查询过滤）+ 单测/集成 | 无 | `test` |
| 3 | M3 UI、S2（看板筛选/聚合） | board-redesign 合入 | `build:client` + harness |
| 4 | S1（read model + drift 测试） | 批次 3 | `test` + harness |
| 5 | S3（attach 文案） | 无 | `test` |
| 观察 | C1（先探针）、C2（契约 patch） | 用户明确需求 | 探针/契约 |

---

## 9. 证据索引（本机 working tree）

| 主题 | 证据 |
|---|---|
| 7 张表 / 域 | `src/host/domain.ts:47-59`、`src/host/config.ts:6` |
| TaskRecord 字段（无模型/无用户原话/无后续链接） | `src/host/schema.ts:230-270` |
| DispatchRecord.userRequest / brief / modelSuggestion | `src/host/schema.ts:280-317`；`src/host/dispatch/service.ts:314` |
| WorkspaceRecord.summary（500 字） | `src/host/schema.ts:128`、`:455`；设置页编辑 `src/client/SettingsSection.tsx:713-719` |
| brief 现状（无说明/无原话） | `src/host/dispatch/brief.ts:26-46`；调用点 `src/host/dispatch/spawn.ts:99-110` |
| userRequest 已算出但未进 spawn | `src/host/dispatch/service.ts:261`；`SpawnInput` `src/host/dispatch/spawn.ts:12-28` |
| 查询参数白名单（无 workspaceId） | `src/host/query/tasks.ts:41`、`:44-51`；行投影 `:230-286` |
| 六列映射 | `src/host/query/board-columns.ts:13-20`；`src/client/board.ts:28-35` |
| 状态机边 / done 仅人 | `src/host/tasks/state-machine.ts:50-80`、`:72`；`src/host/schema.ts:39-49` |
| 派发链路（确认/续派/失败落 blocked） | `src/host/dispatch/service.ts:280-300`、`:586-596`、`:900-912` |
| 会话 link 键与覆盖 | `src/host/store/base.ts:17-20`；`src/host/trigger/status.ts:34-49`；HANDOVER §5#25 |
| 看板头部 tabs（无聚合/无筛选） | `src/client/BoardPage.tsx:217-238`、`:83-85` |
| 回收站筛选范式（可复用） | `src/client/ArchivePane.tsx:49`、`:74`、`:191-194` |
| 冻结边界 | `docs/NEXT-PHASE.md` §2（第 4/5/10 条）；`docs/HANDOVER.md` §7 第 2 条 |
| board-redesign 在改文件 | `git status --short`（§8） |

---

## 10. 未验证 / 风险登记

1. **`selectModel` 的真实语义**【Unverified】：`src/host/dsh-types.ts:89` 只有签名，NEXT-PHASE V3 只验证过 `create({agentPreset})`；C1 的成本与可行性取决于它。
2. **`workspace.summary` 的实际填写率**【Unverified】：M1 的收益取决于用户在设置页填了说明；若大多为空，M1 只是「有就用」，不改变默认体验。建议实施时在 `GET /commander/state` 或设置页加一个「未填说明」的轻提示（可选）。
3. **brief 8KB 预算余量**【Unverified】：M1+M2 各加 ≤500 字，长 goal（2000）+ 上轮结论（800）+ 验收（5×200）后仍可能触顶；需在单测里加一条「全字段最长」边界断言，确认截断发生在尾部而不是把原话截掉。
4. **S2 的形态需用户确认**【Inference】：board-redesign 刚删掉视图切换，加 chips 筛选是兼容做法，但要不要做仍应由用户定（本清单只给建议形态）。
5. **报告 §4.2 对 `modelSuggestion` 的表述**：建议回填勘误到上一轮报告（或本文件 §6 C1 即可作为勘误依据）。
6. **本文件不含任何代码改动**：仅阅读源码与文档；`git status` 的 board-redesign 改动未被触碰。
