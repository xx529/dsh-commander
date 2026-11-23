# 看板查询工具设计（任务 / 工作区 / 会话三套只读工具）· v0.2

> 日期：2026-11-23
> 状态：**已批准（2026-11-23），实施中**。契约已同步到 `task-state-machine-final.md` §5.8/§12（决策 13–16）与 `implementation-plan.md` §10.3 补丁。
> 依据：`task-state-machine-final.md` v1.0；现状实现 `packages/dsh-commander/src/host/tools/index.ts:679-779`。
> v0.2 变更：采纳用户裁定（见 §0）——默认隐藏回收站、时间用人类可读格式、去掉 sort、计数不含回收站、`q` 默认标题、**工作区/会话查询从任务工具中拆出**。

---

## 0. 已定决策（v0.2）

| # | 决策 | 落点 |
|---|---|---|
| D1 | 默认隐藏回收站（`cancelled`/`archived`） | §3 `includeArchived`、§5 过滤管线 |
| D2 | 时间条件用 `2026-10-12 14:40` 这类人类格式，不用时间戳 | §4 时间参数格式 |
| D3 | 去掉 `sort` 参数，固定按创建时间倒序 | §3、§5 |
| D4 | 计数（`total`/`counts`/`columns`）不含回收站，除非 `includeArchived: true` | §6 返回 |
| D5 | `q` 默认搜标题，可显式开放 `goal`/`reportSummary` | §3 `searchIn` |
| D6 | 任务工具不再返回工作区；拆出 `commander_workspace_list` / `commander_session_list` | §1、§9、§10 |
| D7 | 工作区只暴露**配置中已启用**（allowed）的；未启用的不出现、也不可被引用 | §9、§10 |
| D8 | `commander_session_list` **必须**指定工作区（id 或 cwd 路径），不支持空参数全量扫描 | §10 |
| D9 | 会话只出**根会话**：排除子代理（subagent）与 teammate 会话，也不出指挥官会话 | §10 |

## 1. 工具面与分工

| 工具 | 领域 | 定位 |
|---|---|---|
| `commander_task_list` | 任务 | 任务查询：筛选、分页、计数 |
| `commander_task_get` | 任务 | 单任务明细（含写前取 `version`） |
| `commander_workspace_list` | 工作区 | 工作区目录与描述（派发目标、白名单） |
| `commander_session_list` | 会话 | 指定工作区的**根会话**列表（attach 目标；必须指定工作区） |

原则：

1. **领域不混**：任务工具只出任务；派发所需的 `workspaceId` 来自 `commander_workspace_list`（只含已启用工作区）；attach 所需的 `sessionId` 来自 `commander_session_list`。
2. **list 只出列表行**，明细留在 `get`。
3. 列表行自足：拿到一行即可决定「派发 / 续派 / 打开会话 / 忽略」。
4. 三者都是**只读**、都只在指挥官会话可见、都不写盘、不新增表。
5. 四个工具统一渲染约定：模型可见内容只有 `output.render` 的紧凑 JSON 行，结构化返回值必须与 `output.schema` 逐字段一致。

任务行保留 `workspaceName`（去规范化的展示字段，不是工作区查询）；这是唯一的跨域字段，理由：否则每句面向用户的摘要都要再调一次工作区工具。

## 2. 非目标

- 不做全文检索 / 分词 / 拼音 / 纠错 / 正则（沿用 plan §14 第 7 条「只做过滤与摘要」）。`q` 是大小写不敏感的子串 AND。
- 不做 SQL 式表达式、字段投影（`select`）、聚合（group by）。
- 不做 cursor/keyset 分页；用 `offset + limit + total`。
- 不做自然语言时间（「昨天」「上周」由模型换算成具体日期再传入）。
- 不做跨任务组 / 子任务查询（本期无 Task Group）。
- 不改 `commander_task_get`；不改 `commander_task_dispatch` 的确认流程。
- 会话工具不读会话正文（不返回 events/messages）。

## 3. `commander_task_list` 输入

| 参数 | 类型 | 默认 | 说明 / 校验 |
|---|---|---|---|
| `statuses` | `TaskStatus[]` | 省略 = 活跃 7 状态 | 精确状态过滤（OR）。逐项校验枚举，非法 → `invalid_request`（列出合法值）；去重；**空数组视为省略**。显式含 `cancelled`/`archived` 时照常返回（不受 D1 限制） |
| `includeArchived` | `boolean` | `false` | 仅当 `statuses` 省略时生效：`true` = 9 状态全量（含回收站），`total`/`counts`/`columns` 一并包含 |
| `q` | `string` | 无 | 模糊搜索；≤200 字符；按空白切成 ≤8 个 token，**全部命中**（AND）；大小写不敏感子串，CJK 直接子串 |
| `searchIn` | `('title'\|'goal'\|'reportSummary')[]` | `['title']` | 搜索字段；空数组回退默认 |
| `timeField` | `'created'\|'updated'\|'activity'` | `'created'` | 时间过滤字段：`createdAt` / `updatedAt` / `lastActivityAt`（与 D3 的默认排序一致） |
| `since` | `string` | 无 | 区间下界，**闭**；格式见 §4 |
| `until` | `string` | 无 | 区间上界，**开**；只写日期时按「当天结束」处理（见 §4） |
| `limit` | `number` | `20` | 1..100，整数 |
| `offset` | `number` | `0` | 0..10000，整数 |

- **无 `sort`**：固定 `createdAt` 倒序（新任务在前），tie-break `id` 升序保证翻页稳定。需要「最近更新」视角用 `timeField: 'updated'` + 时间窗，不引入排序参数。
- 未知参数一律 `invalid_request`（改名后旧字段不会静默失效）。
- 排序与过滤的组合：`since/until` 走 `timeField` 指定字段，与排序字段相互独立。

## 4. 时间参数格式（D2）

`since` / `until` 均为**字符串**，由 Host 的纯函数解析为 epoch 毫秒后再过滤。

支持格式（无时区后缀时按 **Host 本机时区**解释）：

| 输入 | 解析 |
|---|---|
| `YYYY-MM-DD` | 当天 00:00:00.000（本地） |
| `YYYY-MM-DD HH:mm` | 该时刻（本地） |
| `YYYY-MM-DD HH:mm:ss` | 该时刻（本地） |
| `YYYY-MM-DD HH:mm:ss.SSS` | 该时刻（本地，毫秒可选） |
| `YYYY-MM-DDTHH:mm[:ss]` | 同上，`T` 分隔 |
| 上述任一 + `Z` / `±HH:mm` | 按显式时区解析 |

边界语义：

- `since` 只写日期 → 当天 00:00。
- `until` 只写日期 → **次日 00:00**（即「含当天全天」，内部仍是开区间）。
- 只给时间不给日期（如 `14:40`）→ `invalid_request`，消息给示例。
- 非法日历日（`2026-02-30`）、年份不在 1970..2100 → `invalid_request`。
- `since >= until` → `invalid_request`（同一天的两个日期串合法：`since=2026-10-12`、`until=2026-10-12` 解析为 `[12 日 00:00, 13 日 00:00)`）。
- 传纯数字（epoch）→ `invalid_request`，消息提示「请用 `2026-10-12 14:40` 格式」。

实现约束：**不使用 `new Date(string)` 的宽松解析**（各引擎对 `-`/`/`/`T` 处理不一致），手写正则 + `new Date(y, m-1, d, h, mi, s, ms)`（本地）或 `Date.UTC(...) - offsetMinutes*60_000`（显式时区）。零依赖纯函数，可直接单测。

响应里回 `now: "2026-11-23 21:34"`（本地时间字符串）作为锚点；模型需要相对时间由 `ageMinutes` 直接读，不再自己算 epoch。

## 5. `commander_task_list` 过滤管线

严格按顺序，计数在分页前完成：

1. **取数**：`stores.tasks.list()`（一次）。
2. **scope**：`statuses` 给定 → 用它；否则活跃 7 状态；`includeArchived: true` → 9 状态。
3. **时间**：按 `timeField` 做 `[since, until)`。
4. **文本**：每个 token 都在 `searchIn` 字段中出现。
5. **计数**：`total`、`counts`、`columns` 均基于命中集（D4）。
6. **排序**：`createdAt` 倒序，`id` 升序。
7. **分页**：`slice(offset, offset+limit)` → `returned`、`hasMore`、`nextOffset`。

分页语义（写进工具描述）：

- 不是快照：两次翻页之间任务被改，可能重复或遗漏；需要一致视图就单页拉完（`limit: 100`）。
- `offset >= total` 返回空数组、`hasMore=false`、`nextOffset=null`，`total` 仍为真实值。

`dispatchable` 行字段定义（与派发守卫一致，`.../src/host/dispatch/service.ts:566-571`）：

```ts
dispatchable = (status === 'draft' || status === 'proposed' || status === 'review')
            && dependenciesMet(task, lookup)
```

**不含**全局单卡门禁；那由顶层 `pendingDispatch` 表示。

## 6. `commander_task_list` 返回

```jsonc
{
  "total": 37,              // 命中总数（默认不含回收站）
  "offset": 20, "limit": 20, "returned": 17,
  "hasMore": false,          // nextOffset 仅在 hasMore=true 时出现（不返回 null，避免 schema 空值）
  "now": "2026-11-23 21:34",   // Host 本地时间锚点

  "counts": {               // 命中集按状态分解；键集合随 scope 变化（默认 7 键，不含回收站）
    "draft": 0, "proposed": 3, "queued": 1, "running": 2, "blocked": 1, "review": 5, "done": 25
  },
  "columns": {              // 命中集按六列分解；默认 6 键，含回收站时为 7 键（trash）
    "proposed": 3, "queued": 1, "running": 2, "blocked": 1, "review": 5, "done": 25
  },

  "pendingDispatch": { "taskId": "task_x", "expiresAt": 1764001800000 },  // 仅存在未决确认时出现；全局单卡
  "tasks": [ /* TaskRow[] */ ]
}
```

- **没有** `archive` / 回收站全局计数（D4）：要看回收站规模就传 `includeArchived: true`，`counts.cancelled`/`counts.archived` 会给出。
- 不返回 `workspaces`（D6）。

`TaskRow`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 派发 / 更新用 |
| `title` | string | 未截断（render 截断） |
| `status` | TaskStatus | |
| `column` | `proposed\|queued\|running\|blocked\|review\|done\|trash` | 六列口径 |
| `priority` | Priority | |
| `workspaceId` | string | |
| `workspaceName` | string | 展示用；取自**已启用**工作区目录，找不到（已停用/删除）回退 `workspaceId` |
| `version` | number | CAS / 派发校验 |
| `round` | number | 缺省 1 |
| `dispatchable` | boolean | 见 §5 |
| `waitingFor` | string[] | 未满足依赖 id（空则省略） |
| `blockReason` | string | 仅 `blocked` 输出（截 200 字符） |
| `acceptanceCount` | number | 当前轮验收条数 |
| `stale` | boolean | `taskIsStale`（`.../src/host/board/service.ts:54`） |
| `createdAt` / `updatedAt` | number | 结构化里给 epoch |
| `ageMinutes` | number | `now - updatedAt`，≥0 |
| `primarySessionId` | string | 有主会话时 |
| `pendingInstruction` | boolean | 看板「继续派发」批注未消费 |

留给 `get` 的：`goal`、`timeline`、`acceptance[]`、`acceptanceHistory`、`reportSummary`、`reportMaterials`、`capabilities`、`progress`、`archivedAt`、`archivedFrom`、`dependencyNotifiedAt`、`workspaceIds`、`evidenceInsufficientCount`。

## 7. `commander_task_list` render

```text
Board: total=37, page=21..37 (offset=20 limit=20 hasMore=false nextOffset=null), now=2026-11-23 21:34
columns: {"proposed":3,"queued":1,"running":2,"blocked":1,"review":5,"done":25}
pending: {"taskId":"task_x","expiresAt":1764001800000}
tasks: [{"id":"task_x","title":"…","status":"review","column":"review","priority":"high","workspaceId":"ws-a","workspaceName":"A","version":7,"round":2,"dispatchable":true,"acceptanceCount":2,"stale":false,"age":"42m"}]
```

规则：`title` 用 `clipLine` 截 60；`blockReason` 截 200；`age` 用 `formatRelativeTime`；`pending` 为 null 时写 `pending: none`；空结果也要输出前三行并在末行提示「放宽条件或传 includeArchived」。

## 8. 错误码

沿用两类，不新增 code（保持 `oneOf[toolError, ok]`）：

| code | 场景 |
|---|---|
| `forbidden_scope` | 非指挥官会话 / 取不到调用方 session |
| `invalid_request` | 非法 status/searchIn/timeField、时间格式错、`since >= until`、`limit`/`offset` 越界、`q` 超长、未知参数 |
| `unknown_workspace` | 工作区/会话工具里 `workspaceId` 解析不到 |

消息必须可行动：非法枚举列合法值；时间格式错给示例；越界给合法区间。

## 9. `commander_workspace_list`

**无参数**（工作区数量级小；要「查某个」用工具结果里筛，不引入第二个查询维度）。

**只返回配置中已启用（`allowed === true`）的工作区**；未启用的工作区不出现，也不可被引用（D7）。理由：未启用 = 不可派发目标，暴露出来只会诱发 `invalid_target` 循环，且属于配置隐私。

返回：

```jsonc
{
  "total": 3,
  "workspaces": [{
    "id": "ws-a", "name": "A", "path": "/Users/x/proj",
    "summary": "…", "policy": "inherit",
    "sessionCount": 12        // registry sessionIds 计数（近似，不含归档剔除）
  }]
}
```

- 数据源：`collectWorkspaceDirectory`（registry ∪ stores，`.../src/host/dispatch/candidates.ts:395`）后按 `allowed === true` 过滤。
- 排序：`name` 升序。
- `summary` 结构化原样，render 截 60；`path` 保留（用于向用户复述目标）。
- `total === 0` 也要成功返回（不是错误），render 给可行动提示：`workspaces: [] · 当前没有启用任何工作区，需先在设置页启用后再派发`。
- render：

```text
Workspaces: total=3
workspaces: [{"id":"ws-a","name":"A","path":"/Users/x/proj","policy":"inherit","summary":"…","sessions":12}]
```

- 工具描述里写清：本工具返回的就是派发可用的全部目标；`candidate.workspaceId` 只能从这里取值。

## 10. `commander_session_list`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `workspaceId` | string | **是** | — | 工作区 id / 名称 / 路径（含 cwd）。解析只在**已启用**工作区里进行（D7）；无空参数查询（D8） |
| `q` | string | 否 | 无 | 标题子串（大小写不敏感，单串，不切 token） |
| `includeArchived` | boolean | 否 | `false` | 是否包含归档会话 |
| `since` / `until` | string | 否 | 无 | 作用于 `lastActiveAt`，格式同 §4 |
| `limit` | number | 否 | `20` | 1..100 |
| `offset` | number | 否 | `0` | 0..10000 |

**工作区解析顺序**（针对已启用目录，逐级尝试，先命中先返回）：

1. `id` 精确匹配；
2. `name` 精确匹配（大小写/空白归一）；
3. `path` 精确匹配或 basename 匹配（复用 `resolveWorkspaceReference`）；
4. **cwd 归属**：输入是绝对路径且前 3 步未命中时，取「工作区 path 为该路径的最长前缀」的工作区（允许子目录，与 `cwdBelongsToWorkspace` 同口径）。

仍不唯一 → `invalid_request` 并列出候选 id；完全未命中 → `unknown_workspace`（未启用工作区也走这条，不暴露存在性）。

行为：

- 复用 `collectWorkspaceSessions`（`.../src/host/dispatch/candidates.ts:198`），与「确认卡自定义 attach」的候选口径一致：`lastActiveAt` 取 `max(createdAt, 标题快照 updatedAt)`（近似值，文档写明）。
- **只出根会话**（D9）：排除 `isChild`、有 `parentSession` 指针的会话（teammate / 子代理），以及指挥官会话本身。判据需要 `NormalizedSession` 补 `parentSessionId` 字段（见 §12）。
- 排序 `lastActiveAt` 倒序，`id` 升序；分页语义同 §5。

返回：

```jsonc
{
  "total": 42, "offset": 0, "limit": 20, "returned": 20,
  "hasMore": true, "nextOffset": 20, "now": "2026-11-23 21:34",
  "workspace": { "id": "ws-a", "name": "A" },      // 恒存在（workspaceId 必填）；行内不再重复
  "sessions": [{
    "sessionId": "s-1", "title": "…",
    "createdAt": 1763997000000, "lastActiveAt": 1763997480000, "ageMinutes": 42,
    "archived": false, "model": "…", "agentPreset": "…", "contextUsage": 0.37
  }]
}
```

render：

```text
Sessions: total=42, page=1..20 (hasMore=true nextOffset=20), workspace=ws-a(A)
sessions: [{"sessionId":"s-1","title":"…","age":"42m","archived":false}]
```

## 11. 兼容与迁移

破坏性变更（Host 改动，需重装 + 重启）：

| 现状 | 改版后 | 处理 |
|---|---|---|
| `counts` 全量 9 状态 | 命中集、默认 7 状态 | 测试与 render 改 |
| `workspaces` 恒返回 | **删除**，改由 `commander_workspace_list`（只出已启用） | `.../src/host/session/prompt.ts:10` 改调工作区工具；dispatch 的 `no_workspace` 消息（`.../dispatch/service.ts:583`）改为「调用 `commander_workspace_list`；若为空则需先在设置页启用工作区」，`invalid_target`/`not_found`（`:605,668,674,899`）改提示 `commander_workspace_list`；attach 目标提示 `commander_session_list` |
| `pendingContinue` | `pendingInstruction` | 行字段改名（`TaskView` 同步） |
| 无顶层 pending | `pendingDispatch`（顶层） | 复用 `dispatchService.currentPending()`（`.../dispatch/service.ts:238`） |
| `statuses` 不校验 | 枚举校验 | 新增错误分支 |
| `tasks.items` 是 `additionalProperties: true` | 全字段封闭 schema | 修掉与「schema 逐字段一致」的冲突 |
| 无分页、无时间/文本过滤 | 见 §3 | — |
| 工具数 6 | 8（+workspace_list +session_list） | `COMMANDER_TOOL_NAMES`、`tests/unit/tools.test.ts:29`、`tests/integration/m1-tools-scope.test.ts:31` |
| 确认卡 attach 候选 = 全部非归档、非子代理会话 | 与工具统一为「根会话」判据 | teammate / 带 `parentSession` 的会话不再出现在面板 attach 列表（§12 单一谓词） |

无数据迁移：不改 `TaskRecord`、不加表。工具描述全部重写（模型第一手），并在 prompt 里补一句「任务用 task_list 筛/分页/计数，明细用 task_get；工作区用 workspace_list，会话用 session_list」。

## 12. 实现要点

新增（`src/host/query/`，全部纯函数 + 薄 IO 适配，便于单测）：

| 文件 | 职责 |
|---|---|
| `time-input.ts` | `parseBound(value, {bound:'from'\|'to'})` → epoch ms；手写解析、本地/显式时区、日期-only 语义 |
| `tasks.ts` | `queryTasks({tasks, filter, now, lookup})` → `{total, counts, columns, page}`；单次遍历 |
| `workspaces.ts` | `listWorkspaces({directory})` → 过滤 `allowed === true` + 名称排序 + `sessionCount` |
| `sessions.ts` | `listSessions({ctx, stores, workspaceRef, filter})` → 解析工作区（含 cwd 前缀归属）→ 复用 `collectWorkspaceSessions` → 排序分页 |
| `board-columns.ts` | Host 版六列映射（见下） |

- 行投影复用：`taskIsStale`（`board/service.ts:54`）、`dependenciesMet`/`waitingFor`（`tasks/dependencies.ts`）、`clipLine`/`formatRelativeTime`（`rotation/brief.ts`）、`collectWorkspaceDirectory`（`dispatch/candidates.ts:395`）、`collectWorkspaceSessions`（`:198`）、`resolveWorkspaceReference`（`:444`）。
- **根会话判据（D9）**：在 `session-records.ts` 新增单一谓词 `isRootSession(session)` = `!isChild && parentSessionId === undefined && id !== 指挥官会话`；`NormalizedSession` 增加 `parentSessionId?: string`（真实 header 的 `parentSession` 目前只被读取未使用，见 `.../session/session-records.ts:59-80`；flat 兼容形状已有 `parentSessionId`）。该谓词同时用于工具与 HTTP `GET /commander/sessions`，保证「确认卡候选」与「工具结果」一致——口径只此一处，核实后要收窄也只改一处。现有 fake/归一测试需补 `parentSession` 形状。
- 六列映射：`tsconfig.host.json` 的 `rootDir` 限定 `src/host`，**不能 import client**。按 i18n 双字典的做法：Host 写一份 + drift 测试 `tests/unit/board-columns-drift.test.ts` 同时 import `src/client/board.ts` 与 Host 版，断言 `statuses`/`trash` 一致。
- 工具注册一次、`when: commanderOnly` 放行；每个 `execute` 仍做 `ensureCommanderScope` 二次校验。
- schema：`additionalProperties: false` 到底；`oneOf` 覆盖错误 variant；渲染函数按 §6/§9/§10。
- 性能：任务单次 `list()` 一次遍历；会话按工作区批量读（`readSessionsByIds`，单次上限沿用 800/1000），不读正文。

## 13. 测试清单

unit：
- 时间解析：6 种格式、日期-only 的 `from`/`to` 语义（含 `until=当天` = 次日零点）、非法日期、`14:40` 拒绝、epoch 拒绝、显式 `+08:00`/`Z`、`since >= until`。
- 任务查询：默认隐藏回收站；`includeArchived`；`statuses` 显式含 trash；非法 status/sort 移除后无 sort 参数；`searchIn` 三字段；多 token AND；分页边界（`offset` 越界、`hasMore`、`nextOffset`、tie-break）。
- `dispatchable`：`review`+依赖满足=true；`blocked`=false；依赖未满足=false。
- workspace list：只出 `allowed === true`（未启用的不出现）、名称排序、`sessionCount`、零启用时成功返回空数组 + 提示。
- session list：`workspaceId` 必填（缺失 → `invalid_request`）；id/名称/路径/cwd 子目录四种解析；未启用或不存在 → `unknown_workspace`；歧义 → `invalid_request` + 候选 id；只出根会话（排除 subagent / teammate / 指挥官）；`q`、`includeArchived`、时间过滤、分页。
- schema：真实 validator（沿用 `tryLoadRealTools`）校验四种成功体 + 错误体。
- render：四个工具均含 id 与分页字段；空结果有摘要行。
- drift：Host 六列映射与 client 一致。

integration：
- 四工具只读（查询前后 `version` 不变、无写盘）。
- 非指挥官会话 → `forbidden_scope`。
- 派发后查询：`round`/`primarySessionId`/`dispatchable` 与守卫一致；顶层 `pendingDispatch` 指向正确任务。
- `unknown_workspace` 与歧义名称的报错信息含候选 id。

e2e（`m23-e2e.mjs`）：`workspace_list` → `session_list` → `task_list`（q + 翻页 + includeArchived）→ 派发全链路。

## 14. 实施前需核实（不阻塞设计）

1. **teammate / subagent 在真实 DSH session header 上的标记**：本仓现有判据只有 `origin === 'subagent'` 与 `delegationDepth > 0`（`.../src/host/session/session-records.ts:59-80`），且注释明确「`parentSession` 单独存在不判子会话」。D9 要求排除 teammate，需要先确认 teammate 会话的 header 形状（`parentSession`？`origin`？`delegationDepth`？），再定「根会话」判据；写代码前用一次 live 查询或 `@deepseek-ai/dsh-session-query` 类型核对。
2. **cwd 前缀归属的边界**：嵌套工作区（一个工作区 path 是另一个的前缀）取最长前缀；若将来出现「同一 cwd 属于多个启用工作区」的真实案例，需要决定是报歧义还是按最长前缀优先（当前方案取最长前缀）。

（原 §14 的三项已定：`includeArchived` 命名保留；`workspaceId` 必填；只出根会话。）
