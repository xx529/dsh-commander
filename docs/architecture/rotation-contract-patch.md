# R1 契约补丁（指挥官会话轮换 · 交接简报）

> 版本：v1.2　日期：**2026-11-20（Asia/Shanghai）**　状态：**已实现并自测通过**（2026-11-19；证据 `docs/validation/rotation-implementation.md`）。实现以本文件为唯一口径。
> 依据：用户 2026-11-19 三轮决策——**D1 默认关**、**D2 交接简报带用户最近原话**、**D3 `turn/end` 触发 + 投递前兜底**；以及「先落到文档、再验证」的交付顺序。
> 平台基线：`@deepseek-ai/dsh 0.2.2-rc.3`（desktop profile）；事实核对见 `docs/validation/rotation-contract-facts.md`。
> 边界：**不新增存储表**、**不新增 DSH 会话事件类型**、不改 M0/M1R/M2/M3 已验收行为、不改 V0/V5 裁定、不写实现。

---

## 0. 一页摘要（给 backend / frontend / tester）

| # | 主题 | 唯一口径 |
|---|---|---|
| 1 | 开关 | `config.commander.rotation.enabled` **默认 `false`**。关闭时系统行为与现状完全一致（只有设置页「绑定到新会话」这一条手动路径，**不生成任何简报**）。 |
| 2 | 周期 | `periodDays` 整数 **1–7**，默认 `1`。时间差判定（`now - generationStartedAt >= periodDays*86_400_000`），**与时区/自然日无关**；展示用本地时区。 |
| 3 | 触发 | 一级：指挥官会话 `turn/end`（异步、不阻塞）；二级兜底：`POST /commander/message` 投递前；手动：`POST /commander/rotation`（仅 `enabled=true` 时可用）。**不做定时器**（插件无 scheduler 冻结决策）。 |
| 4 | 门控 | 到点只是必要条件；还必须 `!busy` + 无 `pendingDispatch` + 无未 flush 的看板注入 + 无并发换任。任一不满足 → 本次跳过，下次边界重试。 |
| 5 | 简报 | **确定性生成**（零模型调用）：本周期任务罗列 + 当前未完成 + 用户最近原话（≤10 条、总 ≤800 字、默认开）+ 实时看板提示。总量 ≤4096 字。 |
| 6 | 注入 | `agents.get(newSessionId).inject(buildContextMessage(...))`：`<system-reminder>` 包裹、`source.kind='commander-handoff'`、`form='notice'`。**不唤醒驱动器**，不产生用户气泡，不额外烧一次模型调用。 |
| 7 | 提交 | `create 新会话 → inject 简报 → 写 config（提交点）→ 旧 link=retired + 新 link`。提交前任一步失败：**旧绑定不变**，`markBroken` 不触发，记失败原因并退避重试。 |
| 8 | 退役 | `sessions.status` 增加 `'retired'`（与 `'missing'` 严格区分）；旧会话**不删除、不 archive**，用户可用现有 `mode:'select'` 重新绑回。 |
| 9 | 新增接口 | `POST /commander/rotation`；`GET /commander/state` 增加 `rotation` + `formerCommanders`；SSE 增加 `rotation.updated`。**不新增表。** |
| 10 | 简报可见性 | 简报以 `user/message`（`source.kind='commander-handoff'`）落在**新会话日志**里 → 天然可回放；面板不重复渲染，DSH 聊天显示上下文卡（渲染形式待 live 确认，U3）。 |

---

## 1. 术语与不变量

| 术语 | 定义 |
|---|---|
| **任（generation）** | 一次绑定产生的一任指挥官会话。序号从 1 递增，跨重启持久化在 `config.commander.rotation.generation`。 |
| **轮换（rotation）** | 在安全边界把「当前任」换成「新的一任」，并给新会话注入一份**交接简报**。 |
| **交接简报（brief）** | 由 Host 从持久化数据确定性生成的纯文本，描述「上一周期做了什么 + 现在还有什么没完 + 用户最近原话」。 |
| **退役（retired）** | 被轮换掉的旧会话在 `sessions` 表中的状态；会话本身与日志保留。 |

不变量：

1. **配置是唯一真源**：任一份投递/注入/工具放行都以 `config.commander.sessionId` 为准（现有实现已动态读取，见 §7.5）。
2. **提交点唯一**：只有一次 `config` 写入能改变当前任；它之前的任何失败都不得留下「已换任」的痕迹。
3. **简报不替代看板**：简报是历史摘要；实时状态一律走 `commander_task_list`。
4. **换任不打断用户输入**：投递前兜底失败时，消息照旧投给旧会话。
5. **不轮中**：`busy` 或 `pendingDispatch` 时绝不换任。

---

## 2. 冻结决策

| ID | 决策 | 来源 |
|---|---|---|
| D1 | 轮换**默认关闭**；关闭态唯一路径是设置页「绑定到新会话」，该路径**不做轮换总结**（保持 M0/M1R 行为） | 用户 2026-11-19 |
| D2 | 周期可配 **1–7 天**，默认 1 天 | 用户 2026-11-19 |
| D3 | 交接简报**包含用户最近原话**（≤10 条 / ≤800 字，默认开，可关） | 用户 2026-11-19 |
| D4 | 触发点：**`turn/end` 优先，消息投递前兜底** | 用户 2026-11-19 |
| D5 | 交接 prompt 以 **context 注入**方式交付（不唤醒、不占用户气泡） | 用户 2026-11-19 |
| D6 | 简报内容 = 本周期任务罗列 + 未完成清单（**不做语义总结模型调用**） | 用户 2026-11-19 |
| D7 | 中途自动压缩**不干预**：简报来自持久化任务数据，与上下文压缩解耦 | 用户 2026-11-19 |
| D8 | 旧会话**退役不删除**，可人工绑回；不做自动归档 | 本契约 |

---

## 3. 生命周期与触发

### 3.1 状态

轮换没有独立状态表，运行态由「配置 + 内存标志」表达：

```ts
type RotationPhase = 'idle' | 'due' | 'rotating' | 'failed'

// 判定（纯函数，入参由调用方注入 now）
function rotationPhase(input: {
  enabled: boolean
  now: number
  startedAt: number
  periodDays: number
  rotating: boolean
  lastError?: { code: string; at: number }
}): RotationPhase
```

- `due` 之后若本次门控不通过 → 保持 `due`（不写盘），下一个边界再判。
- `failed` 只用于展示与退避（内存），**不写常量到存储**。

### 3.2 判定顺序（必须一致）

```text
1. enabled === true                       否 → 跳过（关闭态完全不进入本流程）
2. now - generationStartedAt >= periodDays*86400000   否 → 跳过
3. rotating === false                     否 → 跳过（并发保护）
4. 安全边界：
   a. 指挥官会话不 busy（turn 已结束）
   b. pendingDispatch 为空
   c. 看板注入合并窗口内无待发条目（boardService 无 pending merge）
   d. 若 live agent 存在：await agent.whenIdle()
5. 本周期有活动：旧会话窗口内存在 user/assistant message，或窗口内有任务 created/updated
                                          否 → 跳过（不写盘、不推进 startedAt）
6. 失败退避：lastError 在 10 分钟内 → 跳过
7. → 执行轮换（§8）
```

> 第 5 条的目的：用户长期不开工时不产生空会话。若用户手动 `force`（§7.1），第 2、5 条豁免，第 3、4、6 条仍然生效。

### 3.3 触发点

| 触发点 | 位置 | 行为 |
|---|---|---|
| **A 一级：`turn/end`** | `src/host/rotation/service.ts` 订阅 `session/event`，**只处理** `session.id === config.commander.sessionId` 且 `type === 'turn/end'` | 用 `queueMicrotask`（或 `setTimeout(0)`）让 `commander.status.busy` 先落为 `false`，再跑 §3.2 判定；整个过程异步，不阻塞事件循环 |
| **B 兜底：投递前** | `src/host/api/routes/handlers.ts` 的 `POST /commander/message`，在调用 `deliverer.deliverUserMessage(...)` **之前**（用户 echo 是否已保留均可，不影响语义） | 若 `phase === 'due'` 且门控通过 → 先换任，再把这条消息投给**新**会话；换任失败只记日志，**消息继续走原投递路径投给旧会话**（不阻塞用户、不改变响应） |
| **C 手动：`POST /commander/rotation`** | `src/host/rotation/service.ts` + 路由 | 仅 `enabled=true`；`force` 可跳过周期与活动判定；门控不过返回 `rotation_busy` |

**不做**：`setInterval` / 午夜定时器 / DSH schedule 依赖。

### 3.4 并发与退避

- `rotating` 为进程内存标志；整个一次性执行在 `try/finally` 中复位。
- 失败后 10 分钟内不再尝试（防雪崩）；手动 `force` 不受退避限制，但仍要求安全边界。
- 一次轮换的目标耗时 < 2s（create + inject + 写 config）；超时（10s）按失败处理。

---

## 4. 交接简报（brief）

### 4.1 输入

| 字段 | 来源 | 说明 |
|---|---|---|
| `window` | `[briefWindowStart, now)`，`briefWindowStart = min(generationStartedAt, now - periodDays*86400000)` | **至少覆盖一个周期**：刚启用/刚换任就触发时不产生空窗（否则会漏掉当天任务）；本任超过一个周期时从本任起点算，不丢跨日任务 |
| 任务 | `stores.tasks.list()` | 只读；字段 `id/title/status/workspaceId/priority/updatedAt/lastActivityAt/block/reportSummary/timeline` |
| 用户原话 | 旧会话事件日志：`readSessionEvents(ctx, oldSessionId)` 过滤 `type==='user/message'` 且 `source.kind === 'user'` | 窗口内最近 ≤10 条；每条 ≤120 字；总 ≤800 字 |
| 工作区/模型 | `config.commander` | 工作区名称取 `workspaces` 记录或 `workspacePath` 的 basename |
| 待确认派发 | `dispatchService.currentPending()` | 门控保证通常为空；若非空（`force` 场景）写入简报 |

**不使用**：`config.jev`（含 env 名/凭据引用）、工具结果、审批内容、注入卡片正文。

### 4.2 输出格式（逐字模板）

> `{generation}` 一律是**被交接的旧任**（`from.generation`），不是新任一。新一任 = `from.generation + 1`，只在 `config` / `state` / 面板提示里出现。

```text
[commander-handoff] 第 {generation} 任交接简报
窗口：{startLocal} → {endLocal}（{periodDays} 天）
工作区：{workspaceName}（{workspaceId}）· 模型：{provider}/{model}
本周期任务（{n} 条）：
- [done] 修复登录重试 (#t-1) — 已合并
- [review] 导出开关 (#t-2) — 等验收
当前未完成（{m} 条）：
- [running] 文档迁移 (#t-3) — 最近活动 2h 前
- [blocked] 打包脚本 (#t-4) — 阻塞：签名证书缺失
用户最近原话（{k} 条）：
- "今天先把导出的开关收掉"
说明：本简报只是交接摘要；实时看板用 commander_task_list 查。
```

空段规则：某段为空时**省略整段**（含标题），不要输出「无」以外的空行。结尾「说明」行恒在（v1.2 起不再提示「打开第 N 任会话」：历史任务走看板/会话既有能力，简报不承担导航）。

### 4.3 生成规则

1. **本周期任务**：`updatedAt ∈ window` 且 `status !== 'archived'`，按 `updatedAt` 倒序，**≤20 条**；每条一行：
   - 状态标签固定小写：`draft/proposed/queued/running/blocked/review/done/cancelled`；
   - `title` 截断 ≤60 字；
   - 结论优先取 `reportSummary.text` 首句（≤80 字），否则取最近一条 `timeline` 的 `text`（≤80 字），没有则省略 `—` 段。
2. **当前未完成**：`status ∈ {proposed, queued, running, blocked, review}`，排序 `priority` 高→低，再 `lastActivityAt` 倒序，**≤10 条**；`blocked` 必须带 `block.reason`（≤100 字）；running/queued 带相对活动时间（`<1m/…m/…h/…d`）。
3. **用户最近原话**：`includeUserTail === true` 时输出；取窗口内最后 ≤10 条，按时间正序，单条 ≤120 字（超出加 `…`），总长 ≤800 字（超出从最旧开始丢）。
4. **总量**：整份 ≤ `BRIEF_MAX_CHARS = 4096`（Unicode 码点）。超出时按顺序裁剪：用户原话（从旧到新）→ 本周期任务（从旧到新）；**未完成段永不裁剪**；裁剪后追加一行 `…[简报已截断，另有 N 条见看板]`。
5. **确定性**：同一输入必须得到逐字相同的输出（时间格式化用 `YYYY-MM-DD HH:mm` 本地时区；相对时间只精确到分钟；不输出随机 id）。
6. **纯函数**：`buildHandoffBrief(input): { text: string; stats: { tasks: number; unfinished: number; userLines: number } }`，无 IO、无 `Date.now()`（`now` 注入）。

### 4.4 边界

- **窗口内无活动**：门控第 5 条直接跳过，不生成空简报。
- **旧会话不可读**（冷/损坏）：用户原话段整体省略；其余照常。
- **任务全部归档**：本周期段为空、未完成段为空 → 简报只剩头部与说明（仍可换任）。
- **超长任务标题**按码点截断，不切代理对。

---

## 5. 注入协议

### 5.1 消息形状（复用现有上下文注入构造器）

```ts
import { buildContextMessage } from '../session/deliver.ts'

const message = buildContextMessage(brief.text, {
  kind: 'commander-handoff',
  summary: `第 ${generation} 任交接简报（${chars} 字）`,
  generation, // 新增可选字段，写入 source.generation
})
// 实际落到新会话日志的 user/message：
// { role:'user', source:{ kind:'commander-handoff', form:'notice', summary, generation },
//   content:[{ type:'text', text:'<system-reminder>\n…brief…\n</system-reminder>' }] }
```

- `ContextDeliveryOptions` 增加可选 `generation?: number`；`buildContextMessage` 在 `source` 里透传。**语义：`generation` = 被交接的旧任**（`from.generation`），与简报标题一致。**不改**现有 `commander-session-reply` / `commander-board-edit` 行为。
- 与 `followup` 的区别：`followup` 会唤醒一轮并产生一条助手回复；`inject` **不唤醒**，简报跟随下一个真实用户 turn 进入上下文（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent/src/runtime-types.ts:271`）。本契约固定用 `inject`。

### 5.2 时序保证

1. `create` 返回时 Agent 已注册（`dsh-api-session-controller/src/commands.ts:136-159` → `agents.createSession`，`dsh-agent/src/index.ts:580` 的 `get(id)` 可取）→ 优先立即 `inject`。
2. 若 `agents.get(newSessionId)` 仍取不到：重试 3 次（50ms 间隔）；仍失败 → **中止轮换**（不写 config），下次边界重试。
3. 若 `inject` 抛错：同上中止（不写 config）。
4. 静止期注入的语义是「下一个被接纳的 step 之前可见」；若首个用户消息已在一个运行中的 step 里（极窄竞态），简报会顺延到再下一个 step——可接受，记为 U2。

### 5.3 与其它注入的关系

- 现在注入回指挥官的有两种：`commander-session-reply`（工作会话回复）与 `commander-board-edit`（看板人工改动）。新增的 `commander-handoff` **不参与**去重键（一次性，消息 id 用 `handoff_<newSessionId>_<generation>`）。
- 面板消息环**不渲染**交接简报（与现有注入一致，环只收 assistant 文本与用户 echo）；DSH 聊天里显示为上下文卡，面板用系统提示告知「已换任」。

---

## 6. 配置与存储

### 6.1 `ConfigRecord.commander.rotation`（加法式，全部可选）

```ts
interface RotationConfig {
  /** 默认 false；关闭时轮换路由不可用、面板无入口。 */
  enabled: boolean
  /** 1..7，默认 1。 */
  periodDays: number
  /** 是否把用户最近原话放进简报，默认 true。 */
  includeUserTail: boolean
  /** 当前第几任，默认 1；任何绑定变更 +1 或按目标会话回填。 */
  generation?: number
  /** 本任开始时间（ms）；绑定成功时写入，换任时重置。 */
  generationStartedAt?: number
}
```

- 读取归一化：`rotation === undefined` → `{ enabled:false, periodDays:1, includeUserTail:true, generation: <现有 commander 记录数 + 1>, generationStartedAt: <绑定时间或 config.updatedAt> }`；**不主动写盘**，等用户保存或首次轮换时才落库。
- `PUT /commander/config` 校验：`periodDays` 必须是 1–7 的整数（`invalid_request` + `field='commander.rotation.periodDays'`）；`enabled/includeUserTail` 必须是布尔；`generation*` 由 Host 管理，**patch 里出现即拒绝**（`field='commander.rotation.generation'`）。
- 用户把 `enabled` 从 false 改成 true 且 `generationStartedAt` 为空时，Host 在写配置时补 `now`（避免一开就立刻换任）。
- `GET /commander/config` 返回只读视图（保留现有字段，追加 `rotation`）。

### 6.2 `SessionLinkRecord`（sessions 表，加法式）

```ts
status: 'queued' | 'running' | 'idle' | 'missing' | 'retired'   // 新增 retired
generation?: number      // 仅 role='commander' 记录；默认 1
retiredAt?: number       // 仅 retired 记录
```

语义：

| 状态 | 含义 | 写入者 |
|---|---|---|
| `retired` | 被换任退役；会话与日志保留，可在设置页「选择已有会话」绑回 | 轮换提交 |
| `missing` | 会话真的不存在/不可恢复（`markBroken`、bind 换绑） | 现有逻辑不变 |

**禁止**用 `markMissing` 表达退役：现有 `binding.writeBinding` 在换绑时会把旧 link 标 `missing`（`packages/dsh-commander/src/host/session/binding.ts:140`）。轮换**不走** `writeBinding`，走新的 `binding.commitRotation()`（§8），避免语义污染。

### 6.3 不新增表 / 兼容

- 不新增 domain 表；`retired` 与 `generation` 是既有 `sessions` 记录的加字段（validator 允许缺省）。
- 旧记录（无 `generation/retiredAt`）读取时按 `generation=1`、非 retired 处理。
- `config` 旧记录（无 `rotation`）读取时按 §6.1 归一化。

---

## 7. HTTP / SSE

### 7.1 `POST /commander/rotation`

请求：

```json
{ "requestId": "req_<id>", "force": false }
```

- `force` 缺省 false；仅 `enabled=true` 时接受请求。
- 幂等：`requestId` 走现有写操作幂等 LRU（与 `POST /commander/message` 同机制）。

响应 200：

```json
{
  "ok": true,
  "rotated": true,
  "reason": "not_due | no_activity",   // 仅在 rotated=false 时出现
  "generation": 3,
  "rotation": { "enabled": true, "periodDays": 1, "generation": 3, "due": false, "rotating": false, "…": "…" },
  "sessionId": "session-…",
  "previousSessionId": "session-…",
  "startedAt": 1795000000000,
  "brief": { "chars": 1832, "tasks": 6, "unfinished": 3, "userLines": 4, "truncated": false },
  "rev": 42
}
```

- `force=false` 且未到点 → **200 `{rotated:false, reason:'not_due'}`**（不是错误）；到点但本周期无活动 → `{rotated:false, reason:'no_activity'}`。
- `force=true` 跳过周期与活动判定；`busy`/`pendingDispatch`/并发/退避仍然生效（409 `rotation_busy`）。
- 交接失败（create / agent / inject / 写 config）→ 502 `rotation_failed`，旧绑定不变。

错误：见 §7.4。

### 7.2 `GET /commander/state` 增量（全部可选，向后兼容）

```ts
interface RotationView {
  enabled: boolean
  periodDays: number
  includeUserTail: boolean
  generation: number
  startedAt: number
  dueAt: number          // startedAt + periodDays*86400000
  due: boolean           // enabled && now >= dueAt
  rotating: boolean
  lastError?: { code: string; message: string; at: number }
}

// state 顶层追加
rotation: RotationView
formerCommanders: Array<{ sessionId: string; generation: number; startedAt: number; retiredAt: number }> // ≤10，retiredAt 倒序
```

`formerCommanders` 来自 `sessions` 表 `role='commander' && status='retired'`；不新增列表路由。

### 7.3 SSE `rotation.updated`

单事件、全量视图（与 `binding.updated` 同风格）：

```json
{ "event": "rotation.updated", "data": { "rotation": { … }, "formerCommanders": [ … ], "rev": 42 } }
```

时机：`phase: 'rotating'` 开始、`committed` 提交成功、`failed` 失败（带 `lastError`）。

### 7.4 错误码（`src/host/api/errors.ts` 追加）

| code | HTTP | 场景 |
|---|---|---|
| `rotation_disabled` | 409 | `enabled=false` 时调用轮换 |
| `rotation_busy` | 409 | 正在换任 / 指挥官 busy / 有 `pendingDispatch` |
| `rotation_failed` | 502 | create / agent / inject / 写 config 任一步失败（附 `retryable: true`） |

### 7.5 与既有机制的关系（实现时不要额外改）

| 机制 | 现状 | 结论 |
|---|---|---|
| 工具放行 | `when` 每次 step 读 `config.commander.sessionId`（`src/host/tools/index.ts:639`） | 换任后自动跟随 |
| system prompt | 渲染时比对当前 commander id（`src/host/session/prompt.ts:44`） | 自动跟随 |
| `turn/end` 注入 | 目标取 `commanderSessionId()`（`src/host/index.ts:179`） | 自动跟随 |
| 消息环 | 重启回填只读当前绑定会话（`src/host/index.ts:132`） | 换任后不自动回填旧消息；面板保留内存中的旧消息 + 客户端插一条分隔提示 |
| 手动重绑 | `POST /commander/binding` | **不生成简报**（D1），只更新 `generation/startedAt` |

---

## 8. 提交顺序与回滚矩阵

### 8.1 顺序（固定）

```text
1. 快照 from = { generation, sessionId }
2. brief = buildHandoffBrief({…})                     // 纯函数，失败即中止
3. created = sessionController.create(locator)        // locator：workspaceId 非空 → {workspaceId}；否则 {cwd: workspacePath}
   ↓ 与 bindNew 同口径（binding.ts:178-182）：create 后若 config.commander.model 已配置 → selectModel({sessionId, ...model})
4. agent = agents.get(created.sessionId)               // 3×50ms 重试
5. agent.inject(buildContextMessage(brief.text, …))
6. config 提交：sessionId=created, generation=from.generation+1, generationStartedAt=now
7. sessions：旧 link → { status:'retired', retiredAt:now }；新 link upsert { role:'commander', generation, status:'idle', mode:'new' }
8. SSE rotation.updated(committed) + 日志
```

`binding.commitRotation()` 新增于 `src/host/session/binding.ts`，**只做第 6 步**（原子写 config），不调用 `markMissing`。

### 8.2 回滚矩阵

| 失败点 | 已发生 | 处理 |
|---|---|---|
| 2 简报 | 无 | 中止；`lastError=brief_failed`；退避 10min |
| 3 create | 无 | 中止；旧绑定不变；`lastError=create_failed` |
| 4 agent 缺失 | 新会话已建（空） | 中止，**不写 config**；旧绑定不变；新空会话留在 DSH（无害，日志记 id）；如拿到 handle 则 `dispose()` |
| 5 inject | 新会话已建 | 同上；新会话无简报，绝不提交 |
| 6 写 config | 简报已注入到新会话 | 中止；旧绑定不变；新会话成为「无主会话」（不绑定、不投递，可人工删除） |
| 7 sessions 写 | config 已提交 | **不回滚**（提交点已过）；补写重试 2 次，失败只记日志与 `lastError=bookkeeping_failed`；`formerCommanders` 缺失一条可接受 |

**任何失败都不得调用 `binding.markBroken`**；`broken` 只表示会话不可恢复。

---

## 9. 可观测性

- 日志（logger.info/warn）：
  - `[commander] rotation skipped { reason }`
  - `[commander] rotation committed { from,to,generation,briefChars,durationMs }`
  - `[commander] rotation failed { step,code,message }`
- `rotation.updated` 事件即前端观测面；`state.rotation.lastError` 供设置页红条。
- 不新增 metrics 结构；复用现有 `metrics`（不变）。

---

## 10. 验收标准（实现后逐条给证据）

| ID | 分层 | 断言 |
|---|---|---|
| A1 | unit | `buildHandoffBrief`：窗口过滤、排序、≤20/≤10 上限、用户原话 ≤10 条/≤800 字、总量 ≤4096、确定性（同输入逐字相同）、空段省略、代理对截断 |
| A2 | unit | 门控：`enabled=false`、未到点、busy、`pendingDispatch`、无活动、退避中 → 全部不换；到点 + 边界安全 → 换 |
| A3 | integration | 提交顺序：`create → inject → config → retired`；断言新会话收到 `source.kind='commander-handoff'`；旧 link=`retired`（**不是** `missing`）；新 link `role=commander, generation+1` |
| A4 | integration | 回滚矩阵 6 个失败点：旧绑定不变、无 retired、无 `markBroken`、`lastError` 正确 |
| A5 | integration | `turn/end` 触发：仅指挥官会话生效；非指挥官会话 `turn/end` 不触发；异步不阻塞 |
| A6 | integration | 投递前兜底：`POST /commander/message` 到点 → 先换任、消息落新会话；换任失败 → 消息仍落旧会话（200） |
| A7 | integration | `enabled=true` 时 `POST /commander/binding {mode:'new'}` 仍**不生成**简报（D1 回归） |
| A8 | integration | `enabled=false`：`POST /commander/rotation` → 409 `rotation_disabled`；`state.rotation.due=false`；无 SSE |
| A9 | integration | 重启后 `generation/generationStartedAt` 保持；到点仍会换 |
| A10 | client | 设置页：开关/1–7 选择/用户原话开关/本任信息/历任列表（≤10）+「查看前任」（`openSession` 或 `session-transcript`） |
| A11 | client | `rotation.updated` → 面板系统提示「第 N 任已接手」+ 分隔线；不重复渲染简报 |
| A12 | e2e | 隔离 profile + stub 模型：手动 `POST /commander/rotation` 全链路；旧会话 `session-transcript` 可读；新会话首个 turn 的请求里含简报文本（断言请求体） |

> 现有 306 条单测必须保持全绿（基线证据见 `docs/validation/rotation-contract-facts.md`）。

---

## 11. 合入清单（实现前先改这些文档，再动代码）

1. `docs/architecture/implementation-plan.md`：新增 **§5.6 会话轮换**（引用本文件，含状态/触发/提交顺序/错误码）；§5.2 表格加一行 `rotated`（退役→新绑定）；§8 路由表加 `POST /commander/rotation`；§8.4 SSE 表加 `rotation.updated`。
2. `docs/ARCHITECTURE.md`：§3.3 `ConfigRecord.commander` 增 `rotation?`；`SessionLinkRecord.status` 增 `retired` + `generation?/retiredAt?`；§3.2 `sessions` 行备注「退役不删除」。
3. `docs/architecture/implementation-plan.md` §10 工具表：不改（无新工具）。
4. `packages/dsh-commander/src/host/schema.ts` 头注释引用的「字段增删先改 ARCHITECTURE」由第 2 条满足。

---

## 12. 已知限制与 UNVERIFIED

| ID | 内容 | 状态 |
|---|---|---|
| U1 | `create` 后立即 `agents.get(sessionId)` 可取到 live agent | **已证**：`tests/e2e/r1-e2e.mjs` force 换任全链路成功（agent 缺失会 502） |
| U2 | `inject` 在空闲会话的简报会保留到首个 turn 的 pre-step | 语义支持（`dsh-agent/src/runtime-types.ts:263-271`）；集成测试断言注入消息形状，**真实首个 turn 请求体仍待 m23 stub 扩展验证** |
| U3 | `source.kind='commander-handoff'` 在 DSH 聊天中的上下文卡渲染文案 | **待 live 查看**；若未知 kind 不渲染为卡片，退化为「普通上下文」提示，不影响模型可见性 |
| U4 | 旧会话在 DSH 中被用户继续对话 | 允许（普通会话）；其事件不影响新绑定（`subscribeCommanderEvents` 按绑定过滤），但面板不展示；记入文档不额外处理 |
| U5 | 用户原话可能含敏感内容 | 简报落在用户自己的会话日志中，与现有会话同级信任边界；单条 ≤120 字、总量 ≤800 字 |

---

## 13. 实现落点（编码后回填）

| 模块 | 文件 |
|---|---|
| 简报纯函数 | `packages/dsh-commander/src/host/rotation/brief.ts` |
| 配置归一化/到点 | `packages/dsh-commander/src/host/rotation/config.ts` |
| 轮换服务（判定/门控/注入/提交/退避/触发） | `packages/dsh-commander/src/host/rotation/service.ts` |
| 提交点（不 markMissing） | `packages/dsh-commander/src/host/session/binding.ts` `commitRotation()` |
| 上下文消息 `source.generation` | `packages/dsh-commander/src/host/session/deliver.ts` |
| 路由/快照/SSE | `src/host/api/{server.ts,routes/handlers.ts,state.ts,validation.ts,errors.ts}`、`src/host/index.ts` |
| 客户端 | `src/client/{state.ts,store.ts,types.ts,SettingsSection.tsx,locales.ts}` |
| 测试 | `tests/unit/rotation-brief.test.ts`、`tests/integration/rotation.test.ts`、`tests/client/rotation.test.ts` |

## 14. 不修改声明

- 不改 `dispatch` / `commander_task_dispatch` / 确认卡协议 / 看板 M2 / 闭环 M3 的任何行为。
- 不改 `POST /commander/message` 的既有校验顺序（轮换只在 `admit()` 之后、`prompt()` 之前插入，失败不改变响应）。
- 不新增 domain 表、不新增工具、不改 `inject`/`build` 配置；不新增第三方依赖。
- 关闭态（默认）下，本补丁不产生任何可观测行为差异。
