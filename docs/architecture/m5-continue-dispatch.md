# M5 · 任务追加派发（续派）与返工统一 · 实现契约（草案）

> **2026-11-22 定案更新**：本文中「看板 PATCH status / 人可拖动」「commander_task_update({status})」「输出 sessionsStopped」等已被 `task-state-machine-final.md` v1.0 取代。当前：看板只改 priority/title；取消用 action=cancel 或 `POST /cancel`；review→queued 由统一迁移入口 `src/host/tasks/state-machine.ts` 写入；工具输出固定 `{taskId,status,version}`。


> 日期：2026-11-19
> 状态：**已确认（用户 2026-11-20「开始实现」），Host/Client 已实现；待 live 走查**。合并进 `implementation-plan.md` 的 §6/§9/§10/§11/§13 作为后续文档收口。
> 产品口径来源：用户 2026-11-19 需求——
> 1. 任务在**待派发（draft/proposed）或待验收（review）**状态时可以继续派发；
> 2. 运行中的任务（queued/running）不能派发；
> 3. 本轮先不做并发派发（同一任务同一时刻只有一个活跃轮次）；
> 4. 续派可以回原会话，也可以去新工作区/新会话（一个任务可跨工作区）；
> 5. 看板「返工」不再直接给工作会话发 brief，而是给指挥官一条任务更新信息，由指挥官走统一的再次派发。

---

## 0. 一句话方案

把 `commander_task_dispatch` 从「只能派发新任务」扩展为「**同一任务可以多轮派发**」：任务记录增加 `round`（轮次）与 `acceptanceHistory`（历史验收）；`review` 任务再次派发时轮次 +1、上一轮验收归档、当前验收清空，派发目标默认原会话、也可选新工作区/新会话；看板「返工」改成「继续派发请求」——只写一条待消费的批注并通知指挥官，真正的会话投递仍然只由 `commander_task_dispatch` 的确认路径完成。

**不新增表、不新增 scheduler、不做并发派发、不做自动续派（推荐）。**

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| 轮次 `round` | 一个任务第几次派发；首次派发 = 1，每次续派 +1 |
| 首次派发 | 任务还没有任何一轮（`round` 缺省为 1，当前无验收、无历史） |
| 追加派发 / 续派 | 已有至少一轮的任务再次 `commander_task_dispatch`；`round+1`，上一轮验收进历史 |
| 继续派发请求 | 人在看板点「继续派发」并写批注；只通知指挥官，不改任务状态 |
| 当前轮 | `task.round` 指向的轮次；只有当前轮的验收参与 review 门禁 |

---

## 2. 适用范围与不可变边界

### 2.1 允许派发的状态

| 状态 | `commander_task_dispatch` | 行为 |
|---|---|---|
| `draft` | 允许 | 首次派发；`needs_confirmation` 时 `draft→proposed`（沿用现状） |
| `proposed` | 允许 | 首次派发重试；`needs_confirmation` 时保持 `proposed` |
| `review` | **允许（新增）** | 续派：`round+1`；`needs_confirmation` 时**保持 review**，确认成功后 `review→queued` |
| `queued` / `running` | 拒绝 | `rejected(code='task_state')`，运行中不允许再派发 |
| `blocked` | 拒绝 | 本轮不做；要重试先把状态改回可派发状态（人工看板） |
| `done` / `cancelled` / `archived` | 拒绝 | `task_state` |

### 2.2 硬边界（继续遵守）

- Host 是唯一写者；本方案不新增表、不新增事件表、不写投影。
- 派发仍然「先确认、后落地」；续派复用 `autoDispatch` 门控（见 §5.4）：开关关闭/门控不通过时确认，开关打开且门控通过时可直接开新一轮。
- 同一任务同一时刻只有一个活跃轮次；`queued/running` 门禁保证这一点。
- `review` 至少 1 条**当前轮**验收（不变量 2 修订为按轮次计）。
- 指挥官仍然不评估结果、不写代码；`commander_task_report` 仍是唯一写验收的路径。
- 工作会话的 brief 不含 `taskId/decisionId/sessionId` 等内部 id；看板→指挥官的续派通知可以带 `taskId`（指挥官需要它调工具）。

### 2.3 非目标

- 不做同一任务多会话并行执行（并发派发）。
- 不做自动续派策略（如「报告后自动深入分析」）。
- 不做跨任务的依赖编排/子任务树。
- 不改变 Jev 的工作区/会话判定算法。
- 不改变审批/提问的注入与展示。

---

## 3. 状态机

### 3.1 迁移变化

`src/host/schema.ts` 的 `TASK_TRANSITIONS`：

```diff
-  review: ['running', 'done', 'cancelled'],
+  review: ['done', 'cancelled'],
```

- 去掉 `review→running`：返工不再直接改状态；`commander_task_update` 已不接受裸 status，也不能把 review 任务手动置 running。
- `review→queued` 由 **dispatch 内部迁移** 写入，且必须经过统一迁移入口 `src/host/tasks/state-machine.ts`（actor=`host_dispatch`）；不暴露给 `commander_task_update`。
- `review→done` 仍只由 `POST /accept` 触发；`done/archived` 不在工具可写集合内。
- 看板人工 PATCH 已收窄为 **priority/title only**，`status` 一律拒绝；通用状态拖拽已删除（2026-11-22 定案）。

### 3.2 轮次流转

```text
[round N, review]
   │  用户：继续派发 / 指挥官 commander_task_dispatch
   ▼
needs_confirmation（round N+1, 状态保持 review）
   │  确认
   ▼
queued（round N+1；当前验收清空，round N 进历史）
   │  turn/start
   ▼
running
   │  工作会话回合结束 → 指挥官 commander_task_report
   ▼
review（round N+1 的验收）
```

首次派发：

```text
draft → proposed（确认卡）→ queued（round 1）→ running → review
```

---

## 4. 数据模型变更

所有新字段都是**可选字段**，旧记录读取时给默认值，不做数据迁移。

### 4.1 `TaskRecord`（`src/host/schema.ts`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `round` | `number` | `1` | 当前轮次；`>=1`。**只是序号，不承载状态**；完成/待验收等状态仍由 `task.status` 表示 |
| `acceptanceHistory` | `AcceptanceRound[]` | `[]` | 历史轮次验收；只保留最近 5 轮 |
| `pendingInstruction` | `{ text: string; at: number; source: 'rework' }` | 无 | 看板「继续派发」批注，等下一次 `commander_task_dispatch` 消费 |
| `workspaceIds` | `string[]` | `[]` | 本任务派发过的全部工作区（去重，按首次出现顺序） |

```ts
export interface AcceptanceRound {
  round: number
  at: number
  items: AcceptanceItem[]
  reportSummary?: ReportSummary
}
```

- `round` 只由 `finishDispatch` 递增，不允许工具直接写。
- `acceptanceHistory` 超过 5 轮时丢掉最旧一轮（timeline 仍保留一条 continue 记录）。
- `pendingInstruction.text` ≤ `REWORK_COMMENT_MAX`（1000）；被下一次成功派发消费后清空；`accept/cancel/archive` 也清空。
- `workspaceIds` 由 `finishDispatch` 追加，去重；`workspaceId` 的语义改为「当前轮目标工作区」（见 §9）。

`isTaskRecord` 增加可选校验：`isOptional(isInt)` 且 ≥1、`isOptional(isArrayOf(isAcceptanceRound))`、`isOptional(isPendingInstruction)`、`isOptional(isArrayOf(isString))`。

### 4.2 `AcceptanceItem`

不新增 `round` 字段：`task.acceptance` **永远是当前轮**的验收；历史轮次由外层 `AcceptanceRound.round` 标识。这样 `acceptanceCount`、review 门禁、`accept` 路由的现有语义不变。

### 4.3 `ReportSummary`

增加可选 `round?: number`：

```ts
export interface ReportSummary { text: string; at: number; round?: number }
```

`commander_task_report` 写入 `round = task.round ?? 1`；旧记录没有该字段，UI 按「未标注」处理。

### 4.4 `DispatchRecord`

增加可选审计字段：

```ts
round?: number
kind?: 'initial' | 'continue'
instruction?: string
/** 本轮实际发给工作会话的 brief 原文（spawn 已生成，当前没落库）。 */
brief?: string
/** 触发本轮派发的用户原话；旧记录缺失。 */
userRequest?: { text: string; at: number; source: 'chat' | 'board' }
```

- `brief`：`spawnDispatch` 生成的完整 brief，成功提交后原样写入；页面「派发内容」直接展示它，**不要用任务 goal 反推**。
- `userRequest`：由 `commander_task_dispatch.userRequest` 显式传入（聊天）；看板继续派发用 `pendingInstruction` 的文本与时间填充（`source='board'`）。旧记录缺失时页面显示「未记录原话」，不伪造。
- 不改变 `v: 1` 和现有校验（校验器只检查关键字段）。

### 4.5 `SessionLinkRecord`

增加可选 `round?: number`（缺省按 1）：

- `finishDispatch` 写 link 时写当前轮次；
- 同一会话被后续轮次 attach 时，同一 link 的 `round` 被更新（link key 是 `(workspaceId, sessionId)`）；
- **旧轮次的 link 不再参与状态跟踪与回复注入**（`link.round ?? 1 < task.round ?? 1` → skip）。这是「一个任务跨多个会话/工作区」时避免旧会话打扰本轮的关键。

### 4.6 `TaskTimelineItem`

- `type` 增加 `'continue'`（成功续派）与 `'continue_request'`（人请求续派）；
- 增加可选 `round?: number`；
- 旧 `'rework'` 类型保留用于历史记录读取，新代码不再写。

### 4.7 `PendingDecision`（内存，`src/host/dispatch/decisions.ts`）

增加：

```ts
kind: 'initial' | 'continue'
round: number            // 本轮确认成功后的轮次
instruction?: string     // 指挥官在 commander_task_dispatch 里传的本轮要求
userRequest?: string     // 指挥官在 commander_task_dispatch 里传的用户原话（聊天场景）
```

`PendingDispatchView` / SSE `dispatch.updated` 增加 `kind`、`round`（供确认卡显示「继续派发 · 第 N 轮」）。

### 4.8 对外视图

`TaskView`（`/commander/state` 与 SSE `task.updated`）增加：

- `round: number`
- `pendingContinue: boolean`（由 `pendingInstruction` 派生，不传全文）

`GET /commander/tasks/:id` 增加：

- `task.round`
- `acceptanceHistory`
- `pendingInstruction`（全文，抽屉展示）
- `sessions[].round`
- `reportSummary.round`（已在 §4.3）
- **`dispatches[]`**：本任务每一轮的 dispatch 记录（`round/kind/instruction/userRequest/brief/target/outcome/candidates/jev/createdAt`）；现有 `dispatch`（最新一条）保留兼容。
- 推荐再派生 `rounds[]` 只读视图（每轮含 `userRequest / dispatch / sessions / report / acceptance`），客户端直接渲染；若不加派生层，客户端用 `dispatches[] + timeline[].round + sessions[].round` 自行分组，但两边会重复逻辑。

`taskSummary()`（accept/continue/patch/archive 的响应）补 `round`，避免客户端 upsert 任务行时丢轮次。

---

## 5. 派发流程

### 5.1 首次调用（`firstCall`）

```text
commander_task_dispatch(args)
├─ 1. 校验 taskId/requestId；task 存在
├─ 2. 状态门禁：draft | proposed | review；否则 rejected(task_state)
├─ 3. 判定是否续派：
│     hasPriorRound = status==='review' || (round ?? 1) > 1（不拿 acceptance 推断轮次；恢复/改板保留 round）
├─ 4. 候选：
│     ├─ args.candidate 显式 → 按现状解析（id/name/path，歧义走确认）
│     ├─ 否则 hasPriorRound 且 primarySessionId 可 attach（会话存在、未归档、所属工作区 allowed）
│     │     → 默认候选 = { workspaceId: 该会话所属工作区, mode:'attach', sessionId: primarySessionId }
│     └─ 否则 → Jev 正常推荐
├─ 5. 仍然跑 Jev 两段（取 scores/备选；失败则 needs_confirmation jev_unavailable）
│     └─ 若第 4 步已有默认候选：mapped/recommendation 强制用该候选（Jev 只贡献备选与分数）
├─ 6. 创建 pending decision：
│     kind = hasPriorRound ? 'continue' : 'initial'
│     round = hasPriorRound ? (round ?? 1) + 1 : (round ?? 1)
│     instruction = args.instruction（可选；写进 brief 的本轮要求）
│     userRequest = args.userRequest（可选；用户原话，只用于展示/审计）
└─ 7. needs_confirmation
      ├─ 首次（draft）→ status='proposed'（沿用）
      ├─ 续派（review）→ **不改状态**，只追加 timeline `{type:'dispatch', round: N+1, text:'needs_confirmation 续派待确认（第 N+1 轮）'}`（客户端 feed 会按 needs_confirmation 前缀隐藏这一行）
      └─ 返回 candidates/recommendation/scores/reason/round/kind
```

要点：

- **review 的 `needs_confirmation` 不写 `status='proposed'`**。否则看板会从「待验收」掉到「待派发」，用户会以为验收被取消了。
- 默认候选走「原会话」：用户最常要的是在原上下文继续深入；工作区/会话备选仍由确认卡和「自定义选择」提供。
- 显式 `candidate` 优先：用户可以选新工作区/新会话，甚至可以选一个**不同轮次的历史会话**（attach 后该会话 link 的 round 更新为当前轮）。
- 续派复用 `autoDispatch` 门控（见 §5.4）：开关关闭或门控不通过时仍需确认。

### 5.2 二次确认（`dispatchTask` 确认路径）

```text
commander_task_dispatch({taskId, decisionId, confirmTarget, requestId, instruction?, userRequest?})
├─ 1. getUsable(decisionId, taskId)；过期/已用 → decision_expired
├─ 2. 重新读 task；状态仍必须是 draft|proposed|review；且 task 当前轮次与 decision 创建时一致（`decision.kind==='continue' ? task.round+1 : task.round` 必须等于 `decision.round`），否则 decision_expired
├─ 3. target = explicit confirmTarget ?? decision.recommendation
├─ 4. 白名单 + attach 归属/归档校验（沿用）
├─ 5. instruction = mergeInstruction(decision.instruction, args.instruction, task.pendingInstruction)
├─ 6. userRequest = pickUserRequest(task.pendingInstruction, decision.userRequest, args.userRequest)
└─ 7. finishDispatch(task, decision, target, instruction, userRequest)
```

合并规则（本轮要求，最终写进 brief）：

1. 若 `task.pendingInstruction` 存在，先放「看板批注」；
2. 若 `decision.instruction` / `args.instruction` 存在且文本不同，放「指挥官补充」；
3. 两者都没有则留空，brief 用兜底句（§6）；
4. 总长 ≤ 2000 字符（两个来源各自 ≤1000，合并后截断）。

`userRequest`（用户原话）与 `instruction`（本轮要求）分开：

1. 若本轮来自看板继续派发：`{ text: pendingInstruction.text, at: pendingInstruction.at, source: 'board' }`；
2. 若本轮来自聊天：`{ text: args.userRequest ?? decision.userRequest, at: decision.createdAt, source: 'chat' }`；
3. 两者都没有：不写 `userRequest`，页面显示「未记录原话」；**不要用 instruction 冒充原话**。

### 5.3 `finishDispatch` 变更

> **并发修复（2026-11-20 live 反馈）**：prompt 先于 task/link 写入，工作会话的 `turn/start` 可能在 19s 长派发中把 task.version 顶掉；第一次工具调用报 `version changed during update`，但 brief 已发出，指挥官重试会重复派发。`finishDispatch` 现在按最新 version 重试应用同一次派发（≤3 次）；若 task.round 已被其它派发推进则拒绝覆盖。`commander_task_list` 是只读，不是原因。

成功路径（`spawn.ok === true`）：

```text
hasPriorRound = 同一判定（5.1 第 3 步）
nextRound = hasPriorRound ? (task.round ?? 1) + 1 : (task.round ?? 1)

task 更新：
  status: 'queued'
  round: nextRound
  acceptance: hasPriorRound ? [] : current.acceptance
  acceptanceHistory: hasPriorRound
    ? [...history, { round: task.round ?? 1, at: reportSummary?.at ?? timestamp, items: current.acceptance, reportSummary: current.reportSummary }].slice(-5)
    : current.history
  reportSummary: hasPriorRound ? undefined : current.reportSummary
  pendingInstruction: undefined（被消费）
  workspaceId: target.workspaceId（当前轮目标）
  workspaceIds: unique([...current.workspaceIds ?? [current.workspaceId], target.workspaceId])
  dispatchId: 最新 decisionId
  primarySessionId: spawn.sessionId（当前轮会话）
  assignments: unique([...current.assignments, spawn.sessionId])
  timeline: [...,
    hasPriorRound
      ? { type:'continue', round: nextRound, at, text:`第 ${nextRound} 轮继续派发到 ${target.workspaceId}（${target.mode}）` , sessionId }
      : { type:'dispatch', round: nextRound, at, text:`派发到 ${target.workspaceId}（${target.mode}）· ${outcome}`, sessionId }
  ]
```

同时：

- `DispatchRecord` 写 `round/kind/instruction/brief/userRequest`（brief 来自 `spawn.brief`，userRequest 来自工具参数或 pendingInstruction）；
- `sessions.upsert` 写 `round: nextRound`；
- `decisions.markUsed` + `notifyPending`；
- 广播任务行（现有 `onTaskUpdated`）。

失败路径（`spawn.ok === false`）：

- 状态 `blocked`（沿用），**不递增 round、不归档验收、不清 pendingInstruction**；
- 用户/指挥官可重试（重试前需人工把状态改回可派发状态）。

### 5.4 自动派发（`autoDispatch`）与续派

**续派复用同一套 `autoDispatch` 门控**：`config.jev.autoDispatch === true` 且 `evaluateGate` 通过（Jev 可用、无 conflict、pWorkspace/pSession 达阈值）→ 直接开新一轮（`round+1`、归档上一轮验收），不弹确认卡；开关关闭或门控不通过 → `needs_confirmation`。

- 这修正了早期「续派恒确认」导致 100% 仍要审核的问题；用户 2026-11-20 反馈后调整。
- 自动续派仍走 `finishDispatch`，因此 `round+1`、history、`workspaceIds`、brief/userRequest 落库与确认路径完全一致。
- 若用户想手动选目标，关闭自动派发即可回到确认卡。

### 5.5 幂等与并发

- `requestId` 5 分钟 LRU 不变；每轮必须用新 `requestId`（prompt 已要求）。
- 同一 `decisionId` 重复确认仍幂等回放（`replayDispatch`）。
- 同一任务只有一个 pending decision（`decisions.create` 会清掉旧决策，沿用现状）。
- 状态门禁保证 `queued/running` 不能再次派发；若要防「确认卡还没点、状态已被别的操作改掉」，确认路径每次都重读 task 并重新校验状态。
- `accept` / `cancel` / `archive` 时清理该任务的 pending decision：
  - `DecisionStore` 增加 `invalidateTask(taskId)`；
  - accept 路由在成功后调用；看板 PATCH 到 cancelled、archive 路由同理；并广播 `dispatch.updated {pendingDispatch:null}`（若被清理的是当前 pending）。

### 5.6 派发失败与会话创建失败

- 沿用 `spawn` 失败 → `blocked(code='session_create_failed'|'delivery_failed')`；
- 续派失败时 `pendingInstruction` 保留，用户可重新请求；
- 不新建第二个会话，不自动重试。

---

## 6. Brief 变更（`src/host/dispatch/brief.ts`）

> **2026-11-26 作废**：本节模板与「同会话只发增量」的自动裁剪全部取消，`brief.ts` 已删除。工作会话首条消息 = `commander_task_dispatch.prompt` 原文，由指挥官自己组织（见 `dispatch-prompt-passthrough.md`）。轮次/历史归档语义不变。

首次派发保持现状：

```text
任务：<title>
目标：<goal>
约束：你是工作会话，自己拆分与执行；结束时在会话里说明产出与证据（文件路径/命令/结果），不要维护看板。
```

续派**同一会话只发增量**（避免用户反馈的「派发内容重复」）；换新会话/新目标时才带完整上下文：

```text
# 同一会话续派
任务：<title>
本轮要求：<看板批注 + 指挥官补充；都没有则「按上一轮结论继续补做/深入，先说明你本轮要做什么」>
上一轮结论：<上一轮 reportSummary.text，≤800 字>
约束：...

# 新会话续派（attach 其它会话 / new）
任务：<title>
目标：<goal>
本轮要求：...
上一轮结论：...
上一轮验收项：<≤5 条，逐条「（上一轮）」>
约束：...
```

判定：`target.mode==='attach' && target.sessionId === task.primarySessionId` → sameSession，省略 `目标` 与 `上一轮验收项`；否则保留完整上下文。

- `buildDispatchBrief` 入参增加 `round?`、`instruction?`、`previousReportSummary?`、`previousAcceptance?`；
- 每段独立截断：title 200 / goal 2000 / instruction 2000 / summary 800 / 验收项每条 200；总长仍 ≤ `DISPATCH_BRIEF_MAX_CHARS`（8192）；
- 不写内部 id（taskId 等）；
- attach 原会话也照常发这三段：agent 的上下文可能已被压缩，重复一次「本轮要求」比漏掉更安全。

---

## 7. 验收轮次

### 7.1 续派时

- 上一轮 `acceptance` + `reportSummary` 打包进 `acceptanceHistory`；
- 当前 `acceptance = []`、`reportSummary = undefined`；
- timeline 记 `continue`；
- 这样 `review` 不变量（当前轮至少 1 条）不会被上一轮验收错误满足。

### 7.2 `commander_task_report`

- 报告写入当前轮：`acceptance = 本次解析结果`、`reportSummary = { text, at, round: task.round }`、`status = delivered|partial → review`；
- timeline `report` 增加 `round`；
- **当前轮会话校验**：`round > 1` 且 `task.primarySessionId` 存在且 `sessionId !== task.primarySessionId` → `conflict('stale_session', '只能整理当前轮主会话的报告')`；
- `review` 空验收仍拒绝（沿用 HIGH-1 修复）；
- seq/derivedFromSeq 校验不变。

### 7.3 门禁与计数

| 位置 | 口径 |
|---|---|
| `commander_task_report` review 空验收 | 当前轮 `acceptance.length` |
| 统一迁移入口目标 review（report/recover） | 当前轮 `acceptance.length ≥ 1` |
| 看板 PATCH 目标 status | 不再接受（400/409） |
| `GET /commander/state` `acceptanceCount/evidenceInsufficientCount` | 当前轮 |
| `POST /accept` | 当前轮；空验收仍按历史脏数据放行（timeline 标注「无验收项：历史数据」） |

### 7.4 accept

- 任务 `review→done`，timeline `{type:'accept', round: task.round, text:'第 N 轮验收通过'}`；
- 保留 `acceptanceHistory` 与当前验收（记录不可变，归档时仍保留）；
- 清空 `pendingInstruction`；
- 清理该任务的 pending decision（§5.5）。

### 7.5 历史展示

- `GET /commander/tasks/:id` 返回 `acceptanceHistory`（≤5 轮）；
- 抽屉：
  - 当前验收块标题「第 N 轮验收」；
  - 「历史验收」折叠区，按轮次倒序显示每轮验收项与结论；
  - 当前轮为空且存在历史时，显示「本轮暂无验收项」而不是误显示上一轮。
- 看板卡片：显示「第 N 轮」徽标（`round=1` 中性色，`round>1` 品牌色）；不再显示「验收 N/N」。

---

## 8. 返工统一：看板「继续派发请求」

### 8.1 路由

新增（或改名）：

```http
POST /commander/tasks/:id/continue
Body: { comment?: string(≤1000), requestId?: string }
```

- 保留 `POST /commander/tasks/:id/rework` 作为**兼容别名**（同一 handler），避免旧客户端 404；文档与 UI 统一叫「继续派发」。
- 仅 `status === 'review'` 可调用；其它状态 `conflict`。
- 若该任务已有 pending decision（确认卡未处理）→ `conflict('该任务正在等待派发确认，请先处理确认卡')`，避免「点了续派、指挥官又拿旧卡确认」的竞态。
- `requestId` 可选：给了就做 5 分钟 LRU 幂等（双击/重试不重复通知）。

### 8.2 行为（关键：不再直接 prompt 工作会话）

```text
continue(taskId, comment)
├─ 1. 校验 review / comment 长度 / pending decision
├─ 2. 写 task：
│     pendingInstruction = { text: comment.trim() || '用户请求继续派发（无批注）', at, source:'rework' }
│     timeline += { type:'continue_request', round: task.round ?? 1, text:`用户请求继续派发：<comment 摘要>` }
│     updatedAt = at
│     （status 保持 review）
├─ 3. 广播 task.updated
├─ 4. 向指挥官投递上下文消息（不是用户气泡）：
│     kind: 'commander-task-continue'
│     form: 'notice'
│     summary: '任务继续派发请求'
│     正文：
│       [task-continue] taskId=<id> round=<n> status=review
│       用户在任务看板对「<title>」请求继续派发/返工：
│       <comment>
│       请调用 commander_task_dispatch(taskId, instruction=<comment>, requestId=<新ID>) 继续派发；
│       默认推荐原会话，也可以改选新工作区/新会话。确认后任务进入第 <n+1> 轮。
│       ---
│       requestId=<...>
├─ 5. 投递失败 → 502 delivery_failed；**任务保持 review，pendingInstruction 保留**（下次派发仍会带上）
└─ 6. 返回 { ok: true, task, notified: true }
```

- 投递走 `deliverer.deliverContextMessage`（与 `[board-edit]`、`[session-reply]` 同一条通道）；指挥官会话未 live 时回退 `prompt`，保证能触发一轮。
- 不再调用 `sessionController.prompt` 直接给 `primarySessionId` 发 brief；`buildReworkBrief` 与旧 rework 的「先投递成功才改状态」逻辑删除。
- `taskActions.rework` 拆成 `requestContinue`（新行为）+ `accept`；`createTaskActions` 增加 `deliverer` 依赖。
- 因 `deliverer` 在 `index.ts` 里创建于 `taskActions` 之前（当前 `deliverer` 在 line 144，`taskActions` 在 line 194），装配顺序无需调整。

### 8.3 批注生命周期

| 事件 | 行为 |
|---|---|
| 看板提交继续派发 | 覆盖写 `pendingInstruction`（最新一条为准），timeline 记一条 |
| 指挥官 `commander_task_dispatch` 成功 | 消费并清空 |
| 指挥官确认失败 / 过期 | 保留，等下次 |
| 用户验收通过 | 清空（不再派发） |
| 用户取消 / 归档 | 清空 |
| 用户再次提交 | 覆盖旧批注（旧批注可能丢失，timeline 留痕） |

### 8.4 客户端 UI

- 按钮文案 `board.action.rework`：中文「继续派发」，英文「Continue dispatch」；
- 提示 `board.drawer.reworkHint`：「会通知指挥官基于批注继续派发（原会话或新工作区/会话）」；
- 输入框 placeholder：「批注（≤1000 字）：要修正或深入的点，指挥官会转成本轮要求」；
- 提交按钮：「提交继续派发」；
- 成功 toast：「已通知指挥官继续派发」（不再是「任务回到进行中」）；
- `task.pendingInstruction` 存在时，review footer 显示一条等待提示：「已请求继续派发，等待指挥官处理：<批注>」；
- 提交中禁用按钮，防双击；
- `BoardPage` 的 `onRework` 改名语义沿用（只改调用与文案），`store.reworkTask` 的 notice 文案同步改。

### 8.5 指挥官 prompt 变更（`src/host/session/prompt.ts`）

新增/修改：

1. 收到 `[task-continue]` 注入时：读批注，调 `commander_task_dispatch({taskId, instruction:<批注>, requestId:<新ID>})`；默认推荐原会话，用户要求换工作区时传 `candidate`；不要直接给工作会话发消息（也没有这个工具）。
2. `review` 任务允许 `commander_task_dispatch`：Host 会把任务切到第 N+1 轮，上一轮验收进历史；不要用 `commander_task_update` 手动改状态来「继续」。`commander_task_update` 现在只接受 action enum（edit/set_dependencies/block/cancel/recover），且必须带 `expectedRevision`。
3. `queued/running` 任务不得派发；先 `commander_task_list` 确认状态。
4. 新一轮结束后仍用 `commander_task_report` 整理**当前轮主会话**的报告；旧会话的报告会被拒绝。
5. 收到 `[session-reply]` 时若用户此前要求深入分析且任务在 review，可主动提议续派，但必须走确认。

---

## 9. 多工作区 / 多会话

### 9.1 字段语义

| 字段 | 语义 |
|---|---|
| `workspaceId` | **当前轮**目标工作区（沿用字段，语义收紧） |
| `workspaceIds` | 本任务涉及过的全部工作区（去重） |
| `primarySessionId` | **当前轮**的主会话；`commander_task_report` 的当前轮校验用它 |
| `assignments` | 所有轮次用过的会话 id（去重，历史保留） |
| `sessions` 表 | 每个会话一条 link；link 的 `round` 标记它属于哪一轮 |

### 9.2 跨轮次会话隔离

- `findWorkLink` / 注入器：只认 `link.round ?? 1 >= task.round ?? 1` 的 link；
- 旧轮次会话即使被用户手动打开并运行，也不会把状态/回复算到当前轮（turn/start 不会把任务从 queued 拉 running，turn/end 不会注入指挥官）；
- 如果用户希望回到旧会话继续，指挥官显式 attach 该会话：link 的 `round` 更新为当前轮，之后它重新成为可监控会话。

### 9.3 UI

- 抽屉「关联会话」显示 `工作区名 · 会话标题 · 第 N 轮`，当前轮高亮；
- 看板卡片显示「第 N 轮」；「涉及 N 个工作区」可选，后置。
- 「打开会话」仍打开 `primarySessionId`（当前轮）。

---

## 10. API / SSE / Client 变更清单

| 层 | 变更 |
|---|---|
| `GET /commander/state` | `TaskView` + `round`、`pendingContinue`；`pendingDispatch` + `kind`、`round` |
| `GET /commander/tasks/:id` | + `task.round`、`acceptanceHistory`、`pendingInstruction`、`sessions[].round`、`reportSummary.round`、`dispatches[]`（全部轮次；`dispatch` 仍为最新一条） |
| `POST /commander/tasks/:id/accept` | 清理 pending decision / pendingInstruction；timeline 带 round |
| `POST /commander/tasks/:id/continue`（`/rework` 别名） | 新行为：只写批注 + 通知指挥官，不改状态 |
| `PATCH /commander/board/tasks/:id` | 状态改 cancelled 时清理 pendingInstruction / pending decision（可选） |
| `POST /archive` / `restore` | archive 清理 pendingInstruction / pending decision；restore 保持 round/history |
| SSE `task.updated` / `tasks.changed` | 通过 `buildTaskView` 自然带 `round/pendingContinue`；不新增事件 |
| SSE `dispatch.updated` | pending view 带 `kind/round` |
| Client `types.ts` | `TaskView.round/pendingContinue`、`TaskDetailView.round/acceptanceHistory/pendingInstruction`、`AcceptanceRoundView`、`PendingDispatch.kind/round` |
| Client `state.ts` | `normalizeTaskDetail` 解析新字段；`reworkTask` 保持路径，notice 文案改「已通知指挥官」 |
| Client `board.ts` | `TIMELINE_KINDS` + `continue`/`continue_request`；feed 类型；round 徽标 helper |
| Client `BoardPage.tsx` | footer 文案、等待提示、历史验收折叠区、确认卡轮次 |
| Client `DispatchCard.tsx` | 显示「继续派发 · 第 N 轮」与当前会话候选 |
| i18n | zh/en 两份字典同步新增 key（漏一份 `locales.test.ts` 会挂） |

---

## 11. 兼容与迁移

- 旧任务：`round` 缺省 1、`acceptanceHistory` 缺省 []、`sessionLink.round` 缺省 1；不需要重写 storage。
- 旧 timeline 的 `rework` / `dispatch` 记录原样展示；新记录用 `continue` / `continue_request`。
- 旧 HTTP 客户端若仍调用 `/rework`：命中兼容别名，行为已经变成「通知指挥官」，不会直接改状态；若客户端还是旧 UI，会显示「已返工，任务回到 running」，但 Host 实际是 review——**客户端与 Host 必须一起构建/刷新**（本插件本来就是双半 bundle，release 时按现有流程重装 + 硬刷新）。
- `createTaskActions.rework` 的旧测试、`m3-actions.test.ts`、`m23-e2e.mjs` 的 rework 断言都要改成新契约（见 §12）。

---

## 12. 测试分层与验收

### 12.1 Host 单元 / 集成（`pnpm --filter dsh-commander test`）

| # | 用例 | 旧代码应失败 |
|---|---|---|
| 1 | `schema`：round/acceptanceHistory/pendingInstruction/workspaceIds 可选校验；旧记录仍 valid | 是 |
| 2 | `state`：`buildTaskView.round`、`acceptanceCount` 只算当前轮 | 是 |
| 3 | 派发门禁：review 允许；queued/running/blocked/done/cancelled/archived 拒绝 `task_state` | 是（review 当前被拒） |
| 4 | review 首次调用 → `needs_confirmation`，**状态仍 review**，decision.kind=continue、round=N+1、默认候选=原会话 attach | 是 |
| 5 | 确认 → status=queued、round+1、上一轮 acceptance 进 history、当前 acceptance=[]、pendingInstruction 清空、workspaceIds 追加、link.round=新轮 | 是 |
| 6 | 显式 candidate 新工作区/new session → workspaceId/primarySessionId 更新、workspaceIds 含两个工作区 | 是 |
| 7 | 续派 spawn 失败 → blocked、round 不变、history 不变、pendingInstruction 保留 | 是 |
| 8 | 续派复用 autoDispatch：开关打开且分数高 → 直接 dispatched 并开第 2 轮；开关关闭 → needs_confirmation | 是 |
| 9 | `commander_task_report` round 2：写当前验收、reportSummary.round=2、status=review | 是 |
| 10 | `commander_task_report` 用旧会话（round 1 link）→ `conflict(stale_session)` | 是 |
| 11 | `accept`：当前轮验收；timeline round；history 保留；pendingInstruction 清空 | 是 |
| 12 | `continue` 路由：review→写批注+timeline、状态不变、向指挥官投递 `[task-continue]`；投递失败 502 但批注保留；pending decision 存在时 409 | 是 |
| 13 | 注入/状态：旧 round link 的 turn/start、turn/end 不影响当前轮；当前 link 正常 | 是 |
| 14 | 幂等：同 decisionId 回放；同 requestId 回放；accept 后确认 → task_state | 是 |
| 15 | `commander_task_update` 不再接受裸 status；review→running 只能走 dispatch/recover | 是 |
| 16 | 历史上限：第 6 轮续派后 history 只保留最近 5 轮 | 是 |
| 17 | `DispatchRecord.brief` 等于实际发出的 brief；`userRequest` 从参数/批注写入；详情 `dispatches[]` 按 round 齐全 | 是 |
| 18 | 旧记录无 brief/userRequest 时页面降级标签（Host 返回缺省、不伪造） | 是 |

### 12.2 Client 单元 / harness

- `tests/client/board.test.ts`：round 徽标、历史验收分组、`continue`/`continue_request` feed。
- `tests/client/state.test.ts`：`normalizeTaskDetail` 新字段。
- `tests/client/locales.test.ts`：zh/en key 同改。
- `BoardPage` 渲染：review footer 等待提示、历史折叠、提交中禁用。
- `DispatchCard`：kind=continue 时显示轮次。
- `node packages/dsh-commander/tests/client/harness/run-harness.mjs`。

### 12.3 e2e

新增/改造 `tests/e2e/m5-continue-e2e.mjs`（隔离 `DSH_HOME` + stub 模型）：

1. 建任务 → 首次派发 → 工作会话回复 → `commander_task_report` → review（round 1）；
2. 看板 `POST /continue` → 指挥官收到 `[task-continue]`；
3. 指挥官 `commander_task_dispatch(taskId, instruction)` → 确认卡（round 2、原会话）→ 确认 → queued；
4. 工作会话收到 brief（含「本轮要求」「上一轮结论」）；
5. 回复 → 注入 → `commander_task_report` → review（round 2，验收历史 1 轮）；
6. `accept` → done；
7. 另一路：round 2 选新工作区/new session → 旧会话 turn/end 不注入、不把任务拉 running。

旧的 `m23-e2e.mjs` rework 段改成新语义（或直接由 m5 e2e 覆盖，m23 只保留 accept）。

### 12.4 验收标准

- typecheck 全绿；
- Host 全量单测/集成全绿（含新增用例）；
- Client 单测 + harness 全绿；
- `pnpm --filter dsh-commander build`；
- m5 e2e 全绿 + m23 回归全绿；
- 用户 live 走查：搜索任务 → review → 看板继续派发 / 聊天里追加分析 → 确认卡 → 新一轮 → 验收。

---

## 13. 实施顺序与工作量

| 步骤 | 内容 | 预估 |
|---|---|---|
| 1 | 本契约确认后合并到 `implementation-plan.md` §6/§9/§10/§11/§13 | 0.3d |
| 2 | Host schema/store/state/session link round/状态机 | 0.5d |
| 3 | dispatch service + decisions + brief + spawn + finishDispatch | 1d |
| 4 | taskActions/continue 路由/注入/prompt | 0.5d |
| 5 | Client types/state/board/drawer/DispatchCard/i18n | 0.5d |
| 6 | 单测/集成/e2e/harness | 1d |
| 7 | build + 用户重装/重启 + live 走查 | 0.3d |

合计约 **3–4 个开发日**（不含用户 live 走查等待）。Host 改动需要重装 + 重启；Client 改动需要硬刷新。

---

## 14. 已确认的决策（2026-11-20，按推荐实现）

| # | 决策 | 结果 |
|---|---|---|
| D1 | 续派是否复用 `autoDispatch` 门控 | **是**（2026-11-20 反馈：100% 不应强制审核）；开关关闭/门控不通过仍需确认 |
| D2 | 路由名：新增 `/continue` 并保留 `/rework` 别名，还是只改 `/rework` 语义 | **新增 `/continue` + 别名**（文档/UI 统一叫继续派发） |
| D3 | `acceptanceHistory` 保留几轮 | **5 轮** |
| D4 | `blocked` 任务是否允许续派 | **否**（先把状态改回可派发；避免「阻塞原因未解决又开一轮」） |
| D5 | 是否本轮加 `workspaceIds` 与轮次徽标 | **是**（跨工作区是明确需求；看板卡与轮次导航显示第 N 轮） |
| D6 | 历史验收是否也挂到抽屉 feed 的每个 report 行 | **第一期只做抽屉折叠区**；feed 挂接作为后续增强 |
| D7 | 看板续派请求与待确认卡冲突时 | **409 拒绝**，提示先处理确认卡 |
| D8 | 是否允许 `commander_task_update` 修改 `goal` | **否**（本轮要求走 `instruction`；避免改任务定义） |

---

## 15. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 旧轮次会话打扰当前轮 | link.round 过滤 + 只看当前轮主会话的 commander_task_report |
| 上一轮验收被误当成当前轮 | 续派时归档 + 清空；门禁只读当前 acceptance |
| 记录变大 | history ≤5 轮、brief/instruction 截断、timeline ≤100 |
| 双击续派重复通知 | requestId LRU + 提交中禁用 |
| 确认卡与续派请求竞态 | 有 pending decision 时 409 |
| 旧客户端/旧 Host 混跑 | 双半一起构建；`/rework` 别名兜底；release note 写明需重装+硬刷新 |
| 恢复回收站/取消后状态怪异 | 续派判定用 `hasPriorRound`（round>1 / 有验收 / review），避免旧验收漏归档；此边界在实现时补一条单测 |

---

## 16. 代码改动清单（按文件）

> 仅列改动点，具体实现以本契约为准；契约合并后再动代码。

### Host

| 文件 | 改动 |
|---|---|
| `src/host/schema.ts` | `TaskRecord.round/acceptanceHistory/pendingInstruction/workspaceIds`；`AcceptanceRound`；`ReportSummary.round`；`DispatchRecord.round/kind/instruction`；`SessionLinkRecord.round`；`TaskTimelineItem` 新类型 + `round`；`TASK_TRANSITIONS` 去掉 `review→running`；校验器 |
| `src/host/dispatch/decisions.ts` | `PendingDecision.kind/round/instruction`；`DecisionStore.invalidateTask` |
| `src/host/dispatch/service.ts` | 允许 `review`；`hasPriorRound` 判定；review 默认原会话候选；review 的 needs_confirmation 不改状态；auto 跳过续派；确认路径重读 + 合并 instruction/userRequest；`finishDispatch` 轮次/历史/清空/workspaceIds/link.round；`DispatchRecord` 写 `brief/userRequest`；返回 `round/kind` |
| `src/host/dispatch/brief.ts` | 续派 brief 三段（本轮要求 / 上一轮结论 / 上一轮验收项）；截断 |
| `src/host/dispatch/spawn.ts` | 把 instruction/previous 信息传给 brief |
| `src/host/tools/index.ts` | `commander_task_dispatch.instruction` / `userRequest` 参数；输出 `round`；`commander_task_report` 当前轮会话校验 + `round` 写入；`commander_task_update` 改为 action enum + expectedRevision，状态写入统一走 state-machine |
| `src/host/tasks/actions.ts` | 删除旧 rework 直接 prompt；新增 `requestContinue`（写批注 + 通知指挥官）；`accept` 清理批注/决策、timeline 带 round |
| `src/host/api/routes/handlers.ts` | 详情返回 round/history/pendingInstruction/sessions.round/**dispatches[]**；`taskSummary` 补 round；`POST /continue`（`/rework` 别名）；accept 后清理 pending |
| `src/host/api/server.ts` | 动态路由正则加入 `continue`；ApiDeps 若需暴露 pending 清理回调 |
| `src/host/api/state.ts` | `TaskView.round`、`pendingContinue`；`buildTaskView` 派生 |
| `src/host/trigger/status.ts` | `findWorkLink` 跳过旧 round link |
| `src/host/trigger/injection.ts` | `workLinkOf` 跳过旧 round link |
| `src/host/index.ts` | `createTaskActions` 注入 `deliverer`；accept/cancel/archive 清理 pending decision 的装配 |
| `src/host/session/prompt.ts` | `[task-continue]` 处理、review 可续派、当前轮报告、运行中不可派发 |

### Client

| 文件 | 改动 |
|---|---|
| `src/client/types.ts` | `TaskView.round/pendingContinue`；`TaskDetailView.round/acceptanceHistory/pendingInstruction`；`AcceptanceRoundView`；pending dispatch `kind/round` |
| `src/client/state.ts` | `normalizeTaskDetail` 新字段；`reworkTask` notice 文案；请求路径可保持 `/rework` |
| `src/client/board.ts` | feed 类型 `continue`/`continue_request`；round/历史 helper；`TaskFeedKind`；按 `dispatches[]`/`rounds[]` 分组 |
| `src/client/BoardPage.tsx` | 标题优先头部（去掉四段进度条）；轮次导航；每轮「用户原话 → 派发内容（brief）→ 会话 → 报告/验收」；历史轮折叠；review footer 文案/等待提示/历史验收折叠/提交中禁用 |
| `src/client/DispatchCard.tsx` | 续派轮次展示 |
| `src/client/locales.ts` | zh/en 同步新增 key |
| `src/client/styles.ts` | 历史验收/轮次徽标/等待条样式（如需） |

### 测试 / 文档

| 文件 | 改动 |
|---|---|
| `tests/unit/{schema,state,dispatch-core,report-tool,tools,injection}.test.ts` | 新增/改造用例 |
| `tests/integration/{dispatch,m3-actions,m2-board}.test.ts` | 续派、continue 路由、accept/归档清理 |
| `tests/client/{board,state,locales}.test.ts` + harness | 新字段/新文案/渲染 |
| `tests/e2e/m5-continue-e2e.mjs`（新增）+ `m23-e2e.mjs`（改 rework 段） | 端到端 |
| `docs/architecture/implementation-plan.md` §6/§9/§10/§11/§13 | 契约合并 |
| `docs/HANDOVER.md` | 完成后追加 hotfix/功能记录与 live 证据 |

---

## 17. 回滚与兼容说明

- 新字段全部可选：旧代码读取新记录不会因校验失败（校验器只检查已知字段），但**旧代码不理解轮次**——round 2 且当前验收为空的记录在旧代码里会被 review 门禁判为「无验收」。因此**不支持 Host 回滚后继续跑**；回滚必须同时回滚 storage 或接受语义不一致。
- 正常发布是双半一起构建；`/rework` 别名只解决旧客户端路由 404，不解决旧客户端语义。
- 数据备份：`~/.dsh/storages` 的 commander 域记录在升级前由用户自行备份（安装脚本不自动改 live）。



---

## 18. 页面设计（2026-11-19 先行稿）

> 原型：`prototype/task-detail-multiround/`（`?expand=1` 展开第 1 轮、`?compose=1` 打开继续派发；截图在 `shots/`）。
> 这一节是 §4.8 / §10 的 UI 依据；实现时以原型为视觉基线。

### 18.1 结构

```text
标题（第一行，可编辑）
状态 · 第 N 轮 · 当前工作区（本轮） · 优先级 · 工作区数 · 更新时间
目标（2 行，可展开）
[第 1 轮 · 已完成] → [第 2 轮 · 待验收]                    共 N 轮
────────────────────────────────────────
第 1 轮 · 目标/时间/验收数（历史轮默认折叠；保留用户原话首句 + 验收数）
第 2 轮（展开；顶部导航标「当前」）
  用户原话（指挥官会话 / 看板·继续派发）
  派发 → 目标 + 工作会话收到的原文（brief，可展开）
  工作会话卡（打开会话）
  整理报告 + 结论 + 验收
  现在 · 状态
────────────────────────────────────────
继续派发 / 通过验收
继续派发 composer（原会话 / 新工作区；只通知指挥官）
```

### 18.2 关键决策

1. **标题第一**：删除任务级四段进度条；状态/工作区/轮次下移到 meta 行。原因：窄窗（506px）下标题必须第一眼可见，轮次状态由轮次头和看板列表达。
2. **轮次编年**：每轮一个 section；历史轮默认折叠为摘要（含用户原话首句），当前轮展开；顶部轮次导航可跳转。原因：单线混排无法表达「第几轮、哪一轮的验收」。
   - **轮次不带任务状态**：`完成 / 待验收 / 进行中` 只属于整个任务，统一在顶部状态 chip 与「现在」行表达；轮次头只写编号、目标、时间范围、验收数，当前轮在顶部轮次导航里用「当前」标记。
3. **用户原话一等公民**：每轮开头固定「用户原话」块，来源区分聊天/看板；不做总结。原因：多轮语义的起点必须可追溯。
4. **派发内容一等公民**：派发卡正文 = `DispatchRecord.brief` 原文，默认 4–5 行折叠；Jev/候选/确认时间降级为卡底 details。原因：用户要判断「这一轮到底要求了什么」。
5. **工作区/会话按轮归属**：派发行写 `工作区 · 新建会话 / 原会话`；会话卡带轮次；历史轮会话不与当前轮混排。
6. **继续派发语义**：review 底部 composer 明确「第 N+1 轮」「任务保持待验收，指挥官确认后才真正派发」，目标可选原会话/新工作区；提交只通知指挥官。原因：与「返工统一为续派」的产品口径一致。
7. **看板卡显示轮次，不显示验收 N/N**：卡片只回答「第几轮、哪个工作区、何时」；`验收 N/N` 在 review 下恒为满分、信息量为零，且容易被误读为任务级状态。验收数留在详情页；`round=1` 用中性徽标，`round>1` 用品牌色。

### 18.3 依赖的字段

- `DispatchRecord.brief`（必填，落库实际 brief）；
- `DispatchRecord.userRequest`（可选，聊天参数或看板批注）；
- `GET /tasks/:id` 的 `dispatches[]`（全部轮次）；
- M5 的 `TaskRecord.round/acceptanceHistory`、`SessionLinkRecord.round`、`reportSummary.round`。

### 18.4 打开问题（与原型 README 同步）

1. 历史轮默认折叠 vs 全部展开：推荐折叠。
2. 用户原话显式传入 vs Host 自动抓：推荐显式传入（`commander_task_dispatch.userRequest`），批注走 `pendingInstruction`。
3. 工作会话原始回复是否进页面：推荐「指挥官归纳的结论 + 打开会话」，不把详情页变成聊天记录。
4. 长标题是否限制 2 行：当前不限制，可后续加 tooltip。


---

## 19. 取消任务停止关联会话（2026-11-20 live 反馈）

- `commander_task_update({action:'cancel', expectedRevision})` 与看板 `POST /commander/tasks/:id/cancel` 都会先调用 `sessionController.cancel({sessionId})`，只针对该任务 `role=work` 且 `status∈{running,queued}` 的会话（以及 running/queued 任务的 primary session）。
- 任一 cancel 失败 → 返回 `delivery_failed`，**任务状态不变**（避免「看板已取消、会话还在跑」）；已不存在/已停止的会话视为 `skipped`。
- 成功后在 timeline 写「已停止 N 个关联会话」；工具输出固定 `{taskId,status,version}`（不再有 `sessionsStopped`）。
- 测试：`tests/unit/task-cancel-sessions.test.ts`（成功停止 + 失败不取消）。

## 20. 实现与验证（2026-11-20）

### 19.1 实现落点

- **Host**：`schema.ts`（round/acceptanceHistory/pendingInstruction/workspaceIds/brief/userRequest/link.round/状态机）、`dispatch/service.ts`（review 续派、round+1、默认原会话、复用 autoDispatch 门控、brief/userRequest 落库、history 归档、workspaceIds、版本冲突重试）、`dispatch/brief.ts`、`dispatch/spawn.ts`、`dispatch/decisions.ts`（kind/round/invalidateTask）、`tools/index.ts`（commander_task_dispatch instruction/userRequest + 输出 round、commander_task_report 当前轮校验）、`tasks/actions.ts`（requestContinue）、`api/routes/handlers.ts`（dispatches[]/acceptanceHistory/pendingInstruction/continue 路由）、`api/state.ts`、`trigger/status.ts` / `trigger/injection.ts`（旧 round link 过滤）、`session/prompt.ts`。
- **Client**：`types.ts`、`state.ts`、`board.ts`（`buildTaskRounds`）、`BoardPage.tsx`（标题优先头部、轮次导航、每轮「用户原话 → 派发原文 → 会话 → 报告/验收」、历史折叠、pending 续派卡、继续派发 composer、看板卡「第 N 轮」）、`DispatchCard.tsx`、`store.ts`、`locales.ts`、`styles.ts`。
- **看板卡**：`验收 N/N` 从卡片移除，改显示 `第 N 轮`（round=1 中性色，round>1 品牌色）；验收数留在详情页。

### 19.2 验证证据

| 项 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS |
| `pnpm --filter dsh-commander test` | **344/344 PASS**（新增 m5-continue 集成 6 条、取消停止会话 2 条；commander_task_report 轮次 1 条、client 轮次分组 2 条、review→running 禁止 1 条） |
| `pnpm --filter dsh-commander build` | PASS（client 387.9KB / window 484KB） |
| `node packages/dsh-commander/tests/client/harness/run-harness.mjs` | **173/173 PASS**（含 zh 字典、标题优先头部、轮次 section、无四段进度条） |
| `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS，0 FAIL，3 INFO**（新增 M5 continue 路由/注入断言） |

### 19.3 部署

- Host 改动 → `pnpm --filter dsh-commander build` 后**重装插件 + 重启 DSH**（安装是快照式，只重启不生效）。
- Client 改动 → 重装/重启后**硬刷新页面**；原生壳需重新 `build:native` 并重装（如需）。
- 存储零迁移：新字段全部可选，旧记录按 round=1 / 空 history 读取。

### 19.4 已知限制 / 未走查

- live UI 走查（真实多轮任务：review → 继续派发 → 确认 → 第二轮 → 验收）尚未由用户执行；隔离 e2e/harness 已覆盖 Host 语义与 DOM 装配。
- 续派复用 `autoDispatch` 门控：开关关闭或门控不通过时才确认；100% 且开关打开会自动开新一轮。
- `blocked` 任务不允许续派（D4）；要重试先人工改回可派发状态。
- continue composer 只提交批注；最终目标仍在派发确认卡里由指挥官/用户选择（与原设计一致）。
- 旧客户端（硬刷新前）看到的 `/rework` 仍可用，但语义已是「只通知指挥官」，显示文案可能滞后；发布时双半一起更新。