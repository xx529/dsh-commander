# M0 契约补丁（面板消息通道 / 设置接口 schema / 验收执行口径）

> 版本：v1.0　日期：2026-11-17 20:15（Asia/Shanghai）
> 状态：**M0 实现期补丁，M0 范围内以本文件为准**（待 lead 批准后合并回 `implementation-plan.md` §5/§8/§11）。
> 依据：用户已批准 **忽略 V5、降级为每次人工确认，继续 M0 → M1**（2026-11-17 用户决定，lead 转达；`V0-GATE.md` §12 记录的"停在验证阶段"为更早决策，本补丁依据用户最新决定，**不改 V0-GATE 既有裁定**）；冻结决策/判据不变（NEXT-PHASE §2、§7.3 的确认式降级）。
> 边界：只补 `implementation-plan.md` 未定清的三处；不写实现代码、不改 NEXT-PHASE/ARCHITECTURE/PRODUCT-DESIGN、不改 `validation-protocol` 判据。

---

## 0. 本补丁补什么（给 backend/frontend 的一页摘要）

| # | 主题 | 唯一口径 |
|---|---|---|
| 1 | 面板消息通道 | **Host 路由 `POST /commander/message` → `sessionController.prompt`**；Host 订阅指挥官会话 `session/event` 取 user/assistant 文本；SSE 新增 `commander.message` / `commander.status`；快照新增 `messages`(≤200) + `commanderBusy`。**不采用 Client 直连 `ctx.remote.session.prompt`**（理由见 §1.2）。 |
| 2 | 设置写接口 | `PUT /commander/config`、`PUT /commander/workspaces`、`POST /commander/binding` 的字段/默认/错误码；M0 最小字段集见 §2.4；M1+ 字段明确不实现。 |
| 3 | M0-1..M0-4 验收 | 操作步骤/环境/重启风险归属/隔离 profile 替代项/`docs/validation/m0-accept.md` 证据字段（§3）。 |

> 与 `implementation-plan.md` §8 的差异：**新增路由 1 条**（`POST /commander/message`）、**新增 SSE 事件 2 个**（`commander.message`、`commander.status`）、**快照新增 2 字段**（`messages`、`commanderBusy`）。其余沿用 §8.1/§8.5（前缀路由、错误 envelope、`requestId` 幂等）。

---

## 1. 面板消息通道（唯一方案：Host 路由 + Host 订阅 + SSE）

### 1.1 数据流（唯一）

```
面板输入 → POST /commander/message {text, requestId}
  → Host 校验（绑定/长度/幂等）→ sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})
  → Host 写内存消息环（user echo, messageId=requestId）→ SSE commander.message(role:'user')
指挥官会话运行 → Host 的 session/event 订阅收到 assistant/message（文本）
  → 写内存消息环（messageId=asst_<turn>_<seq>，去重）→ SSE commander.message(role:'assistant')
turn/start|turn/end → SSE commander.status {busy}
任意连接/重连 → GET /commander/state（SSE 首帧 snapshot 或 JSON）：messages(≤200) + commanderBusy + 既有快照字段
Client 心跳看门狗：Host 每 15s 发 heartbeat；连续 45s 收不到任何帧即判定流为半开，主动 `stopStream()` + 切 3s 轮询（轮询快照重新对齐 pending/messages；浏览器对半开连接既不报错也不重连，2026-11-18 用户反馈）
```

- 单写者仍是 Host；面板不直接持有会话对象、不直接调 `sessionController`。
- 消息正文**不落 domain**（不新增表；DSH 会话日志是唯一真源）：M0 用 Host 进程内**有界内存环**（≤500 条）供快照/SSE；Host 重启后可从已 live 的指挥官会话事件**尽力回填最近 ≤200 条**（只读 session events；回填失败不影响 M0 验收）。
- 截断/隐私：SSE/快照文本按 §1.6 截断；不打印到日志、不写文件。

### 1.2 为什么不用 Client 侧 `ctx.remote.session.prompt`（评估结论）

| 项 | Client 直连 Remote | **Host 路由（采用）** |
|---|---|---|
| 发送 | 可行（GUI 同款） | 可行 |
| 取回 assistant 回复/follow 历史 | 需要面板自行接 `SessionEventStream`/`useSessionStatus`/客户端 journal，**组件内再实现一套分页/重连/去重**，与看板/注入/任务消息模型并存 | Host 统一订阅会话事件，SSE 推同一模型 |
| 绑定/懒 resume | 绕过 Host 的绑定校验与投递队列（`implementation-plan` §5.4/§5.5） | 复用绑定校验 + `sessionController.prompt`（懒 resume 已验证 V3-C5） |
| 幂等 | 需 Client 自己 mint requestId 并处理重试 | Host 以 `requestId` 做 LRU 幂等（与 §8.5 一致） |
| M3 注入融合 | 注入消息在 Host 生成，面板还要另接一条流 | 同一 SSE 流 + 同一 `messages` 模型 |
| 结论 | 可行但把 3 套会话读取机制拼在一起，M0 复杂度更高 | **唯一实现口径**：消息通道由 Host 拥有 |

> 若未来要改用 Client Remote（例如 M2 看板内嵌会话 UI），**必须同时满足**：面板从 `useSessionStatus`/SessionEventStream 取回 assistant 回复、绑定/懒 resume 由 Host 路由保留、去重键与 `messages` 模型不变——否则视为破坏本契约，需重新评审（不由 frontend 擅自切换）。

### 1.3 `POST /commander/message`

**请求**

```json
{
  "text": "帮我给 HtDot 的订单导出加个开关",
  "requestId": "req_7f3c2a1b-…",
  "clientTs": 1763450000000
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `text` | string | 是 | trim 后长度 1..8192 字符；>8192 → `invalid_request`（**不截断请求**，由面板限制输入） |
| `requestId` | string | 是 | 8..64，字符 `[A-Za-z0-9_-]`；同一 `requestId` 5 分钟内重复返回首次响应（不重复 prompt） |
| `clientTs` | number | 否 | 仅记录展示用，不参与校验 |

**成功响应 `200`**

```json
{
  "ok": true,
  "requestId": "req_7f3c2a1b-…",
  "messageId": "req_7f3c2a1b-…",
  "sessionId": "session-…",
  "accepted": true,
  "queued": false,
  "busy": false,
  "rev": 43
}
```

- `messageId`：用户消息的 id **等于 requestId**（确定性、便于幂等与前端 echo 去重）。
- `queued`：提交时指挥官是否已有进行中的 turn（true=按 `queue` 排队）；`busy`：提交后 Host 视角的 `commanderBusy`。
- `accepted` 来自 `sessionController.prompt` 的返回值；Host 只认 `accepted===true` 为成功。

**错误**（envelope 沿用 §8.5 `{ok:false,code,message}`）

| code | HTTP | 场景 / 前端动作 |
|---|---|---|
| `invalid_request` | 400 | JSON/字段/长度/字符不合法；附 `field` 与约束 |
| `binding_required` | 409 | 尚未绑定指挥官（`commander.sessionId` 空）→ 面板引导到设置页绑定 |
| `binding_broken` | 409 | 绑定会话不存在/`writer-held`/'missing' → 面板显示红条并引导"绑定到新会话" |
| `prompt_failed` | 502 | `sessionController.prompt` 抛错/`accepted!==true`；`message` 带脱敏原因（不含 key/正文） |
| `storage_error` | 500 | 写 config/绑定记录失败（`retryable:true/false`） |
| `internal` | 500 | 未分类；面板展示通用错误 + 重试按钮 |

**Host 处理顺序（固定）**

1. 解析/校验 body（失败 `invalid_request`）。
2. `requestId` 幂等查（5 分钟 LRU）：命中 → 返回首次响应（不再 prompt）。
3. 读 `config.singleton.commander.sessionId`：空 → `binding_required`；`sessions[link].status==='missing'` → `binding_broken`。
4. 计算 `busy`（§1.5），`sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})`。
5. 成功：写内存环（user，`messageId=requestId`，`order=++localOrder`，`at=Date.now()`）→ SSE `commander.message`；返回 §1.3 成功体。
6. 失败：映射 §1.3 错误码，**不写内存环、不发 SSE**（避免面板出现幽灵消息）。

### 1.4 Host 订阅指挥官会话 → assistant 消息

- 订阅：既有 `ctx.on('session/event', (session, event) => …)`（V2 已验证的方式）；仅处理 `session.id === config.commander.sessionId`。
- 采集：`assistant/message` 的 `data.message.content` 中 `type==='text'` block 拼接；**只发这一条**（不发流式 chunk、不发 tool/result、不发中间进度）。
  - v1.1 加法（2026-11-26，原生壳气泡）：Host 额外解析 `tool/call` 的 `arguments.description` 与工具调用之间的 assistant 文本，写入 `commander.status.activity` / 快照 `commanderActivity`；**不产生消息、不落库、不改变上面这条消息通道**。
- 去重键：`messageId = 'asst_' + turn + '_' + seq`（`turn = event.data` 所在 turn；`seq = event.seq`）；内存环按 `messageId` 去重（同一事件重复投递只发一次）。
- 空文本：不产生 `commander.message`（`commander.status` 仍会更新 busy=false）；若需要"本轮无文本"占位由面板用 status 渲染，不在消息流造假消息。
- 顺序：`order = ++localOrder` 由 Host 单调分配；**SSE 事件按 order 发送**；快照 `messages` 按 `order` 升序；面板以 `(rev, order)` 判重/丢弃乱序。
- `turn/start` / `turn/end`：更新 `commanderBusy`（§1.5）并广播 `commander.status`；`turn/end` 不额外生成消息。

### 1.5 `commanderBusy` 与 `commander.status`

- `commanderBusy`：Host 维护的 boolean——收到指挥官会话 `turn/start` → true；收到 `turn/end` → false；启动/重连时以"最后观察到的事件 + 会话是否 live"尽力恢复（无法判定时默认 false，不阻塞 M0）。
- SSE 事件：

```json
// event: commander.status
{ "busy": true, "lastTurnId": 4, "activity": { "text": "查看当前目录", "at": 1763450000123 }, "rev": 44, "at": 1763450000123 }
```

- `lastTurnId`：最近一次 `turn/start.data.turn`，无则 `null`。
- `activity`（v1.1 加法，可省略）：当前回合最近一条可展示动作，`{text, at}` 或 `null`；来源为 `tool/call` 参数的 `description`（无则跳过）或 assistant 文本；`turn/start` / `turn/end` 清空。文本折叠空白、截到 200 字符（补 `...`）。
- `pendingInteraction` **不在 M0 事件中**（审批/提问只在界面层，M3 由 V6 另行渲染；M0 面板只显示 busy）。

### 1.6 快照新增字段（`GET /commander/state`）

在 §8.3 既有字段基础上新增：

```json
{
  "commanderBusy": false,
  "commanderActivity": { "text": "查看当前目录", "at": 1763450000123 },
  "messages": [
    { "messageId": "req_7f3c…", "role": "user", "text": "…", "at": 1763450000000, "order": 41, "truncated": false },
    { "messageId": "asst_4_37", "role": "assistant", "text": "…", "at": 1763450002100, "order": 42, "turnId": 4, "seq": 37, "truncated": true, "fullChars": 12034 }
  ]
}
```

| 字段 | 规则 |
|---|---|
| `messages` | 最近 ≤200 条（按 `order` 升序）；快照永远是"当前内存环尾部 200 条" |
| `commanderActivity` | v1.1 加法字段：当前回合活动 `{text, at}` 或 `null`；与 `commander.status.activity` 同源，用于气泡重连恢复 |
| 消息字段 | `messageId`、`role:'user'\|'assistant'`、`text`、`at`、`order`、`truncated`；assistant 另带 `turnId`/`seq`；被截断时带 `fullChars` |
| 截断 | 文本 >8192 字符：头 6144 + 尾 2048，中间 `\n…[truncated N chars]…\n`，`truncated:true`；请求端不截断（拒绝超长） |
| 保留 | 内存环 ≤500 条；快照只给 200；Host 重启后尽力从 live 会话事件回填 ≤200（回填 best-effort，失败即空，不报错） |

### 1.7 SSE 事件总表（M0 全集 = §8.4 + 本节新增）

| event | data | 触发 |
|---|---|---|
| `snapshot` | 完整快照（含 `messages`/`commanderBusy`/`commanderActivity`） | 连接/重连（沿用） |
| `commander.message` | `{messageId, role, text, at, order, turnId?, seq?, truncated?, fullChars?}` | 用户 echo / 助手文本到达 |
| `commander.status` | `{busy, lastTurnId, activity?, rev, at}` | turn/start、turn/end、工具 description、assistant 文本、绑定后首次恢复 |
| `task.updated` / `tasks.changed` / `dispatch.updated` / `binding.updated` / `capability.applied` / `heartbeat` | 沿用 §8.4 | 沿用 |

- `commander.message` 的 `id:` 沿用 `rev`（= 全局 rev），`data.order` 用于同 rev 内排序；面板丢弃 `rev < lastSnapshotRev` 的事件，再按 `order` 排序。
- 重连仍按 §8.4：直接重拉 `GET /commander/state`，不实现 Last-Event-ID 增量；面板用 `messages` 全量替换本地列表（以 messageId 去重）。

---

## 2. 设置写接口（精确 schema）

### 2.1 通用约定

- 全部 `Content-Type: application/json; charset=utf-8`；成功 `200` 返回 `{ok:true, …, rev}`；失败沿用 §8.5 envelope（`{ok:false, code, message, field?}`）。
- 写操作幂等：body 可带 `requestId`（string 8..64），同一 `requestId` 5 分钟内返回首次结果。
- 写盘：`config`/`workspaces`/`binding` 全部写 `commander` 域（`config.singleton`、`workspaces` 表、`sessions` link），**不新增表**；写后 `rev++` 并广播 `binding.updated`（binding）或 `snapshot` 差异事件（config/workspaces 用 `snapshot` 里的 `workspaces`/`binding` 字段刷新，不新增事件类型）。
- 这些路由**只由界面调用**，不注册为模型工具。

### 2.2 `PUT /commander/config`

**请求（partial，只提交要改的段；未提交段保持不变）**

```json
{
  "requestId": "req_cfg_01",
  "commander": { "model": { "provider": "tokfans", "model": "deepseek-flash", "reasoningEffort": "high" }, "agentPreset": "standard" },
  "jev": { "endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest", "apiKeyEnv": "JEV_API_KEY", "threshold": 0.8, "timeoutMs": 1500 },
  "ui": { "theme": "follow", "entryPosition": "br", "entryEnabled": true, "entryPos": { "x": 0.82, "y": 0.9 } }
}
```

| 段.字段 | 类型 | 默认 | 校验（失败 → `invalid_request` + `field`） |
|---|---|---|---|
| `commander.model.provider` | string | 当前绑定会话模型（无则 DSH 默认） | 1..64 |
| `commander.model.model` | string | 同上 | 1..128 |
| `commander.model.reasoningEffort` | string? | 不传=不指定 | 0..32 |
| `commander.agentPreset` | string? | 不传=DSH 默认 | 0..64；若给了不存在的 preset → `preset_unknown`（Host 用 sessionController.create/selectModel 的错误映射） |
| `jev.endpoint` | string | `https://api.typesafe.ai/v1/systemone` | `^https?://` 且 ≤512 |
| `jev.model` | string | `jev-latest` | 1..64 |
| `jev.apiKeyEnv` | string | `JEV_API_KEY` | `^[A-Z][A-Z0-9_]{1,63}$`（**M0 只支持环境变量来源；不接收明文 key**） |
| `jev.threshold` | number | 0.8 | 0.5..0.99（M0 仅存储/展示；V5 FAIL 后 autoDispatch=false，**不用于放行**） |
| `jev.timeoutMs` | integer | 1500 | 500..30000 |
| `ui.theme` | enum | `follow` | `follow\|light\|dark` |
| `ui.entryPosition` | enum | `br` | `br\|bl`（旧版角落入口；无 `entryPos` 时作为默认落点） |
| `ui.entryEnabled` | boolean? | `true` | 布尔；浮窗是否显示（2026-11-18 加，旧配置缺省视为开启） |
| `ui.entryPos` | object?/null | 无（走默认角落） | `{x,y}` 均为 0..1 的视口归一化中心点；`null` = 清除自由位置 |

**响应 `200`**

```json
{ "ok": true, "config": { "commander": {…}, "jev": {…}, "ui": {…}, "updatedAt": 1763450000000 }, "rev": 45 }
```

- 返回的是**可展示视图**：不含 Jev Key 明文（只有 `apiKeyEnv`），`commander.sessionId/workspaceId/workspacePath` 属绑定，由 §2.4 的 binding 路由维护，本接口**只读回显、拒绝修改**（尝试修改 → `invalid_request`，`field:"commander.sessionId"`）。
- 未知字段/未知段 → `invalid_request`（严格，防前端 typo 静默丢配置）。

### 2.3 `PUT /commander/workspaces`

**请求（数组整体替换）**

```json
{
  "requestId": "req_ws_01",
  "workspaces": [
    { "id": "htdot-project", "allowed": true, "summary": "电商后台：订单、结算、导出链路", "policy": "inherit" },
    { "id": "dsh-capability-settings", "allowed": true, "summary": "", "policy": "auto" }
  ]
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `workspaces` | array | ≤100 项；`id` 唯一 |
| `id` | string | 1..128；**必须在 DSH 工作区注册表中存在**，否则 `unknown_workspace` |
| `allowed` | boolean | 必填 |
| `summary` | string | ≤500 字符；默认 `""`（空=未配置摘要，确认卡提示"未配置摘要"） |
| `policy` | enum | `inherit\|auto`，默认 `inherit`（M0 仅存储；auto 的行为 M1 才执行） |

**响应 `200`**

```json
{ "ok": true, "workspaces": [ { "id": "…", "name": "…", "path": "…", "allowed": true, "summary": "…", "policy": "inherit" } ], "rev": 46 }
```

- 语义：**整体替换**白名单/摘要/策略；未出现的已存工作区记录被删除（回到"未配置"默认：allowed=false、summary=""、policy=inherit）。前端保存前应提交完整列表。
- `GET /commander/state` 的 `workspaces` = 注册表全部工作区 × 已存配置（未存 → 默认值），按 `name` 升序；`lastSelection` 只读（M1 写入）。
- M0 不校验"至少 1 个 allowed"（M1 派发前才提示"无可用工作区"）。

### 2.4 `POST /commander/binding`

**请求（oneOf 两支）**

```json
// A. 绑定到新会话
{ "mode": "new", "workspaceId": "htdot-project", "agentPreset": "standard", "requestId": "req_bind_01" }

// B. 绑定到已有会话
{ "mode": "select", "workspaceId": "htdot-project", "sessionId": "session-…", "requestId": "req_bind_02" }
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `mode` | enum | `new`\|`select`（必填） |
| `workspaceId` 或 `cwd` | string | `new` 时必须二选一（都传 → `invalid_request`；都不传 → `invalid_request`）；`cwd` 为绝对路径且 ≤1024 |
| `sessionId` | string | `select` 时必填；1..128；会话必须存在 |
| `agentPreset` | string? | 仅 `new`；不存在 → `preset_unknown` |
| `requestId` | string? | 幂等用 |

**Host 行为（固定）**

1. `new`：`sessionController.create({ workspaceId | cwd, agentPreset })` → `sessionId`；若 `config.commander.model` 有值 → `selectModel`；写 `config.singleton.commander = {workspaceId, workspacePath, sessionId, model, agentPreset}`；写 `sessions` link `{role:'commander', mode:'new', status:'idle', taskId:''}`。
2. `select`：只读校验会话存在（`sessionQuery`/列表）且其 cwd 属于该 workspace（若给了 `workspaceId`）→ 写 config 同上（不 create、不 selectModel、不删除旧会话）。
3. 旧 commander link 标 `missing`（有界保留）；**不删除旧会话**。

**响应 `200`**

```json
{ "ok": true, "binding": { "workspaceId": "…", "workspacePath": "/abs", "sessionId": "session-…", "model": {"provider":"…","model":"…"}, "agentPreset": "standard" }, "commanderStatus": "bound", "rev": 47 }
```

| 错误码 | 场景 |
|---|---|
| `invalid_request` | mode 非法 / workspaceId+cwd 同传 / 缺 sessionId / 字段非法 |
| `not_found` | workspaceId 不存在 / select 的 session 不存在 |
| `workspace_conflict` | select 的会话 cwd 不属于指定 workspace |
| `preset_unknown` | agentPreset 不存在（映射 `Unknown agent preset`） |
| `create_failed` | `sessionController.create` 抛错（`message` 脱敏） |
| `storage_error` | 域写失败（`retryable`） |
| `internal` | 未分类 |

### 2.5 M0 最小设置字段集（前端只做这些）

| 分组（PRODUCT-DESIGN §10） | M0 字段 | 说明 |
|---|---|---|
| 指挥官 | `commander.model.{provider,model,reasoningEffort}`、`commander.agentPreset`、绑定状态（只读）+ 绑定/重绑按钮 | 能力面板入口只做跳转占位（不实现面板内配置） |
| 工作区 | `workspaces[].{id,allowed,summary,policy}` | 列表来自 `state.workspaces`；摘要可编辑；policy 两档可保存（M1 才执行 auto） |
| 派发与 Jev | `jev.{endpoint,model,apiKeyEnv,threshold,timeoutMs}` | **M0 不接收明文 key**（只用 env）；不做"测试连接"（M1）；autoDispatch 只在界面显示"当前为确认式派发"，无开关 |
| 外观与通知 | `ui.{theme,entryPosition,entryEnabled,entryPos}` | `entryPosition` 为旧版角落预设；浮窗可自由拖动，`entryEnabled` 控制显示（默认开）；hotkey/通知/静音 M2+ |
| 看板 / 关于 / 播报 | **不实现** | M2/M3 |

**M1+ 才用、M0 明确不实现**：`jev.apiKeySource`/手动 credential、`jev.onTimeout`、`board.*`、`ui.hotkey`、通知/静音、`capabilityPolicy.lastSelection` 的写入与展示（M0 只读空值）、`GET /commander/tasks/:id`、`/commander/jev/test`、看板/验收相关全部路由与字段。

---

## 3. M0-1..M0-4 验收执行口径

### 3.0 前置（devops 执行，用户在场）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm install && pnpm --filter dsh-commander build
dsh plugin --profile desktop add ./packages/dsh-commander   # 或由有权限的 agent 用 plugin_manager install_bundle
dsh --profile desktop --dump-config | grep -A3 commander    # 确认 layer 存在
```

> 安装/替换插件后**需要重启 DSH 才能加载新 Host JS**（HMR 只对新装 bundle / client 重建生效；替换已装包必须重启）。

### 3.1 重启风险（必须写进交付说明）

- **DSH 重启会中断本会话所在的 agent 进程**：本验收会话本身跑在该 DSH 里，重启=当前 agent 被终止。
- 因此 M0-1 的"重启 DSH → 刷新页面"与 M0-3 的"重启后验证"由**用户/下一步操作者**在安全时点执行；agent 侧只准备安装、命令与证据模板，**不得自行重启**。
- 重启前须：① 保存当前任务状态与证据；② 确认安装命令已成功；③ 记录 `--dump-config` 片段。
- 若重启后验收失败，恢复路径：`dsh plugin --profile desktop remove dsh-commander` → 刷新；任务记录/绑定存于 `commander` 域，删除插件不清空（见 §5 存储）。

### 3.2 各项操作步骤与判据

| 项 | 环境 | 步骤（操作者） | 通过判据 | 替代/隔离方案 |
|---|---|---|---|---|
| **M0-1** 安装插件、刷新 DSH，球出现 | live desktop profile | 构建/安装（§3.0，agent 可做）→ **用户重启 DSH** → 刷新页面 → 打开任意会话 | `shell.overlay` 出现 56px 球 + 点击展开 420×660 空面板；`GET /commander/health` 返回 `ok:true, panel:'present'`；浏览器控制台无 `slot entry crashed` | 无（球是 Client 视觉，只能在 live 页面验证）；隔离 profile 可先验证 Host 路由/SSE 可达（`/commander/health` 200）但不能替代"球出现" |
| **M0-2** 能打开面板并发一条消息，指挥官正常回复 | live desktop profile | 点球 → 输入"只回一句：m0-ok"→ 发送 | `POST /commander/message` 返回 `accepted:true`；SSE 收到 `commander.message(role:'user')` 和至少 1 条 `commander.message(role:'assistant')`（文本含"m0-ok"）；`commander.status busy` 先 true 后 false；快照 `messages` 含这两条（`messageId`/`order` 正确） | 隔离 profile 可替代验证"发送→会话收到→assistant 事件→SSE"链路（无球，用 curl + SSE 客户端）；live 页面只补视觉/交互 |
| **M0-3** 重启 DSH 后绑定不丢 | live desktop profile（主）/隔离 profile（先行） | 记录重启前 `GET /commander/state` 的 `binding`（workspaceId/sessionId/model）→ **用户重启 DSH** → 刷新 → 再取快照 | 重启前后 `binding.sessionId` 完全相同、`commanderStatus:'bound'`；再发一条消息仍 `accepted:true`（懒 resume 成功） | **隔离 profile 可先验证持久化**：同 `DSH_HOME` 重启探针 Host → 快照 binding 不变（Host 侧证据）；live 重启仍需用户执行 |
| **M0-4** 面板不存在时插件仍能启动（inherit 降级） | **隔离 profile（唯一可靠方式）** | 隔离探针 profile 不加载 `dsh-capability-settings`，只装 commander | Host 正常启动；`GET /commander/health` 返回 `panel:'absent'`；无 `inject` 失败；日常对话/消息通道可用；绑定/设置接口可用 | live desktop **不要**为了验收禁用能力面板（会破坏用户环境）；只接受隔离 profile 证据 + 代码层 `ctx.get('capabilityPanel')` 为 undefined 的分支测试 |

### 3.3 证据格式：`docs/validation/m0-accept.md`

```md
# M0 验收记录
- 结论：PASS | FAIL | PARTIAL
- 操作者 / 时间：
- 环境：DSH 版本、profile=desktop、插件版本/构建 sha、页面 URL
- 安装证据：build 日志路径、`dsh plugin add` 输出、`--dump-config` 片段路径
- 重启信息：执行人（用户/下一步）、重启时刻、重启前保存的证据路径
## M0-1
- 结果：PASS/FAIL
- 步骤（可重放命令/点击序列）：
- 证据：截图路径（球+面板）、`/commander/health` JSON、控制台无报错截图
- 限制：
## M0-2
- 结果：PASS/FAIL
- 请求/响应原文（`POST /commander/message` 的 HTTP 状态+JSON）
- SSE 事件序列（`commander.message`*2 + `commander.status`*2，含 messageId/order/turnId/seq）
- 快照 messages 摘录（脱敏、≤10 条）
- 限制：
## M0-3
- 结果：PASS/FAIL
- 重启前快照 binding JSON（路径/sha）
- 重启后快照 binding JSON（路径/sha）
- 重启后再发消息的响应（accepted/sessionId）
- 隔离 profile 先行验证（命令+输出）或说明为何未做
## M0-4
- 结果：PASS/FAIL
- 隔离 profile 启动命令/日志、`/commander/health` JSON（panel:'absent'）
- 代码分支证据（`ctx.get('capabilityPanel')===undefined` 时日志）
## 独立复跑
- tester 复跑命令与结果（或 UNVERIFIED + 原因）
## 未闭合/风险
- 例如：live 重启由用户执行、球在 1280px 下的位置、SSE 重连体验
```

- 每项必须给**可重放命令或精确点击序列**；截图/JSON 放 `docs/validation/m0-artifacts/`（目录新建时由执行人创建；不覆盖既有证据）。
- 失败即记录 `code`/`message` 与复现步骤，不修文档凑 PASS；M0 任一项 FAIL → 停在 M0，lead 决定修复或回退。

### 3.4 M0 验收与 V0 门禁的关系（必须随证据说明）

- V5 已 FAIL、用户已批准**降级为每次人工确认**继续 M0 → M1；M0 验收**不重新判定 V5**、不构成 V5 PASS。
- M0/M1 的 `commander_task_dispatch` 全链路按确认式（`autoDispatch=false`）实现；证据里不得出现"自动派发成功"作为 M0 验收项（那属 V5 门禁）。

---

## 4. 与既有契约的差异 / 待合并

| 位置 | 现状 | 本补丁 |
|---|---|---|
| `implementation-plan.md` §8.2 路由表 | 无消息路由 | **新增 M0 `POST /commander/message`** |
| §8.4 SSE 事件表 | 无 commander 消息/状态事件 | **新增 `commander.message`、`commander.status`** |
| §8.3 快照 | 无消息/忙状态 | **新增 `messages`(≤200)、`commanderBusy`** |
| §8.5 错误码 | `invalid_request/not_found/conflict/…` | **新增 `binding_required`、`binding_broken`、`prompt_failed`、`workspace_conflict`、`preset_unknown`、`create_failed`**（其余沿用） |
| 消息持久化 | 未定义 | M0 内存环（≤500/快照 200），不落 domain；会话日志仍是真源 |

> 合并方式：lead 批准后由 architect 把上述差异并入 `implementation-plan.md` §8（本补丁在合并前即 M0 实现口径）。

---

## 5. storage 与隐私边界（重申）

- 消息正文：**不写 domain、不落文件、不打日志**（仅进程内环 + SSE）；DSH 会话日志是唯一真源。
- `PUT /commander/config` 不接收明文 Jev Key（仅 `apiKeyEnv`）；Key 由 env/credential 提供（M1 手动 key 来源另定）。
- 快照/SSE 不含任务正文之外的隐私（workspace path 可含本机路径，属 M0 可接受；如需脱敏留 M2）。
- 内存环在插件重载/DSH 重启后清空（可 best-effort 从 live 会话回填）；面板刷新（不重启 Host）不受影响。

---

## 6. 不修改声明

- 本补丁不改 NEXT-PHASE §2 十条、不改 ARCHITECTURE/PRODUCT-DESIGN、不改 `validation-protocol` 判据、不写实现代码。
- 本补丁为 M0 范围契约；M1+ 路由/字段不在此实现（见 §2.5）。

---

## 7. 实现对齐补记（二轮复核 Lead 批准项 C2/C3/C4）

> Lead 2026-11-17 批准：将二轮复核发现的实现事实同步进契约（不改实现行为、不加新概念）。

| # | 项 | 实际实现（已对齐） |
|---|---|---|
| **C2** | `GET /commander/config`（§2 未列的加法只读路由） | **保留**：只读可展示配置视图（Client 设置页启动探测；无 Jev Key 明文、不写盘）；已并入 `implementation-plan §8.2` 路由表，标注"加法只读" |
| **C2** | `GET /commander/health.binding` 枚举 | **增加 `'broken'`**（绑定会话不可恢复；`unbound/bound/broken`）；已并入 `implementation-plan §8.2` |
| **C3** | `dsh.client.inject` 集合 | **实际 = `@deepseek-ai/dsh-client-ui-layout` + `@deepseek-ai/dsh-client-ui-settings`**（无 `dsh-api-remotes`；H3 唯一通道裁定后 client 不再依赖 Remote）；与 `implementation-plan §2.1` 一致 |
| **C4** | Host `inject` 集合 | **实际 = `['storageDomain','webServer']`**（唯一强依赖；`sessionController/sessions/workspaceRegistry/capabilityPanel` 全部 `ctx.get` 软解析、缺失降级不阻塞）；`implementation-plan §3.1` 已改为该口径 |
| **H3 边界** | Client 的只读快照轮询 | client 保留"SSE 不可用/关闭时每 3s 只读 `GET /commander/state`"作为**快照降级**（不是消息通道）：**不得发送消息、不得直连 `ctx.remote.session.prompt`**（bundle 内 `session.prompt/getRemote`=0 已由 tester 复核）；消息唯一通道仍是 `POST /commander/message` |

> 本补记不改变 M0 契约行为；二轮复核结论见 `docs/architecture/m0-review.md` §7。

