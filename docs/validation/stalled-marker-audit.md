# 看板「停滞」标记审计（只读）

> 日期：2026-11-24　基线：`4ae9865`（工作区另有 39 个未提交改动；`git diff` 已核对**未触及** stale 判定逻辑，仅 import 顺序变化）。
> 范围：仅阅读仓库代码与文档，未改任何代码。契约：`docs/architecture/m2m3-contract-patch.md` §2、`docs/architecture/implementation-plan.md` §8.3。

> **后续状态（2026-11-24）**：本审计描述的行为**已被移除**——看板不再有「停滞」判定/徽标/`stale` 字段与常量（见 `docs/HANDOVER.md` §12）。本文件保留为移除前的历史事实记录。

## 0. 裁定（先给结论）

| 问题 | 结论 |
|---|---|
| 判定条件 | `status ∈ {queued, running}` **且** `now - lastActivityAt > 20min`（严格大于，恰好 20min 不算） |
| 时间基准字段 | **`task.lastActivityAt`**（不是 `updatedAt`、不是 `round`、没有任务级心跳字段） |
| 计算位置 | **Host 权威计算**并随快照/SSE 下发；**Client 再做一次兜底重算**（仅当 Host 未给 `stale===true`） |
| 是否自动停滞 | **否**。没有 per-task timeout/lease/deadline，没有定时器扫描，不会自动改状态，连「自动打标记」也没有——标记是**读取时惰性派生** |
| 是否落库 | **否**。`TaskRecord` 无 `stale` 字段，纯展示派生 |
| 阈值可调 | **不可运行时配置**。`20 * 60 * 1000` 硬编码为常量，无 env、无 `ConfigRecord` 字段、无设置页入口 |
| 出现延迟 | 看板页无独立 1s 计时器；靠 SSE `heartbeat`（15s）或降级轮询（3s）触发重渲染 → **最迟约 15s 后出现/消失** |

## 1. 判定条件与时间基准

Host 唯一判定函数（`src/host/board/service.ts`）：

```ts
// packages/dsh-commander/src/host/board/service.ts:53-57
/** stale 只读派生：queued/running 且 now-lastActivityAt > 20min。 */
export function taskIsStale(task: TaskRecord, now: number): boolean {
  if (task.status !== 'queued' && task.status !== 'running') return false
  return now - task.lastActivityAt > STALE_AFTER_MS
}
```

阈值定义（`src/host/config.ts:130-131`）：

```ts
/** M2：疑似停滞阈值（queued/running 且 now-lastActivityAt > 20min，只读派生）。 */
export const STALE_AFTER_MS = 20 * 60 * 1000
```

### 1.1 字段来源：`lastActivityAt` 的全部写入点

`TaskRecord.lastActivityAt` 是**必填数值**（`src/host/schema.ts:268`，校验在 `schema.ts:599`），记录里没有 `stale`/`timeout`/`lease`/`deadline` 任何同族字段（`schema.ts:230-270`）。

| 写入场景 | 位置 | 是否刷新 `lastActivityAt` |
|---|---|---|
| 创建任务（draft） | `src/host/tools/index.ts:394-401` | ✅ `lastActivityAt: timestamp` |
| 任意状态迁移 | `src/host/tasks/state-machine.ts:209-213` | ✅ 每次迁移都写 `lastActivityAt: at` |
| 时间线追加 | `src/host/store/tasks.ts:26-34` | ✅ `appendTimeline` 同步写 `lastActivityAt: item.at` |
| 工作会话 `turn/start`、`turn/end` | `src/host/trigger/status.ts:51-83`（写点在 `:76`；queued/blocked→running 走迁移在 `:64-72`） | ✅ 但**只在回合边界**，回合内的 tool 调用不刷新 |
| 派发生效（spawn） | `src/host/dispatch/service.ts:391` | ✅ |
| 派发确认卡生成（proposed） | `src/host/dispatch/service.ts:643`、`:800` | ✅ |
| `commander_task_report` | `src/host/tools/index.ts:1275-1286`（`:1283`） | ✅ |
| `commander_task_update` action=edit / block / recover / cancel | `src/host/tools/index.ts:604-616`（edit `:610`）；block/recover/cancel 走 `transitionTask` | ✅ |
| 「继续派发」请求 | `src/host/tasks/actions.ts:129-133`（`:132`） | ✅ |
| **看板人工改 title/priority** | `src/host/board/service.ts:242`、`:250` | ❌ 只写 `updatedAt` |
| **`commander_task_update` action=set_dependencies** | `src/host/tools/index.ts:628-648`（`updatedAt` 在 `:638`） | ❌ 只写 `updatedAt` |

结论：`updatedAt` 与 `lastActivityAt` 是两个不同语义的字段；`updatedAt` 也用于列表 `ageMinutes`（`src/host/query/tasks.ts:282`）与排序，但**停滞判定不读它**。

## 2. Host 侧 vs Client 侧

### 2.1 Host 权威计算（三处出口，全部同一函数）

| 出口 | 位置 | 说明 |
|---|---|---|
| `GET /commander/state` 快照 `tasks[].stale` | `src/host/api/state.ts:155`（`buildTaskView`） | 快照与 SSE 共用同一投影 |
| SSE `task.updated` 整行 | `src/host/index.ts:83-89` → `buildTaskView(task, Date.now(), …)` | 每次任务变更都推整行（不是轻量 `{taskId,status}`） |
| `GET /commander/tasks/:id` 详情 `stale` | `src/host/api/routes/handlers.ts:140`（`taskIsStale(task, nowOf(deps))`） | 详情页/抽屉 |
| `commander_task_list` 行 `stale` | `src/host/query/tasks.ts:244,279`；`handlers.ts:174`、`:275` | 工具行投影 |

Host 侧 `now` 一律用 Host 时钟：`deps.now ?? Date.now()`（`src/host/api/state.ts:175-176`、`src/host/board/service.ts:139`）。

### 2.2 Client 兜底重算

```ts
// packages/dsh-commander/src/client/board.ts:153-161
/** Stale flag: prefer the Host-derived value, else recompute from lastActivityAt. */
export function isStaleTask(task: TaskView, now: number, staleAfterMs = 20 * 60 * 1_000): boolean {
  if (task.stale === true) return true
  const status = task.status ?? ''
  if (status !== 'queued' && status !== 'running') return false
  const last = task.lastActivityAt ?? task.updatedAt
  if (typeof last !== 'number' || last <= 0) return false
  return now - last > staleAfterMs
}
```

渲染点仅一处：卡片标题右侧徽标（`src/client/BoardPage.tsx:302`，`now` 由 `:97` 的 `Date.now()` 在渲染时取）。
文案：`board.card.stale` = 「疑似停滞（queued/running 超过 20 分钟无活动）」、徽标「停滞」（`src/client/locales.ts:296-297`，英文 `:786-787`）。

即：**Host 算一遍（权威、随数据下发），Client 在 Host 没给 `true` 时用本机时钟再算一遍**（阈值默认参数又硬编码了一次 20min）。

## 3. 出现与消失

### 3.1 出现

- 任务处于 `queued`/`running`，且 `lastActivityAt` 距今 > 20min；
- **无后台扫描**：不写入任何东西，只在「读快照 / 收 SSE / 渲染卡片」时惰性为真；
- 页面上的可见延迟：
  - `BoardPage` 无自己的 1s ticker（`src/client/BoardPage.tsx` 全文无 `setInterval`；对比原生窗口 `src/client/WindowApp.tsx:246` 有 1s ticker）；
  - 重渲染来源：SSE 事件（含 `heartbeat`，Host 每 15s 发一次：`src/host/config.ts:35`、`src/host/api/sse.ts:42-49`；客户端 `heartbeat` 会产出新 state：`src/client/state.ts:249-251`）→ **约 15s 内**出现；
  - SSE 死流判定 45s（`src/client/store.ts:31`）后切轮询，`POLL_INTERVAL_MS = 3_000`（`src/client/state.ts:25`、`src/client/store.ts:292`）→ 此时约 3s 内出现。

### 3.2 消失

| 触发 | 机制 | 证据 |
|---|---|---|
| 任何刷新 `lastActivityAt` 的活动 | 下一次计算 `now - last <= 20min` → false；Host 推整行 `task.updated` | 见 §1.1 表 |
| 状态离开 `queued/running`（→blocked/review/done/cancelled/archived） | 首行 `status` 判断直接返回 false（即使毫无活动） | `src/host/board/service.ts:55` |
| 页面刷新 / DSH 重启 | 不落库，重新从 `lastActivityAt` 派生：仍在 `queued/running` 且超 20min 就**仍显示** | 无持久化字段（`schema.ts:230-270`） |
| **人工改 title/priority** | ❌ **不清除**：只写 `updatedAt`，`lastActivityAt` 不变 | `src/host/board/service.ts:242,250` |
| **指挥官改依赖 `set_dependencies`** | ❌ **不清除**：同上 | `src/host/tools/index.ts:628-648` |
| Client 端状态标志 | Host 给 `stale:false` 时 Client 不信 false 而是重算（`isStaleTask` 只短路 `true`）；正常时钟下结果一致 | `src/client/board.ts:154-160` |

## 4. 是否存在「任务超时后自动停滞」

**不存在。三层都不存在：**

1. **无 per-task 超时字段**：`TaskRecord`（`src/host/schema.ts:230-270`）无 `timeout/lease/deadline/expiresAt`；任务相关工具 schema（`src/host/tools/index.ts`）无 timeout 入参。
2. **无超时 actor / 无自动迁移**：状态机迁移图 `EDGE_ACTORS`（`src/host/tasks/state-machine.ts:50-80`）逐条列出白名单，全部是 `host_dispatch / host_turn / commander_tool / user_*`，**没有任何 timeout 来源的边**；未列出的边一律禁止（`:113-118`）。
3. **无 scheduler / 巡检定时器**：Host 侧 `setInterval` 只有两处，且都与任务无关——原生壳心跳（`src/host/native/supervisor.ts:167`）与 SSE 连接心跳（`src/host/api/sse.ts:47`）。产品边界亦冻结：`docs/NEXT-PHASE.md:20`「没有 scheduler、没有结果轮询；非空闲超 20 分钟只显示『疑似停滞』徽标（只读）」，`docs/ARCHITECTURE.md:831`、`docs/PRODUCT-DESIGN.md:227` 同口径；`docs/architecture/m2m3-contract-patch.md:113`「`stale`：… **只读**；不改状态、不轮询、不注入」。

所以「超时」的效果**仅为展示**：不置 `blocked`、不写时间线、不发 SSE 以外任何事件、不通知指挥官。

## 5. 配置项与可调边界

### 5.1 不能设（停滞阈值）

| 项 | 状态 | 证据 |
|---|---|---|
| `STALE_AFTER_MS` | 硬编码常量 20min | `src/host/config.ts:130-131` |
| Client 兜底阈值 | 硬编码默认参数 20min（**第二处**，需同步改） | `src/client/board.ts:154` |
| env 覆盖 | 无（Host 只认 `COMMANDER_BOARD_MERGE_MS`、`COMMANDER_SESSION_TITLE_CONCURRENCY` 等，与停滞无关） | `src/host/index.ts:170`、`src/host/session/session-records.ts:157` |
| `ConfigRecord` 字段 | 无 | `src/host/schema.ts:102-121` |
| 设置页入口 | 无；只有「指挥官/工作区/派发与 Jev/外观/会话轮换」五组 | `src/client/locales.ts:84-88` |
| API 入参 | 无（`PATCH /commander/board/tasks/:id` 仅 `priority|title`） | `src/host/board/service.ts:206-213` |

改阈值 = 改两处常量 + `pnpm --filter dsh-commander build` + 重装/重启 Host（AGENTS.md「live 属用户」）。

### 5.2 能设（但都不是任务超时）

| 配置 | 默认 / 范围 | 作用对象 | 证据 |
|---|---|---|---|
| `jev.timeoutMs` | 默认 `1500`，可调 **500–30000 ms**（`JEV_TIMEOUT_MIN/MAX`） | **Jev HTTP 请求**（派发判定），非任务 | `src/host/config.ts:55,73-74`；校验 `src/host/schema.ts:421-424`；使用 `src/host/jev/client.ts:64`、`src/host/dispatch/service.ts:501` |
| `jev.onTimeout` | `pause_and_ask` / `use_model` | Jev 超时后的降级策略，非任务状态 | `src/host/schema.ts:97` |
| `board.archiveAfterDays` | 默认 `30` | **无实现**：除 schema 校验与默认值外无任何读取点，不做自动归档 | 仅 `src/host/schema.ts:106,433-434,657` |
| `board.syncUserEdits` | 默认 `true` | 无行为读取点 | 同上 |
| `COMMANDER_BOARD_MERGE_MS` | 默认 30000 | `[board-edit]` 注入合并窗口 | `src/host/index.ts:169-175` |

**确切边界**：仓库里「可调的超时」只有 Jev 请求超时（且只影响派发判定的等待，不影响任务状态）；`board.archiveAfterDays` 看起来像「超时自动归档」，但**是死配置**——设置它不会有任何自动行为。任务级的 timeout/lease/deadline 在整个仓库中**不存在**。

## 6. 与状态机的关系

- `stalled` 是**展示层派生值**，不是状态：`TaskStatus` 只有 `draft/proposed/queued/running/blocked/review/done/cancelled/archived`（`src/host/schema.ts:20`；迁移图 `src/host/tasks/state-machine.ts:50-80`），`CommanderSnapshot` 里 `stale` 是 `tasks[]` 的附加值（`src/host/api/state.ts:38`），不在 `tasks` 表。
- 单向关系：**状态机 → 停滞**（迁移刷新 `lastActivityAt`、非 queued/running 直接不判）；**停滞 → 状态机**：无任何写入/触发。
- 六列看板的列归属只看 `status`（`src/client/board.ts:132-144`、`src/host/query/tasks.ts:217-224`），停滞徽标只是卡片上的装饰标记。
- 契约侧同样把它定义为派生字段：`docs/architecture/implementation-plan.md:525`「M2 派生字段（只读展示，**不改任务记录 schema**）」、`m2m3-contract-patch.md:299`「增补派生字段（不改记录 schema）」。

## 7. 边界与风险（读代码得出，供后续决策）

1. **人工改板不清停滞**：改 title/priority（`board/service.ts:242,250`）或改依赖（`tools/index.ts:638`）只动 `updatedAt`；若任务已 >20min 无活动，改完仍显示「停滞」。是否符合预期需产品确认。
2. **长回合误报**：`lastActivityAt` 只在 `turn/start`、`turn/end` 刷新（`src/host/trigger/status.ts:52-56`），回合内 tool 调用不刷新 → 单个连续跑 >20min 的回合会被判停滞（这是由代码结构推出的**推断**，未实测）。
3. **Client 重算可覆盖 Host 的 false**：`isStaleTask` 对 Host 的 `false` 不短路（`board.ts:154-156`），用浏览器时钟重算；若客户端时钟比 Host 快 >20min 会误显示。两半阈值也已各写一份，改阈值必须双改。
4. **blocked 永不显示停滞**：只要状态是 `blocked`，无论多久无活动都不显示；真正的「卡住」观感依赖 block reason（`src/host/api/state.ts:43-48` 的 `pendingDispatch/ready` 等字段）。

## 8. 证据清单（命令与结果）

| 命令 | 结果（要点） |
|---|---|
| `grep -rn "stale\|lastActivityAt\|STALE" packages/dsh-commander/src` | 66 处；判定点仅 `host/board/service.ts:53-57` + `client/board.ts:153-161` |
| `grep -rn "setInterval" packages/dsh-commander/src/host` | 仅 `native/supervisor.ts:167`（壳心跳）、`api/sse.ts:47`（SSE 心跳） |
| `grep -rn "timeout\|lease\|deadline" packages/dsh-commander/src` | 全部是 Jev HTTP 超时、原生桥超时、board merge timer；任务域零命中 |
| `grep -rn "archiveAfterDays\|syncUserEdits" src tests docs` | 仅 `host/schema.ts:106,433-434,657`（无行为） |
| `grep -rn "自动归档\|自动置" docs` | 无「超时自动归档/自动置状态」的设计条目 |
| `git diff \| grep "stale"` | 工作区 39 个未提交改动**不含** stale 逻辑变更（仅 import 排序） |
| 测试佐证 | `tests/integration/m2-board.test.ts:171-190`（伪造 `lastActivityAt = now - STALE_AFTER_MS - 1000` → `stale:true`）；`tests/client/board.test.ts:99-103`（21min→true / 5min→false / blocked→false） |

## 9. 自查/复核命令

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
sed -n 53,57p packages/dsh-commander/src/host/board/service.ts      # 唯一判定式
sed -n 130,131p packages/dsh-commander/src/host/config.ts           # 阈值常量
sed -n 153,161p packages/dsh-commander/src/client/board.ts          # 客户端兜底
sed -n 300,304p packages/dsh-commander/src/client/BoardPage.tsx     # 徽标渲染
sed -n 50,80p  packages/dsh-commander/src/host/tasks/state-machine.ts # 迁移图（无 timeout actor）
```
