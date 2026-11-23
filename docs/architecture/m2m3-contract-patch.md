# M1 余项 + M2 看板 + M3 闭环 · 实现契约补丁

> 版本：v1.0　日期：2026-11-18 09:40（Asia/Shanghai）
> 状态：**实现期契约补丁（M1 收尾 / M2 / M3），在合并前即实现口径**；Lead 批准后由 architect 合并回 `implementation-plan.md` §8/§10/§11 与对应 patch。
> 依据：`docs/NEXT-PHASE.md` §4（M2/M3）、`docs/PRODUCT-DESIGN.md` §6/§9/§11/§13、`docs/ARCHITECTURE.md` §3（记录）/§4（工具）/§6（状态机）、`docs/architecture/implementation-plan.md`、`m1-contract-patch.md`、`m0-contract-patch.md`。
> 约束：不改冻结决策/判据/冻结文档；不写实现代码；**用户决策**保持 `autoDispatch=false` 全确认模式，M1-5 指标豁免（V5 FAIL 仍保留，不得表述为 PASS）。
>
> **2026-11-22 定案更新**：任务状态机/工具/看板口径以 `docs/architecture/task-state-machine-final.md` v1.0 为准。本文中「五列」「看板 PATCH 可改 status」「commander_task_update 可传 status」「rework 直接 review→running」等表述已被取代；当前实现为六列、无拖拽、action enum + expectedRevision、人专用 cancel/archive/restore/accept。

---

## 0. 一页摘要（给 backend/frontend）

| # | 主题 | 唯一口径 |
|---|---|---|
| 1 | M1 余项（自定义 attach） | 新增只读 `GET /commander/sessions?workspaceId=…`；`confirmTarget{mode:'attach',sessionId}` 校验"会话存在 + cwd 属于该工作区 + 非归档/非子代理"；**同工作区多任务可 attach（记录 assignment，不锁、不做并发控制，排队交给 prompt queue）**；attach **不调用能力面板**。 |
| 2 | M2 看板 | Client 在 `main` keyed 注册 **`commander-board`** 整页；六列映射见 §2.2（**无状态拖拽**）；`PATCH /commander/board/tasks/:id` **只改 priority/title** + `board_edits` → **30s 合并 + 幂等 `[board-edit]` 注入指挥官**；`/accept|archive|restore|cancel` 为人专用路由；`stale`（>20min 只读）；`GET /commander/tasks/:id` 补 boardEdits/依赖派生字段。 |
| 3 | M3 闭环 | `turn/end` 最后回复注入（触发/去重/截断/pending/合并/补一次，详见 §3.1）；`commander_task_report` 工具（整理不评估）；**审批悬浮卡只在 Client**（同一 `PendingApproval`，`answerable` 守卫，Host 不碰）；人专用 `accept/archive/restore/cancel/continue`；播报由状态派生（无 `brief_user`、无 Host 调度）。 |
| 4 | 边界 | 不改任务记录 schema（只加展示派生字段）；不新增事件类型/表；不做原生壳/系统悬浮/scheduler/投影；`done` 仅 accept 路由；审批不进上下文/看板。 |

---

## 1. M1 余项：自定义确认 target=attach

### 1.1 新增只读路由 `GET /commander/sessions?workspaceId=<id>`

- 用途：确认卡「自定义选择」时列出目标工作区的已有会话（当前 M1 只展示 Jev 候选，缺任意会话选择能力）。
- 请求：query `workspaceId`（必填，1..128）；可选 `limit`（默认 50，最大 100）。
- 响应 `200`：
```json
{
  "ok": true,
  "workspaceId": "c83dde64-…",
  "sessions": [
    { "sessionId": "session-…", "title": "订单导出 · 流式改造", "lastActiveAt": 1763450000000,
      "contextUsage": 0.78, "model": "deepseek-flash", "archived": false, "agentPreset": "standard" }
  ],
  "truncated": false,
  "rev": 58
}
```
- 数据源：只读 **`ctx.get('sessionQuery')`/`sessions` 列表 + workspaceRegistry**（不建会话、不 resume、不 prompt）；按 `lastActiveAt` 倒序；`contextUsage`/`model` 缺失时省略（不伪造）。
- 过滤：该 workspace 的**顶层非归档**会话；排除子代理/team 子会话（有 subagent owner 的会话）；`limit` 截断时 `truncated:true`。
- 错误：`invalid_request`（缺/非法 workspaceId/limit）、`not_found`（workspace 不存在）、`internal`；**能力面板缺失不影响本路由**。
- 只读、不写盘；不进快照（按需拉取，避免快照膨胀）。

### 1.2 `commander_task_dispatch` 确认时 `confirmTarget{mode:'attach', sessionId}`

校验（唯一口径，按顺序）：

1. `sessionId` 非空；`GET` 同源只读校验会话存在；**不能是 commander 自身会话**（`config.commander.sessionId`）。
2. 会话为**顶层普通会话**（非 subagent/team 子会话）且**非归档**。
3. 会话的 cwd 属于 `target.workspaceId`（`workspacePath` 前缀/精确匹配按 workspace 记录；隔离环境无 registry 时允许按 workspaceId 记录，见 M0 兼容口径）。
4. **不检查"是否已被其它任务占用"**：同一工作区多任务 attach 同一会话是允许的；Host 记录 `task.assignments`/`sessions` link（多任务可指向同一 sessionId）；**不引入并发锁**，消息按 `sessionController.prompt(mode:'queue')` 排队（"queued" 语义由会话队列保证）。
5. attach **不调用能力面板**（沿用会话已有配置；`capabilities = {policy:'inherit', executor:'capability-panel', status:'inherited'}` 或直接不写 plan）；失败码 `invalid_target`（原因见 message）。
6. attach 成功：`sessions` link `{role:'work', mode:'attach', status:'queued'}` + `task.assignments` 去重追加；`primarySessionId` 设为该会话（同任务改派时更新，旧 assignment 保留）。

> 与当前实现的关系：现有 `findTargetConflict` 的"占用冲突拒绝"应**放宽为上述 1–3**（当前会阻止合法自定义 attach）；这是 M1 余项的唯一行为变更。

### 1.3 自定义卡消息模板（Client→指挥官，沿用 `[dispatch-confirm]`）

```text
[dispatch-confirm] 自定义
decisionId=dec_<24hex> taskId=task_<…>
target=workspaceId:<ws>;mode:attach;sessionId:<sid>
```

- Client 仅 `POST /commander/message` 发此普通消息；不新增确认路由；消息里的 workspace/session 来自 `GET /commander/sessions`（或候选列表）。「采用建议」模板不变；「取消」不变。
- 指挥官 prompt 约束沿用 `m1-contract-patch §2.2`：收到 `[dispatch-confirm]` → 调 `commander_task_dispatch({taskId, decisionId, confirmTarget:{workspaceId,mode,sessionId}, requestId:新ID})`；`decision_expired` → 重新完整派发。

### 1.4 M1 余项验收

- e2e：`GET sessions` 200 且返回目标工作区会话；自定义 attach 确认 → `dispatched`、`sessionCreated=false`、任务 `queued`、`turn/start` 后 `running`；同会话二次 attach 其它任务被允许且两条 assignment 都存在；archived/subagent 会话 → `invalid_target`；attach 路径**无面板调用**（panel mock 计数 0）。
- 证据并入 `docs/validation/m1-accept.md` 追加节。

---

## 2. M2 看板契约

### 2.1 入口与槽位（Client，禁止替换 root/sidebar）

- 在 **`main` keyed 槽**注册整页：`ctx.slots.register({name:'main', id:'commander-board', order:40, label:()=>t('board.title'), inject:…}, BoardPage)`（`main` 为 keyed 槽，`conversation` 保留 key；**不得**注册 `root`/`sidebar`/`shell.overlay` 替换）。
- 打开：面板头部「看板」按钮 → `ctx.layout.selectPanel('commander-board')`；看板页「返回对话」→ `ctx.layout.selectPanel('conversation')`。
- 移动端/窄宽：六列横向滚动（CSS overflow-x），不做响应式重排（M2 最小）。
- 侧栏入口：可选（`sidebar.panellist` 的 list 添加一条），**M2 非必需**；入口形态最终由用户决定（主面板整页为默认建议）。
  - **补充（2026-11-19，用户裁决「在 DSH 侧栏这个位置补任务看板入口」）**：已实现并在 live 可见。`sidebar.panellist` 追加一条 `id:'commander-board'`、`order:40`（已发布行顺序：插件 0、自动化任务 10、上下文洞察 20、能力面板 30；40 即紧随能力面板、位于侧栏「更多」之上）。注册组件只渲染图标本体（`size` 由侧栏给 16/18px，`currentColor`），可见文本/`aria-label`/折叠 tooltip/选中态均由 ui-sidebar 渲染，label 取新 key `board.nav`（任务看板 / Task board）。`sidebar.panellist` 的 `id` 与 `main` keyed key 必须同值，否则点击会 `selectPanel` 到不存在的面板而抛错。实现：`src/client/board-nav.ts`（注册契约，纯 TS 便于单测）+ `src/client/BoardNavIcon.tsx`（内联 SVG，零运行时依赖）；回归：`tests/client/nav.test.ts` + harness `smoke.mjs`（id/main key 一致、order、label、图标 SSR）。

### 2.2 六列映射（唯一，2026-11-22 定案）

| 列 | 任务状态 | 排序 |
|---|---|---|
| 待派发 | `draft`、`proposed` | `updatedAt` 倒序；有待确认卡（`pendingDispatch`）置顶并高亮；waitingFor 显示「等待 A 验收」 |
| 待运行 | `queued` | `lastActivityAt` 倒序；stale 徽标 |
| 运行中 | `running` | `lastActivityAt` 倒序；stale 徽标 |
| 受阻 | `blocked` | `block.since` 倒序；卡片显示 code/reason |
| 待验收 | `review` | `updatedAt` 倒序；卡片显示 acceptance 条数/证据不足数/继续派发 badge |
| 已验收 | `done` | `updatedAt` 倒序 |
| 回收站（页签/抽屉内） | `archived`、`cancelled` | 独立「回收站」页签（不是列）；archived 可恢复 |

- 卡片字段（最小）：`title`、`workspaceName`、`status`、`priority`、`capability` 摘要、`stale` 徽标、`blocked` code/reason、`dependsOn/waitingFor/ready`、`pendingDispatch`、`pendingContinue`、`sessionCount`、`updatedAt`；操作只保留「打开会话/取消/归档」（review 另有验收/继续派发）。
- **不做状态拖拽**；状态推进通过 commander 工具或人专用按钮。
- 看板不放审批/提问（冻结决策：审批不进看板）。

### 2.3 快照字段增补（只加展示派生字段，不改任务记录 schema）

`GET /commander/state` 的 `tasks[]` 每项追加（只读派生，不写盘）：
```json
{ "stale": true, "sessionCount": 2, "acceptanceCount": 3, "evidenceInsufficientCount": 1,
  "version": 12, "dependsOn": ["task_a"], "waitingFor": ["task_a"], "ready": false,
  "pendingDispatch": false, "pendingContinue": false,
  "archiveSummary": { "archivedCount": 2, "cancelledCount": 1 } }
```
- `stale`：`status ∈ {queued,running}` 且 `now - lastActivityAt > 20min` → true（**只读**；不改状态、不轮询、不注入）。
- `archiveSummary` 仅快照顶层给全局计数；成本低（域内已加载）。
- `tasks` 默认只含非 `archived`（≤200，`updatedAt` 倒序）；回收站数据由 `GET /commander/archive` 拉取（§2.5）。
- `counts` 增加 `cancelled`、`archived`（现有 counts 已含则不变）。

### 2.4 `PATCH /commander/board/tasks/:id`（人工改动）

请求（**只允许元数据**）：
```json
{ "field": "priority", "value": "high", "editId": "edit_<32hex>", "requestId": "req_…" }
```
- `field ∈ {'priority','title'}`；`value` 按字段校验（priority ∈ low/normal/high/urgent；title 1..200）。
- `field='status'` 一律 `invalid_request`（400，或兼容实现 409）；状态推进走 `/accept|archive|restore|cancel` 与 commander 工具，**不再接受拖拽改状态**。
- 写：一次 `tasks.update`（priority/title + `updatedAt` + timeline `{type:'user_edit'}`）；**另写 `board_edits` 一条** `{v:1,id:editId,taskId,field,before,after,actor:'user',at}`；`version` 乐观并发（冲突重试 ≤3 次）。
- **异步注入指挥官**（§2.6）：本路由**不等待注入**；返回：
```json
{ "ok": true, "task": { …更新后的任务摘要+详情字段… }, "boardEdit": { "editId": "…", "injectedAt": null }, "rev": 61 }
```
- 幂等：同 `editId` 重复提交返回首次结果（不重复写/不重复注入）；`requestId` 沿用全局 5min LRU。
- 错误码：`invalid_request`、`not_found`、`conflict`（状态机/前置条件）、`storage_error`、`internal`。
- **单向**：看板→指挥官；指挥官改看板直接写（工具 `commander_task_update`），不再反向注入用户。
- 不注入审批/提问内容；不写事件表。

### 2.5 归档 / 恢复

- `POST /commander/tasks/:id/archive`：允许源状态 `review|done|cancelled`；写 `status='archived'`、`archivedFrom=<原状态>`、`archivedAt=now`、清 pending、timeline 压成一条摘要；`review` 来源还要提醒依赖它的 draft/proposed 后继（`[task-dependency-blocked]`）；其他源状态 → `conflict`。
- `POST /commander/tasks/:id/restore`：仅 archived；按 `archivedFrom` 回 `review/done`，缺省/cancelled 来源回 `draft`；清 `archivedAt/archivedFrom/pendingInstruction/dependencyNotifiedAt`。
- `POST /commander/tasks/:id/cancel`：非终态 → cancelled；先停 running/queued 工作会话，失败不落状态；清 pending/block 并提醒依赖它的后继。
- `GET /commander/archive?limit=50&cursor=<updatedAt>`：回收站列表（`archived|cancelled`，按 `updatedAt` 倒序），返回 `{tasks:[摘要], nextCursor}`；只读。
- `POST /commander/tasks/:id/restore`：仅 `archived` → **`draft`**（唯一口径；保留原 acceptance/timeline 摘要/assignments；`archivedAt` 保留历史不删，timeline 追加 `{type:'status', text:'从回收站恢复为 draft'}`）；返回摘要；`cancelled` 不可直接 restore（用户需先改为 draft 需显式 PATCH，`conflict`）。
- 归档不进自动清理（不建 scheduler）；`archiveAfterDays` 配置 M3 之后再说（当前 board.archiveAfterDays=30 仅展示）。

### 2.6 人工改动注入（30s 合并 + 幂等）

- 触发：仅 PATCH 成功写 `board_edits` 后；**一次性 `setTimeout(30s)` 合并窗口**（不是 scheduler/轮询；无编辑则无定时器）。
- 合并：同任务 30s 内多条 edit 合并为一条消息；只保留**最终态**（同 field 取最后 after；不同 field 各一行）；`injectionKey = sha1(taskId + '\0' + sorted(editIds))` 记录在合并记录首条 `board_edits.injectionKey`（实现可只写首条，其余标 `mergedInto` 到首条 id——若不想加字段则仅在首条写 injectionKey）。
- 注入文本（发到指挥官会话，普通 user message）：
  ```
  [board-edit] taskId=<id> by=user
  title: <before> → <after>
  status: <before> → <after>
  请同步任务状态与后续跟进，不要回滚用户改动。
  ---
  editIds=<id1,id2> injectionKey=<key>
  ```
- 投递（2026-11-18 起）：**上下文消息**，不是用户输入——live 指挥官 Agent 上 `agent.followup({role:'user', content:[{type:'text', text:'<system-reminder>…</system-reminder>'}], source:{kind:'commander-board-edit', form:'notice', summary:'看板人工改动'}})`；DSH 聊天渲染成上下文卡、模型 prompt 里是 `<system-reminder>` 提醒。会话尚未 live（宿主刚重启）时回退 `sessionController.prompt({mode:'queue'})` 保证投递。成功后写各 edit `injectedAt`；失败**不重试风暴**——启动时/下次编辑时对 `injectedAt` 为空且 `at<now` 的记录补注入一次（最多一次），仍失败保留 `injectedAt:null` 等待下次。
- 不落盘消息正文（只把 editIds/key 写 board_edits）；不新增事件/表。

### 2.7 任务详情抽屉（`GET /commander/tasks/:id` 增补）

现有 M1 响应追加：
```json
"boardEdits": [ { "editId":"edit_…", "field":"status", "before":"review", "after":"blocked", "at":0, "injectedAt":0 } ],   // 最近 20 条
"archivedAt": 0,
"stale": false
```
- UI 抽屉分区：概览（title/goal/workspace/status/priority/时间/block）、决策记录（dispatch 详情）、验收内容（acceptance + evidence 状态，人可看不可改）、关联会话（sessions/assignments + 打开会话按钮）、时间线（≤100）、交付物（M3 起，本 M2 为空）、人工改动（boardEdits 摘要）。
- 只读；不返回 Jev Key/会话正文/审批内容。

### 2.8 实时同步（SSE；看板/详情**不得**依赖重启）

- **任何**任务记录写入都推 `task.updated {task:<整行 TaskView>, rev}` + 同一时刻的 `tasks.changed {counts, rev}`（面板头部状态 chip 读 counts；只推任务行会让 chip 停在旧状态，2026-11-18 用户反馈）（implementation-plan §8.4 的 `{task, rev}`）：指挥官工具（`commander_task_create`/`commander_task_update`/`commander_task_report`）、人工 PATCH、`turn/start|end` 的 `lastActivityAt/updatedAt`、派发状态。**禁止**只推 `{taskId,status}` 让前端猜其余字段。
- Client 收到整行后合并进 `tasks[]`；**已打开的详情抽屉**在该行 `updatedAt` 变新时重拉 `GET /commander/tasks/:id`（抽屉里的会话状态/时间线不在快照里）。
- `sessions[].status` 由 `turn/start|end` 维护；读取详情时，若记录是 `running` 但该会话已不在内存（Host 重启/会话已停止），按 `idle` 展示。`status` 与 `lastInjected` 必须用 `sessions.patch` 原子写——两条链路并发整条 upsert 会互相覆盖（实测把 turn/end 写的 `idle` 冲回 `running`）。

---

## 3. M3 闭环契约

### 3.1 `turn/end` 最后回复注入（trigger）

- **订阅**：`ctx.on('session/event', (session,event)=>…)`；仅 `event.type==='turn/end'`。
- **触发条件（全部满足）**：会话在 `sessions` 表有 `role:'work'` 绑定（有 taskId）；**任务状态 ∈ {running, review}**（只监控进行中/待验收；draft/proposed/queued/blocked/done/archived/cancelled 及任务缺失都不注入——验收完成或归档后工作会话的后续回合不关指挥官的事）；`event.data.reason.kind ∈ {completed,error,blocked,max-tokens}`（`aborted/interrupted` 跳过）；**无未配对 `approval/asked`**（最近一条 asked 无 decided）；`ctx.sessionProjections.snapshot(session).userQuestions.active.length === 0`；指挥官会话自身的事件忽略。
- **取最后回复**：在该 turn 区间内取 `assistant/message` 最大 seq；拼 text blocks；空文本 → 注入 `[session-reply] 本轮无文本回复`（常量；M3 不做配置项）。事件源必须用 `ctx.sessionQuery.readSession(sessionId)`（live 优先、冷会话读持久化；`sessions` 服务的 live `Session` 没有 `events` 字段，直接读恒空）。
- **格式（逐字）**：
  ```
  [session-reply] <最后回复原文>
  ---
  taskId=<id> sessionId=<id> turnId=<n> seq=<n> truncated=<bool>
  ```
- **截断**：整条注入（`[session-reply] ` 正文 + 截断标记 + `---` 元数据行）≤8192 字符（= 投递上限 `PROMPT_TEXT_MAX`，超了会被投递校验拒绝、长回复永远注不进）：正文超预算时保留头 6144 + `\n…[truncated N chars]…\n` + 尾（剩余预算，约 2KB 减标记与元数据行占用），`truncated:true`（与消息通道口径一致）。
- **去重**：键 `<sessionId>:<turnId>:<lastSeq>`；`SessionLinkRecord.lastInjected={turnId,seq,at}`；先投递成功再写；投递失败允许补一次（补一次后无论成败写 lastInjected，避免风暴）。写用 `sessions.patch(...)` 只改 `lastInjected`，不得整条 upsert（会覆盖同 turn/end 写入的 `status:'idle'`）。
- **合并/忙**：指挥官忙时排队，同 session 连续停止合并为一条（替换未发出的同 session 项）；不同 session 不合并。
- **投递形态（2026-11-18 起）**：上下文注入，不是用户消息。live 指挥官 Agent 上 `agent.followup({role:'user', content:[{type:'text', text:'<system-reminder>\n…\n</system-reminder>'}], source:{kind:'commander-session-reply', form:'relay', senderSessionId:<工作会话>}})`：DSH 聊天显示「收到执行请求 / 这条通知触发了本轮回复」的上下文卡（可展开看原文），模型 prompt 里是 `<system-reminder>` 提醒；不再产生用户气泡。会话未 live 时回退 `sessionController.prompt(mode:'queue')` 保证仍能触发一轮。
- **不注入**：审批/提问全文、tool/result、进度、中间流式；**不写任务记录**（注入本身不落任务 timeline；指挥官整理时才写）；**不轮询**（无 scheduler）。
- 观测：内存计数 `injections/deduped/pendingSkipped/injectFailures` 进快照 `metrics`。

### 3.2 `commander_task_report` 工具（M3 起对指挥官可见）

参数（照 `ARCHITECTURE §4.2`）：
```json
{ "taskId":"task_…", "sessionId":"session-…", "seqFrom":0, "seqTo":0,
  "outcome":"delivered|partial|blocked|no_progress",
  "acceptance":[{"text":"…","verify":"…","evidence":"…","derivedFromSeq":0}],
  "summary":"≤800 字；指挥官对最后回复的归纳（Host 原文落库，不核对来源）" }
```
- 行为：校验 task 存在/绑定会话匹配；`seqFrom..seqTo` 必须落在该 session 事件区间（只读取 session log）；每条 acceptance 的 `derivedFromSeq` 必须在区间内（缺失则 error）；写 `TaskRecord.acceptance`（state=`evidence_present` 若 evidence 非空，否则 `insufficient`）+ timeline `{type:'report'}` + `status = outcome∈{delivered,partial}?'review': (outcome==='blocked'?'blocked':'running')`；**不评估是否达标**。
- `summary` 落库：写 `TaskRecord.reportSummary={text,at}`（≤800 字，空串不写）；`GET /commander/tasks/:id` 详情透出该字段，看板抽屉「整理报告」行在验收清单上方渲染 summary 正文（缺字段=老数据，不渲染）。
- 返回：`{taskId, status, evidenceState:'complete'|'insufficient', insufficient:[text…]}`；错误 `invalid_request/not_found/conflict`（review 要求 ≥1 acceptance）。
- 调用自由：指挥官可先 `commander_task_update` 或直接 `commander_task_report`；工具全局注册、`when` 只对指挥官会话放行（与其它六个工具同机制）。

### 3.3 审批悬浮卡（**只在 Client**；Host 不碰）

- 数据源：`useSessionStatus(sessionId).pendingInteraction`（标准 hook，任意槽位可读）；对象为官方 `PendingApproval`（`answerable`/`answer(outcome)`/`delegate()`）。
- 渲染：对**任务关联的工作会话**（`GET /commander/state` 增补 `workSessions: [{sessionId, taskId, title?}]`，≤200，派生自 `tasks.assignments/primarySessionId` + `sessions` 表）在 `shell.overlay` 渲染精简卡；同一请求若主窗口已有官方卡，两处**显示同一实例**；先答者生效。
- 行为：`if (!pending.answerable) return`；`pending.answer('allowed-once'|'rejected')` → 成功后卡片消失；后答者 catch `already settled` 并静默移除；**不 abort**（abort=cancel 语义）；「打开会话」用 Client 现有会话打开动作（`ctx.layout.selectPanel('conversation')` + 选择该 session；具体 API 以 `cordis_inspect_query` 核对，UNVERIFIED 处标注）。
- `ask_user_question` 复用同一条 `pendingInteraction` 通道：官方 `PendingQuestion`（`kind='question'|'plan-review'`）带 `questions` + `answer({answers:[{id,selected,custom?}]})`。面板对**指挥官会话 + 任务工作会话**渲染精简问答卡（选项/多选/自定义/跳过/分页/提交），与主窗口合成器卡**共用同一实例**，先答者生效；成功后本地收起（防止投影清理一拍内重复提交），`already settled` 静默。「收起」只本地隐藏，不调用 `dismiss()`（不把主窗口座位卡收起）；「去会话作答」切到该会话。
- 硬约束：**不注册第二个 `approval/request` answerer**；不建 Host 仲裁；Host **不订阅/不转发/不落盘**审批内容；审批/提问不进指挥官上下文与任务记录；能力面板/命令面板的官方卡保持唯一消费者。
- 降级：若 `pendingInteraction` 不可读（官方审批插件被禁/结构变化），悬浮卡不显示，仅保留主窗口官方卡（不自行实现 answerer）。

### 3.4 人专用路由（2026-11-22 定案）

- `POST /commander/tasks/:id/accept`（仅人）：`review→done`，幂等；写 timeline `{type:'accept'}`；首次成功清该任务未决确认并提醒依赖它的 ready 后继。历史脏数据 `acceptance=[]` 仍允许收尾并标注「无验收项：历史数据」。
- `POST /commander/tasks/:id/archive` / `restore` / `cancel`：见 §2.5；只由界面调用，不注册为模型工具。
- `POST /commander/tasks/:id/continue`（`/rework` 兼容别名）：只写 `pendingInstruction`+timeline 并通知指挥官，任务保持 review；不直接 prompt 工作会话、不改任务状态。真正的续派由 `commander_task_dispatch` 确认路径完成（见 `m5-continue-dispatch.md`）。
- 不变量 `review ⇒ acceptance≥1` 由写入侧保证：`commander_task_report`（delivered/partial 空验收 → invalid_request）与 unified state machine（目标 review 且 acceptance<1 → precondition）。`commander_task_update` 已不接受 status；`done/archived` 只走上表人路由。

### 3.5 播报/徽标（派生，无 `brief_user`）

- 来源：快照 `counts` + `pendingDispatch!=null` + 各任务 `review/blocked` 计数 + 审批 pending 数（Client 侧从 `workSessions` 的 `pendingInteraction` 聚合）。
- 派生规则：`pendingDispatch`→球角标「待确认」；`review>0`→「待验收」；`blocked>0`→「受阻」；审批 pending→「待审批」；同屏只显示最高优先级一个角标 + 面板列表。
- 合并/节流：Client 60s 节流、可静音（`ui` 增补 `broadcast:{enabled:true,throttleMs:60000,muteUntil?:number}`）；**无 Host 定时器/无事件表/无 `brief_user`/无独立通知通道**（M4 再做系统级）。

---

## 4. backend/frontend 任务拆分、顺序与验收证据

### 4.1 拆分建议

| 阶段 | backend（Host） | frontend（Client） | tester |
|---|---|---|---|
| **W1 M1 余项**（0.5d） | `GET /commander/sessions` 只读路由 + 快照无关；放宽 `findTargetConflict` 为 §1.2 校验；attach assignment 去重 | 确认卡「自定义选择」展开：工作区下拉 + 会话列表（新路由）+ 发送 `[dispatch-confirm] 自定义` 消息 | 并入 m1-accept 追加：sessions 路由/自定义 attach/无面板调用 |
| **W2 M2 后端**（1d） | `board_edits` 仓储补 `listByTask`/`injectionKey` 查询；`PATCH board`（校验/状态机/写 task+edit/幂等）；`/archive`、`/restore`、`GET /archive`；快照 `stale/sessionCount/acceptanceCount/archiveSummary`；`GET tasks/:id` 补 boardEdits；30s 合并注入器（一次性 timer） | — | 单测/集成：状态机、幂等、合并、失败补注入 |
| **W3 M2 前端**（1.5d） | — | `main` keyed `commander-board` 整页 + `selectPanel` 导航；六列/卡片/回收站/详情抽屉；无状态拖拽，取消/验收/归档按钮 → 人专用路由；stale 徽标；空态/加载/错误 | e2e：状态迁移、重启不变、30s 注入一次不重复 |
| **W4 M3 后端**（1d） | turn/end trigger（§3.1 全口径）+ `lastInjected`；`commander_task_report` 工具 + seq 校验；`accept/continue` 路由；快照 `workSessions`/metrics | — | e2e：注入去重/pending 过滤/8KB/合并；accept/continue/live |
| **W5 M3 前端**（1d） | — | 审批悬浮卡（`pendingInteraction`/answerable/answer/打开会话）；播报徽标；详情「交付物/验收」展示 | live 走查：审批双处同实例、先答生效、注入后看板更新 |
| **W6 收尾**（0.5d） | 回归全部测试、更新契约文档、live 安装/迁移说明 | 同 | `docs/validation/m2-accept.md`、`m3-accept.md` + 审计 |

> 顺序硬依赖：W1 →（W2 与 W3 可并行，但 W3 需 W2 接口形状冻结）→ W4 → W5；tester 每阶段末跑。

### 4.2 验收证据清单（`docs/validation/{m2,m3}-accept.md` 字段）

沿用 M0/M1 accept 格式，每项必须有：项目 ID（M2-x/M3-x）、结论（PASS/FAIL/UNVERIFIED）、操作者/时间、环境（origin、DSH 版本、插件版本/构建 sha）、步骤（可重放命令/点击序列）、原始证据路径（截图/JSON/SSE 日志）、限制。
- M2 必测：六列投影与计数；一条命令 `proposed→queued→running`；重启后看板不变；`PATCH priority/title` 后 30s 内指挥官收到 `[board-edit]` 一次且不重复（`injectionKey`/`injectedAt` 证据）；`PATCH status` 拒绝；archive/restore/cancel；stale 徽标（伪造 `lastActivityAt` 单测即可）；详情抽屉各分区与五段进度。
- M3 必测：turn/end 注入只发最后回复、pending 不注入、去重、8KB 截断、指挥官忙合并；`commander_task_report` 写 acceptance/status=review、seq 越界拒绝；accept `review→done` 仅人；rework 投递 brief 且 `review→running`；审批双处渲染同请求、先答生效、后答 `already settled` 被吞、审批不进 state/tasks；播报角标派生与节流。
- 复跑命令：`pnpm --filter dsh-commander test`（≥142 + 新增）、`node packages/dsh-commander/tests/e2e/m2-e2e.mjs`、`m3-e2e.mjs`（新增）、`node tools/dev/client-repro.sh`（client UI）、`node tools/dev/verify-live-m0.mjs`（live，注意其 inject 断言待更新）。
- live 走查属用户/Lead（安装/重启用 §m0-live-install 规则；改 Host/新增文件必须重装+重启）。

### 4.3 不做项（M2/M3 明确排除）

原生壳/系统级悬浮/全局热键（M4）；scheduler/投影/事件表/`brief_user`/FTS；自动验收/自动返工；审批进上下文或看板；`done` 从 PATCH 直接置位；新增确认路由；把看板/播报做成 Host 定时行为。

---

## 5. 与现有契约的差异与待合并

| 位置 | 现状 | 本补丁 |
|---|---|---|
| `implementation-plan §8.2` 路由 | M1 无 sessions/board/archive/accept | 新增 `GET /commander/sessions`、`PATCH /commander/board/tasks/:id`（priority/title）、`POST /commander/tasks/:id/archive|restore|accept|cancel|continue`、`GET /commander/archive` |
| `§8.3` 快照 | 无 stale/workSessions/archiveSummary | 增补派生字段（不改记录 schema） |
| `§8.5` 错误码 | 无 delivery_failed 等 | M2/M3 使用 `conflict`；M3 增 `delivery_failed` |
| `§9`/`§10` 工具 | M1 四工具 | M3 增 `commander_task_report`；状态机 v1.0 增 `commander_task_get` 并收窄 `commander_task_update` |
| `§11` 验收映射 | M1 表 | 增 M2/M3 行（按本 §4.2 口径） |

**合并方式**：Lead 批准后由 architect 并入 `implementation-plan.md`，本补丁保留为细节契约；冲突以本补丁为准。

---

## 6. 不修改声明

不改 `docs/NEXT-PHASE.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT-DESIGN.md`、任何冻结判据/阈值；不写实现；不新增表/事件类型/scheduler/投影；审批保持"界面层唯一消费者"；V5 FAIL 与全确认模式不变（本补丁不启用 auto）。
