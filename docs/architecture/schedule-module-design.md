# dsh-commander 定时任务模块 · 方案设计

> 日期：2026-11-24（Asia/Shanghai）
> 状态：**方案设计（本轮只出方案，不实现、不改仓库代码）**
> 范围：定时需求（查资料 / 监控更新 / 检测）的规则表达、触发、看板呈现、数据模型、与 DSH 原生调度的关系、权限与分阶段落地。
> 依据：现有 task / dispatch / 看板 / 状态机契约；DSH 0.2.2-rc.2 的 `@deepseek-ai/dsh-schedule` 与 `@deepseek-ai/dsh-tool-schedule` 源码；本机 `~/.dsh/storages/schedule.json` 的真实任务样本。
> 读法：**Fact** = 已核对源码/存储/契约；**建议** = 本文提出的设计；**待确认** = 需要用户拍板的产品/排版问题（见 §17）。

---

## 0. 一页结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 定时规则与时区 | **规则引擎完全复用 DSH 原生 `ctx.schedule`**：`at`（单次）/`every`（固定间隔，最小 60s）/`cron`（5 段）/`rrule`（DTSTART+RRULE）/`daily`/`weekly`。commander 只做 UI 预设与字段映射，**不自写 cron/rrule 解析、不自己算 next run**。每条定时任务显式保存 IANA 时区；墙钟规则由原生处理 DST（缺口跳过、重叠取较早），commander 只做展示。 |
| 2 | 触发如何落到 task/dispatch | **包装原生，不建第二套调度**。原生负责计时与投递；commander 监听 `schedule/changed` 并读 `ctx.schedule.catalog()/view()` 的 `lastDelivery`，**幂等物化**一次触发（身份：scheduleId + occurrenceAt + attempt；messageId 用于对账）。v1 推荐 `direct` 模式（**需 Q1 拍板**）：原生直接把提醒投到**创建时显式绑定的工作会话/工作区**，这个投递就是派发，**不走 Jev、不逐次确认**；`authorize_then_direct`（首轮确认再自动）或 `confirm`（逐次确认）作为备选。 |
| 3 | 周期实例与轮次 | **一次触发 = 一条 run（运行记录），不是 TaskRecord 的一轮，也不是默认一个 TaskRecord**。run 只在“需要人处理/需要任务流水线”时**升级**为一个独立 TaskRecord（默认仅异常升级）。TaskRecord 的 `round` 继续只表示**返工轮次**，不承载周期。这样不破坏 `done` 只能人验收、`done` 是终态等不变量。 |
| 4 | 会话绑定与复用 | 三种直连目标：`attach`（固定会话，上下文连续）、`new_once`（首次触发建一个会话，之后复用）、`new`（每次新会话，适合独立查资料）。一个工作会话在同一时刻只允许一个活跃 `direct` 定时任务（原生按会话批处理 + commander 的 `sessions` link 单 taskId 约束）。`confirm` 模式的 native target 是指挥官会话；R1 换任时必须把 native target 重指到新指挥官会话。 |
| 5 | 失败/超时/重试/告警 | 事件驱动为主（`turn/end` 的 `reason ∈ completed/error/blocked/max-tokens/aborted/interrupted/forked`）+ **一个 60s 看门狗**（唯一新增定时器，只扫 commander 自己的 schedule/run，不轮询结果）。投递失败/目标会话归档/运行报错/超时/错过触发 → run 终态 + `[schedule-alert]` 注入指挥官 + 看板 health；连续失败 N 次自动暂停（熔断）。**不自动回答审批、不自动验收**。 |
| 6 | 看板呈现 | **不新增第 7 列**。看板顶部加可折叠「定时任务」条（每张卡 = 一个定时任务，显示下次触发、上次结果、目标、单次/周期徽标、health），任务实例仍进六列但带「定时」徽标；顶部筛选「只看定时 / 隐藏定时」；抽屉看 run 历史与产出（打开会话 / 会话记录 / 材料）。 |
| 7 | 数据模型 | 新增第 8 张 per-record 表 `schedules`；`TaskRecord` 加可选 `schedule` 引用；快照加 `schedules` 与 `scheduleSummary`；SSE 加 `schedule.updated` / `schedules.changed`。**域版本保持 1（加法式新增表）**：旧代码忽略第 8 表、新代码把缺表读成空；升版本会让回滚时旧代码把新记录当“外来文档”静默丢弃（源码已核实），因此不升。 |
| 8 | 与原生 scheduler 的关系 | **包装（wrap），不自建**。原生是唯一 recurrence timer / 规则 / 投递 / 投递历史 / 暂停恢复 / CAS 的实现；commander 只加策略、看板、run 账本、异常升级与一个看门狗。明确**不做**：第二套 cron 解析、第二套 next-run、第二套并发闸门、二次投递。 |
| 9 | 权限与安全 | 人专用路由才能创建 `direct`/开启自动派发/删除/立即运行；**模型工具只能创建 `confirm` 模式**，不能改 target/策略/自动化开关。目标必须在工作区白名单内；直连目标必须是根会话、非归档、非 subagent、非指挥官会话。定时运行的审批仍走 DSH 正常审批，**Host 不代答**。 |
| 10 | 分阶段 | P0 隔离环境 spike（原生服务/事件/归档删除行为）→ P1 契约+表+CRUD → P2 直连触发+run 账本+异常升级 → P3 看板 UI → P4 看门狗/告警/重试 → P5 confirm + 首轮授权（可选）→ P6 验证与文档。P0–P4+P6 约 7.5–8.5 人日；confirm + 首轮授权再加 2–2.5 人日。 |

### 0.1 需要用户先拍板的三件事

1. **默认派发策略**：`direct`（创建时显式绑定目标 = 一次授权，之后自动直派，实现最简、推荐 v1）；`authorize_then_direct`（首轮确认、之后自动，最贴合现有“首次必确认”口径，建议作为产品默认备选）；`confirm`（每次触发都生成待确认卡）。三选一，还是做成每条任务可选？
2. **看板呈现**：顶部「定时任务」条 + 六列内「定时」徽标（推荐），还是每轮生成一张任务卡进六列（字面“一个任务”，但高频任务会淹没看板）？
3. **成功轮次是否需要人验收**：默认只把 run 记进历史、异常才升级为任务（推荐）；还是每轮都进「待验收」（`each_run`，phase 2）。

---

## 1. 现状基线（先对齐事实）

### 1.1 commander 现有执行模型

- **9 状态**：`draft/proposed/queued/running/blocked/review/done/cancelled/archived`；看板六列（待派发/待运行/运行中/受阻/待验收/已验收），取消/归档在回收站。见 `docs/architecture/task-state-machine-final.md` §2、§8.1。
- **唯一写入口**：所有任务状态写入必须经 `src/host/tasks/state-machine.ts#transitionTask`；`done` 只能人 `POST /accept`，`archived` 只能人 `POST /archive`；`review` 至少 1 条 acceptance；`queued` 必须有 `primarySessionId` 且由 `commander_task_dispatch` 写入。
- **派发门禁**：`AUTO_DISPATCH = false`（`src/host/config.ts`），`commander_task_dispatch` 首次恒 `needs_confirmation`；确认后才 create/attach 会话并写 `queued`。全局只允许一条未决 `pendingDispatch`（`src/host/dispatch/service.ts`）。
- **工具面**：`commander_task_create/get/list/update/dispatch/report` + `commander_workspace_list/update` + `commander_session_list`，只在当前指挥官会话作用域放行（`src/host/tools/index.ts`）。
- **看板/SSE**：快照 `GET /commander/state`（`tasks ≤200`、`workSessions ≤200`、`counts`、`pendingDispatch`）；SSE 事件 `task.updated` / `tasks.changed` / `dispatch.updated` / `commander.message` / `commander.status` / `binding.updated` / `rotation.updated` / `capability.applied` / `heartbeat`（`docs/architecture/implementation-plan.md` §8.3/§8.4）。
- **回合状态**：`src/host/trigger/status.ts` 用 `session/event` 的 `turn/start|end` 维护 `queued→running`，带孤儿补偿（`reconcile`）与启动回填（`backfill`）；`src/host/trigger/injection.ts` 在 `turn/end` 把最后助手回复以 `[session-reply]` 注入指挥官（`INJECTION_REASONS = completed/error/blocked/max-tokens`）。
- **审批/提问**：客户端从快照 `workSessions`（`sessionId/taskId`，由 `sessions` link 派生）挑出待审批/待提问会话；审批卡不拥有 answerer，只调官方 `PendingApproval.answer()`（`src/client/approval.ts`、`ApprovalFloat.tsx`）。
- **存储**：`commander` 域，per-record，`DOMAIN_VERSION = 1`，7 张表 `config/workspaces/commands/tasks/dispatches/board_edits/sessions`（`src/host/config.ts`、`src/host/domain.ts`）。任务记录是唯一真相，没有事件表/投影/回放。
- **冻结边界**：`docs/NEXT-PHASE.md` §2 第 4 条「没有 scheduler、没有结果轮询」、第 5 条「任务记录就是唯一真相」、第 10 条「一期只在 DSH 内」；`docs/architecture/implementation-plan.md` §14 第 3 条还写着「没有 `ctx.schedule` 心跳」。**本次需求明确要重开第 4 条**，其余边界尽量保持。

### 1.2 DSH 原生调度能力（0.2.2-rc.2，源码逐条核对）

包位置（本机全局安装，供复核）：

- `~/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-schedule/`（Host 服务 + 规则 + 运行时 + 存储）
- `.../dsh-tool-schedule/src/index.ts`（模型工具 `schedule_create/list/view/edit`）
- `.../dsh-client-ui-schedule/src/client/`（原生「自动化任务」侧栏页，`sidebar.panellist` `order:10`）

关键事实：

| 事实 | 证据 |
|---|---|
| 服务是 `ctx.schedule: ScheduleService`，方法包括 `create/list/catalog/view/history/edit/run/deleteInactive/deliveryLimits`；变更事件 `schedule/changed`（**无 payload**）。 | `dsh-schedule/src/index.ts` L73–77、L351–354、L440–443、L629–636；`types.ts` L629–636 |
| 规则种类：`after` / `at` / `every` / `daily` / `weekly` / `cron` / `rrule`。`every` 最小 60s；`new` 目标的投递间隔可配（默认 60s，范围 60s–7d）。 | `types.ts` L16–142；`index.ts` L80–96、L226–231；`domain.ts` L42 |
| 目标：`session`（固定会话）、`new_once`（首次投递创建并复用；创建时就预留 sessionId）、`new`（每次新会话）。原生 `validateTarget` 只校验**存在/非归档/非 subagent**（不校验根会话、不校验工作区白名单）；根会话与白名单由 commander 在 §7.2 追加校验；`new_once/new` 需要 Host 能创建会话。 | `types.ts` L344–394；`index.ts` L626–680 |
| 状态：`active` / `paused` / `ended`（存储里旧值 `inactive` 读时归一为 `ended`）。每次投递写 `lastDelivery` 与 `deliveryHistory`；`executionActive` 只对复用会话目标有意义；`deliveryFloorEndsAt` 表示最小投递间隔未结束。 | `storage.ts` L68–112；`types.ts` L451–475；`runtime.ts` L177–189 |
| 计时：**整个 Host 只有一个 `setTimeout`**，`unref()`；按所有任务里最近的 `scheduledAt`/投递 floor 重算。 | `runtime.ts` L67–70、L196–225 |
| 到期/错过：`resolveRecurringOccurrence(record, now)` 取**最近一个已到期 occurrence**；工具描述明确「After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.」 | `domain.ts` L810–830；`tool-schedule/src/index.ts` L196–200；`runtime.ts` L252–255 |
| 投递 = 往目标会话 enqueue 一条 `source.kind='schedule'` 的用户消息，并等 `sessions.flush()` 持久化确认；**只代表 inbox 收件，不代表模型执行完成**。 | `runtime.ts` L352–367；`types.ts` L396–407 |
| 复用会话目标有单飞：同一任务在目标 agent 未回到 whole-agent idle 前占住 slot，不会并发投递；`new` 目标没有这个 slot，只受最小间隔约束。 | `runtime.ts` L140–179、L287–297 |
| 编辑/暂停/恢复/删除：`edit({id, action:'update' 或 'delete', patch:{title?,prompt?,timing?,target?,active?}, expectedUpdatedAt})`，CAS 冲突返回 `schedule_conflict`；恢复要求规则有未来 occurrence；删除不撤回已排队的消息。 | `types.ts` L530–571；`index.ts` L555–593；`tool-schedule/src/index.ts` L207 |
| **归档目标会话会删掉指向它的 active 定时任务**：`workspace/session-stop` → `stopSessionTasks()` 删除这些行；`workspace/session-activity` 也会把 active schedule 视为会话活跃原因。 | `dsh-schedule/src/index.ts` L323–341、L754–762；`dsh-workspace/src/index.ts` L368–405 |
| 投递历史默认保留 30 天 / 每任务 200 条；`lastDelivery` 永远保留。 | `index.ts` L98–105、L226–231 |
| 原生「自动化任务」页是全局的：能看到**所有会话创建的**定时任务；模型工具面只有 `rrule` + target enum（`this_session/new_once/new`），但 Host 服务支持全部规则与 `session` 目标。 | `tool-schedule/src/index.ts` L371–391、L196–249；`dsh-client-ui-schedule/src/client/index.ts` L240–247 |
| 实机样本（本机 `~/.dsh/storages/schedule.json`）：9 条任务，4 条 active；一条 `daily` 任务已有 31 条投递历史；一条 `at` 任务计划 `00:25` 实际 `01:08` 投递（宿主停机后补投最近一次）；active 任务目标均为已存在的 `session`。 | 2026-11-24 只读解析（未记录/未引用标题与 prompt 正文） |

**对方案最重要的三条原生语义**：

1. **原生投递即启动目标会话**，没有“静默 webhook / 只通知不投递”的目标类型。因此“每次触发先拦截、再人工确认”不能在 `direct` 模式实现；要确认就只能把 native target 设成指挥官会话（`confirm` 模式），或者自建调度器（否决，见 §13）。
2. **原生只补最近一次**，且可能晚于计划时间很久（实机 43 分钟）；commander 不应假设“每个 occurrence 都会有独立投递”，也不应重放历史。
3. **原生没有 payload 事件**，只能靠 `schedule/changed` 后重新读 catalog，比较 `lastDelivery.messageId` 判断“有没有新投递”。这决定了 commander 的物化必须是**幂等 + 可对账**的。

### 1.3 本次要改的契约（设计先行，实施前先落文档）

| 契约 | 现状 | 本次要改 |
|---|---|---|
| `docs/NEXT-PHASE.md` §2 #4 | 没有 scheduler | 重开为「允许使用 DSH 原生调度器；commander 不建第二套 recurrence timer」 |
| 派发门禁 | `commander_task_dispatch` 首次恒 `needs_confirmation`；`AGENTS.md` 记为“不是可调参数” | **只对 `direct` 定时触发源**新增“预绑定目标 = 创建时授权”的例外；是否接受、默认选哪种模式由用户拍板（§17 Q1）。不把 `AUTO_DISPATCH` 改 true，也不给普通任务开自动 |
| 域表 | 7 张 | 8 张（+`schedules`）；`DOMAIN_VERSION` 仍为 1（理由见 §12.6） |
| 任务状态机 | 9 状态、单一写入口 | **不加状态、不加边**；新增 actor `host_schedule`，仅用于「异常升级」时 `draft→blocked`；`done` 仍仅人。**`each_run`（phase 2）会另需 `draft→review` 边 + `AcceptanceItem.source='host'`，属于独立契约变更，不在 v1** |
| 工具面 | 9 个 commander 工具 | 新增 `commander_schedule_create/list/get/update`（模型侧仅 confirm 模式、不能开自动） |
| 人专用路由 | accept/archive/restore/cancel/continue | 新增 `POST/PATCH /commander/schedules*`、`pause/resume/run-now/delete`；仍不接受模型调用 |
| 快照/SSE | tasks/workSessions/... | 加 `schedules`、`scheduleSummary`；加 `schedule.updated`、`schedules.changed`；`workSessions` 允许带 `scheduleId`（审批卡用） |
| 注入来源 | `commander-session-reply` / `commander-board-edit` | 新增 `commander-schedule-alert`（`[schedule-alert]`）与 confirm 模式的 `[schedule-fire]` 系统提醒 |
| 看板 | 六列 + 回收站 | 顶部「定时任务」条 + 六列内徽标 + 筛选；**不加第 7 列** |

---

## 2. 目标与非目标

### 2.1 目标

1. 用户能在一个地方（任务看板）看到：有哪些定时任务、下次何时跑、上次结果、跑在哪里、历史产出在哪。
2. 定时任务能覆盖三类日常需求：
   - **查资料**：周期性地在某个工作区/会话里做研究，产出报告；
   - **监控更新**：定期检查外部变化，异常才打扰人；
   - **检测**：定期跑检查，失败/超时要能看见、能处理。
3. 定时任务与现有任务/dispatch/验收/会话复用**衔接而不是平行**：需要人处理时，自然升级为看板任务，能打开会话、看报告、返工、验收。
4. 失败、超时、错过触发、目标会话归档、重复投递都能被看见并有明确处置。
5. 不引入第二套计时器、第二套规则解析、第二套派发门禁。

### 2.2 非目标（本轮明确不做）

- 本轮不写业务代码、不改仓库实现（只出文档）。
- 不做跨 Host / 多进程分布式调度（现有架构是单 Host 假设，`implementation-plan` §14-8）。
- 不做“无人值守自动验收”（`done` 仍仅人）；不做自动回答审批。
- 不做 Task Group / 子任务 / 并行多工作区（沿用状态机定案的非目标）。
- 不做外部告警通道（邮件/IM/系统通知）；一期告警 = 指挥官面板注入 + 看板 health。
- 不做原生定时任务的自动导入/双向同步（见 §13.5，phase 2 再议）。
- 不把原生「自动化任务」页替换掉；两个入口并存，见 §13.4。

---

## 3. 总体设计

### 3.1 分层

```text
┌────────────────────────────────────────────────────────────┐
│ DSH 原生调度器 ctx.schedule（唯一 recurrence timer）         │
│  - 规则解析 / 时区 / DST / 单 timer / 最近一次补投           │
│  - 投递到 target session（followup + flush）                 │
│  - deliveryHistory / 暂停恢复 / CAS                          │
└───────────────┬────────────────────────────────────────────┘
                │ schedule/changed（无 payload）
                │ 读 catalog()/view() → lastDelivery
                ▼
┌────────────────────────────────────────────────────────────┐
│ commander 定时模块（Host，单写者）                            │
│  ├ ScheduleService   : schedules 表 CRUD、native 映射、策略   │
│  ├ TriggerObserver   : 幂等物化 run（messageId 去重）         │
│  ├ RunTracker        : session/event → run 状态/结果          │
│  ├ Watchdog          : 60s，超时/错过/目标丢失/熔断           │
│  └ Escalator         : 异常 → TaskRecord（draft→blocked）     │
└───────────────┬────────────────────────────────────────────┘
                │ 复用现有 task / dispatch / board / SSE
                ▼
┌────────────────────────────────────────────────────────────┐
│ 现有任务流水线（9 状态 / 六列 / 验收 / 会话 / 注入）           │
└────────────────────────────────────────────────────────────┘
```

### 3.2 四个对象

| 对象 | 含义 | 存储 | 生命周期 |
|---|---|---|---|
| **Schedule（定时任务）** | 用户定义的“每隔多久、在哪里、做什么” | `schedules` 表 + 原生 `schedule.tasks` | `active → paused → active`，单次跑完 `ended`，删除为软删 |
| **Run（运行/轮次）** | 一次触发产生的一次运行 | 内嵌 `ScheduleRecord.recentRuns`（≤20）+ 原生 `deliveryHistory` | `delivered → running → succeeded/failed/blocked/timeout/missed` |
| **Task（看板任务）** | 需要任务流水线处理的一次运行（异常升级 / `each_run` / confirm 派发） | `tasks` 表 | 现有 9 状态，走现有写入口 |
| **SessionLink（会话绑定）** | 任务↔工作会话 | `sessions` 表 | 现有；定时 run 只有升级为 Task 时才写 link |

### 3.3 五条设计原则

1. **原生拥有时间**：commander 不计算 occurrence、不持有 recurrence timer、不保存“下一次触发”作为真相（只镜像展示）。
2. **Host 是唯一写者**：Client 只发命令；定时模块的写全部经 Host 服务与现有 `transitionTask`。
3. **投递与任务解耦**：`direct` 模式的投递由原生完成，commander 不重复 `commander_task_dispatch`；只有升级任务或 `confirm` 模式才进入现有派发流程。
4. **至少一次 + 幂等**：原生可能重复投递，commander 用 `(scheduleId, occurrenceAt, attempt)` 做 run 身份（messageId 用于对账/去重，不是身份本身），重启后对账；同一 occurrence 只保留一条 run。
5. **异常才打扰人**：成功 run 只进历史；失败/超时/目标丢失/错过触发才生成告警与（默认）一个受阻任务。

---

## 4. 定时规则与时区

### 4.1 规则种类与映射

commander 的规范规则（`ScheduleRule`）只覆盖 6 种，映射到原生 `ScheduleTiming`：

| commander kind | 原生 timing | 适用 | 备注 |
|---|---|---|---|
| `at` | `{kind:'at', at:'<RFC3339 UTC>'}` | 单次 | 创建时必须严格未来；单次跑完原生 `ended` |
| `every` | `{kind:'every', every_seconds}` | 固定间隔 | 最小 60s；锚点是创建/最近一次改规则的时间（原生语义，不是整点对齐） |
| `daily` | `{kind:'daily', daily:{time:'HH:mm:ss', time_zone}}` | 每天几点 | UI 预设；原生处理 DST |
| `weekly` | `{kind:'weekly', weekly:{time, time_zone, weekdays:[1..7]}}` | 每周几 | UI 预设；weekday 周一开始 |
| `cron` | `{kind:'cron', cron:{expression, time_zone}}` | 复杂日历 | 5 段 Vixie；原生规范化 |
| `rrule` | `{kind:'rrule', rrule:'DTSTART...\nRRULE:...'}` | 最复杂 | 原生子集：无 SECONDLY；BYSECOND 单值；COUNT≤1000；UNTIL 必须是 UTC `Z`；DTSTART 可过去，取创建后第一个 occurrence |

- **不把 daily/weekly 折成 cron**：原生直接支持，折了反而丢语义（尤其 DST）。UI 提供「每天/每周/间隔/单次/高级(cron/rrule)」五种入口，高级入口才暴露原始表达式。
- **模型工具**（`commander_schedule_create`）只允许 `at/every/cron/rrule` + 显式 `timeZone`（或 `every` 不需要时区），降低模型乱写 daily/weekly 的概率；UI 的 daily/weekly 由人选择。

### 4.2 时区策略

1. **墙钟规则必须显式 IANA 时区**（`Asia/Shanghai`、`America/New_York`），禁止“浮动本地时间”。原生 `daily/weekly/cron` 本来就要求 `time_zone`；`rrule` 要求 `TZID` 或 `Z`。
2. **默认值**：人从 UI 创建时默认浏览器 IANA 时区；模型创建时**必须显式传**（缺省 → `invalid_request`，不猜）。
3. **单次 `at`**：存绝对 UTC instant；另存 `timeZone` 仅用于展示（“你设的是本地 9:30”）。切换时区不改变已定的单次时刻。
4. **`every`**：固定速率，无墙钟语义；`timeZone` 仅展示创建者时区。
5. **DST**：完全交给原生——不存在的本地时间跳过该日，重复的本地时间取较早 instant（`tool-schedule/src/index.ts` L215–218）。commander **不做二次纠正**，展示时用 `Intl.DateTimeFormat` 按存储的 IANA 时区格式化。
6. **next run 只读原生**：`scheduledAt`（UTC ISO）来自 `ctx.schedule.view()`；commander 的 `nextRunAt` 是镜像，不参与触发判定。
7. **行内展示**：卡片显示“下次 明天 09:30（Asia/Shanghai）”；hover/详情显示 UTC 与查看者本地时间；单次结束显示“已完成于 …”。

### 4.3 校验与错误

- 时间必须在未来（单次）；`every >= 60`；cron/rrule 语法与频率由原生校验；时区必须 IANA。
- 原生错误码直接透传：`invalid_prompt` / `invalid_selector` / `invalid_rule` / `invalid_time_zone` / `not_future` / `frequency_too_high` / `time_out_of_range` / `subagent_session` / `internal_error`（`types.ts` L234–298）。
- commander 额外校验（在调原生之前）：
  - 目标工作区必须在 `WorkspaceRecord.allowed === true`；
  - `attach` 的 session 必须是根会话、非归档、非 subagent、非当前指挥官会话；
  - 同一 `(workspaceId, sessionId)` 不允许两个 active `direct` 定时任务（§7.3）；
  - 单工作区/全局定时任务数量上限（建议 20/100）、单任务最小间隔 60s、每日触发上限（建议 1500，覆盖 1 分钟间隔的 1440 次）——防跑飞。
- 不合法时**不写 commander 记录、不建原生任务**；错误原样回给 UI/模型。

### 4.4 规则编辑

- 改规则 = 调原生 `edit({id, action:'update', patch:{timing}, expectedUpdatedAt})`，由原生重算下一次；commander 在同一逻辑操作里更新 `rule`/`nextRunAt` 镜像。
- 改规则后如果原生返回 `not_future`（例如把单次改到过去），commander 不落任何改动，返回明确错误让用户改时间。
- 改间隔的锚点语义（原生）：`every` 从最近一次改规则/恢复时重新锚定，不是“保持原相位”；UI 要写清楚，避免用户以为“每 5 分钟”会固定在 :00/:05。

---

## 5. 触发 → 看板任务 / dispatch 的衔接

### 5.1 观察循环（Host，幂等）

```text
on schedule/changed:
  catalog = await ctx.schedule.catalog()          // 一次读全量，O(N)
  for each commander schedule S with nativeId:
     N = catalog.find(id === S.nativeScheduleId)
     if N missing:  drift(S)                      // 目标归档/原生页删除 → target_lost
     else:
        mirror S.status/nextRunAt from N
        if N.lastDelivery && N.lastDelivery.messageId !== S.lastProcessedMessageId:
           materializeRun(S, N.lastDelivery)      // 幂等键：messageId + scheduledAt
```

- `schedule/changed` **没有 payload**，所以只能重读；commander 内部用串行队列（单写者）避免并发物化。
- `materializeRun` 的顺序：
  1. 用 `S.version` + `lastProcessedMessageId` 做 CAS；已处理过同一 messageId → 直接返回。
  2. 写一条 run：`occurrenceAt = Date.parse(lastDelivery.scheduledAt)`、`deliveredAt`、`nativeMessageId`、`sessionId = lastDelivery.targetSessionId`、`state='delivered'`。
  3. 读该会话自 `deliveredAt` **前移一个 grace 窗口**（建议 60s）之后的事件；若事件能带 `messageId`，优先用 `lastDelivery.messageId` 精确定位消息所在 turn。原因：原生 `deliveredAt` 在 `sessions.flush()` 之后采样，快速目标会话的整个回合可能已在 flush 前结束（`runtime.ts` L357–362 注释），只用 `deliveredAt` 当下界会漏读。据此把 run 置 `running` 或直接终态。
  4. 按策略决定是否升级为 Task（§5.3）。
  5. 更新 `lastProcessedMessageId`、`lastRun`、`recentRuns`、`counters`、`version`；广播 `schedule.updated`。
- 启动/重连时对全部 schedule 做一次同样的对账（因为停机期间可能错过 `schedule/changed`）。
- 写序竞态：`ctx.schedule.create/edit` 触发的 `schedule/changed` 可能**早于** commander 记录写入；观察者按 commander 记录匹配，早到的事件会被安全忽略。创建/编辑成功后必须**主动 `view` 一次并写镜像**，不能只等下一次事件。
- 如果 `lastDelivery` 存在但 occurrence 已经很旧（停机很久后补投），仍然只记一条 run，`state` 由会话事件判定；不补历史所有 occurrence（原生也只补最近一次）。

### 5.2 触发/派发模式

| 模式 | native target | 谁执行 | 走 Jev？ | 逐次人工确认？ | 适用 |
|---|---|---|---|---|---|
| **direct（v1 推荐，Q1 拍板后）** | `session`（固定工作会话）/ `new_once`（首次建会话）/ `new`（每次新会话，cwd 固定工作区） | 原生直接把 `[SCHEDULE REMINDER]` 投到工作会话，工作 agent 执行 | 否（目标已在创建时显式绑定，无候选歧义） | 否；**创建/编辑时的目标选择就是授权**（建议 UI 二次确认“以后每次自动派发到 X”） | 监控、检测、定期查资料 |
| **authorize_then_direct（备选，§5.7）** | 首轮 = 指挥官会话；授权后重指为工作目标 | 首轮由指挥官确认目标并派发；之后同 direct | 首轮可走 Jev；之后否 | 仅首轮 | 既要无人值守、又坚持“首次必确认” |
| **confirm（phase 3）** | `session` = 当前指挥官会话 | 原生把提醒投给指挥官；Host 先建 `draft` 任务，指挥官按现有流程 Jev + 确认卡后再派发 | 是（复用现有候选/门控） | 是 | 每次都要人挑目标 / 需要把关 |
| **manual run-now** | 同 direct | 人点「立即运行」→ `ctx.schedule.run({id})` 投递一次 | 否 | 否（人主动） | 补跑、验证 |

- **direct 的关键不变量**：原生投递就是派发，commander **绝不能**再对同一个 occurrence 调 `commander_task_dispatch`；否则会在同一会话里跑两遍。代码里用 run 的唯一幂等键 + “该 run 已派发”标记防重。
- **confirm 的关键不变量**：原生只负责“叫醒指挥官”，真正的派发仍由 `commander_task_dispatch` 完成；确认卡仍受全局单卡限制。confirm 模式下的 `ScheduleRecord.target` 只是“建议目标”（可为空，由 Jev/确认决定），native target 固定为当前指挥官会话。
- **为什么 direct 可以不走确认而不算“加自动派发捷径”**：现有 `AUTO_DISPATCH` 禁止的是“在候选不确定时自动挑目标”；direct 的目标是用户在创建定时任务时**显式选定并确认**的单一目标，不存在候选/Jev 放行问题。这不是把 `AUTO_DISPATCH` 改成 true，而是新增一个**受限于预绑定目标的触发源**。这一点必须在契约文档里写清楚，并由用户拍板（§17 Q1）。

### 5.3 何时生成看板任务（升级策略）

`ScheduleRecord.escalation` 三档：

| 策略 | 每次触发 | 成功 | 失败/超时/目标丢失 | 看板效果 |
|---|---|---|---|---|
| **`on_anomaly`（默认）** | 只记 run | 只记 run（历史可见） | **生成 1 个 TaskRecord**（`draft→blocked`，带 reason） | 六列只出现需要处理的任务；定时条显示健康度 |
| `each_run`（phase 2） | 生成 1 个 TaskRecord（`review`，Host 提供 1 条 acceptance） | 进「待验收」 | 进「受阻」 | 每轮都有人看；适合日报/低频 |
| `always`（phase 3，配合 confirm） | 生成 `draft` 并走现有派发确认 | 按现有流程 review/done | blocked | 最重、最可审计 |

- **v1 只实现 `on_anomaly`**。`each_run` 需要新增 `draft→review` 迁移（actor `host_schedule`）与 acceptance `source:'host'`，属于扩展；`always` 依赖 confirm 模式。
- **升级任务的字段**：
  - `title = ${schedule.title} · ${occurrence 本地时间}`；
  - `goal = schedule.goal + "\n本次失败：" + reason`（≤ 现有 goal 限制）；
  - `workspaceId = schedule.target.workspaceId`；`priority='normal'`；`commandId=''`；
  - `schedule = {scheduleId, occurrenceAt, attempt}`；
  - 若 run 有 `sessionId`，写 `primarySessionId` + `sessions` link（role=work、mode=attach/new、round=1），这样「打开会话 / 审批卡」都能工作。**写 link 前先查 `(workspaceId, sessionId)` 是否已有非终态任务的 link**：有则不覆盖，**不写 `primarySessionId`、不写 link**，在 timeline 记 `link_conflict` 并在 `block.reason` 说明；该任务不能 `recover→running`（缺 session），只能取消/重新派发。靠 §7.3“一个会话一个 active direct 定时任务”把冲突降到最低。
  - `timeline`：`created` + `status(blocked, "定时任务第 N 轮失败：…")`；
  - `block = {reason, code, since}`；`acceptance=[]`（blocked 允许空）。
  - 写入口：`draft` 创建（复用现有 create 逻辑）→ `transitionTask({to:'blocked', actor:'host_schedule'})`；**不直接写 status**。
- **不生成任务的情况**：成功 run；`cancelled`（用户主动停）；v1 不提供 skip；停机期间原生只补最近一次，commander **不补历史 occurrence**，只对当前最新未投递 occurrence 记一条 `missed`（按 occurrence 去重）并按策略升级。
- **“生成几轮”结论**：**一次触发最多生成一个 TaskRecord；不会把周期压进同一个 Task 的多轮**。`TaskRecord.round` 仍只表示返工轮（rework），与触发次数无关。若同一 occurrence 重试，则 `attempt+1` 生成**新的 run**，并按策略生成**新的升级任务**（旧任务保留为历史，可 cancel）。

### 5.4 是否计入全局单卡限制

- `direct`：不产生 `pendingDispatch`，**不占全局单卡**；多个定时任务可以同时跑（原生按会话串行/新会话间隔约束）。
- `authorize_then_direct`：**仅首轮**产生一个 `draft` + 确认，占一次单卡；授权后不占。多个待授权任务排队（一次一个确认）。
- `on_anomaly` 升级任务：`blocked` 不需要确认卡，**不占单卡**。
- `confirm`（phase 3）：每次触发先生成 `draft`，再走 `commander_task_dispatch` 的确认；**占全局单卡**。多个定时任务同时触发时，按触发时间排队，一次只推进一个确认；其余在「待派发」列显示「等待确认」，不会互相顶掉。
- `each_run` 的 `review` 任务：不需要确认卡，不占单卡。

### 5.5 是否走 Jev

- `direct`：**不走**。目标固定，Jev 没有信息可判；强行跑 Jev 只会增加延迟和不确定性。
- `authorize_then_direct`：**仅首轮可走**（确认目标时复用现有 Jev/候选）；授权后固定目标，不再走。
- `confirm`：**走**。沿用现有 `dispatch` 的候选构造、Jev 打分、门控与确认卡；`ScheduleRecord.target` 只是“建议目标”，最终由确认决定。
- 升级任务的续做：`blocked` 用 `commander_task_update(action=recover, to=running)`（需 `primarySessionId`）；`review`（phase 2 `each_run`）才用现有 rework，固定回原会话，不再跑 Jev。

### 5.6 confirm 模式的触发流程（phase 3，先设计不实现）

1. 创建时 native target = 当前指挥官会话 `{kind:'session', sessionId: commanderSessionId}`；`prompt` 是固定模板 + 用户指令，例如：
   ```text
   [commander-schedule] scheduleId=sch_… title_json="…"
   这是用户预先设定的定时任务。Host 已为本轮创建草案任务（见下一条提醒/看板）。
   请用 commander_schedule_get 读取目标/策略，然后对该草案调用 commander_task_dispatch 走确认；
   不要直接用 commander_task_create 重复建任务，也不要直接碰工作会话。
   ```
2. 原生投递 → 指挥官会话出现 `[SCHEDULE REMINDER]` 用户消息（原生框架 + 上述 prompt）。
3. Host 在 `schedule/changed` 里**确定性**创建 `draft` 任务并写 `schedule` 引用（唯一创建者）；**确认卡由指挥官的 `commander_task_dispatch` 创建**（`draft` 本身不产生 `pendingDispatch`）。若原生消息已足够，不再重复注入；建议只依赖原生消息 + draft 已存在，避免双消息。
4. 指挥官按现有确认流程派发；`pendingDispatch` 仍全局唯一。
5. R1 换任：换任成功后，遍历所有 `dispatchMode='confirm'`（以及尚未完成首轮授权的 `authorize_then_direct`）的 schedule，`ctx.schedule.edit({id, action:'update', patch:{target:{kind:'session', sessionId:newCommander}}, expectedUpdatedAt})`；失败则把 schedule 置 `paused + health='target_lost'` 并告警（不能让提醒继续投给已退役会话）。

### 5.7 备选：首轮确认再自动（`authorize_then_direct`）

这是“严格保持现有‘首次派发必确认’”与“定时任务不能每次都打扰人”之间的折中，建议作为 Q1 的备选；若用户选它，实现放到 P5（与 confirm 共用大部分代码）。

流程：

1. 创建时 native target = 当前指挥官会话（同 confirm），`dispatchMode='authorize_then_direct'`，`authorization.state='pending'`。
2. 第一次触发：原生提醒 → Host 确定性创建 `draft` 任务 → 指挥官调用 `commander_task_dispatch` 生成确认卡 → 用户确认目标/工作区（单候选或 Jev 推荐；目标来自 `ScheduleRecord.target` 的预绑定/建议）。
3. 确认成功、`commander_task_dispatch` 落地后，Host：
   - 写 `authorization={state:'authorized', at, target}`；
   - 把 native target **重指**到确认后的工作目标（`session` 或 `create:{cwd, agentPreset}`），后续触发直接投工作会话；
   - 对单次任务（`at`）无需重指，跑完即 `ended`。
4. 用户取消确认 → `authorization.state='denied'`，schedule `paused` + 告警；不自动重试。
5. 首轮触发时用户不在 → 保持 pending；后续触发只维护**一个** pending draft（去重），并告警“等待授权”，不会跑工作会话。

取舍：

- 优点：首次派发仍由人确认（不破坏 V5 门禁的产品口径）；之后无人值守。
- 缺点：多一个授权状态 + native target 切换；首轮提醒是模型中介（与 confirm 相同）；用户必须在首轮触发时在场；实现/测试比 direct 多。
- 与 direct 的关系：`direct` 是“创建时确认”，`authorize_then_direct` 是“首次触发时确认”。两者都不逐次确认；`confirm` 是逐次确认。

---

## 6. 周期实例与轮次建模

### 6.1 结论

- **一次触发 = 一条 run**；run 是历史/审计单位，不是 TaskRecord。
- **需要任务流水线时，一次触发最多升级为一个 TaskRecord**；不复用长生命周期的 Task 多轮。
- **TaskRecord.round 保持“返工轮”语义**，不表示第 N 次触发。

### 6.2 为什么不是“一个 Task 多轮”

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 一个 Task 多轮（推荐过又被否） | 每个 schedule 一个 TaskRecord，每次触发 `round+1` | `done` 是终态且只能人 accept；一轮验收后无法回到 queued，除非新增 `done→queued` 边；`review` 的“至少 1 条 acceptance”在轮次间无法自然清空；“等待下次触发”没有合适状态；看板“已验收”会反复跳变。 |
| B. 每触发一个 Task（本次不默认） | 每次 run 建一个 TaskRecord，走完整状态机 | 语义最直白，但高频监控每天 288 张卡、每月 8640 张；成功轮次也要人验收（`done` 仅人）或长期堆在 `review`；存储/看板计数膨胀。 |
| **C. run 账本 + 异常升级（推荐）** | 成功只记 run；异常/按策略才建一个 TaskRecord | 不破坏状态机；看板不被淹没；需要人处理时仍进现有流水线；代价是“定时任务卡”不是 TaskRecord（见 §11）。 |

### 6.3 Run 状态机

```text
            ┌────────────┐
  trigger → │ delivered  │  （原生 lastDelivery 已落账）
            └─────┬──────┘
                  │ turn/start（或物化时读到已开始）
                  ▼
            ┌────────────┐
            │  running   │
            └─────┬──────┘
       turn/end   │   watchdog 超时
   ┌──────────────┼──────────────┐
   ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│succeeded │  │ failed / │  │ timeout  │
└──────────┘  │ blocked /│  └──────────┘
              │ cancelled│
              └──────────┘
  另：active schedule 到点但未投递（排除单飞排队）→ watchdog 直达 `missed`
```

- `failed`：`turn/end` 的 reason 为 `error` / `max-tokens` / `interrupted` / `forked`（后者是崩溃/分叉收尾，记 `note=reason`）；`cancelled`：reason 为 `aborted` 且 cause 是用户取消/disposed（不告警、不升级）；`blocked`：reason 为 `blocked`（需要审批/提问/工具受阻）；`timeout`：看门狗到点仍无 `turn/end`；`missed`：`scheduledAt + grace` 后仍没有 `lastDelivery`，且 `executionActive !== true`、`deliveryFloorEndsAt` 已过/不存在，此时 `occurrenceAt` 取**计划的 `scheduledAt` 镜像**；`succeeded`：reason 为 `completed`（无文本也算成功，记 `note='no_text'`）。
- run 的 `reason/note` 来自会话事件，不来自模型自述；不把模型输出当状态真相。
- `manual` run 标记 `manual=true`，不推进 occurrence；看板显示「手动运行」。

### 6.4 occurrence 身份与重试

- 身份：`(scheduleId, occurrenceAt, attempt)`。已投递的 occurrenceAt 取 `lastDelivery.scheduledAt`；`missed` 的 occurrenceAt 取计划 `scheduledAt` 镜像。原生重复投递同一 occurrence 时 `(scheduleId, occurrenceAt)` 相同 → 只物化一次（messageId 作为第二道键）。
- 重试策略（v1 保守）：
  - **投递失败**：不自动重投；`missed` + 告警 + 人可点「补投」（`ctx.schedule.run({id})`，会立即投递一次；注意原生 `run` 不消费原 occurrence，若原 occurrence 仍 due，之后可能再投一次——UI 要提示“可能重复”，见 §8.2）。
  - **运行失败**：不自动重跑；升级任务进「受阻」；人可「恢复运行」（`commander_task_update(action=recover, to=running)`，需 primarySessionId）或「重跑本轮」（`attempt+1` 新 run + 原生 `run({id})`/新会话）。
  - **自动重试**（phase 2）：按 `maxAttempts` + 退避，仅对 `missed`/`failed`；仍不自动验收。
- 历史保留：`recentRuns ≤20`（可配）；更早的看原生 `deliveryHistory`（默认 30d/200）与会话记录；需要更细时 phase 2 再拆 `schedule_runs` 表。

### 6.5 Run 记录字段

```ts
interface ScheduleRun {
  occurrenceAt: number          // 已投递：lastDelivery.scheduledAt；missed：计划 scheduledAt 镜像（UTC ms）
  attempt: number               // 从 1 开始；同一 occurrence 的重试递增
  deliveredAt?: number
  nativeMessageId?: string
  sessionId?: string
  state: 'delivered' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'timeout' | 'missed'
  endedAt?: number
  reason?: string               // turn/end reason 或失败码
  taskId?: string               // 升级任务
  manual?: boolean
  /** manual=true 时指回原失败/错过的 occurrence，仅审计/展示；不改变 occurrence 身份。 */
  manualOfOccurrenceAt?: number
  note?: string                 // ≤200 字；如 no_text / busy_target / ignored / duplicate_delivery
}
```

---

## 7. 会话绑定与复用策略

### 7.1 目标模式

| 模式 | native target | 上下文 | 并发 | 适合 | 注意 |
|---|---|---|---|---|---|
| `attach` | `{kind:'session', sessionId}` | 固定会话，历史连续 | 原生单飞：上一次未回 idle 时新提醒排队 | 监控同一个对象、需要连续上下文 | 会话归档会**删掉**该定时任务（§7.4） |
| `new_once` | `{kind:'new_once', create:{cwd, agentPreset}}` | 首次触发建会话，之后一直复用 | 同上 | 不想手动选会话、但要长期复用 | 创建时 native 就预留 sessionId；首次触发前会话不存在 |
| `new` | `{kind:'new', create:{cwd, agentPreset}}` | 每次全新会话 | 原生只保证最小间隔（默认 60s，可配），不保证串行 | 独立查资料、避免上下文污染 | 会话数量增长；标题会自动加触发时间 |
| `confirm` | `{kind:'session', sessionId: 指挥官会话}` | 指挥官会话 | 指挥官自己的 busy/排队 | 每次要人挑目标 | R1 换任要重指 target |

- **默认建议**：监控/检测 → `attach`（同一会话，连续上下文）；定期查资料/报告 → `new`（每次干净上下文）；不想选会话但想复用 → `new_once`。
- `agentPreset` 透传原生 `create.agentPreset`；留空用 Host 默认。

### 7.2 会话有效性校验

在创建/编辑/触发前都校验：

- 工作区在 commander 白名单（`WorkspaceRecord.allowed`）；
- `attach` 会话：根会话（非 child、无 parentSession 指针）、非归档（`workspaceRegistry.archivedSessionIds`）、非 subagent（`delegationDepth=0`）、**不是当前指挥官会话**（防止自投递循环）；
- 会话存在（live 或持久化 header）；不存在 → `invalid_rule`；
- 会话已归档 → 拒绝创建/编辑；若在触发时才发现 → `target_lost`。

### 7.3 同名会话约束

- **一个工作会话同一时刻只允许一个 active `direct` 定时任务**。原因：
  1. 原生会把同一会话的多个到期周期任务**合并成一条批次消息**（`renderRecurringReminderBatchFraming`），一条消息对应多个 schedule；
  2. commander 的 `sessions` link 以 `(workspaceId, sessionId)` 为键、只存一个 `taskId`，无法同时表达两个活跃任务；
  3. run→turn 的匹配需要“一个会话一个活跃 run”。
- 需要多个定时任务投同一会话时：改用不同会话，或 `new` 模式，或 phase 2 设计批次 run（一条消息含多个 schedule）。
- `new` 模式每个 run 有自己的会话，不受此约束；但仍建议 `maxConcurrent=1`（v1 只做展示/告警，不强制）。

### 7.4 目标会话归档的原生陷阱（必须处理）

- 原生有两层行为：
  1. **普通归档（不 stopActivity）**：`archiveSession` 先问 `workspace/session-activity`；active 定时任务会作为 `schedule` 活跃项被报上来，归档被 `WorkspaceActiveSessionError` **拒绝**（`dsh-workspace/src/index.ts` L381–394）。
  2. **强制归档（`stopActivity:true`）**：`workspace/session-stop` → `stopSessionTasks(sessionId)` 把**所有指向该会话的 active 定时任务删除**（`dsh-schedule/src/index.ts` L323–341、L754–762）。
- 后果：前者让“归档失败”，用户需要先暂停定时任务；后者让 commander 的 `schedules` 记录还在、native 任务没了；下一次 `schedule/changed`/启动对账 `view()` 返回 `schedule_not_found`。
- 处置：
  1. 普通归档被拒：在错误里引导“先暂停该会话上的定时任务”；commander 不自动暂停（除非用户确认）。
  2. 强制归档导致 native 缺失：`health='target_lost'`、`status='paused'`、`nativeMissingAt=now`；
  3. 注入 `[schedule-alert] reason=target_archived`；
  4. 看板卡片显示「目标会话已归档，定时任务已停止」，提供「重新绑定」；
  5. 不自动重建（避免往归档/错误会话继续投）。
- 用户主动暂停/删除不受影响。

### 7.5 审批与提问的可见性

- `workSessions` 目前只含“任务链接的工作会话”；定时 run 没有 Task 时不会被包含，导致定时运行中出现的审批/提问在指挥官面板看不到。
- 设计：快照 `workSessions` 扩展为 `{sessionId, taskId?, scheduleId?, title?}`；`buildTaskView` 之外的来源增加“活跃 run 的 session”。
  - 客户端 `selectPendingApprovals` / `selectPendingQuestions` 已按 sessionId 工作，只需接受 `taskId` 可空，并在标题回退时用 `schedule.title`。
  - 审批卡显示「定时任务：<title>」而不是任务标题。
- 定时运行仍走 DSH 正常审批；**Host 不自动 answer**。如果审批长时间不处理，看门狗把 run 置 `blocked` 并告警（不是自动放行）。

### 7.6 run ↔ turn 匹配规则（已知限制）

- v1 规则：以 `lastDelivery.messageId` 精确定位 scheduled 消息所在的 turn；找到后取该 turn 的 `turn/end` 作为 run 结束。匹配不到时才退回“`deliveredAt - grace` 之后该会话的第一个 `turn/end`”（不能只用 `deliveredAt` 之后，见 §5.1-3）。
- 已知歧义：如果投递时目标会话正忙（用户回合/别的任务），原生会排队；期间用户自己的回合可能被误算成本次 run。
  - 缓解：只认 `lastDelivery.messageId` 对应的消息/turn；不要用宽泛的 `source.kind='schedule'` 匹配——原生在 create/edit/delete 时还会向 `involvedSessionIds` 注入 `[SCHEDULE CHANGE]` 通知，其 `source.kind` 也是 `schedule`，会误判（`dsh-schedule/src/index.ts` L183–188、L706–730）。
  - v1 可先要求 `attach` 目标会话在投递时 idle（不满足则记 `note='busy_target'` 并只做弱匹配）；精确匹配作为 P0 spike 的一项验证。
- **P0 必须验证**：真实 `session/event` 里 scheduled 消息的 `messageId` 是否能和 `lastDelivery.messageId` 对上；对不上就明确降级为“窗口内第一个 turn/end”并写进限制。

### 7.7 R1 轮换的影响

- `direct` 模式：native target 是工作会话，**与指挥官会话无关**，R1 换任不影响。
- `confirm` 模式：native target 是指挥官会话；R1 换任后必须重指（§5.6-5）。
- 手动“绑定到新会话”（设置页）同理：confirm 模式要重指；direct 模式不受影响。
- 若重指失败：schedule `paused` + `target_lost` + 告警，不自动删除。

---

## 8. 失败 / 超时 / 重试 / 告警

### 8.1 失败分类与处置

| 类型 | 检测 | run 终态 | 升级任务 | 告警 |
|---|---|---|---|---|
| 原生投递失败（目标激活失败、持久化未确认） | 原生只 log；`lastDelivery` 不更新；看 `scheduledAt + grace` 仍无新 receipt | `missed` | `on_anomaly` 下生成 blocked 任务（reason=`delivery_failed`） | `[schedule-alert] delivery_failed` |
| 目标会话归档导致 native 任务被删 | `view()` → `schedule_not_found`；或 `workspace/session-stop` 事件后对账 | `missed` | 生成 blocked 任务（reason=`target_archived`） | `target_lost` |
| 运行报错 | `turn/end` reason=`error` | `failed` | 生成 blocked 任务（reason=`run_error`），带会话 link | `run_failed` |
| 用户取消运行 | `turn/end` reason=`aborted` 且 cause 是用户取消/disposed | `cancelled` | 不升级 | 不告警 |
| 崩溃/分叉收尾 | `turn/end` reason=`interrupted` / `forked` | `failed`（`note=reason`） | 生成 blocked 任务（reason=`run_interrupted`/`run_forked`） | `run_failed` |
| 运行被阻塞（审批/提问/工具） | `turn/end` reason=`blocked` | `blocked` | 生成 blocked 任务（reason=`run_blocked`），会话 link + 审批卡可见 | `run_blocked` |
| token 超限 | reason=`max-tokens` | `failed`（partial） | 生成 blocked 任务（reason=`max_tokens`） | `run_truncated` |
| 超时 | 看门狗：`now - deliveredAt > timeoutMinutes` 且 run 非终态 | `timeout` | 生成 blocked 任务（reason=`timeout`） | `run_timeout` |
| 无文本回复 | `turn/end` + 无 assistant 文本 | `succeeded` + `note='no_text'` | 不升级（除非策略要求输出） | 无 |
| 错过触发 | `scheduledAt` 已过 + grace，且**没有新 receipt**，同时 `executionActive !== true` 且 `deliveryFloorEndsAt` 已过/不存在（排除原生单飞排队） | `missed` | 生成 blocked 任务（按 occurrence 去重） | `missed_trigger` |
| 重叠运行 | 上一个 run 未终态时又出现新 receipt | 正常记新 run，`note='overlap'` | 不升级 | `overlap`（低优先级） |

### 8.2 重试

- **v1 不自动重试**；只提供明确的人工动作：
  - 受阻任务上的「恢复运行」：`commander_task_update(action=recover, to=running)`（需 `primarySessionId`）；如果任务已在 `review`（phase 2 `each_run`），才用现有 `POST /commander/tasks/:id/rework` 续做。注意：`requestContinue` 只接受 `review`（`src/host/tasks/actions.ts` L116），`blocked` 任务不能直接 rework。
  - 「重跑本轮」：对失败/错过的 run，人可让原生立即投递一次（`ctx.schedule.run({id: nativeId})`）。**原生 `run` 的 receipt 用 `scheduledAt=now`，不是原 occurrence**（`runtime.ts` L155），所以 commander 把它记成一条 `manual=true` 的新 run，并用 `manualOfOccurrenceAt` 指回原失败 occurrence 做审计；调用前把原 occurrence 写进 `ScheduleRecord.pendingManual`，物化时消费并清空（宿主重启后也能对上）。不把 `attempt+1` 伪装成同一 occurrence（`attempt` 只用于 phase 2 的自动重试）。注意原生 `run` 不消费原 occurrence，若原 occurrence 仍 due，之后可能再投一次；UI 要提示“可能重复”，重复投递按 §10.1 去重。
  - 「忽略本轮」：v1 只允许把 run 标 `note='ignored'`（不提供 skip；`counters.skipped` 先恒为 0），不动原生。
- **phase 2 自动重试**：`maxAttempts` + 指数退避；仅对 `missed`/`failed`，且目标会话可激活；仍不自动回答审批、不自动验收。
- 投递层不要试图 `edit` 原生任务来“催触发”：`requestDrive` 不是公开 API；任何绕过都可能造成重复投递。承认原生“至少一次”的语义，靠幂等消化。

### 8.3 告警

- 注入格式（固定模板 + JSON 转义，避免把标题当指令）：
  ```text
  [schedule-alert] scheduleId=sch_… kind=run_failed
  定时任务「…」第 3 次触发失败：run_error（会话 sess_…）。
  已生成受阻任务 task_…；请在看板处理，或暂停该定时任务。
  ---
  scheduleId=sch_… occurrenceAt=1763… attempt=1 taskId=task_…
  ```
- 注入通道：复用 `deliver` 的上下文注入（`agent.followup` + `<system-reminder>`，冷会话回退 `prompt`），新 source kind `commander-schedule-alert`；客户端 `system-message.ts` 增加 `[schedule-alert]` 解析，渲染成紧凑告警卡。
- 去重键：`(scheduleId, occurrenceAt, alertKind)`；同一 run 只告警一次；恢复（下一次成功）发一条 `recovered`（可选）。
- **熔断**：`consecutiveFailures >= autoPauseAfterFailures`（默认 3）→ `ctx.schedule.edit({id, action:'update', patch:{active:false}, expectedUpdatedAt})` + `status='paused'` + `health='paused_by_system'` + 告警；必须人手动恢复（不自动恢复）。
- 告警不改变任务状态（升级任务除外）；不自动 accept/cancel。

### 8.4 看门狗（唯一新增定时器）

- 一个 `setInterval(60_000).unref()`，`ctx.effect` 里清理；只做：
  1. 扫 `schedules` 中 active/paused 的 `recentRuns` 里 `delivered/running` 超时；
  2. 扫 `scheduledAt + grace` 仍无 receipt 的 active schedule：**只有 `executionActive !== true` 且 `deliveryFloorEndsAt` 已过/不存在时才判 `missed`**（复用会话目标上一次未回 idle 时原生会压住下一次投递，`scheduledAt` 停在过去是正常排队，不是错过）；
  3. 检查 native 任务是否还在（低频，避免每个 tick 都打 `view`）；
  4. 触发熔断/告警；
  5. 不读会话正文、不轮询模型结果、不启动会话。
- 为什么必须有：超时/错过触发没有事件可依赖；没有它就无法保证“失败能被看见”。这是对冻结决策 #4 的**最小例外**，只加一个低频、只读 commander 自己数据的定时器；不引入 recurrence 计时。
- 可配置：`SCHEDULE_WATCHDOG_MS`（默认 60s，测试可注入 fake clock）。

---

## 9. 暂停 / 恢复 / 编辑 / 删除

| 动作 | 原生调用 | commander 写入 | 进行中的 run | 边界/错误 |
|---|---|---|---|---|
| 暂停 | `edit({id, action:'update', patch:{active:false}, expectedUpdatedAt})` | `status='paused'`、`nativeUpdatedAt`、`updatedAt++` | 不打断，跑完照常记 run | 已 paused → 幂等；原生找不到 → `target_lost` |
| 恢复 | `edit({id, action:'update', patch:{active:true}, expectedUpdatedAt})` | `status='active'`、镜像 `nextRunAt` | 无 | 原生 `not_future`（单次已过/规则无未来）→ 要求先改规则；`paused_by_system` 恢复后清 health |
| 编辑标题/目标/prompt | 有变化才调原生 `edit`（title/prompt/target） | 更新对应字段 + `nativeUpdatedAt` | 不打断 | 目标改 `new_once` 会预留新 session；target 必须重新校验 |
| 编辑规则 | `edit({id, action:'update', patch:{timing}, expectedUpdatedAt})` | 更新 `rule`/`nextRunAt` | 不打断 | 原生重算下一次；`not_future` 拒绝 |
| 仅改策略（超时/重试/升级策略） | 不调原生（策略在 commander） | 更新 policy | 不打断 | 模型工具不能改策略 |
| 删除 | `edit({id, action:'delete', expectedUpdatedAt})` | `status='deleted'`、`deletedAt`、保留 runs/任务 | 不撤回已投递消息；正在跑的 run 继续 | 原生删除失败 → 不写 commander；原生已不存在 → 仍可软删 |
| 立即运行 | `run({id})` | 记 `manual` run（由 `schedule/changed` 物化） | 可能 `schedule_execution_pending` | 不消费原 occurrence；可能重复 |
| 单次完成 | 原生 `ended` | `status='ended'` | — | 卡片进「已结束」分组；可删除/清理 |
| 原生页外部编辑/删除 | — | 对账：`view()` 缺失 → `target_lost`；字段不一致 → 以原生为准镜像 | — | 不静默采用原生页新建的任务（避免看板被塞满），phase 2 可加“导入” |

### 9.1 写序与一致性

- **先原生、后 commander**（原生是规则真相）：原生成功 → 写 commander；commander 写失败 → 返回错误，但下次 `schedule/changed`/启动对账会把镜像纠正；不出现“commander 说 active、原生已删”的长期漂移。
- 原生成功、commander 写失败时，不能回滚原生（否则可能把用户刚设的规则弄丢）；记录 `syncError` + 告警，UI 显示“同步中/需刷新”。
- **CAS 双保险**：原生 `expectedUpdatedAt` + commander `version`；任一冲突都返回 409，不部分写入。
- 删除是**软删**（保留历史与升级任务）；phase 2 再提供“彻底删除”（删除 schedule 记录与 runs，保留已生成的 TaskRecord，因为任务是独立审计实体）。

### 9.2 暂停是否等于“跳过当前轮”

- 暂停只阻止**未来触发**；已经投递的 run 继续跑完。
- 如果用户想“跳过下一次但保留之后”，v1 不提供；phase 2 可做“跳过下一轮”（记录一次 skip，不改原生）或“暂停后恢复”（恢复会从下一个未来 occurrence 开始，可能跳过暂停期间的触发——原生语义）。

---

## 10. 并发与重复触发防护

### 10.1 重复投递（原生是 at-least-once）

- 原生明确“Delivery can repeat after a crash”；`deliveryHistory` 的 `messageId` 用于区分投递。
- commander 幂等键：
  - 主键：`(scheduleId, occurrenceAt, attempt)`；同一 occurrence 只保留一条 run；
  - 对账键：`(nativeScheduleId, lastDelivery.messageId)`（识别“这条 receipt 是否已处理”；重复 messageId/同一 occurrence 只更新 `deliveredAt` 并记 `note='duplicate_delivery'`）；`missed` 没有 messageId，用 `(scheduleId, 计划 scheduledAt, attempt)` 去重；
  - 持久化 `lastProcessedMessageId` + `recentRuns`；物化前 CAS，已存在则只更新 `deliveredAt`（若不同）并跳过计数。
- 重启对账：启动时全量扫 schedule，处理 `lastDelivery` 尚未物化的；已物化但 run 仍是 `delivered/running` 的，读会话事件补齐终态。
- 若观察者错过中间投递（`catalog().lastDelivery` 只保留最新一条），启动/低频对账可读原生 `history`（≤200）按 messageId 补齐最近缺失项；仍只补可得的，不承诺全量。
- 若原生重复投递了两条消息（不同 messageId、同一 occurrence）：**同一 occurrence 只保留一条 run**，只更新 `deliveredAt` 并记 `note='duplicate_delivery'`，不建第二条 run、不重复升级任务；只告警一次。

### 10.2 重叠运行

- `session/new_once` 目标：原生单飞，同一任务上一次未回 idle 时不会并发投递；但**下一次 occurrence 仍可能排队**，最终串行执行。
- `new` 目标：原生只保证最小间隔（默认 60s），长任务可能与下一个 occurrence 重叠。
- commander v1 **不拦截投递**（没有可靠的事前拦截点），只：
  - 记录 `overlap`（上一个 run 未终态时出现新 receipt）；
  - 看板显示「重叠运行」；
  - `maxConcurrent` 仅展示/告警，不强制。
- phase 2 若要“跳过重叠”：在 run 开始/结束时 `edit({active:false/true})` 切原生任务；需处理崩溃后恢复、`not_future`、以及暂停期间错过触发；复杂度高，先不做。

### 10.3 全局单卡与队列

- `direct`/`on_anomaly`：不产生 pending，不受单卡限制。
- `confirm`：每个触发一个 draft，按 `occurrenceAt` 排队；一次只允许一个 pending；前一个确认/取消后推进下一个。排队中的卡片显示「定时触发，等待确认」，不占用 `pendingDispatch`。
- `dispatch` 服务现有的 `pending_dispatch_exists` 仍是硬约束；定时模块不绕过它，只做队头调度。

### 10.4 其他并发

- **单 Host 假设**：现有架构没有跨进程锁（`implementation-plan` §14-8）；定时模块同样假设单 Host。多 Host 需要外部 lease，不在本期。
- **重复创建**：UI 双提交用 `requestId` 幂等（现有 HTTP 5min LRU）；服务层再用“同一 native 任务只允许一个 commander 记录”的查询兜底（native id 唯一）。
- **时钟回拨**：原生用 UTC instant + 自己的 timer；commander 不计算 occurrence；看门狗用 `Date.now` 容忍 ±grace（建议 2×watchdog），不因回拨误判。
- **crash 窗口**：
  - 原生投递成功、commander 未物化 → 启动对账补；
  - commander 物化、run 未开始 → 对账读会话事件，补齐/标记 missed；
  - 暂停成功、commander 未写 → 对账以原生为准，补写 paused；
  - 删除成功、commander 未写 → 对账 `schedule_not_found`，补软删/告警。

---

## 11. 看板呈现与筛选

### 11.1 布局（推荐）

```text
┌─ 任务看板 ────────────────────────────────────────────────┐
│ [看板] [回收站]                    [筛选: 全部 ▾] [+ 新建] │
│ ┌─ 定时任务 (3)  [展开/收起] ───────────────────────────┐ │
│ │ [卡1 周期·下次 09:30] [卡2 单次·已完成] [卡3 已暂停] │ │
│ └──────────────────────────────────────────────────────┘ │
│  待派发 │ 待运行 │ 运行中 │ 受阻 │ 待验收 │ 已验收        │
│  …      │ …      │ [定时] │ [定时]│ …      │ …              │
└───────────────────────────────────────────────────────────┘
```

- **不新增第 7 列**：六列是任务状态语义，定时任务是另一种对象；第 7 列会破坏“列=状态”的契约，也无法表达“暂停/已结束”。
- **顶部定时条**：每张卡 = 一个 schedule；横向滚动或网格；默认展开，可收起；展开状态存 localStorage（与现有列宽同类）。
- **六列**：只显示升级后的 TaskRecord；`data-schedule="true"` + 「定时」徽标；视觉上与普通任务区分，但仍可点开现有任务抽屉。
- **筛选**：顶部筛选 chip「全部 / 只看定时 / 隐藏定时」；「只看定时」时六列只显示带 `scheduleId` 的任务；定时条不受影响。
- **换页/移动端**：定时条改为两行网格；抽屉全屏。

### 11.2 定时卡内容

| 区域 | 内容 |
|---|---|
| 标题 | schedule.title；`单次` / `周期` 徽标；health 徽标（正常/失败/目标丢失/系统暂停） |
| 规则摘要 | “每 30 分钟” / “每天 09:30（Asia/Shanghai）” / “每周一 10:00” / “单次 11-25 09:30” |
| 下次触发 | 相对时间 + 绝对本地时间；已暂停/已结束显示对应文案 |
| 目标 | 工作区名 + 模式（复用会话/新会话/指定会话）；会话标题（如已知） |
| 上次结果 | 时间 + 状态 chip + 耗时（如可算） |
| 操作 | 暂停/恢复、立即运行、历史、更多（编辑/删除） |
| 计数 | 今日/累计触发、连续失败数（失败时显示） |

### 11.3 抽屉

三个 tab（或分段）：

1. **概览**：规则（含时区、DST 说明）、目标、下次触发、策略（升级/超时/重试）、原生任务 id（可复制，调试用）、绑定状态。
2. **历史**：
   - run 列表（新→旧，≤20，可加载更多走原生 deliveryHistory）；
   - 每行：occurrence 本地时间、状态 chip（成功/失败/受阻/超时/错过/手动）、耗时、会话、最后回复摘要（折叠）、升级任务链接；
   - 产出入口：打开会话、查看会话记录（复用 `GET /commander/session-transcript`）、查看材料（升级任务的材料面板）、复制摘要；
   - 失败行：展开看 reason + 处置建议。
   - 原生「投递记录」子段：receipt（scheduledAt/deliveredAt/messageId），用于排查“投了没跑/跑了没投”。
3. **设置**：编辑标题/目标/规则/策略、暂停/恢复、删除；修改前显示影响（如“改目标会新建/切换会话”）。

### 11.4 单次 vs 周期

- `at` → 「单次」徽标；跑完 → `ended`，卡片移到定时条的「已结束」分组（可折叠），显示“已完成于 …”；操作只剩「查看历史/删除」。
- 其他 → 「周期」徽标 + 规则摘要 + 下次触发；暂停显示「已暂停」。
- `every` 要标“从创建/修改时起算，不整点对齐”，避免误解。

### 11.5 空态/错误态

- 空态：“还没有定时任务。可以让指挥官创建，或点「新建定时任务」。”
- 原生调度器不可用（`ctx.get('schedule')` 缺失）：定时条显示“定时能力不可用（DSH 版本/插件未启用）”，不阻塞普通看板；`/commander/health` 增加 `scheduler:'present'|'absent'`。
- 目标丢失/系统暂停：卡片红色 health + 说明 + 「重新绑定/恢复」。
- 同步失败：卡片显示“配置同步中/失败”，提供重试。

### 11.6 文案（i18n 两份同改）

新增 key（zh/en 各一份）：

- `board.schedule.strip` / `.empty` / `.new` / `.collapse` / `.expand`
- `board.schedule.badge.once` / `.recurring`
- `board.schedule.status.active` / `.paused` / `.ended` / `.deleted`
- `board.schedule.health.ok` / `.failing` / `.targetLost` / `.pausedBySystem`
- `board.schedule.next` / `.nextIn` / `.last` / `.runNow` / `.pause` / `.resume` / `.history` / `.delete`
- `board.filter.all` / `.onlySchedule` / `.hideSchedule`
- `schedule.drawer.overview` / `.history` / `.settings`
- `schedule.history.state.*`（succeeded/failed/blocked/timeout/missed/manual）
- `schedule.alert.*`（runFailed/timeout/targetLost/missed/recovered）
- `task.scheduleBadge`（六列任务上的「定时」）

### 11.7 备选呈现（不推荐）

| 备选 | 优点 | 缺点 |
|---|---|---|
| 第 7 列「定时」 | 一眼看到全部定时任务 | 破坏“列=状态”；暂停/已结束/健康度没有位置；六列宽度被挤 |
| 新增顶部 tab「定时」 | 与看板分离清晰 | 违背“统一看板”；用户要在两个视图间切换 |
| 每轮一张任务卡进六列 | 字面“一个任务一个卡” | 高频任务淹没看板；成功轮次也需验收；计数/存储膨胀 |
| 原生「自动化任务」页直接当看板 | 零开发 | 没有任务/验收/派发/会话语义；不能统一管理 |

---

## 12. 数据模型改动

### 12.1 新表 `schedules`（第 8 张，per-record）

```ts
export type ScheduleStatus = 'active' | 'paused' | 'ended' | 'deleted'
export type ScheduleKind = 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'
export type ScheduleRule =
  | { kind: 'at'; at: string }                  // RFC3339 UTC
  | { kind: 'every'; everySeconds: number }     // >= 60
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] } // 1..7, 周一=1
  | { kind: 'cron'; expression: string; timeZone: string }
  | { kind: 'rrule'; rrule: string }            // DTSTART+RRULE

export interface ScheduleRecord {
  v: 1
  id: string                         // sch_<...>，key 规范化同现有
  title: string                      // ≤120
  goal: string                       // 任务目标，升级任务时用
  prompt: string                     // 每次投递给工作会话的指令
  status: ScheduleStatus
  rule: ScheduleRule
  timeZone: string                   // 展示时区（IANA）；every/at 也存
  nativeScheduleId: string           // 1:1 映射
  nativeUpdatedAt?: string           // 原生 CAS 用
  target: {
    /** direct 必填且非空；confirm / authorize_then_direct 的首轮是“建议目标”，可为 ''（由 Jev/确认决定）。 */
    workspaceId: string
    mode: 'attach' | 'new_once' | 'new'
    sessionId?: string               // attach；new_once 首次投递后回填
    cwd?: string                     // new/new_once
    agentPreset?: string
  }
  dispatchMode: 'authorize_then_direct' | 'direct' | 'confirm'
  /** 仅 authorize_then_direct：首轮授权状态；direct 视为创建即授权，confirm 不使用。 */
  authorization?: {
    state: 'pending' | 'authorized' | 'denied'
    at?: number
    /** 授权后的工作目标（与 target 同形）；用于重指 native target 与展示。 */
    target?: { workspaceId: string; mode: 'attach' | 'new_once' | 'new'; sessionId?: string; cwd?: string }
  }
  escalation: 'on_anomaly' | 'each_run' | 'always'
  policy: {
    timeoutMinutes: number           // 默认 60
    maxAttempts: number              // 默认 1（v1 不自动重试）
    autoPauseAfterFailures: number   // 默认 3
    alertAfterFailures: number       // 默认 1
    keepRuns: number                 // 默认 20，上限 50
    overlap: 'record' | 'skip'       // v1 只 record
  }
  counters: {
    fires: number
    succeeded: number
    failed: number
    missed: number
    skipped: number
    consecutiveFailures: number
  }
  lastProcessedMessageId?: string
  /** 已发起「重跑本轮」但尚未物化：记原 occurrence，物化时写入 manualOfOccurrenceAt 并清空。 */
  pendingManual?: { occurrenceAt: number; at: number }
  lastRun?: ScheduleRun
  recentRuns: ScheduleRun[]          // 新→旧，≤keepRuns
  health: 'ok' | 'failing' | 'target_lost' | 'paused_by_system'
  /** 原生任务被归档/外部删除的检测时间；用于 target_lost 展示与重建。 */
  nativeMissingAt?: number
  /** 原生与 commander 写序不一致时的最近错误（不阻塞读；下次对账自愈）。 */
  syncError?: { code: string; message: string; at: number }
  createdBy: 'user' | 'commander'
  createdAt: number
  updatedAt: number
  deletedAt?: number
  version: number
}
```

- 存储大小：20 runs × ~250B ≈ 5KB/记录；高频任务（每分钟）每天 1440 次写整条会放大写放大。**v1 接受**；若实测写放大明显，phase 2 拆 `schedule_runs` 表（append-only + 保留策略），schedules 只留 lastRun/counters。
- `keepRuns` 上限 50；超过裁剪最旧。
- `recentRuns` 里不存长报告/材料，只存摘要与引用；完整产出按需读会话/原生 history。

### 12.2 `TaskRecord` 新增可选字段

```ts
export interface TaskScheduleRef {
  scheduleId: string
  occurrenceAt: number   // 该 run 的 occurrence（UTC ms）
  attempt: number        // 从 1 开始
}

export interface TaskRecord {
  // …现有字段
  schedule?: TaskScheduleRef
}
```

- 旧记录缺省 = 普通任务；新记录普通任务不写该字段。
- `each_run`（phase 2）还需要：`draft→review` 迁移（actor `host_schedule`）与 `AcceptanceItem.source='host'`（当前 schema 只有 `'commander'`）。**v1 不实现 `each_run`**，这两项属于独立契约变更，先改 §1.3/状态机文档再写代码。
- 升级任务的 `timeline` 增加一条 `type:'status'`（现有 enum 够用）文案；不新增 timeline type。
- 不新增任务状态、不改 `TaskStatus`。

### 12.3 其他表

- `dispatches`：`confirm`/`always` 模式的派发记录可加可选 `scheduleId?: string`，用于溯源；`direct` 模式不写 dispatch。
- `sessions`：不改结构；升级任务写 link 时沿用现有字段（`round` 仍为任务返工轮）。
- `commands`：不写；升级任务 `commandId=''`。
- `board_edits`：不改；升级任务的人工改动仍走现有看板 PATCH。
- `config`：v1 不加字段；超时/重试/上限用代码常量（可后续加到设置页）。

### 12.4 快照与视图

```ts
export interface ScheduleCardView {
  id: string
  title: string
  status: ScheduleStatus
  health: ScheduleRecord['health']
  kind: ScheduleKind
  ruleText: string                 // Host 渲染的短文案
  timeZone: string
  nextRunAt?: number
  lastRunAt?: number
  lastRunState?: ScheduleRun['state']
  target: { workspaceId: string; workspaceName?: string; mode: string; sessionId?: string }
  dispatchMode: 'authorize_then_direct' | 'direct' | 'confirm'
  authorizationState?: 'pending' | 'authorized' | 'denied'
  escalation: ScheduleRecord['escalation']
  counters: ScheduleRecord['counters']
  updatedAt: number
}

export interface TaskView {
  // …现有字段
  scheduleId?: string
  scheduleOccurrenceAt?: number
  scheduleAttempt?: number
}

export interface CommanderSnapshot {
  // …现有字段
  schedules: ScheduleCardView[]   // ≤100；active 按 nextRunAt，其余按 updatedAt
  scheduleSummary: { active: number; paused: number; ended: number; failing: number; targetLost: number }
}
```

- `TaskView.scheduleTitle` 不冗余存，客户端用 `schedules` join；任务详情 `GET /commander/tasks/:id` 增加 `schedule` 摘要（可选）。
- `workSessions` 扩展：`Array<{sessionId, taskId?, scheduleId?, title?}>`（见 §7.5）。

### 12.5 路由 / 工具 / 事件

**人专用路由**（Client 调；不接受模型调用）：

| 方法/路径 | 作用 |
|---|---|
| `GET /commander/schedules?status=&limit=&offset=` | 列表（快照已有；此路由给分页/筛选） |
| `GET /commander/schedules/:id` | 详情：schedule + recentRuns + native deliveryHistory（≤50）+ 升级任务 |
| `POST /commander/schedules` | 创建（`requestId` 幂等；含 target 二次确认） |
| `PATCH /commander/schedules/:id` | 编辑（`expectedRevision` + 原生 `expectedUpdatedAt`） |
| `POST /commander/schedules/:id/pause` / `resume` / `run-now` / `delete` | 生命周期动作 |
| `GET /commander/schedules/:id/runs?before=` | 历史分页（读完 recentRuns 后走原生 history） |

**模型工具**（仅指挥官会话；全部写操作只在用户明确要求时）：

| 工具 | 权限 |
|---|---|
| `commander_schedule_create` | 只能创建 `dispatchMode='confirm'`；不能设 `direct`/`always`/target 自动；`timeZone` 必填 |
| `commander_schedule_list` / `get` | 只读 |
| `commander_schedule_update` | 只能 `pause/resume/edit(title/goal/prompt/rule/timeZone)`；不能改 target/dispatchMode/escalation/policy；必带 `expectedRevision`（commander 记录 version；原生 CAS 用 Host 保存的 `nativeUpdatedAt`，不暴露给模型） |
| `commander_schedule_run` | 不提供（避免模型触发开销）；立即运行仅人 |

**SSE**：

| event | data | 触发 |
|---|---|---|
| `schedule.updated` | `{schedule: ScheduleCardView, rev}` | schedule 任意写/镜像/run 状态变化 |
| `schedules.changed` | `{summary, rev}` | 计数变化（可与上一条合并） |
| （复用）`task.updated` / `tasks.changed` | 现有 | 升级任务 |

### 12.6 迁移与向后兼容（关键取舍）

- **保持 `DOMAIN_VERSION = 1`，加法式新增 `schedules` 表**。已核实的存储语义：
  - 读旧数据：per-record 后端只按 descriptor 声明的表建空 Map；缺失目录 = 空表，不读、不写、不报错（`dsh-storage-json/src/per-record-unit.ts#loadPerRecordState` L59–106），所以新代码打开旧数据 = 空 schedules，无迁移；
  - 旧代码读新数据：`loadPerRecordState` 只把**自己声明的表**目录装进 state，多出来的第 8 表目录被忽略（同上）；`isTaskRecord` 是手写校验器、不拒绝未知字段，所以带 `schedule` 的新任务旧代码也能读；
  - 升到 version 2 的代价：per-record 记录会以新 version 戳写；回滚到旧代码时 `parseRecord` 对不接受的版本**静默当作不存在**（`dsh-storage-json/src/format.ts#parseRecord` L104–124），会让回滚后的任务“消失”。因此**不升版本**，除非未来做正式迁移与回滚策略。
- 需要同步修改的契约点：`TABLE_NAMES`（`src/host/config.ts`）、`CommanderDomainSpec.tables`（`src/host/domain.ts`）、`assertDomainSpec` 的 7→8 断言、`docs/ARCHITECTURE.md` §3.2、HANDOVER 的“7 表”表述。
- 无 backfill；旧任务 `schedule` 缺省；旧客户端忽略 `schedules`/新 SSE 事件（客户端按已知事件名分发）。
- **回滚演练**（实施时必做）：用 v1 数据 + 新代码打开/读写；再用旧构建打开新数据，确认第 8 表被忽略、任务可读。若发现旧代码因 `assertDomainSpec`/表数断言失败（当前旧代码只检查自己的 7 张，不应失败），记录并调整。

### 12.7 不变量与校验

- `schedules`：`nativeScheduleId` 唯一（应用层查询）；`rule` 与原生规范化一致；`status='active'` 时 `native` 必须存在（对账异步纠正）；`recentRuns` 按 occurrenceAt 降序、无重复 `(occurrenceAt, attempt)`。
- `TaskRecord.schedule`：`scheduleId` 必须存在（软删也可）；`occurrenceAt > 0`；`attempt >= 1`；同一 `(scheduleId, occurrenceAt, attempt)` 最多一个 TaskRecord（应用层唯一）。
- 升级任务必须满足现有不变量：`blocked` 有 `block.reason`；有 `primarySessionId` 时应有对应 link（link 冲突时按 §5.3 不写 `primarySessionId`）；`review`（phase 2）至少 1 条 acceptance。
- 所有状态写入仍经 `transitionTask`；新增 actor `host_schedule` 的权限表必须先改 `docs/architecture/task-state-machine-final.md`。

---

## 13. 与 DSH 原生调度能力的关系（包装 vs 自建）

### 13.1 结论：包装，不自建

**原生是唯一 recurrence timer / 规则解析 / 时区 / 投递 / 投递历史 / 暂停恢复 / CAS 的实现。** commander 只在其上叠加：策略、run 账本、看板、异常升级、一个 60s 看门狗。

理由：

1. 原生已经实现完整 rrule 子集、cron、DST、单 timer、错过触发取最近一次、投递最小间隔、至少一次语义、历史保留、归档联动；
2. 自建要重写这些，且很难达到同样的边界正确性（DST 缺口/重叠、RRULE 展开、频率上限、时钟回拨）；
3. 双套调度会带来双投递/双计时/状态不一致，是最差解；
4. commander 现有 Host 约束是零运行时依赖（不 import `@deepseek-ai/*`），通过 `ctx.get('schedule')` 软依赖访问，天然适合包装；实现时用 `ctx.inject(['schedule'], ...)` 延迟挂载，服务缺失则整块功能降级为 `scheduler:'absent'`，不阻塞插件启动。

### 13.2 职责划分

| 能力 | 原生 | commander |
|---|---|---|
| 规则解析/时区/DST | ✅ | 只做 UI 预设与字段映射 |
| recurrence timer | ✅（单 timer） | ❌（只加 60s 看门狗，不参与 recurrence） |
| 下一次触发计算 | ✅ | 只镜像展示 |
| 投递到会话 | ✅ | 不重复投递 |
| 投递历史 | ✅（30d/200） | 代理展示 + 自己的 run 摘要（≤20） |
| 暂停/恢复/编辑/删除 | ✅（CAS） | 镜像 + 看板动作 + 策略校验 |
| 目标绑定/会话选择 | 原生只校验存在/根/非归档 | commander 负责白名单/业务校验/复用策略 |
| 并发/单飞 | ✅（session 目标） | 记录重叠；v1 不加第二道闸 |
| 错过触发 | ✅ 最近一次 | 记录 `missed` + 告警；不重放 |
| 任务/验收/看板 | ❌ | ✅ 复用现有 |
| 失败/超时/告警 | ❌（只 log） | ✅ 看门狗 + 注入 + 升级任务 |
| 权限（人/模型） | 原生工具有自己的授权文本 | commander 更严格：模型只能 confirm |

### 13.3 原生能力映射（commander 视角）

| commander 需求 | 原生能力 | 备注 |
|---|---|---|
| “每 30 分钟” | `every: 1800` | 从创建/改规则起算 |
| “每天 9:30” | `daily` + `Asia/Shanghai` | DST 由原生处理 |
| “每周一 10:00” | `weekly` + weekdays `[1]` | 周一=1 |
| “每月最后工作日” | `rrule`（BYSETPOS=-1） | 原生示例即此 |
| “单次 11-25 09:30” | `at` | 严格未来 |
| “补跑最近一次” | 原生启动/下次 drive 自动 | 不重放全部 |
| “暂停/恢复” | `edit(active:false/true)` | 恢复要求未来 occurrence |
| “立即运行” | `run` | 不消费原 occurrence |
| “投递历史” | `history` | 30d/200 |
| “目标会话归档就停” | 原生自动删任务 | commander 必须 `target_lost` 对账 |

### 13.4 双入口问题（原生「自动化任务」页）

- commander 创建的 native 任务会出现在原生「自动化任务」页（原生是全局的），用户可能在那边删除/编辑。
- 建议：
  1. **接受双入口**，不隐藏原生页（隐藏会影响用户已创建的原生任务）；
  2. commander 卡片/抽屉显示 native schedule id，提供“在原生页查看/编辑规则”的说明（不做跨页深链，避免依赖原生内部路由）；
  3. commander 以 `schedule/changed` 对账；原生页删除 → `target_lost`，提示“已被原生页删除，是否重建”；
  4. **不自动把原生页新建的任务导入 commander**（会塞满看板）；phase 2 可加显式「导入已有定时任务」按钮。
- 文档/发布说明要写清：commander 的定时任务与原生「自动化任务」是同一批底层任务，两个入口；commander 不复制规则。

### 13.5 被否决的备选：自建调度器

| 维度 | 自建 | 包装 |
|---|---|---|
| rrule/cron/DST | 需重写并长期测试 | 原生已覆盖 |
| 计时器 | 第二套 timer，必须自己做 | 原生单 timer |
| 错过触发 | 自己定义 | 原生“最近一次” |
| 投递 | 自己 followup/flush | 原生已做 |
| 可靠性 | 需自己处理至少一次/CAS/归档 | 原生已做 |
| 与原生页关系 | 两套独立任务，用户困惑 | 同一底层任务 |
| 结论 | ❌ | ✅ |

### 13.6 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 原生 API/字段在 DSH 升级中变化 | 集成破裂 | P0 spike + 版本探测 + 降级（`scheduler:'absent'`）；不复制原生类型，最小接口面 |
| `schedule/changed` 无 payload，事件风暴 | 每次全量读 catalog | ≤100 任务可接受；串行合并（debounce 100ms）；只读不写 |
| 原生归档删任务 | 定时任务静默消失 | `target_lost` 对账 + 告警 + 重新绑定 |
| 原生只补最近一次 | 停机期间少跑 | 明确语义；`missed` 告警；不承诺补全 |
| 至少一次/重复投递 | 重复 run/任务 | messageId 幂等 + 对账 |
| 双入口误删 | 用户困惑 | 文档 + 对账 + 重建入口 |
| 卸载 commander 后原生任务继续跑 | 无人看管/重复投递 | 文档明确；phase 2 提供“暂停全部 commander 定时任务”动作 |
| 模型在 confirm 模式不按提醒执行 | 漏派发 | Host 先建 draft（确定性）；提醒文案固定；失败告警 |
| 定时运行审批阻塞 | 无人值守卡住 | 审批卡可见（workSessions 扩展）+ 超时告警；不自动放行 |

---

## 14. 权限与安全边界

### 14.1 角色矩阵

| 动作 | 人（UI 路由） | 指挥官模型（工具） | Host |
|---|---|---|---|
| 创建 `direct` / `authorize_then_direct` / 开自动 | ✅（二次确认） | ❌ | ❌ |
| 创建 `confirm` | ✅ | ✅（用户明确要求） | ❌ |
| 首轮授权（authorize_then_direct） | ✅（确认卡） | ✅（按用户确认执行 dispatch） | ❌ |
| 编辑 target / dispatchMode / policy | ✅ | ❌ | ❌ |
| 编辑 title/goal/prompt/rule/timeZone | ✅ | ✅（仅 confirm，用户要求） | ❌ |
| 暂停/恢复 | ✅ | ✅（confirm 模式） | ✅（熔断/目标丢失） |
| 删除 | ✅ | ❌ | ❌（只软删/停用） |
| 立即运行 | ✅ | ❌ | ❌ |
| 升级任务 | — | — | ✅（`host_schedule`，仅 `draft→blocked`） |
| 验收/归档 | ✅ | ❌ | ❌ |
| 回答审批 | ✅ | ❌ | ❌ |

### 14.2 目标校验（防越权/误投）

- 工作区必须 `allowed`；`new` 的 `cwd` 必须在允许工作区路径内（或等于工作区 path）。
- `attach` 会话：根会话、非归档、非 subagent、非指挥官会话、存在；不允许跨工作区（session 的 workspace 必须匹配目标 workspace）。
- 不允许把定时任务投到“子 agent / teammate”会话（原生本身也会拒 subagent，但 commander 先在业务层拒）。
- 目标工作区从白名单移除时：暂停所有指向它的 active schedule + 告警（不继续投）。

### 14.3 Prompt 注入与内容安全

- schedule 的 `title/goal/prompt` 是用户内容，投递时由原生用 JSON 引号包裹（`reminder_prompt_json`），commander 的告警/提醒也用 JSON 转义；Host **不解析**内容为指令。
- `confirm` 模式的提醒模板固定，只插入转义后的 id/标题；不让用户内容改变模板结构。
- 不把 Jev key、文件路径以外的敏感配置写进 schedule/run；不新增外部网络调用。
- 定时任务可能把内容投到工作会话（同一 Host 内），不扩大既有数据边界；看板快照只含摘要，不含完整 prompt/回复正文。

### 14.4 审批与沙箱

- 定时运行仍受 DSH 的正常审批/沙箱/工具权限约束；Host **不注册第二个 answerer、不自动 allowed-once**。
- 审批/提问挂起 → run `blocked` + 告警；用户可在指挥官审批卡或原会话处理。
- 定时任务不获得额外工具/能力；`agentPreset` 由创建人选择，不能借定时任务绕过工作区策略。

### 14.5 配额与防跑飞

- 单任务最小间隔 60s（原生）；每日触发上限（建议 1500，覆盖 1 分钟间隔；超过自动暂停 + 告警）。
- 全局/单工作区 schedule 数量上限（建议 100/20）。
- `recentRuns`/native history 保留上限；看门狗扫描上限（只扫 active/paused，≤100）。
- 连续失败自动暂停；恢复需人。
- 模型工具不能创建 `direct`/`authorize_then_direct`；模型创建的 `confirm` 任务最小间隔 5 分钟、每日触发上限 500（`direct` 由人设，仍受 60s 原生下限与全局 1500/日上限）。

### 14.6 审计

- v1 的审计面：`schedules.createdBy`、`createdAt/updatedAt`、`nativeUpdatedAt`、`recentRuns`、原生 `deliveryHistory`、Host 日志；编辑/暂停/删除的“谁在何时做了什么”可由这些时间戳与告警/run 变更推断。
- 如需要更强的审计，phase 2 再加 `recentEvents`（≤20，`{at, kind, by}`）；**不纳入 v1 schema**，避免为了审计先加一张小表/字段。
- 升级任务有完整 timeline（现有）；run 有 reason/taskId；原生有 deliveryHistory。三方可对账。

---

## 15. 分阶段落地计划与验收

### 15.1 阶段

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P0 Spike** | 隔离 `DSH_HOME` 验证：`ctx.get('schedule')` 可用；`schedule/changed` 在投递后触发；`lastDelivery` 可读；`session` target 可指向 commander 选的工作会话；`run`/`edit`/CAS；目标会话归档会删原生任务；scheduled 消息在 `session/event` 里的 messageId/turn 形状 | `docs/validation/schedule-spike.md`（命令/证据/结论） | 0.5d |
| **P1 契约+数据+CRUD** | 改契约文档；`schedules` 表/schema/store；`TABLE_NAMES`；创建/编辑/暂停/恢复/删除路由；快照/SSE；原生映射层 | 代码 + 单测/集成；契约 diff | 1.5d |
| **P2 直连触发+run 账本** | **前提：Q1 选 direct**；`TriggerObserver`（幂等物化）、`RunTracker`（turn 事件/终态）、`Escalator`（异常任务）、启动对账；`workSessions` 扩展。若 Q1 选 authorize_then_direct/confirm，P2 先只做 P1 的 CRUD，触发部分随 P5 | 集成测试（fake schedule 事件 + 真 tracker）+ 隔离 e2e（`at` +5s） | 2d |
| **P3 看板 UI** | 顶部定时条、卡片、徽标、筛选、抽屉（概览/历史/设置）、单次/周期、空态/错误态、i18n | client harness + 截图/交互验证 | 1.5d |
| **P4 看门狗/告警/重试** | 60s watchdog、超时/错过/目标丢失、熔断、`[schedule-alert]` 注入与客户端卡片、人工重跑 | 单测（fake clock）+ 集成 | 1d |
| **P5 Confirm + 首轮授权（可选）** | native target=指挥官、draft 物化、首轮确认后重指、R1 重指、单卡排队、模型工具限制 | 集成/e2e（stub model） | 2–2.5d |
| **P6 验证与文档** | 迁移/回滚演练、e2e、验收文档、发布说明 | `docs/validation/schedule-*.md`；HANDOVER/ARCHITECTURE 更新 | 1d |
| **合计** | P0–P4+P6 | | **7.5–8.5d** |

> 阶段顺序取决于 Q1：若选 `direct`，按 P0→P6；若选 `authorize_then_direct`/`confirm`，P2 的触发部分与 P5 合并（P1/P3 可先做看板骨架，P4 的看门狗依赖触发），总工期约 8.5–10d。具体拆分在 Q1 拍板后再定。

### 15.2 验收方式（按仓库验证分层）

| 层 | 必须覆盖 |
|---|---|
| unit | 规则映射/时区/校验；run 状态机；幂等键；升级策略；熔断；状态镜像；CAS |
| integration | fake schedule service 触发 → run；重复 `schedule/changed` 不重复；turn/start/end → succeeded/failed/blocked；超时；目标丢失；暂停/恢复/编辑/删除；升级任务满足 `blocked.reason`/link/不变量；`workSessions` 含 schedule 会话；告警去重 |
| e2e（隔离 `DSH_HOME` + stub model） | 创建 `at` +5s → 原生投递 → 工作会话跑一轮 → run 成功；失败 stub → blocked 任务；暂停后不再触发；重启后对账不重复；`run-now` |
| client | 定时条/卡片/徽标/筛选/抽屉/单次 vs 周期/i18n 两份；harness 全绿 |
| 兼容 | v1 数据 fixture 打开；新代码读写；旧构建打开新数据（第 8 表忽略）；无 schema 断言失败 |
| 安全 | 模型工具不能建 direct/改 target/policy；未授权工作区拒绝；归档/子 agent/指挥官会话拒绝；审批不被自动回答 |
| live | 只读 `/commander/health`（加 `scheduler:'present'`）+ 用户手动创建 1 条测试任务；安装/重启由用户执行；不在 live 跑脚本 |

命令（与仓库约定一致）：

```bash
pnpm --filter dsh-commander typecheck
pnpm --filter dsh-commander test
pnpm --filter dsh-commander build
pnpm --filter dsh-commander build:client
node packages/dsh-commander/tests/client/harness/run-harness.mjs
node packages/dsh-commander/tests/e2e/m23-e2e.mjs   # 回归
# 新增：node packages/dsh-commander/tests/e2e/schedule-e2e.mjs（隔离 DSH_HOME + stub 模型）
bash tools/dev/install-live-m0.sh                    # 只读预检；不写 live
```

### 15.3 验收清单（DoD）

1. 创建一条 `direct` 定时任务 → 原生 1:1 任务存在；看板定时条出现；暂停/恢复/编辑/删除双向一致。
2. 触发一次 → 只物化一条 run；重复 `schedule/changed`/重启不重复。
3. 成功 run → 历史可见、可在会话里看产出；**不**产生待验收任务。
4. 失败/超时/目标归档 → run 终态 + `[schedule-alert]` + 一条 `blocked` 升级任务（含会话 link）。
5. `confirm` 模式 → draft + 确认卡；全局单卡不冲突；R1 换任后 native target 重指。
6. 停机跨过多次触发 → 只补最近一次；`missed` 有告警；不重放历史。
7. 原生页删除 commander 任务 → `target_lost` + 告警 + 重建入口。
8. 模型工具无法创建 direct/改策略；白名单/归档/子 agent 拒绝。
9. 旧数据可读、可写；回滚演练通过；typecheck/test/build/harness/e2e 全绿。
10. 文档：契约、HANDOVER、ARCHITECTURE、用户说明同步。

### 15.4 发布与回滚

- Host 新增文件（`src/host/schedule/**`、`lib/host/schedule/**`）→ **必须重装 + 重启 DSH**（安装是快照式）；Client 改动 → build 后硬刷新。
- 回滚：卸载插件不影响原生 schedule 任务（它们独立存储在 `schedule` 域）；commander 域保留 `schedules`（旧代码忽略）。**注意：卸载/禁用 commander 不会自动暂停已创建的 native 定时任务**，它们仍会在原生页可见并继续投递；需要用户在原生页清理，或 phase 2 提供“关闭模块前暂停全部 commander 定时任务”的显式动作。回滚前建议备份 `~/.dsh/storages/commander` 与 `~/.dsh/storages/schedule`。
- 不在 live 跑测试；隔离 `DSH_HOME`。

---

## 16. 关键取舍与备选方案

| # | 决策 | 推荐 | 备选 | 理由 |
|---|---|---|---|---|
| 1 | 调度实现 | 包装原生 | 自建；双套 | 原生已覆盖规则/时区/补投/历史；双套必乱 |
| 2 | 存储 | 新增 `schedules` 表 | 塞 `config`；塞 `tasks` 模板行 | 配置会膨胀；模板任务污染状态机/看板/工具 |
| 3 | 实例模型 | run 账本 + 异常升级 | 一 Task 多轮；每轮一 Task | 不破坏 `done` 终态；不淹没看板；需要时仍进任务流水线 |
| 4 | 默认派发 | direct（创建即授权） | authorize_then_direct（首轮确认再自动）；confirm（逐次） | 目标已固定，逐次确认是噪声；首轮确认版最贴合现有“首次必确认”，但多一个授权状态与 target 切换 |
| 5 | 看板呈现 | 顶部定时条 + 六列徽标 + 筛选 | 第 7 列；新 tab；每轮一卡 | 不破坏六列契约；统一看板；不淹没 |
| 6 | run 历史 | 内嵌 ≤20 + 原生 history | 新 `schedule_runs` 表 | v1 简单；高频写放大明显时再拆 |
| 7 | 域版本 | 保持 1（加法表） | 升 2 + compatible [1] | 升版本会让回滚静默丢记录（源码已核实） |
| 8 | 同会话多定时 | 先限制 1 个 active direct | 允许并做批次 run | 原生批次消息 + link 单 taskId；v1 先简单 |
| 9 | 超时检测 | 1 个 60s 看门狗 | 无定时器；事件驱动 | 超时/错过无事件可依赖；只加一个只读低频定时器 |
| 10 | 原生页关系 | 双入口 + 对账 + 深链说明 | 隐藏原生页；自动导入 | 隐藏影响已有任务；自动导入会塞满看板 |
| 11 | 成功验收 | 不验收，只留 run | 每轮 review | `done` 仅人；高频任务会堆满待验收 |
| 12 | 重试 | v1 人工/告警 | 自动重试 | 投递语义复杂（run 不消费 occurrence）；先保守 |

---

## 17. 待确认的开放问题（需用户拍板）

> 标注「排版」的属于看板视觉/交互，需要用户确认后我再出细稿。

1. **默认派发策略**：`direct`（创建时显式绑定目标 = 一次授权，之后自动直派，实现最简、推荐 v1）；`authorize_then_direct`（首轮确认、之后自动，最贴合现有“首次必确认”口径，推荐作为产品默认的备选）；`confirm`（每次触发都生成待确认卡）。三选一，还是做成每条任务可选？
2. **看板呈现（排版）**：顶部「定时任务」条 + 六列徽标 + 筛选（推荐）；还是第 7 列 / 新 tab / 每轮一卡？
3. **成功轮次是否需要人验收**：只记 run（推荐）；还是每轮进「待验收」（phase 2 `each_run`）？
4. **异常是否生成受阻任务**：失败/超时默认生成 1 个 `blocked` 任务（推荐，便于恢复/打开会话）；还是只告警不建任务？
5. **模型权限**：模型只能创建 `confirm` 模式、不能开 `direct`/改策略（推荐，安全边界）；是否允许模型创建 `direct`（需更强授权 UI）？
6. **重试**：v1 只人工/告警（推荐）；是否要自动重试（次数/退避/仅哪些失败）？
7. **告警渠道**：面板注入 + 看板 health（推荐一期）；是否需要系统通知/IM/邮件？
8. **保留策略**：`recentRuns=20` + 原生 30d/200（推荐）；是否需要更长/可配？
9. **与原生「自动化任务」页**：双入口 + 对账（推荐）；是否要隐藏/只读/导入？
10. **时区默认**：人从浏览器、模型必填（推荐）；还是统一 Host 时区？
11. **删除语义**：软删保留历史（推荐）；是否需要“彻底删除”？
12. **文案与排版细节（排版）**：定时条高度/是否默认展开/卡片横排还是网格/「单次」「周期」「已暂停」「目标丢失」的具体中英文案；六列徽标位置（标题旁 vs meta 行）。

---

## 18. 证据与参考

### 18.1 原生调度源码（本机 0.2.2-rc.2）

- `@deepseek-ai/dsh-schedule/src/types.ts`：规则/目标/目录/编辑/CAS/事件（L16–142、L344–475、L530–636）。
- `@deepseek-ai/dsh-schedule/src/index.ts`：服务、目标校验、归档删任务、投递限制、`schedule/changed`（L73–105、L226–341、L494–502、L626–700、L754–762）。
- `@deepseek-ai/dsh-schedule/src/runtime.ts`：单 timer、单飞、投递 floor、followup+flush、最近一次补投（L67–70、L140–225、L252–297、L352–387）。
- `@deepseek-ai/dsh-schedule/src/domain.ts`：`MIN_EVERY_INTERVAL_SECONDS=60`、`resolveRecurringOccurrence`、提醒 framing（L42、L810–830、L1159–1190）。
- `@deepseek-ai/dsh-schedule/src/storage.ts`：状态 `active/paused/ended/inactive`、`inactive→ended`、per-record 域 v2（L68–112）。
- `@deepseek-ai/dsh-tool-schedule/src/index.ts`：模型工具面/rrule 子集/target 文案（L196–249、L371–391）。
- `@deepseek-ai/dsh-client-ui-schedule/src/client/index.ts`：原生「自动化任务」侧栏入口 `order:10`（L240–247）。
- `@deepseek-ai/dsh-storage-json/src/per-record-unit.ts`：per-record 只加载声明表、多余表目录忽略、缺目录为空单元（L59–106）。
- `@deepseek-ai/dsh-storage-json/src/format.ts`：整单元缺表读空、per-record 版本戳不接受即丢弃（L47–124）。
- `@deepseek-ai/dsh-workspace/src/index.ts`：归档 `stopActivity` → `workspace/session-stop`（L368–405）。

### 18.2 commander 现有契约与实现

- `docs/architecture/task-state-machine-final.md`：9 状态、迁移矩阵、六列、依赖、`done` 仅人。
- `docs/architecture/implementation-plan.md`：§8.3 快照、§8.4 SSE、§9 派发、§14 非目标（scheduler/单 Host）。
- `docs/NEXT-PHASE.md` §2：冻结决策 #4/#5/#8/#9/#10。
- `src/host/config.ts`：7 表、`AUTO_DISPATCH=false`、`INJECTION_REASONS`、上限。
- `src/host/domain.ts` / `src/host/schema.ts`：域 spec、`TaskRecord`、`isTaskRecord`（不拒绝未知字段）。
- `src/host/dispatch/service.ts`：`needs_confirmation`、单 pending、`finishDispatch`、`spawnDispatch`。
- `src/host/tasks/state-machine.ts`：唯一迁移入口。
- `src/host/trigger/status.ts` / `injection.ts`：turn 状态、孤儿补偿、`[session-reply]`。
- `src/host/api/state.ts`：`TaskView`、`workSessions`、快照上限。
- `src/client/board.ts` / `BoardPage.tsx`：六列分组、无拖拽、抽屉/rounds。
- `src/client/approval.ts` / `ApprovalFloat.tsx`：审批卡依赖 `workSessions`。

### 18.3 实机存储观察（只读）

- `~/.dsh/storages/schedule.json`：9 条原生任务，4 条 active；`at`/`daily`/`rrule` 混合；active 目标均为已存在 `session`；一条 `daily` 有 31 条投递历史；一条 `at` 计划 `00:25` 实际 `01:08` 投递（宿主停机后补投最近一次）。**未在本文引用任何标题/prompt 正文**。
- 结论：原生“最近一次补投”和“至少一次”语义在真实数据中成立；active 任务确实会长期复用同一会话。

---

## 19. 术语

- **Schedule**：定时任务定义（规则+目标+策略），看板上的定时卡。
- **Run**：一次触发产生的一次运行记录（历史/轮次单位）。
- **Occurrence**：规则计算出的计划时刻（UTC instant）。
- **Attempt**：同一 occurrence 的第 N 次尝试（重试）。
- **direct**：原生直接投递到预绑定工作会话，投递即派发。
- **confirm**：原生投递到指挥官会话，由指挥官按现有 Jev/确认卡派发。
- **升级（Escalation）**：把一次异常的 run 变成看板 TaskRecord。
- **原生页**：DSH 侧栏「自动化任务」页（`dsh-client-ui-schedule`）。
