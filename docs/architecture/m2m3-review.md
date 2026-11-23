# M1R/M2/M3 契约复核（architect，独立只读）

> 版本：v1.0　日期：2026-11-18 09:55（Asia/Shanghai）
> 角色：architect（**只读实现与证据**；只写本文件；未改实现/配置/他人证据）。
> 复核对象：`packages/dsh-commander/src/**`（M1R/M2/M3 实现）、`tests/**`、`docs/architecture/m2m3-contract-patch.md`（sha `28a1c1d7…`）、`implementation-plan.md`（sha `9045c634…`）、冻结决策（NEXT-PHASE §2）。
> 核对方式：逐文件只读 + 测试复跑（`pnpm --filter dsh-commander test` → **200/200 pass**，2026-11-18 09:5x）；未跑 e2e/live（tester/devops 负责）。**live 证据未出，本复核不判 live。**

---

## 0. 结论

**M1R/M2/M3 契约复核 = PASS（实现契约层面），HIGH = 0（HIGH-1 已修复并复核关闭）。**

- 实现整体遵守 `m2m3-contract-patch.md`：M1R sessions/attach、M2 看板 Host+Client、M3 注入/整理/审批/accept-rework/播报均已落代码，单测 200/200。
- **HIGH-1（已关闭，owner: backend，2026-11-18 10:0x）**：`commander_task_report` 曾允许 `acceptance: []` 且 outcome=`delivered|partial` → 任务被写成 `status='review'` 但 **0 条 acceptance**，违反 ARCHITECTURE §6 不变量 2。修复：`src/host/tools/index.ts:588-591` 在 `nextStatus==='review' && parsedAcceptance.length===0` 时返回 `invalid_request` 且**不写 task**；`blocked/no_progress` 仍允许空。复核证据：新增单测 `tests/unit/report-tool.test.ts`（delivered/partial 空拒绝且任务保持 running；blocked 空成功）；architect 复跑 `pnpm --filter dsh-commander test` = **201/201 pass**（2026-11-18 10:0x）。
- MEDIUM/LOW 见 §3；**Lead 2026-11-18 已对 3 个 MEDIUM 裁决：全部记为 known limitations（MEDIUM-2 保留 fail-open + 计 metric、不改 fail-closed）**，见 §2/§5。live 验收（看板五列/审批双处/注入实时/accept-rework）待 tester/devops 重载走查后更新 `docs/validation/{m2,m3}-accept.md`。

---

## 1. 逐项检查表

### 1.1 M1 余项（自定义 attach）

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| `GET /commander/sessions?workspaceId=&limit=` 只读、顶层非归档、非子 agent、截断标记、错误码 | `handlers.handleSessionsGet`（`workspaceId`/`limit` 校验、`collectWorkspaceSessions`、`archived` 过滤、`truncated`、`not_found/invalid_request`） | **PASS** |
| `confirmTarget{mode:'attach',sessionId}` 校验：存在、非归档、cwd 属 workspace、非 commander 自身、**不检查占用** | `dispatch/service.ts:614-625`：显式校验 sessionId/archived/commander 自身；`candidates.findTargetConflict`（`candidates.ts:297-303`）仅校验存在+workspaceId 匹配，**不含占用判断** | **PASS**（注释与代码不符，见 LOW-1） |
| 同会话多任务 attach 记录 assignment、无锁、prompt queue | `spawn.ts` attach 分支仅 prompt；`finishDispatch` 写 `assignments` 去重（`service.ts`）；无锁 | **PASS** |
| attach 不调能力面板 | `spawn.ts` 面板调用仅在 `mode==='new'` 分支；attach 走 `inherited` 计划 | **PASS** |
| 自定义卡消息模板 `[dispatch-confirm] 自定义 … target=…;mode:attach;sessionId=…` | Client `DispatchCard.tsx` 加载 `GET /commander/sessions`、选项/模板生成；确认仍走 `POST /commander/message` | **PASS**（模板逐字待 live 复核） |

### 1.2 M2 看板（Host）

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| `PATCH /commander/board/tasks/:id` 字段/校验/幂等/version | `board/service.ts` `patchTask`：field∈{status,priority,title}；status 允许集 = draft/proposed/queued/running/blocked/review/cancelled；`done`/`archived` 拒绝并提示专用路由；review≥1 acceptance、queued 需 primarySessionId；`editId` 重复返回 duplicate；`writeTask` version 冲突重试 3 次 | **PASS** |
| 写 tasks + 一条 `board_edits`（before/after/actor=user） | `patchTask` 先 writeTask（timeline 追加 `user_edit`）再 `boardEdits.put({v:1,...actor:'user'})` | **PASS**（写入非原子，MEDIUM-1） |
| 30s 合并、幂等 injectionKey、只同步最终态、不回滚 | 内存 `merges` per task：`before` 首值、`after` 末值、`editIds` 累加；`setTimeout(mergeWindowMs)`（默认 30s、**unref 的一次性 timer，非 scheduler**）；`buildBoardEditText` 输出 `[board-edit] …请…不要回滚用户改动`；`boardEditInjectionKey=sha1(taskId+editIds)`；`makeInjected` 写 `injectedAt`（首条写 injectionKey） | **PASS** |
| 注入不写任务记录 | `flush()` 只 `deliverer.deliverUserMessage` + 标记 edits；**不写 tasks/timeline** | **PASS** |
| 失败不风暴：保留 injectedAt 空，下次/启动补一次 | `flush` catch 仅 warn；`backfill()` 对 `injectedAt===undefined` 按 task 合并补一次 | **PASS**（投递成功但标记前崩溃→可能重复一次，LOW-2） |
| archive/restore/archive list | `archiveTask`：仅 review/done/cancelled→archived，timeline 保留 created+最后一条+归档摘要；`restoreTask`：archived→draft（唯一口径），其他 conflict；`listArchive` 分页 cursor（archived/cancelled） | **PASS** |
| stale >20min 只读派生 | `taskIsStale`（queued/running 且 `now-lastActivityAt>STALE_AFTER_MS`）、`state.ts` 输出 `stale`；不改状态 | **PASS** |
| 快照派生字段 `sessionCount/acceptanceCount/evidenceInsufficientCount/archiveSummary`；tasks 不含 archived | `state.ts:129-160`；live `/commander/state` 已含 `archiveSummary`/`workSessions` | **PASS** |
| 详情 `GET tasks/:id` 补 `boardEdits`/`archivedAt`/`stale` | `handlers.handleTaskGet` 组合 `detailBoardEdits()`（≤20 倒序）、`archivedAt`、`stale` | **PASS** |

### 1.3 M2 看板（Client）

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| `main` keyed `commander-board` 整页（不替换 root/sidebar） | `client/index.tsx:110-124`：`ctx.slots.inject('main', … register({name:'main', key:'commander-board', order:40, …}, BoardPage))`；**右侧栏 tab 未实现**（符合本轮口径） | **PASS** |
| 面板「看板」→ `selectPanel('commander-board')`；返回 `selectPanel('conversation')` | `index.tsx:62-63` `openBoard/closeBoard`；Overlay 头部按钮调用 | **PASS** |
| 五列映射 + 回收站页签 | `client/board.ts`：`BOARD_COLUMNS`/`TRASH_STATUSES=[archived,cancelled]`、`boardColumnOf`、`groupBoardTasks`、拖拽 `checkStatusPatch/dropTargetStatus`（done/archived 不可 PATCH） | **PASS** |
| 卡片字段/stale 徽标/详情抽屉 | `BoardPage.tsx` 渲染 title/workspace/status/priority/capability/stale/block/sessionCount/updatedAt；抽屉分区（概览/决策/验收/会话/时间线/人工改动） | **PASS（视觉待 live）** |
| 空态/加载/错误 | `BoardPage.tsx` 状态分支（loading/error/empty/trash） | **PASS** |

### 1.4 M3 turn/end 注入

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| 触发：turn/end + work 会话有任务绑定 + reason 允许集 + 无未配对 approval/asked + userQuestions.active 空 + 非 commander 自身 | `trigger/injection.ts` `handle/deliverNow`：`workLinkOf`(role=work&&taskId≠'')、`INJECTION_REASONS` 过滤、`isPendingApproval`（scan approval/asked vs decided 配对）、`userQuestionsActive`（`getProjection` snapshot）、commander 跳过 | **PASS**（投影缺失时 fail-open 并计 `projectionUnavailable`，MEDIUM-2 known limitation） |
| 取最后 assistant 文本；空文本占位 | 取该 turn 内 `assistant/message` 最大 seq；空 → `EMPTY_REPLY_TEXT` | **PASS** |
| 格式/8KB 头6尾2 | `buildInjectionText` 逐字 `[session-reply] …\n---\ntaskId/sessionId/turnId/seq/truncated`；`truncateInjectionText` 6144/2048 | **PASS** |
| 去重 `<sessionId>:<turnId>:<lastSeq>` 写 `lastInjected`；先成功再写；失败补一次后也写 | `deliverNow` 比较 `lastInjected.turnId/seq`；`attemptDelivery`（INJECTION_RETRY_MAX=1 → 共 2 次）；无论成败 upsert lastInjected | **PASS**（比较用 `>=`，比契约更严，LOW-3） |
| 忙/在途合并同 session；不同 session 不合并；不写任务记录、不轮询 | `pending Map<sessionId>` 最新事件覆盖；`isBusy`/inflight → pending + 一次性 timer；仅 `deliver` + sessions.upsert | **PASS** |
| 不注入审批/提问/tool/进度 | 仅 assistant 文本；pending 时 skip | **PASS** |

### 1.5 M3 commander_task_report / accept / rework

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| tool 仅指挥官作用域、schema 完整、seq 区间校验、derivedFromSeq 必需、只整理不评估、review 至少 1 条 acceptance | `tools/index.ts` `commander_task_report`：task/session 绑定校验、seqFrom≤seqTo、acceptance≤40 逐项 text+整数 derivedFromSeq、`seqs` 区间与 derivedFromSeq 越界拒绝；`nextStatus=delivered/partial→review, blocked→blocked, 其它→running`；**review 且空 acceptance → invalid_request（不写 task）**；不评估通过与否 | **PASS（HIGH-1 已修）** |
| 写 acceptance（state evidence_present/insufficient）、timeline `report`、返回 evidenceState/insufficient | `acceptance` map + `appendTimeline({type:'report'})` + 返回 `evidenceState` | **PASS** |
| accept：仅人路由、review→done、acceptance≥1、幂等（done 重复返回 duplicate）、timeline | `tasks/actions.ts` `accept`：done→duplicate ok；非 review→conflict；acceptance<1→conflict；写 done+timeline accept | **PASS** |
| rework：仅人路由、review→running、先投递续做 brief 成功才改状态、失败 502 不改状态 | `rework`：校验 review/primarySessionId；先 `prompt({mode:'queue'})`（`[commander-rework]` brief：taskId/未通过项/目标/不要维护看板）；accepted!==true 或抛错 → `delivery_failed`（handler 映射 502），**状态未改**；成功才 writeTask running+timeline rework | **PASS**（prompt 成功后版本冲突会返回 conflict，MEDIUM-3） |

### 1.6 审批（只在 Client）与播报

| 契约点 | 实现证据 | 判定 |
|---|---|---|
| 只读官方 `pendingInteraction`（同一实例）；不注册第二 answerer；Host 不转发/不落盘审批 | Client：`approval.ts` `selectPendingApprovals` + `useSyncExternalStore`（Overlay.tsx:169）读官方 session status；`answerPendingApproval`：`answerable!==true → not-answerable`、`answer(outcome)`、catch `already settled` → 静默；Host：`grep approval/request|ctx.approval` 仅 injection 的**只读事件扫描**，无 answerer/转发 | **PASS**（双处渲染 live 待验） |
| 审批/提问不进指挥官上下文与任务记录 | Host 注入 pending 时 skip；state/tasks 无审批字段 | **PASS** |
| accept/rework 人专用 HTTP；不是模型工具 | `handlers` 绑定 router；`COMMANDER_TOOL_NAMES` 不含 accept/rework | **PASS** |
| 播报派生（pendingDispatch/review/blocked/审批数）+ 合并节流；无 brief_user/新事件/Host 调度 | Client `approval.ts` `deriveCommanderBadge` + Overlay `BadgeHintStrip`；60s 节流；Host 无 brief_user/无事件类型 | **PASS（视觉/live 待验）** |

### 1.7 硬边界（冻结决策）

| 检查 | 证据 | 判定 |
|---|---|---|
| 无 scheduler/轮询 | 全仓无 `ctx.schedule`；仅 board merge/注入 merge 的**一次性 `setTimeout`（unref）**，由编辑/事件触发 | **PASS** |
| 无投影/事件表/新事件类型 | 无 `appendPluginRecord`/`sessionProjections.register`；`TABLE_NAMES` 仍 7 表；`board_edits` 表名不变 | **PASS** |
| Client 不直连 remote/session.prompt | `src/client` 无 `ctx.remote`/`remote.session`/`session.prompt` 引用；消息只走 `POST /commander/message`+SSE | **PASS** |
| Host 唯一写者；任务记录单一真相 | 写操作均在 Host store/service；client 只 fetch/PATCH/消息 | **PASS** |
| autoDispatch=false 未回退 | config 无 auto 开关；派发仍首次恒 needs_confirmation | **PASS** |

---

## 2. 严重级别汇总

| 级别 | 数量 | 条目 |
|---|---|---|
| **HIGH** | **0（1 已关闭）** | HIGH-1 `commander_task_report` 允许 delivered/partial + 空 acceptance → `review` 无验收项（违反 ARCHITECTURE §6 不变量 2）。**已修复**（`tools/index.ts:588-591` 守卫 + 单测；201/201 pass）。 |
| MEDIUM | 3（全部按 Lead 2026-11-18 裁决记为 known limitations） | **MEDIUM-1（接受，known limitation）**：PATCH 先写 task 再写 board_edits；域存储无事务，反向顺序会产生指向旧 before 的孤儿 edit 被 backfill 注入、风险更大，故保持现顺序（失败时最多"任务已改但缺一次注入同步"）；后续可加事务化。**MEDIUM-2（保留 fail-open，known limitation）**：注入 pending 判定在 `ctx.get('sessionProjections')` 缺失时 fail-open（不静默丢最后回复）；Lead 裁决保留该行为并**计 metric 记录**；**已实施：`InjectionMetrics.projectionUnavailable`（投影不可用时 fail-open 仍注入、仅计数），已同步快照 `state.metrics` 与单测**，不改为 fail-closed。**MEDIUM-3（本轮不加幂等键，known limitation）**：rework prompt 成功后版本冲突返回 conflict 但 brief 已发；客户端按钮在请求中禁用；后续可加 requestId 幂等键。 |
| LOW | 3 | LOW-1 `service.ts:615` 注释仍写"同会话已有活跃任务时拒绝"，与实现/契约不符（仅注释）；LOW-2 board-edit 投递成功但 `injectedAt` 标记前崩溃 → backfill 可能重复注入一次（幂等键未用于投递去重）；LOW-3 注入去重比较用 `>=`（比契约的精确 `===` 更严，行为可接受，建议注释说明）。 |

---

## 3. 待 live 复核项（tester/devops 出证据后关闭，不阻塞本契约复核）

- M2：五列/回收站/详情抽屉视觉；拖拽 PATCH 后 30s 内**恰好一条** `[board-edit]`（injectionKey/injectedAt 证据）；重启后看板不变；stale 徽标。
- M3：turn/end 注入实时（去重/pending 过滤/8KB/忙合并）；审批双处同请求、先答生效、后答 `already settled` 被吞；accept/rework live；播报角标/节流。
- 证据路径：`docs/validation/m2-accept.md`、`docs/validation/m3-accept.md`（字段按契约 §4.2）。

---

## 4. 复核限制

1. 未跑 e2e/live（tester 负责）；未改实现/证据；测试复跑 `pnpm --filter dsh-commander test` = **200/200**（2026-11-18 09:5x）。
2. 逐文件静态核对，未覆盖 UI 视觉/暗色主题/窄宽。
3. HANDOVER.md 已同步到 M1R/M2/M3 实现完成阶段；live 证据出后再更新 UNVERIFIED 项。

---

## 5. HIGH-1 修复复核（2026-11-18 10:0x）

| 项 | 内容 |
|---|---|
| 修复提交 | backend（`src/host/tools/index.ts:588-591`）：`nextStatus==='review' && parsedAcceptance.length===0 → invalid_request`，不写 task；`blocked/no_progress` 保留空 acceptance |
| 新增测试 | `tests/unit/report-tool.test.ts`：delivered+空 → invalid_request 且任务保持 running；partial+空 → invalid_request；blocked+空 → blocked 成功 |
| 复跑 | `pnpm --filter dsh-commander test` → **201/201 pass / 0 fail / 0 skipped**（architect 复跑，2026-11-18 10:0x）；backend 报告 tsc 0、build exit 0 |
| 结论 | **HIGH-1 关闭；M1R/M2/M3 契约复核维持 PASS，HIGH=0** |

> MEDIUM-2 观测已实施：`projectionUnavailable` metric（含单测/`state.metrics` 同步）；不改 fail-open 行为。

### 5.1 Lead 对 MEDIUM 的裁决（2026-11-18，已落 §2）

| # | 裁决 | 落文 |
|---|---|---|
| MEDIUM-1 | 接受现状（PATCH 先 task 后 board_edits，非原子），记 known limitation / 后续可事务化 | 本文件 §2；HANDOVER §5 第 11 条 |
| MEDIUM-2 | **保留 fail-open**（不静默丢最后回复）+ **计 metric 记录**，不改 fail-closed | 本文件 §2；HANDOVER §5 第 11 条 |
| MEDIUM-3 | 本轮**不加幂等键**，客户端按钮请求中禁用，记 known limitation | 本文件 §2；HANDOVER §5 第 11 条 |

> 以上均不阻塞 M1R/M2/M3 交付；HIGH-1 已关闭，**最终结论：PASS，HIGH=0**。
