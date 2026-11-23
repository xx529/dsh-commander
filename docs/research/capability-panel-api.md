# capabilityPanel API 契约（dsh-capability-settings v1.19.3 源码级）

> 取证角色：scout。取证对象：`~/.dsh/profiles/desktop/node_modules/dsh-capability-settings@1.19.3`（GitHub `xx529/dsh-capability-settings#v1.19.3`），运行安装 DSH Desktop `0.2.2-rc.3`、探针 CLI `0.2.2-rc.2`。
> 代码路径缩写：`P` = `~/.dsh/profiles/desktop/node_modules/dsh-capability-settings`。
> 标注：**【Fact】**= 源码/实测直接可证；**【Inference】**= 推断；**【Unverified】**= 未实测。
> 运行态证据：`docs/research/probes/evidence/plugin-boot.json`、`evidence/v3.json`。

---

## 0. 五条最要命的结论（先看这个）

1. **`ctx.get("capabilityPanel")` 返回的是工厂函数，不是 service 对象。**
   插件用 `ctx.provide("capabilityPanel", () => service)` 注册（`P/lib/index.js:439`），Cordis 的 `provide` 原样存值（`A/cordis/src/reflect.ts:291-326`）。取用必须：
   ```js
   const panel = ctx.get('capabilityPanel')()   // ← 注意调用
   panel.jev.rank(...) / panel.jev.apply(...)
   ```
   实测：`typeof ctx.get('capabilityPanel') === 'function'`（`plugin-boot.json.services.capabilityPanelRaw`），调用后 `keys = [jev,mcp,mcpTools,overrides,prompt,session,skills,tools]`。**`inject: ['capabilityPanel']` 注入到的也是这个函数**（Cordis 不做解包）。
2. **`rank` 需要 Jev key；`apply` 不需要。** `rank` 无 key → `{ok:false, code:"no-config"}`（不发网络请求，`P/lib/jev/manager.js:144-148`）。`apply` 全程只做本地枚举 + 会话开关写入（实测可落盘）。
3. **`apply` 写失败时返回的 `ok` 仍是 `true`**，失败信息在 `failed[]`/`errors`（`P/lib/jev/apply.js:1077-1097`）。**判据必须是"`failed` 不存在/为空"，不是 `ok===true`**。
4. **阈值/自动触发是客户端概念**：`decisionThreshold`（live=0.7）、`autoTrigger` 只在 `P/lib/client.js` 使用（`client.js:1403,9389-9390`）；**宿主 `rank` 只排序、不按阈值过滤**。
5. **24k 预算不属于能力面板**：面板用的是 `REQUEST_SOFT_LIMIT_CHARS = 150_000` 字符（`P/lib/jev/rank.js:53`）+ 按能力二分分片/4 档降级（`:265-313`）；`24k` 是本项目自己 Jev 派发评估的 token 预算（`docs/eval/jev-dispatch-eval.md:71`）。两个 Jev 不要混。

---

## 1. 服务注册与形状

| 项 | 内容 | 证据 |
|---|---|---|
| 插件名 | `capability-panel`（`name` 导出） | `P/lib/index.js:49` |
| `inject` | 仅 `['skills']`（强依赖）；`connection`/`webServer`/`agents`/`tools` 均为惰性 `ctx.get`，缺失即降级 | `P/lib/index.js:51`；`apply` 内 `ctx.get?.("tools")`（`:318`）、`agents`（`apply.js:70-78`） |
| 注册语句 | `ctx.provide("capabilityPanel", () => service)` | `P/lib/index.js:439` |
| 打包入口 | `main: lib/index.js`；`dsh.bundle.patch: ./cordis.patch.yml` 插入 `- id: capability-panel / name: 'dsh-capability-settings'` | `P/package.json`；`P/cordis.patch.yml:8-10` |
| service 对象 | `{ skills, mcp, overrides, prompt, jev, tools, session, mcpTools }` | `P/lib/index.js:349-436`（对象字面量），实测键一致 |
| `jev` 管理器 | `{ getConfig, setConfig, test, rank, apply, dispose }` | `P/lib/jev/manager.js:221`；实测 `jevKeys` 一致 |
| RPC 通道 | `config.mountRpc !== false` 且宿主有 `connection` 时挂 `/capability-panel`（GUI 用）；**rank/apply 不依赖它** | `P/lib/index.js:489-493`；`P/lib/remote.js` |
| 面板配置项（patch config） | `dshHome`、`agentsHome`、`mountMcp`（默认 true）、`mountRpc`（默认 true）、`enableAutoAttribution` | `P/lib/index.js:58-147,489` |

`service.jev.*` 的底层实现全部在 `createJevManager`（`P/lib/jev/manager.js:47-222`），枚举/事务/排队在 `createJevApplyEngine`（`P/lib/jev/apply.js:707-1137`）。

---

## 2. `jev.rank({ sessionId, draft, cwd })` 契约

### 2.1 签名与入参校验

```
rank(input, signal?) -> Promise<RankResult>
input = { sessionId: string(必填), draft: string(必填), cwd?: string }
```
校验（`manager.js:28-41`）：

| 条件 | 结果 |
|---|---|
| `sessionId` 非字符串/空 | `{ok:false, code:"bad-request", errors:["sessionId is required"]}` |
| `draft` 非字符串/trim 后空 | `{ok:false, code:"bad-request", errors:["draft is empty"]}` |
| `draft` 码点数 > 8000 | `{ok:false, code:"bad-request", errors:["draft exceeds 8000 characters"]}` |
| `cwd` | 仅当非空字符串才透传；缺省 = 由枚举按工作区/默认口径处理 |

实测：`rank({sessionId:'', draft:''})` → `{ok:false, code:"bad-request", errors:["sessionId is required"]}`。

### 2.2 执行流程（`manager.js:137-214`）

1. `loadContext()`：每次重新读 `$DSH_HOME/dsh-capability-settings/jev.json`（不缓存）+ `resolveJevKey(config, process.env)`；
2. key 缺失 → `no-config`（**不发请求**）；
3. `engine.enumerate({cwd, sessionId, live: engine.isSessionLive(sessionId)})`（`apply.js:750-759` → `enumerateCapabilities` `apply.js:135-350`）；
4. 枚举为空 → `{ok:false, code:"empty-capabilities", errors:["no capabilities in this session"]}`；
5. 枚举 > `MAX_RANK_CAPABILITIES = 300`（`manager.js:43`）→ `bad-request too many capabilities`；
6. `buildSystemOneRequests(config, capabilities, draft)`（`rank.js:295-313`）：先按能力二分分片，单片仍超软上限再走 4 档降级（24→8 名额→只留带描述的 8 条→只留 8 个名称→不带工具）；**对外仍是一次 rank**；
7. 串行 POST `${baseURL}/v1/systemone`（`systemOneURL`，`rank.js:126-129`；`postSystemOne` `:541-588`）：`Authorization: Bearer <key>`，`timeoutMs` 超时，**仅 429/529 重试，最多 2 次，退避 500ms/1000ms**（`RETRY_DELAYS_MS` `:107`）；
8. 三维判据：每题 `~role` / `~task` / `~operation` 三个 `noul` 概率 → **取 max**（`parseRankScore` `rank.js:387-392`）；全缺失记 `score:0, reason:"no-answer"`；
9. `items.sort(compareRankItems)`（`rank.js:446-455`：score 降序 → skill→mcp→tool → name → id）；
10. 顺带消费一次 `consumePendingOutcome(sessionId)`（把上一次排队 apply 的结果附在 `pendingOutcome`）。

### 2.3 成功返回（实测字段全等）

```ts
{
  ok: true,
  items: RankItem[],          // 全量、已排序、未按阈值过滤
  model: string,              // 响应里的 model，缺省回退配置
  usage: { input_tokens: number, output_tokens: number },
  elapsedMs: number,
  requestCount: 1,            // 逻辑批量数恒为 1（物理分片不进契约）
  capabilitiesTotal: number,
  pendingOutcome?: { applied: number, failed: number, errors: string[], at: number }
}

RankItem = {
  id: string,                 // "cap_" + 36 位小写 hex（capabilityId(namespaceKey)，rank.js:116-120）
  kind: "skill" | "mcp" | "tool",
  name: string,
  description: string,
  score: number,              // 0..1（∈ [0,1] clamp）
  applicable: boolean,        // false 时带 reason
  enabledInSession: boolean,
  source: string,
  reason?: string,            // no-answer / 不可切换原因（hard-disabled 等，见 enumerateCapabilities）
  origin?, channel?, provider?, contentReadOnly?, hostInjected?, toolCount?   // additive
}
```

### 2.4 失败返回（统一信封）

```ts
{ ok: false, code: RankErrorCode, errors: string[] }
```
`code` 全集（`manager.js:24-27` + `rank.js:473-487` + `:136`）：`bad-request`、`no-config`、`empty-capabilities`、`network`、`timeout`、`auth`、`rate-limit`、`overloaded`、`context-too-long`。错误文本统一 `redact()` 脱敏（key/secret 不会回传）。

> 实测：无 key 时 `{ok:false, code:"no-config", errors:["Jev API key is not configured"]}`（`plugin-boot.json.panel.rank`）。

### 2.5 `draft` / `cwd` / `sessionId` 语义

- `draft`：用户输入框当前草稿，仅用于本次评分、**不落盘**；请求体只含草稿 + 能力名/描述（截断 200/120 码点，`rank.js:30-34`）。**【Fact】**
- `cwd`：能力枚举的项目上下文（项目级 `.mcp.json`、项目 skills、项目 overrides、项目默认三态都按 cwd 算）。缺省时枚举按工作区基线。**【Fact】**（`enumerateCapabilities` doc `apply.js:124-134`）
- `sessionId`：① 用来判 live（`isSessionLive` = `agents.list()` 里是否有 `agent.id === sessionId`，`apply.js:70-78`）；② 用来给 skills 域算"会话级覆盖"（`enumerate` 传入 `live`）；③ **不要求会话真实存在**——不存在的 id 会被当冷会话（`isSessionLive` 返回 false），`enumerate` 仍可返回工作区基线能力。**【Fact】**（代码路径）+ 实测：冷 id `probe-cold-session-0001` 下 `apply` 正常返回 `pending:true`。

---

## 3. `jev.apply({ sessionId, plan, cwd })` 契约

### 3.1 签名与入参校验（`apply.js:994-1042`）

```
apply(input) -> Promise<ApplyResult>
input = { sessionId: string(必填), plan: PlanItem[], cwd?: string }
PlanItem = { id: string /* cap_… */, enabled: true }   // enabled 必须严格 true，否则记 skipped("unknown-id")
```
- `plan` **必须是数组**，长度 ≤ `MAX_APPLY_PLAN_ITEMS = 500`（`apply.js:39,1007-1009`）；实测 `plan:"nope"` → `{ok:false, code:"bad-request", errors:["plan must be an array (<=500)"]}`；
- **空数组合法**：语义是"目标集合为空"= 关闭当前会话全部可应用能力（`apply.js:985-987,1006`）；
- 含非法/未知 id → 进 `skipped[{id, reason:"unknown-id"}]`，不报错。

### 3.2 语义：筛选而不是增量（关键）

`plan` 是"已勾选集合"，即**目标真值**：枚举出当前会话打分的所有能力后，`applicable` 项里「被选中 → 目标启用」「未选中 → 目标关闭」，**只写当前状态 ≠ 目标状态的项**（`planTargetOps` `apply.js:681-699`；`:1041-1042`）；不可应用项一律不动。冷会话下 `not-toggleable` 被豁免（`apply.js:1033-1037`，§7.3 冷会话例外）。

### 3.3 live 路径（有 agent）

1. 两阶段：**先 enable 全批，再 disable 全批**（`sortPlannedOps` `:662-679`）；
2. skills：同 tick 全量发起 + `Promise.allSettled`（注册表 effect 合并）；MCP/Tools 各并发 4（`MCP_WRITE_CONCURRENCY`/`TOOLS_WRITE_CONCURRENCY` `:53,60`）；
3. 任一失败 → 按**相反顺序**批量回滚已写项（`rollback` `:620-661`），`rollbackFailed` 时 reason 变 `"write-failed（回滚部分失败）"`；
4. 写入耗时 > `SLOW_APPLY_WARN_MS = 800ms` 才 `logger.warn`（`:46,1071-1076`）。

**成功返回**（`apply.js:1100-1111`）：
```ts
{ ok:true, applied:number, enabled:number, disabled:number,
  skipped:{id,reason}[], pending:false, elapsedMs:number, pendingOutcome?:{...} }
```
**写失败返回**（`apply.js:1077-1097`）：
```ts
{ ok:true, applied:0, enabled:0, disabled:0, skipped:[…], pending:false,
  failed:[{ id, reason:"write-failed" | "write-failed（回滚部分失败）" }], errors:string[] }
```
→ **`ok` 仍为 true**，必须看 `failed`。

实测（`evidence/v3.json`，对 `sessionController.create` 出来的真实 live 会话）：
`apply({sessionId, plan:[]})` → `{ok:true, applied:1, enabled:0, disabled:1, skipped:[], pending:false, elapsedMs:17}`；
再次 apply → `applied:0, skipped:[{id:"cap_7505ed…", reason:"already-applied"}]`（幂等）。

### 3.4 冷会话路径（无 live agent）

**判活**：`isSessionLive = agents.list() 存在 agent.id === sessionId`（`apply.js:70-78`，每次现算不缓存）；`agents` 服务缺失时按冷会话处理（降级）。

**只排队不写**（`apply.js:1043-1062`）：
1. 把「全部 `applicable` 能力」的完整目标集合（**含 desired=false 的关闭**）存进内存 `Map<sessionId, PendingPlan>`（`queuePendingPlan` `:743-746`）；
2. 同会话后者替换前者；`PENDING_TTL_MS = 30min`（`:33`），每次读写时 prune（`:719-725`）；
3. 返回：
```ts
{ ok:true, applied:0, enabled:0, disabled:0, skipped:[…], pending:true, elapsedMs, pendingOutcome?:{...} }
```

**重放时序**（`apply.js:946-964`）：
```
agent/created(sessionId) 事件
  └─ pendingPlans 命中的 plan 先取走（防重复）
     └─ setTimeout(0)：让同一事件的其它监听（mcp/loader.mountAgent 等）先登记
        └─ applyPending(plan)
           ├─ resolvePlanned：**重新枚举**（live:true），逐 id 复核 applicable / 已一致 → skipped
           │   └─ 技能 not-toggleable 视为"服务未就绪" → sleep 100ms / 300ms 后重枚举（READY_RETRY_DELAYS_MS）
           ├─ applyPlannedOps（逐条 + 就绪短重试 writeOneWithReadyRetry）
           └─ recordOutcome(sessionId, {applied, failed, errors, at})
```
- 结果回执 `pendingOutcomes`：**有界 32 条**（`PENDING_OUTCOME_LIMIT` `:35`），插入顺序淘汰最旧；`consumePendingOutcome` 读取即消费，并作为下一次 `rank`/`apply` 返回的 `pendingOutcome` 字段出现。
- `agent/disposed` → 清该 session 的排队计划与回执（`:965-972`）；`dispose()` 清所有监听与内存表（`:1113-1128`）。

**冷会话前置条件汇总**：
- 会话**不必存在**、**不必处于 turn 内**、**不依赖 client**（纯 Host）；**【Fact】**
- 但真的"写"必须等到该 `sessionId` 有 live agent（`agent/created`）；否则永远停在排队（TTL 30 分钟）；**【Fact】**
- `sessionController.create({cwd})` 会**立即建出 agent**（实测 `agents.list()` = 该 sessionId），所以"create 之后马上 apply"走的是 **live** 路径，不是冷路径。**要验冷路径必须构造「apply 先于 create/agent」的顺序**。**【Fact】**

### 3.5 失败模式清单

| 场景 | 表现 | 证据 |
|---|---|---|
| 面板插件未安装/未启用 | `ctx.get('capabilityPanel') === undefined`；调用方应回退 inherit | 实测对照实验：stock `web` profile 不加 patch → `[scout-probe] capabilityPanel=absent` |
| rank 无 key | `{ok:false, code:"no-config"}`（不发网络） | 实测 `plugin-boot.json.panel.rank` |
| rank 会话无能力 | `{ok:false, code:"empty-capabilities"}` | `manager.js:157-160` |
| rank 能力 > 300 | `{ok:false, code:"bad-request", "too many capabilities"}` | `manager.js:161-168` |
| rank 网络/鉴权/限流 | `network` / `auth` / `rate-limit` / `overloaded` / `timeout` / `context-too-long` | `rank.js:473-487`；`fetchOnce` `:493-534` |
| apply 写失败 | **`ok:true`** + `failed[]` + `errors[]`，已写项已回滚 | `apply.js:1077-1097` |
| apply 参数非法 | `{ok:false, code:"bad-request"}` | `apply.js:1001-1009`；实测 |
| 面板已 dispose | `{ok:false, code:"write-failed", errors:["jev manager disposed"]}` | `apply.js:995-996` |
| 枚举期 service 缺失 | 抛 `capability-panel service unavailable` → rank 收成 `network`，apply 收成 `write-failed` | `apply.js:136-138`；`manager.js:153-156`；`apply.js:1017-1019` |
| enable/disable 回滚 | 逆序恢复前态；`rollbackFailed` 标记 | `apply.js:620-661,1077-1097` |

---

## 4. 配置键（`$DSH_HOME/dsh-capability-settings/jev.json`）

默认值（`P/lib/jev/types.js:defaultJevConfig()`）：

| 键 | 默认 | 本机 live 值 | 宿主消费点 |
|---|---|---|---|
| `baseURL` | `https://api.typesafe.ai` | 同 | `systemOneURL`（`rank.js:126-129`），最大 2048 字符 |
| `model` | `jev-latest` | 同 | 请求体 `model`，最大 128 |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 同 | `resolveJevKey`（`config-file.js:453-466`）：**env（该变量名）优先，其次文件 `apiKey`** |
| `apiKey`（可选） | 无 | **无**（本机只存 env 名） | 同上；最大 512 字符 |
| `autoTrigger` | `{enabled:false, pauseMs:1000, minChars:10, minEditChars:4}` | `enabled:true`（其余同） | **仅客户端**（`client.js`），宿主不用 |
| `decisionThreshold` | `0.5` | `0.7` | **仅客户端**（`client.js:1403`），宿主 rank 不过滤 |
| `timeoutMs` | `30000` | 同 | 单次 HTTP 超时（`fetchOnce`） |

其他固定常量（不可配）：`MAX_RANK_CAPABILITIES=300`、`MAX_APPLY_PLAN_ITEMS=500`、`REQUEST_SOFT_LIMIT_CHARS=150000`、`PENDING_TTL_MS=30min`、`PENDING_OUTCOME_LIMIT=32`、`MAX_RETRIES=2(429/529)`、`SLOW_APPLY_WARN_MS=800`、`MCP_WRITE_CONCURRENCY=4`、`TOOLS_WRITE_CONCURRENCY=4`、`READY_RETRY_DELAYS_MS=[100,300]`。

`GET`/`SET` 配置 API：`panel.jev.getConfig()` 返回**无明文 key** 的视图（`{baseURL, model, apiKeyEnv, hasApiKey, apiKeySource:"env"|"file"|"none", apiKeyLast4, autoTrigger, decisionThreshold, timeoutMs}`，`config-file.js:481-500`）；`setConfig(input)` 走同一套合并/校验。实测无 key 时 `hasApiKey:false, apiKeySource:"none"`。

---

## 5. 冷会话时序图（V1 要验的那条）

```
调用方（Host 插件）                      capabilityPanel（宿主内）
    │
    ├─ sessionId = 新建/预留会话 id（可尚不存在，也可 create 后）
    ├─ panel.jev.apply({sessionId, plan, cwd})
    │        ├─ isSessionLive?  agents.list().some(a=>a.id===sessionId)
    │        ├─ 否 → enumerate → queuePendingPlan({sessionId, ops(含关闭), createdAt})
    │        └─ 返回 {ok:true, pending:true, applied:0}
    │
    │  …… 用户/调用方 prompt → Agent 创建 …… 
    │
    │        [agent/created]  (cordis 事件，由 dsh-agent 发出)
    │        ├─ pendingPlans 取出（先删防重复）
    │        ├─ setTimeout(0) 让 mcp loader 等监听先登记
    │        └─ applyPending：重新 enumerate(live) → 复核 applicable/一致 → 写 → recordOutcome
    │
    ├─ 下一次 rank 或 apply 的返回里出现 pendingOutcome:{applied,failed,errors,at}
    └─（可选）panel.jev.apply 再调一次：不一致项写、一致项 skipped("already-applied")
```

**风险点**
- 重放发生在 `agent/created` 之后的一个宏任务，调用方**不能**在 create/created 同 tick 断言已生效——要等 `pendingOutcome` 或再 apply 一次。**【Fact】**
- 重放时**重新枚举**：如果这期间技能/插件集合变了，`unknown-id` / `not-toggleable` 会进 `skipped`，不会报错。**【Fact】**
- 排队计划只存内存：Host 重启会丢（不落盘），TTL 30 分钟。**【Fact】**
- 冷会话 `not-toggleable` 被豁免（`apply.js:1033-1037`）：冷会话技能全部可写，live 后才按 `canToggleInSession` 排除——所以"冷会话里能启用"不代表"live 时一定写成功"。**【Fact】**

---

## 6. V1 运行时通过/失败判据（可直接写进验收脚本）

| # | 检查 | 通过 | 失败 |
|---|---|---|---|
| 1 | 服务存在性 | `typeof ctx.get('capabilityPanel') === 'function'` 且调用后 `Object.keys(panel)` 含 `jev` | `undefined` → 面板未装/未启用，降级 inherit |
| 2 | 服务方法 | `typeof panel.jev.rank === 'function' && typeof panel.jev.apply === 'function'` | 缺失/抛错 |
| 3 | rank 输入校验 | `rank({sessionId:'',draft:''})` → `code:"bad-request"` | 抛异常 |
| 4 | rank 凭据 | 有 key：`ok:true` 且 `items.length === capabilitiesTotal`、`elapsedMs < 30000`；无 key：`code:"no-config"`（**不算失败，属环境未配置**） | 其它 code（network/auth/…）视为环境/网络问题 |
| 5 | rank 结果形状 | `items[].id` 匹配 `/^cap_[0-9a-f]{36}$/`，`score∈[0,1]`，排序满足 score 降序 | 形状不符 |
| 6 | apply 冷会话 | `{ok:true, pending:true, applied:0}`（无 live agent 时） | 抛错 / `code` 非空 |
| 7 | apply live 写入 | `{ok:true, pending:false, passed:failed===undefined}` 且 `applied === enabled+disabled` | 存在 `failed[]` → 写失败（已回滚） |
| 8 | apply 幂等 | 同参重复调用 → `applied:0`，`skipped[].reason === "already-applied"` | 重复写入 |
| 9 | 落盘证据 | `$DSH_HOME/dsh-capability-settings/session-capabilities.json` 出现该 sessionId 的域记录 | 无文件/无变更 |
| 10 | 排队回执 | 冷路径后第一次 rank/apply 的返回含 `pendingOutcome`（或日志出现 `Jev 排队能力激活失败`） | 计划丢失且无日志 |

日志可观测点（`P/lib/jev/*` 的 `logger.warn`）：
- `capability-panel: Jev apply 较慢 <ms>（枚举 Xms / 写入 Yms，skills N 条，写入 M 项）`（>800ms）
- `capability-panel: Jev 排队能力激活失败（session <id>）：<errors>` / `…应用异常…`

---

## 7. 给 V1 之后的实现建议（仅事实推导，不做决策）

1. **取服务必须调用 thunk**；若用 Cordis `inject: ['capabilityPanel']`，`inject` 通过后拿到的仍是函数 —— 建议封装一层 `getPanel()` 并在面板不存在时返回 `undefined`（天然降级 inherit）。
2. **判 apply 成功看 `failed`**，不要看 `ok`。
3. **auto 流程顺序**：`sessionController.create({cwd})` → `rank`（需要 key）→ 取 `items.filter(score≥阈值)` 转 `plan` → `apply` → prompt。注意 create 后会话已 live，`apply` 是同步写入路径（实测 17ms），不必等 `agent/created`。
4. **阈值由 commander 自己定**：宿主 `rank` 不按 `decisionThreshold` 过滤，要自己按 `score` 取 Top-K / 门控。
5. **能力面板与 commander 自己的 Jev 客户端分离**（两者 baseURL/model/key 都是独立的），不要复用 `jev.json` 误当派发配置。

---

## 8. 证据索引（本文件引用的工件）

| 工件 | 路径 |
|---|---|
| 宿主入口 / provide | `P/lib/index.js:49,51,58-147,296-301,349-436,439,489-493` |
| jev 管理器 | `P/lib/jev/manager.js:24-43,47-61,62-68,96-136,137-214,215-217,221` |
| apply 引擎 | `P/lib/jev/apply.js:33-60,70-78,135-350,662-699,707-746,747-795,946-980,994-1112,1113-1128` |
| rank 细节 | `P/lib/jev/rank.js:28-60,107-126,265-313,387-392,409-437,446-455,473-487,541-588` |
| 配置 | `P/lib/jev/types.js`（默认值）；`P/lib/jev/config-file.js:28,453-466,481-500`；`P/lib/jev/paths.js`（配置路径） |
| Cordis provide 语义 | `A/cordis/src/reflect.ts:284-326` |
| 运行态实测 | `docs/research/probes/evidence/plugin-boot.json`、`docs/research/probes/evidence/v3.json` |
| 启动/隔离配方 | `docs/research/validation-env.md` §A / §E |
