# M1 契约补丁（全确认模式 · commander_task_dispatch / 确认卡协议 / 任务详情 / 能力结果）

> 版本：v1.0　日期：2026-11-17 21:34（Asia/Shanghai）
> 状态：**M1 实现期补丁，M1 范围内以本文件为准**（待 lead 批准后合并回 `implementation-plan.md` §8/§9/§10/§11 与 `m0-contract-patch.md` 差异清单）。
> 依据：用户 2026-11-17 决策——**继续 M1，采用全确认模式**：每次派发人工确认、`autoDispatch=false`、**V5 指标豁免**（V5 FAIL 作为门禁依据保留，不构成 auto 派发依据）。
> 边界：不改冻结决策/判据/NEXT-PHASE/ARCHITECTURE/PRODUCT-DESIGN；不写实现；不改 M0 已验收行为（仅加法式扩展）。

---

## 0. 一页摘要（给 backend/frontend）

| # | 主题 | 唯一口径 |
|---|---|---|
| 1 | 全确认 | 运行期 `DEFAULTS.autoDispatch=false`（**不写 ConfigRecord 冻结 schema**）；`commander_task_dispatch` 首次调用**恒**返回 `needs_confirmation`；二次 `decisionId+confirmTarget`（或原 `candidate`+`requestId`）→ `dispatched`；决策仅内存 TTL 30m；`decision_expired` 要求重派；同 decision 只提交一次；`requestId` 5min 幂等。 |
| 2 | 确认卡 | **不新增确认路由**：卡片三动作（采用/自定义/取消）以**普通用户消息**发到指挥官会话（模板见 §2）；指挥官据此二次调 `commander_task_dispatch`。 |
| 3 | 快照/SSE | `pendingDispatch` 完整字段（§3.1）+ `dispatch.updated`；`tasks[]` 加 `capability` 摘要；新增 `GET /commander/tasks/:id`、`POST /commander/jev/test`（永不回传 key）。 |
| 4 | 能力 | auto 只在 `mode='new' && policy='auto'`；`enabled` 只写提交给 apply 的 plan 项 name；pending replay；失败/面板缺失 → `fallback` 继续派发；确认卡只展示摘要。 |
| 5 | trigger | `turn/end` 注入**格式沿用 plan §7.5**、M1 不启用注入（M3）；M1 不做 `commander_task_report`/看板页/accept/rework。 |

---

## 1. 全确认语义（M1 核心）

### 1.1 运行期常量（不改冻结 schema）

- `DEFAULTS.autoDispatch = false`：**Host 运行期常量**（`src/host/config.ts`/M1 常量文件），**不写入 `ConfigRecord`**（冻结 schema 无此字段；不加字段、不加表）。
- 手写 `ConfigRecord.jev.threshold / confidenceFloor` 仍存在：M1 **仅用于计算 `scores` / recommendation / 界面提示**，**不用于放行**（永远 `needs_confirmation`）。
- 语义：M1 的 gate 不决定"是否自动派发"，只决定"推荐哪个目标 + 推荐质量（scores）"。

### 1.2 `commander_task_dispatch` 首次调用（恒确认）

入参沿用 `ARCHITECTURE §4.1`（`taskId/candidate/decisionId/confirmTarget/capabilityNeeds/requestId`），出参三支不变；M1 行为：

```text
commander_task_dispatch({taskId, candidate?, capabilityNeeds?, requestId})
├─ 校验 task（draft/proposed）、requestId、白名单；失败 → rejected(code)（不写盘）
├─ requestId 幂等（工具层 5min LRU，与 HTTP 路由的 requestId 缓存独立）
├─ 候选构造（全量优先/两层，按 plan §9.2；产出 candidates ≤8）
├─ 调 Jev（超时/失败按 plan §9.2：默认 pause_and_ask → 仍走确认，reason=jev_unavailable）
├─ 计算 scores + recommendation（**计算但不放行**）
└─ 恒返回 needs_confirmation：
   {
     status: 'needs_confirmation',
     decisionId: 'dec_<24hex>',                  // 确定性：sha256(taskId+'\0'+requestId) 前 24 hex
     taskId,
     candidates: [ ≤8 项，见 §1.3 ],
     recommendation: { workspaceId, mode:'new'|'attach', sessionId? },
     scores: { pWorkspace, pSession, pMax, concentration },   // pMax=min(pW,pS)；concentration=min(cW,cS)
     reason: 'user_confirm_required'             // 全确认模式恒为主因；例外见 §1.4
     expiresAt: <createdAt+30min>
   }
```

- 副作用：`task.status → 'proposed'`；`task.timeline` 追加一条 `dispatch` 项（含 decisionId、候选数、recommendation、reason）。
- **不写 `dispatches` 终态记录**（决策仅内存；`DispatchRecord.outcome` 无 pending ∈ 冻结 schema，见 D2）。
- 同一 `requestId` 重复首次调用：返回同一 `needs_confirmation`（同一 decisionId），不重复建候选/调 Jev（缓存首次结果 5min）。

### 1.3 候选与推荐字段（确认卡数据源）

`candidates[]` 项（≤8，按可解释顺序，**recommendation 项排第一**）：

```json
{
  "workspaceId": "htdot-project",
  "workspaceName": "htdot-project",
  "workspacePath": "/abs/path",            // 可选（界面展示，可脱敏）
  "mode": "new",
  "sessionId": "session-…",                // mode=attach 时必填
  "sessionTitle": "订单导出 · 流式改造",     // attach 时可选
  "pWorkspace": 0.62,
  "pSession": 0.71,
  "score": 0.44,                           // pW*pS 或 pMax，界面排序用
  "reason": "low_confidence"               // 可选：该候选被列出的原因
}
```

- `recommendation = candidates[0]` 的 `{workspaceId, mode, sessionId?}`（无候选时 `null`，`reason='no_workspace'` 走 rejected 不开决策）。
- **不返回** Jev Key、完整 Jev 请求/响应、代码正文；候选只给展示字段（遵循 ARCHITECTURE §3.5 不落盘）。

### 1.4 `reason` 枚举

| reason | 含义 | 确认卡展示 |
|---|---|---|
| `user_confirm_required` | 全确认模式（默认恒为此值，即使 scores 很高） | "需要你确认派发目标" |
| `jev_unavailable` | Jev 超时/网络/鉴权失败（按 `onTimeout` 走确认） | "Jev 不可用，按模型候选请你确认" |
| `low_confidence` | scores 低于提示阈值（仅供展示，不改变"必须确认"） | "置信度较低（提示值）" |
| `decision_required` | 缺 taskId/候选无法构造等需要用户先决定 | "请先补全任务/工作区" |

> 说明：`user_confirm_required` 与 `low_confidence` **可以同时成立**；返回时取最具体的一个，但 `scores` 总是带上，由前端展示。

### 1.5 二次调用（确认路径）

**规范路径（首选）**：

```text
commander_task_dispatch({ taskId, decisionId, confirmTarget:{ workspaceId, mode, sessionId? }, requestId })
  → 校验 decision（内存 Map：存在、未过期、taskId 匹配、未 used）
  → 校验 confirmTarget（workspace 在白名单；attach 会话属于该 workspace 且非归档）
  → 执行提交（§1.6）→ 返回 {status:'dispatched', taskId, decisionId, sessionId, sessionCreated, target, scores, capabilities}
```

**兼容路径（允许，但需唯一 pending）**：

```text
commander_task_dispatch({ taskId, candidate:{workspaceId, mode, sessionId?}, requestId })
  → 若该 taskId 恰有 1 条未用 pending decision → 视为确认该 candidate（须通过白名单/归属校验）
  → 若 0 条 pending → rejected(code='decision_required', message='请先 commander_task_dispatch 获取 decisionId')
  → 若 ≥2 条 pending → rejected(code='decision_required', message='存在多个待确认决策，请带 decisionId')
```

- 确认成功：`outcome='confirmed'`（confirmTarget === recommendation）或 `'overridden'`（用户自定义选择）；`confirmedBy:'user'`。
- **同一 decision 只能提交一次**：成功后 `used=true`；再次用同 decisionId 调用 → **返回首次 `dispatched` 结果（幂等回放，不新建会话）**；`dispatches` 终态记录是该回放的权威来源。
- **decision 不存在/过期/已 used 但无终态记录（异常）** → `rejected(code='decision_expired', message='确认已过期，请重新 commander_task_dispatch')`；用户可见行为：指挥官重新走完整 `commander_task_dispatch`（重新候选+Jev），对用户说"确认已过期，我重新判定一次"；不自动派发。
- **TTL 30 分钟**：`createdAt + 30min`；惰性清理（`commander_task_dispatch` 入口、confirm 查找、`/commander/state` 快照构造时各扫一次，**不新建定时器**）；重启后内存清空 → confirm 即 `decision_expired`。
- **requestId 幂等（工具层）**：同 `requestId` 5 分钟内重复调用返回首次结果（首次 needs_confirmation / 确认 dispatched）；与 HTTP 路由层 LRU 各自独立。

### 1.6 提交（确认后执行）

```text
提交（spawn）
├─ 目标 mode='new'：
│   ├─ 若工作区 policy='auto' → 能力 auto（§4，含 fallback）
│   ├─ sessionController.create({workspaceId|cwd, agentPreset})（二选一，M0-H1 合同）
│   ├─ prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text:brief}]}, signal)
│   └─ 失败 → task blocked(code='delivery_failed') / create 失败 → blocked(code='session_create_failed')
├─ 目标 mode='attach'：不调面板；校验会话存在/归属；prompt brief
├─ 写 dispatches 终态（outcome=confirmed|overridden；finalTarget；confirmedBy='user'）
├─ task.status → 'queued'；primarySessionId/assignments；timeline 追加 dispatch 项
├─ sessions link {role:'work', mode, status:'queued'}
└─ 返回 dispatched（含使用的能力摘要）
```

- 后续 `turn/start` → task `queued→running`（M1 唯一自动状态更新；不注入）。
  - link 解析**只认活跃任务**：任务缺失或已终态（done/cancelled/archived）的历史 link 视为无 link——同一会话可被重新 attach，link 被覆盖前到达的 `turn/start` 不得记到旧任务上（2026-11-18 修正：否则新任务永远停在 queued）。
  - 孤儿补偿除「无 link 时暂存 turn/start」外，还记录「会话最近一次 turn/start」：`reconcile` 时二者任一命中都补 `queued→running`；启动时对仍是 queued 的任务按会话最后回合事件回填一次（重启会丢事件，不重放）。
- brief 文本沿用 plan §9.5 模板；**不带** `[commander-dispatch]` marker 与 `taskId/decisionId/sessionId` 元数据行（2026-11-18 修正：工作会话不需要内部 id，关系在持久化里）。

### 1.7 M1 验收映射调整（Lead/用户 2026-11-17 决策）

| 原验收项 | M1 调整后 | 说明 |
|---|---|---|
| **M1-1** 明显工作区任务 auto 派发成功，`queued→running` | **确认后派发成功**：`commander_task_dispatch` 首次恒 needs_confirmation → 模拟"采用建议"二次调用 → 任务 `queued` → 工作会话 `turn/start` 后 `running` | 不再要求 auto；证据 `docs/validation/m1-e2e.md`（需含两次返回原文） |
| **M1-2** 低置信任务 `needs_confirmation`，二次确认后派发 | **保持**（全确认模式下所有任务都走此路径；低置信样本作为其中一个 case） | 同上 |
| **M1-3** auto 能力 | **保持**（能力 auto 与派发确认解耦；`capabilityPolicy=auto` 仍生效） | 同上 + 面板证据 |
| **M1-4** 面板不可用回退 inherit | **保持** | 同上 |
| **M1-5** 50 案例指标达标 | **豁免**（用户决策：V5 指标豁免；以"默认每次确认"替代自动派发门禁） | 证据记录引用用户决策与 `V0-GATE.md`；不得写成 V5 PASS |

---

## 2. 确认卡 → 指挥官消息协议

> **禁止新增确认路由**：不新增 `/commander/dispatch/confirm` 之类路由；客户端只调用既有 `POST /commander/message` 发**普通用户消息**，由指挥官会话决定调工具。这是冻结决策"派发确认没有专门路由"的落地。

### 2.1 三个动作的消息模板（Client → POST /commander/message）

```text
# 采用建议
[dispatch-confirm] 采用建议
decisionId=dec_<24hex> taskId=task_<…>
target=workspaceId:<ws>;mode:new|attach[;sessionId:<sid>]

# 自定义选择
[dispatch-confirm] 自定义
decisionId=dec_<24hex> taskId=task_<…>
target=workspaceId:<ws>;mode:new|attach[;sessionId:<sid>]

# 取消
[dispatch-confirm] 取消
decisionId=dec_<24hex> taskId=task_<…>
```

- 客户端**只**发这段文本（`POST /commander/message {text, requestId}`；requestId 用新的 UUID，重试同 requestId 由 Host 幂等）。
- 文本中的 `target` 由卡片当前选择生成（采用建议 = recommendation；自定义 = 用户在下拉里选的工作区/会话；取消无 target）。
- 不携带 `requestId` 以外的协议字段；不直接调工具、不直连 `commander_task_dispatch`（Client 无工具）。
- 卡片"取消"也可由客户端直接调/隐藏（不派发）；消息模板用于让指挥官知道用户取消并回复一句。

### 2.2 指挥官 prompt 约束（M1 system prompt 摘要）

写进 M1 指挥官 system prompt（plan §10.4 的补充段）：

1. 收到 `[dispatch-confirm]` 消息时：解析 `decisionId/taskId/target`，**立即调用** `commander_task_dispatch({taskId, decisionId, confirmTarget:{workspaceId,mode,sessionId?}, requestId:新ID})`；"取消"时调 `commander_task_update` 把任务置 `cancelled`（或调用方允许的取消语义）并回一句。
2. `rejected(code='decision_expired')` → 回一句"确认已过期，我重新判定一次"，然后**重新完整 commander_task_dispatch**（新候选+Jev），把新的确认卡内容给用户；不得无 decisionId 直接派发。
3. 不得编造/复用其它任务的 decisionId；不得跳过 Jev 直接建会话。
4. 确认成功后，用一句话告诉用户目标（工作区/模式/会话）与任务状态（queued），不改口。

### 2.3 前端职责（不改契约）

- 渲染确认卡（候选 ≤8、recommendation、scores、reason、expiresAt 倒计时）；三按钮只发 §2.1 文本。
- **用户点击任一动作且消息投递成功后，确认卡立即收起**，只保留一行状态（`dispatch.waiting`），不等待 Host 清 `pendingDispatch`（2026-11-18 用户反馈：点完还挂整张卡太久）；同一 decision 若再次出现 `needs_confirmation` 卡片会重新渲染。
- `dispatch.updated` 到达时：`pendingDispatch=null` 则确认卡保持收起（状态行可切到任务当前状态）；`needs_confirmation` 到达时刷新卡片。
- 不缓存/复用 decisionId；卡片过期（`expiresAt`）置灰并提示"重新发起"。

---

## 3. 快照 / SSE / 新路由

### 3.1 `pendingDispatch` 完整字段（快照 + `dispatch.updated`）

```json
{
  "decisionId": "dec_…",
  "taskId": "task_…",
  "taskTitle": "给订单导出加开关",
  "candidates": [ { "workspaceId": "…", "workspaceName": "…", "workspacePath": "…", "mode": "new", "sessionId": "…", "sessionTitle": "…", "pWorkspace": 0.62, "pSession": 0.71, "score": 0.44 } ],
  "recommendation": { "workspaceId": "…", "mode": "new" },
  "scores": { "pWorkspace": 0.62, "pSession": 0.71, "pMax": 0.62, "concentration": 0.43 },
  "reason": "user_confirm_required",
  "createdAt": 1763450000000,
  "expiresAt": 1763451800000
}
```

- 无待确认时为 `null`；**最多同时 1 条**（新 needs_confirmation 覆盖旧的：旧 decision 作废，用户旧卡操作会得到 `decision_expired`）。
- `dispatch.updated` 事件（plan §8.4 已有）：`{pendingDispatch: <上结构>|null, rev, at}`；触发：needs_confirmation、确认成功/取消、过期清理（快照刷新时）。
- 快照中 `pendingDispatch` 与事件同结构；不新增事件类型。

### 3.2 `tasks[]` 摘要增加 capability（只读派生）

```json
"capability": { "status": "applied|fallback|inherit|pending|none", "enabledCount": 3, "disabledCount": 12, "durationMs": 240 }
```

- 派生自 `CapabilityPlan`：`enabledCount=enabled.length`、`disabledCount=disabled.length`；`plan` 不存在 → `status:'none'`（inherit 时 `'inherit'`，派发中 `'pending'`）。
- 不新增表字段（`CapabilityPlan` 不变）。

### 3.3 `GET /commander/tasks/:id`（M1 新增，只读）

响应 `200`：

```json
{
  "ok": true,
  "task": { "id": "task_…", "title": "…", "goal": "…", "status": "running", "workspaceId": "…", "priority": "normal", "commandId": "cmd_…", "primarySessionId": "session-…", "assignments": ["session-…"], "createdAt": 0, "updatedAt": 0, "lastActivityAt": 0, "version": 3 },
  "acceptance": [ { "id": "acc_…", "text": "…", "verify": "…", "evidence": "…", "source": "commander", "state": "evidence_present|insufficient" } ],
  "capabilities": { "policy": "auto", "executor": "capability-panel", "status": "applied", "enabled": ["…"], "disabled": [], "durationMs": 240, "at": 0 },
  "dispatch": { "id": "dec_…", "candidates": [ … ≤8 … ], "modelSuggestion": "…", "jev": { "provider": "typesafe", "model": "jev-latest", "requestId": "…", "latencyMs": 1200, "ok": true, "pMax": 0.62, "concentration": 0.43 }, "outcome": "confirmed", "finalTarget": { "workspaceId": "…", "mode": "new", "sessionId": "session-…" }, "confirmedBy": "user" },
  "timeline": [ { "at": 0, "type": "dispatch", "text": "…", "sessionId": "…", "seq": 0 } ],
  "sessions": [ { "sessionId": "session-…", "workspaceId": "…", "role": "work", "mode": "new", "status": "queued|running|idle|missing" } ],
  "rev": 52
}
```

- 错误：`not_found`（任务不存在）、`storage_error`。只读、不写盘、不触发派发。
- 不返回 Jev Key、会话正文、审批内容。

### 3.4 `POST /commander/jev/test`（M1 新增，服务端探针）

请求（全部可选；只用于本次探针，不落盘、不改配置）：

```json
{ "endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest", "apiKeyEnv": "JEV_API_KEY", "timeoutMs": 1500 }
```

响应 `200`：

```json
{ "ok": true, "latencyMs": 842, "model": "jev-1.14.0", "requestId": "probe_…" }
```

失败（仍是 `200` 或 `4xx/5xx` 由宿主统一 envelope）：

```json
{ "ok": false, "code": "jev_unavailable|invalid_request|auth|timeout", "message": "…", "latencyMs": 1500 }
```

- **永不回传 Key**（只回 `apiKeyEnv` 名或 `hasApiKey:true|false`）；不发真实派发候选（最小探针：1 个 choice/noul 或按面板 `jev.test` 等价最小请求）。
- 每次请求最多 1 次网络调用；429/529 退避 1 次、4xx 不重试（沿用 plan §5.1）。

---

## 4. 能力 auto 结果口径（M1）

1. **触发条件**：只在 `target.mode='new'` 且该 workspace `capabilityPolicy.mode='auto'` 时调用；`attach` 不调用；`confirm` 路径与首次派发路径一致（确认后才创建会话）。`inherit`（默认）/ attach 一律 `status:'inherit'`、不调 panel；工作区策略在「指挥官设置 → 工作区 → 能力策略」切换（2026-11-18 用户反馈：默认 inherit 导致看板能力为 0）。
2. **调用顺序**（固定）：`create 会话 → resolvePanel（形状校验：`jev.rank`/`jev.apply` 均为 function，thunk 兼容）→ getConfig.threshold → rank → plan → apply → prompt brief`。
3. **CapabilityPlan 映射**（D1 裁定：只写提交给 apply 的 plan 项 name；不新增字段）：
   - `status`：`applied`（apply ok）/ `fallback`（面板缺失、形状不符、rank 失败、apply 失败、空 plan）/ `inherit`（policy=inherit，不写 plan 也可写 `status:'inherit'` 于派发摘要）/ M1 不产生 `failed`（D9：失败回退 continue）。
   - `enabled` = 提交的 plan 项 `name`（去重、排序）；`disabled=[]`（plan 只提交 enabled:true）；`durationMs=apply.elapsedMs`；`reason`：`panel_unavailable|panel_shape_mismatch|rank_failed|apply_failed|empty_plan|pending_replay_on_agent_created|threshold_defaulted`。
   - 冷会话 `pending:true`：`status='applied'` + `reason='pending_replay_on_agent_created'`；`agent/created` 后以 `rank.items[].enabledInSession` 复核并更新 `WorkspaceRecord.capabilityPolicy.lastSelection`。
4. **摘要展示**：确认卡/任务详情只显示 `启用 N 项 / 未启用 M 项 · 耗时 Xms`（fallback 显示 reason）；不展开目录、不回传 panel rank 全量 items（仅名/数量）。**N+M=0（inherit / 空 fallback）时不显示数量**（避免看板出现「能力 0/0」误导，2026-11-18 用户反馈）。
5. **结果不可变**：派发提交后 `TaskRecord.capabilities` 不再改（只允许 `lastSelection` 摘要更新）。
6. **失败不阻塞**：任何能力失败 → `fallback + reason`，派发继续（M1-4 验收）。

---

## 5. `turn/end` 注入格式确认（M1 不启用）

- **格式沿用 plan §7.5，逐字不变**：
  ```
  [session-reply] <最后回复原文>
  ---
  taskId=<id> sessionId=<id> turnId=<n> seq=<n> truncated=<bool>
  ```
- pending 判定（未配对 `approval/asked` 或 `userQuestions.active>0`）、去重键 `<sessionId>:<turnId>:<lastSeq>`、8KB 头尾截断（6KB/2KB）、仅空闲注入、`aborted/interrupted` 跳过 —— 全部沿用 plan §7.2–§7.5，**M1 不实现 trigger 注入**（M3 才启用；M1 只在 `turn/start` 更新 `queued→running`，不注入）。
- M1 不写 `SessionLinkRecord.lastInjected`（M3 才写）；不新增事件类型/表。

---

## 6. M1 不做（明确边界）

- 不做 `commander_task_report`、`follow_up`、`task_cancel`/`task_archive` 工具（M3/M2）。
- 不做看板页/五列/任务详情 UI（`GET /commander/tasks/:id` 只提供数据；前端 M2 才做页面）、`PATCH /board/tasks`、accept/rework 路由（M3）。
- 不做 `turn/end` 注入、不做审批悬浮卡、不做播报。
- 不新增确认路由、不新增表/事件类型、不新增 scheduler/轮询；`autoDispatch` 不改冻结 schema。

---

## 7. 与 M0 契约 / implementation-plan 的差异清单

| 位置 | 现状（M0/plan） | M1 补丁 |
|---|---|---|
| `POST /commander/message` | 普通消息通道 | **复用**：确认卡消息也走此路由（不新增确认路由） |
| `pendingDispatch`（§8.3） | M0 恒 `null` | **M1 填充完整字段**（§3.1） |
| `dispatch.updated`（§8.4） | 已列事件 | **M1 激活**（needs_confirmation/确认/取消） |
| 错误码 | M0 6 个新增 | **M1 增加** `decision_expired`、`decision_required`（+ 工具侧 rejected：`no_workspace`/`unknown_task`/`task_state`/`invalid_target`） |
| 路由表 | M0 6 条 | **M1 新增** `GET /commander/tasks/:id`、`POST /commander/jev/test` |
| `tasks[]` 摘要 | 无 capability | **加** `capability` 摘要（§3.2） |
| `DEFAULTS.autoDispatch` | 无 | **加运行期常量 false**（不写 ConfigRecord） |
| 工具 | M0 无模型工具 | **M1 注册** `commander_task_create`/`commander_task_update`/`commander_task_dispatch`/`commander_task_list`（只指挥官作用域；plan §10.3） |
| gate 语义 | plan §9.2 "通过→提交" | **M1 改为"计算但不放行 → 恒确认"**；gate 结果只影响 recommendation/scores |
| `dispatches` 记录 | 终态记录 | **不变**：只有确认成功后写终态；pending 仅内存（D2） |
| M1 验收 | M1-1 auto、M1-5 指标 | **M1-1 改确认后派发成功；M1-5 豁免**（§1.7） |

> 合并方式：lead 批准后由 architect 把差异并入 `implementation-plan.md` §8/§9/§11 并更新 `m0-contract-patch.md` 的差异表；本补丁在合并前即 M1 实现口径。

---

## 8. 待 lead 确认的开放点

| # | 开放点 | 建议 |
|---|---|---|
| O1 | 兼容路径（`candidate` 无 decisionId）是否保留 | 保留但仅"唯一 pending"时生效（§1.5）；若 lead 要最严，可只允许 decisionId |
| O2 | `GET /commander/tasks/:id` 是否返回 `timeline` 全量（≤100） | 返回（只读、M2 详情用）；M2 可加分页 |
| O3 | `/commander/jev/test` 是否允许 UI 传覆盖参数 | 允许（不落盘）；不允许传明文 key |
| O4 | M1-1 证据是否必须含"低置信样本也走确认" | 建议含（全确认下两类样本都应出 needs_confirmation） |

---

## 9. 不修改声明

- 本补丁不改 `docs/NEXT-PHASE.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT-DESIGN.md` 与任何冻结判据；不改 M0 已验收行为；不写实现代码。
- V5 FAIL 与"指标豁免"仅限 M1 auto 放行决策，不得表述为 V5 PASS；`V0-GATE.md` 裁定保留。
