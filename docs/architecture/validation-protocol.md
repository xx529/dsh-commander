# DSH Commander · V1–V5 验收协议（V0 门禁）

> 版本：v1.0　日期：2026-11-17
> 角色：architect（本文件只定义协议，不写探针代码、不写测试、不写生产代码）。
> 上游依据：`docs/NEXT-PHASE.md` §3（V0 门禁）、§7（停止条件）；`docs/ARCHITECTURE.md` v2.4 §5/§8；`docs/eval/jev-dispatch-eval.md`；`docs/eval/cases.schema.json`。
> 探针环境与能力面板 API 的**现场事实**以 scout 产出为准：
> - `docs/research/validation-env.md`（环境基线、隔离方式、版本、命令）
> - `docs/research/capability-panel-api.md`（`capabilityPanel` 服务的精确形状）
>
> 本文件引用上述两份时只写"接口约定"，不复制其细节；若两份尚未产出，按本文件 §1.2 的接口占位执行，产出后替换引用、不改判据。

---

## 0. 一句话目标

V1–V5 每一项都必须产出**可复现的二值结论**（PASS / FAIL）与落盘证据；只有 V1–V5 全 PASS，才允许进入 M0/M1。任何一项 FAIL 立即停止，按 §9 的停止条件映射降级，**不得带病进入实现**。

---

## 1. 通用约定（所有 V 项共用）

### 1.1 角色

| 角色 | 职责 |
|---|---|
| **执行人（V1–V4）** | devops（task-3/task-4）：搭隔离探针环境、安装探针、执行 V1–V4 步骤并落盘原始证据；可请求 backend 协助 Host 侧探针代码。**不得自行修改已冻结设计或判据。** |
| **执行人（V5）** | backend（task-5）：案例快照采集与标注、live 评估、阈值扫描、报告生成；harness 两层模式扩展也由 backend 实现。 |
| **独立复跑与证据审计** | tester（task-6）：按本协议**独立复跑**关键步骤、核对证据是否可复现、判据是否按协议执行、原始返回是否与结论一致；只读执行记录，不改写证据。 |
| **协议与蓝图** | architect：维护本协议与 `implementation-plan.md`；只做协议/蓝图，**不执行验证、不改执行记录**。 |
| **门禁裁定人** | lead。依据本协议 §8 裁定 V0 门禁是否通过、是否进入 M0/M1。 |

### 1.2 环境基线（引用而非复述）

- 现场 profile：`desktop`（`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=/Users/lzx/.dsh/profiles/desktop`）。
- 插件安装位置：`/Users/lzx/.dsh/profiles/desktop/node_modules/`；本仓库工作区 `/Users/lzx/Documents/GitHub/dsh-commander`（所有命令在此执行）。
- DSH 安装：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`（包文档在其 `docs/`）。
- 能力面板：包 `dsh-capability-settings`。**实测现场版本 1.19.3**（NEXT-PHASE 记 v1.19.2，以现场为准；此差异写入 `docs/research/validation-env.md`）。
- 探针**不得改动 live profile**：探针一律以临时 `$DSH_HOME` + `--patch` 叠加层运行（与 scout 探针同法，见 `docs/research/probes/probe.patch.yml`）；需要观察真实面板时用同一隔离 Home 的 profile 副本，**不写 live profile、不碰 live Desktop 数据**。
- 证据目录：`docs/validation/`（由执行人按 V 项创建；tester 审计；本协议只约定字段与命名）。

### 1.3 三类探针形态（固定，不新增形态）

| 代号 | 形态 | 用途 | 约束 |
|---|---|---|---|
| **P-A** | Host 探针插件（`export function apply(ctx, config)` + 覆盖层 patch 行） | 调 Host 服务（`capabilityPanel`、`sessionController`、`storageDomain`、`webServer`、`sessionProjections`）、订阅事件、暴露 `/probe/*` HTTP 观测口 | 只读观察 + 显式标注的写入动作；证据写文件后用 `ctx.get('appExit')(0)` 有序退出；**不注册工具、不改会话日志类型、不写 live profile** |
| **P-B** | 独立 Node 脚本（`tools/*.mjs`，零依赖 Node 18+） | 纯离线计算：Jev 评估、阈值扫描、报告生成 | 不得直接访问 Host 内部；需要 Host 数据时由 P-A 落 JSON 再由 P-B 读 |
| **P-C** | 浏览器控制台片段 / Client 探针插件（`shell.overlay` 里只读渲染） | Client 侧事实：`pendingInteraction`、SSE 可达性、槽位注册 | 只读；不改 DOM 外结构；不影响审批所有权（不注册第二个 answerer） |

每项 V 在下面明确"探针形态"，不得临时换形态而不记原因。

### 1.4 证据格式（所有 V 项统一）

每条证据必须是"命令可重放 + 原始返回可核对"，字段固定：

```md
# <V 编号> <标题>
- 结论：PASS | FAIL
- 执行人 / 执行时间：
- 环境：profile、DSH 版本、能力面板版本、探针包与 commit（来自 validation-env.md）
- 输入冻结（V5 必填）：frozen 副本路径 + sha256 + manifest round
- 前置检查：<逐条 PASS/FAIL>
- 步骤与原始返回：<按 §步骤编号；命令原文；返回 JSON 按 §1.5 截断规则>
- 判据核对：<判据 ID → 实测值 → PASS/FAIL>
- 失败细节（仅 FAIL）：
- 复跑审计人 / 审计时间 / 结论：
```

原始返回截断规则：单条返回 >2KB 时保留头部 1.5KB + 尾部 0.5KB，中间标 `…<truncated N bytes>…`；**计数、布尔、错误码、模型名、elapsedMs 不得落入截断区**。每份证据最多附 5 个原始响应；完整原始 JSON 落 `docs/validation/<id>-artifacts/`。

### 1.5 二值判据的写法

- 一个判据只有一个布尔结论；"部分通过""基本可用"一律记 FAIL。
- 每条判据必须给出**实测值**（数字/枚举/错误码），不接受"看起来正常"。
- 判据中出现的阈值（如 0.50、8000、8KB、24k、95%）都是本协议显式写明的常量，执行人不得自行放宽。

### 1.6 探测顺序与时间盒

V1 → V2 → V3 → V4 → V5，**严格串行**（V1 FAIL 时 V5 的阈值结论无意义）。每项建议时间盒：V1/V2/V3/V4 各 ≤1 天，V5 ≤2 天（含 50 案例标注）。超时不算 FAIL，记"BLOCKED"并交 lead 裁定。

---

## 2. V1 · 能力面板服务（最高优先）

### 2.1 目标

确认宿主插件能解析 `capabilityPanel` 服务，`jev.rank` / `jev.apply` 在**冷会话**可用，且 apply 对冷会话的排队能在 `agent/created` 后重放；失败可回退 `inherit`。

### 2.2 前置条件（全部满足才开测）

| # | 前置 | 检查方式 |
|---|---|---|
| P1 | 隔离环境可启动 Host 并加载探针（P-A） | 探针启动日志出现 `[probe-v1] loaded`，且 `/probe/v1/health` 返回 200 |
| P2 | 能力面板在隔离 profile 中**已启用** | 状态快照中 `capabilityPanelRaw !== 'undefined'`（探针首段证据） |
| P3 | 能力面板 Jev 已配置（有 key 或 `hasApiKey:true`） | `jev.getConfig()` 返回 `hasApiKey:true`；无 key 时 V1 的 C2/C3 记 BLOCKED（不是 FAIL），先配 key 再测 |
| P4 | 一个真实工作区 cwd 可用于建冷会话 | 目录存在且被该 profile 的 workspaceRegistry 识别 |

> 说明：`no-config` 是**环境未配置**，记 BLOCKED；`network`/`auth` 在网络确有问题是环境问题，记 BLOCKED 并附 curl 复证。只有"服务形状不具备"才记 FAIL。

### 2.3 探针形态

**P-A**：`packages/probes/v1-capability-panel/`（或 `docs/research/probes/` 同法），Host 插件，`inject: []`（不要 inject 面板，否则面板缺失时探针不启动，看不到"缺失"这个事实）。暴露路由：

- `GET /probe/v1/health` → `{ok, panelRawType, panelIsFactory, panelKeys, panelJevKeys}`
- `GET /probe/v1/rank?sessionId=...&draft=...&cwd=...` → rank 原始返回
- `GET /probe/v1/apply?sessionId=...&planIds=id1,id2` → apply 原始返回
- `GET /probe/v1/session?sessionId=...` → 会话事件尾部摘要（seq/type/turn）

**服务解析约定（关键，来自现场实读）**：`dsh-capability-settings` 用 `ctx.provide("capabilityPanel", () => service)` 注册的是**工厂 thunk**，`ctx.get('capabilityPanel')` 拿到的是函数。探针与实现都必须兼容两种形状：

```ts
const raw = ctx.get('capabilityPanel')
const panel = typeof raw === 'function' ? raw() : raw   // 兼容 thunk 与对象
if (!panel || typeof panel.jev?.rank !== 'function' || typeof panel.jev?.apply !== 'function') {
  // FAIL 或按 P2 记缺失
}
```

### 2.4 精确步骤

1. 启动隔离 Host（临时 `$DSH_HOME` + 探针覆盖层），调用 `/probe/v1/health`；记录 `panelRawType`（`object|function|undefined`）、`panelIsFactory`、`panelKeys`、`panelJevKeys`。
2. 冷会话准备：通过 `sessionController.create({ cwd, agentPreset })` 建一个**从未跑过 turn** 的会话，记下 `sessionId`。随后**立刻**（不 prompt）执行第 3 步。
3. `jev.rank({ sessionId, draft: "需要单测和浏览器自动化", cwd })`：记录完整返回（`ok/items/model/usage/elapsedMs/capabilitiesTotal` 或 `code/errors`）；记录前 5 条 `{name, kind, score, applicable}`。
4. 由 rank 结果构造 plan：`items.filter(i => i.applicable && i.score >= threshold).map(i => ({ id: i.id, kind: i.kind, name: i.name, enabled: true }))`；`threshold` 取 `panel.jev.getConfig().decisionThreshold`（面板自己的配置，默认 0.5；缺该字段时用 0.5，并在证据里标注）。
5. `jev.apply({ sessionId, plan, cwd })`：记录 `{ok, applied, enabled, disabled, skipped, pending, elapsedMs, pendingOutcome?, failed?, errors?}`。冷会话预期 `pending:true`（只入队）。
6. `sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text', text:'准备中，确认可用能力。'}] })`；等一回合结束（探针订阅 `session/event` 捕获 `agent/created`、`turn/start`、`turn/end`）。
7. 再次 `jev.rank({ sessionId, draft: 同一 draft, cwd })`，检查第 4 步所选 id 的 `enabledInSession === true`；同时记录 `pendingOutcome`（若第 5 步返回或面板在激活后给出）。
8. 回退测试（可在同一探针内用独立 patch 行禁用面板）：把能力面板行 `disabled: true` 后重启 Host，确认探针仍启动、`/probe/v1/health` 返回 `panelRawType:'undefined'`，且记录"应回退 inherit"的判定路径。

> 备选路径（NEXT-PHASE §3 V1 已授权，仅当 C2/C3 失败时尝试）：
> - 备选 A：先 prompt 一个极短"准备中"回合，再 rank/apply；
> - 备选 B：只在 `agent/created` 后 rank/apply。
> 采用备选时，证据必须记录"直接路径失败码 + 备选路径结果"，且实现蓝图（`implementation-plan.md` §6）的 auto 顺序同步改为备选路径。**备选不得跳过 C3/C4。**

### 2.5 可观测证据

`docs/validation/v1-capability-panel.md` + `v1-artifacts/`：

| 证据 | 字段 |
|---|---|
| 服务形状 | `panelRawType`、`panelIsFactory`、`panelKeys[]`、`panelJevKeys[]`、版本号 |
| rank（冷） | `ok`、`items.length`、`capabilitiesTotal`、前 5 条 `{name,kind,score,applicable}`、`elapsedMs` |
| apply（冷） | `ok`、`applied`、`enabled`、`disabled`、`pending`、`skipped[]`、`elapsedMs` |
| 激活重放 | `agent/created` seq、`pendingOutcome`（如有）、二次 rank 中目标 id 的 `enabledInSession` |
| 回退 | 面板禁用后 `panelRawType`、插件启动成功标记 |

### 2.6 通过判据（二值）

| ID | 判据 | PASS 条件 |
|---|---|---|
| **V1-C1** | 服务可解析 | `panelRawType ∈ {object,function}`；解析后 `panel.jev.rank`、`panel.jev.apply` 均为 function；`panel.jev.getConfig` 也为 function |
| **V1-C2** | 冷会话 rank 可用 | `ok === true` 且 `Array.isArray(items)` 且 `items.length > 0` 且 `capabilitiesTotal >= items.length`；无 `bad-request`/`empty-capabilities` |
| **V1-C3** | apply 成功（冷会话排队） | `ok === true` 且满足其一：(a) `pending === true` 且 `skipped` 均为合法 reason；(b) `pending === false` 且 `applied >= 0` 且 `failed` 为空 |
| **V1-C4** | 激活后生效 | `agent/created` 在 apply 之后出现；二次 rank 中第 4 步所选 id 至少 1 条 `enabledInSession === true`（plan 为空时此判据记 N/A→FAIL，须换 draft 重测） |
| **V1-C5** | 失败可回退 | 面板禁用/解析失败时插件**仍启动**；派发路径判定为 `inherit` 并记录 `reason=panel_unavailable`（探针只需验证判定函数返回该值） |

**V1 总判据 = C1∧C2∧C3∧C4∧C5 全 PASS。** C4 是"rank/apply 真的作用于会话"的唯一硬证据，不允许用 apply 的 `ok:true` 代替。

### 2.7 失败判据与停止条件映射

| 现象 | 结论 | 映射 |
|---|---|---|
| `ctx.get('capabilityPanel')` 为 undefined 或解析后无 `jev.rank/apply` | V1 FAIL | **NEXT-PHASE §7.1**：暂停 M1 auto，先做 inherit 版本；lead 裁定是否把 auto 推迟到 M2 |
| 冷会话 rank 报 `bad-request`/`empty-capabilities` 且备选 A/B 均失败 | V1 FAIL | §7.1 |
| 冷会话 apply 永为 `pending:true`，`agent/created` 后无重放、二次 rank 仍 `enabledInSession:false` | V1 FAIL（C4） | §7.1 |
| 面板服务可调用但 `apply` 写入失败（`failed` 非空、`errors` 非空） | V1 FAIL（C3） | §7.1；同时记录是否可在 M1 用 inherit 兜底 |
| 仅 `no-config`/网络/鉴权问题 | BLOCKED，不是 FAIL | 先修环境重测 |

### 2.8 执行与审计

- 执行：devops（task-3）；环境/版本核对：devops 本身；Host 实现相关复核：backend；独立复跑与证据审计：tester（task-6）；协议符合性：architect；门禁裁定：lead。

---

## 3. V2 · 会话停止、最后回复、pendingInteraction 与去重

### 3.1 目标

确认 `turn/end` 与"最后一条 assistant 回复"的稳定对应关系；确认审批/提问等待期**不注入**；确认同 `sessionId + turnId + seq` 只注入一次。

### 3.2 前置条件

| # | 前置 |
|---|---|
| P1 | 隔离环境可跑 P-A 探针，并能在探针内订阅 `ctx.on('session/event', (session, event) => …)` |
| P2 | 至少 1 个可正常跑 turn 的普通会话（由 `sessionController.create` 或 GUI 新建），模型可用 |
| P3 | 能制造一次审批：一条在 `workspace-write` 下需要审批的 shell 命令（例如网络或越界写入；具体命令由 devops 在隔离环境选定并写进证据） |

### 3.3 探针形态

**P-A**（Host 探针，只观察）：订阅 `session/event`，把每个事件压成 `{seq, type, turn?, reasonKind?, role?, textPreview?, approvalId?}` 写环形缓冲；路由：

- `GET /probe/v2/log` → 事件摘要数组
- `GET /probe/v2/decide?sessionId=...&turn=...&seq=...` → 运行**注入决策纯函数**（从实现蓝图 §7 抽出同一份逻辑），返回 `{shouldInject, reason, dedupeKey, textLength, truncated}`，**不真正 prompt**
- `POST /probe/v2/replay` → 用同一 `{sessionId,turn,seq}` 喂决策函数两次，验证去重

**P-C**（Client 侧只读）：在页面控制台或 Client 探针里读目标会话的 `useSessionStatus(sessionId).pendingInteraction`，记录 `null` / 非空（类型名），用于对照 Host 判定。**不调用 `answer()`**（不抢审批所有权）。

### 3.4 精确步骤

1. **普通完成回合**：对工作会话 prompt 一句话（如"只回一句：收到"）。记录：`turn/start(seq,turn)`、全部 `assistant/message`、`turn/end(seq,turn,reason.kind)`。
2. **工具回合**：prompt "运行 `echo ok` 并把结果告诉我"，记录 `tool/call`、`tool/result` 与 `turn/end`；确认中间事件不产生注入候选。
3. **审批等待**：触发需要审批的命令；在审批卡出现、尚未作答期间，调用 `/probe/v2/decide` 对该会话最近状态求值，记录 `pendingInteraction`（P-C）与 Host 侧 pending 信号（未配对 `approval/asked`）。然后**在 GUI 手工作答**（探针不注册 answerer）；恢复后记录回合结束事件，再求值一次。
4. **去重**：对第 1 步产生的 `{sessionId, turn, seq}` 连续两次 `/probe/v2/decide`，第二次必须 `shouldInject:false, reason:'duplicate'`；再等一个**新 turn** 结束，求值必须 `shouldInject:true`（去重键按 turn 区分，不误杀）。
5. **空回复回合**（可选但建议）：构造一个只有工具调用、无文本的回合，记录决策函数返回（默认注入占位文案或跳过，二选一由证据确定并回写蓝图 §7；此分支不影响 V2 总判据）。

### 3.5 可观测证据

`docs/validation/v2-turn-end.md` + `v2-artifacts/probe-log.json`：

- 每个场景的 `turn/start seq`、`turn/end seq`、`turn` 号、`reason.kind`；
- 该 turn 内最后的 `assistant/message` 的 `seq` 与文本长度/首尾 40 字；
- 决策函数输出：`shouldInject/reason/dedupeKey/textLength/truncated`；
- 审批场景：`approval/asked` 与 `approval/decided` 的 seq 配对情况、P-C 的 `pendingInteraction` 快照；
- 去重：同键两次决策、不同 turn 一次决策。

### 3.6 通过判据（二值）

| ID | 判据 | PASS 条件 |
|---|---|---|
| **V2-C1** | turn 边界稳定 | 每个完成回合恰有 1 个 `turn/start` 与 1 个 `turn/end`；`turn/end.data.turn === turn/start.data.turn`；`reason.kind` 可枚举为 `completed/error/blocked/max-tokens/aborted/interrupted` 之一（现场枚举以探针实测补全） |
| **V2-C2** | 最后回复可唯一确定 | 在同一 turn 区间内，取 `assistant/message` 中 `seq` 最大者为"最后回复"；其 `data.message.content` 的 text block 拼接非空（普通回合场景）；决策函数产出的文本与该拼接**逐字相等**（长度≤8KB 时），或按截断规则头尾相等（>8KB 时） |
| **V2-C3** | 中间事件不注入 | 工具回合并发期间与整个回合内，`shouldInject` 只在 `turn/end` 之后为 true；`tool/call`、`tool/result` 时刻求值均为 false |
| **V2-C4** | pending 不注入 | 存在未配对 `approval/asked`（或 `userQuestions.active.length>0`）时，决策 `shouldInject:false, reason:'pending_interaction'`；P-C 的 `pendingInteraction` 非空与 Host 判定一致；恢复并结束回合后求值为 true |
| **V2-C5** | 去重正确 | 同键第二次 `shouldInject:false, reason:'duplicate'`；跨 turn 的不同键 `shouldInject:true`；去重键明文等于 `<sessionId>:<turnId>:<lastAssistantSeq>` |

**V2 总判据 = C1∧C2∧C3∧C4∧C5。** C4 的"Host 判定与 Client 一致"是防止"只看 turn/end 就注入"的关键。

### 3.7 失败判据与停止条件映射

| 现象 | 结论 | 映射 |
|---|---|---|
| `turn/end` 缺失、一个回合多次 `turn/end`、或无法定位最后 `assistant/message` | V2 FAIL（C1/C2） | **NEXT-PHASE §7.2**：回到设计，禁止用轮询硬凑 |
| 审批期间仍 `shouldInject:true`，或 Host 与 Client 判定不一致 | V2 FAIL（C4） | §7.2；并检查是否用了 `agent/status` 轮询（禁止） |
| 同键重复注入或跨 turn 误去重 | V2 FAIL（C5） | 修去重键实现后重测（属实现 bug，不属设计失败） |

### 3.8 执行与审计

- 执行：devops（task-3）；去重实现复核：backend；独立复跑与证据审计：tester（task-6）；协议符合性：architect；门禁裁定：lead。

---

## 4. V3 · 会话创建、模型选择、prompt 与 resume

### 4.1 目标

`sessionController.create({workspaceId|cwd, agentPreset})`、`selectModel`、`prompt({mode:'queue'})` 全链路可用；Host 重启后指挥官会话可按 `sessionId` **懒恢复**（首次 prompt 触发 resume）并继续。

### 4.2 前置条件

P1：P-A 探针可调 `sessionController`（`ctx.get('sessionController')` 为对象且方法齐全）；
P2：存在 1 个真实工作区（`workspaceId` 与 `cwd` 都可取到）；
P3：`/probe/v3/run` 每步都返回 JSON 且失败不崩溃（探针自带 try/catch）。

### 4.3 探针形态

**P-A**：路由

- `POST /probe/v3/create` → `{sessionId, agentPreset}`（`workspaceId` 与 `cwd` 二选一，均记下）
- `POST /probe/v3/model` → `selectModel({sessionId, provider, model, reasoningEffort})` 返回 `selected`
- `POST /probe/v3/prompt` → `prompt({requestId, sessionId, mode:'queue', content})` 并等 `turn/end`，返回 `{accepted, turnEndSeq, lastAssistantLength}`
- `GET /probe/v3/session?sessionId=` → 事件摘要（seq 连续性、`session/created` header.cwd）
- `POST /probe/v3/rebind-test` → 用同一 `sessionId` 再 `create`，记录服务实际返回的 `sessionId`（验证非空会话不会被复用）

### 4.4 精确步骤

1. `create({ cwd })`（或 `workspaceId`）→ 记 `sessionId`、`agentPreset`；确认新会话出现在该目录/工作区（`session/created` 的 `header.cwd` 与请求目录 realpath 相同）。
2. `create({ workspaceId, cwd })` 同时传 → 预期被拒；记录错误码（用于实现参数互斥校验）。
3. `selectModel({ sessionId, provider, model, reasoningEffort })` → 返回 `selected` 与请求一致。
4. `prompt({ mode:'queue', content:[{type:'text',text:'只回一句：v3-ok'}] })` → `accepted:true`；等该会话 `turn/end`；确认存在非空 `assistant/message`。
5. 对**已有内容**的 `sessionId` 再 `create`：记录服务实际行为（预期不重用、返回新 id；实现据此选择"重绑=新建"路径）。
6. **resume**：卸载/重载探针 Host（或重启隔离 DSH Host），不新建会话；对第 1 步 `sessionId` 直接 `prompt` 第二条 → 期望：`accepted:true`、旧会话事件 seq 从上次值连续递增、出现新 `turn/start`、无 `writer-held`、无新会话被创建。
7. 记录"重启后未 prompt 前"的会话状态（`sessionQuery` 只读或列表），确认**无需主动 resume** 也能保留绑定信息（懒恢复前提）。

### 4.5 可观测证据

- 每步请求/返回原文；`session/created` header.cwd；`selectModel` 后的 model 选择（返回 + 下次 `request/header` 的 model 若可取）；
- prompt 后事件序列 `[turn/start, ..., assistant/message, turn/end]`；
- resume 前后 `sessionId` 相同、`seq` 单调、事件条数增量、是否出现 `session/created` 新 id；
- 同时传 `workspaceId`+`cwd` 的拒绝证据。

### 4.6 通过判据（二值）

| ID | 判据 | PASS 条件 |
|---|---|---|
| **V3-C1** | create 落点正确 | 返回 `sessionId` 非空；该会话 `header.cwd` 等于请求目录的 realpath（或属于请求 workspaceId） |
| **V3-C2** | 参数互斥 | 同时传 `workspaceId` 与 `cwd` 被拒，错误可读 |
| **V3-C3** | 模型可选 | `selectModel` 返回 `selected` 与请求三字段（provider/model/reasoningEffort）一致 |
| **V3-C4** | prompt 能唤醒一轮 | `accepted:true` 且该会话出现 `turn/start` 与至少 1 条非空 `assistant/message`，且 `turn/end` 出现 |
| **V3-C5** | resume 可继续 | 重启后对同一 `sessionId` prompt 成功；`sessionId` 不变；事件 seq 单调且连续；无 `writer-held`；无重复会话 |
| **V3-C6** | 非空会话不复用 | 对有内容会话再 `create` 的返回值记录明确（复用=FAIL，因为会把旧对话当新会话；实测如为复用则实现禁用该路径） |

**V3 总判据 = C1∧C2∧C3∧C4∧C5∧C6。**

### 4.7 失败判据与停止条件映射

V3 无直接 §7 停止条件；任一 FAIL 记"阻塞 M0 会话绑定"，由 lead 裁定是否重设计（例如改为"绑定空会话 + 重绑即新建"）。特别地：

- 若 `prompt` 不能唤醒已有会话 → M0 的"重启后绑定不丢"改为"重绑到新会话"，须 lead 批准（属产品行为变化，不得 architect 自行改）。
- 若 `create` 对非空 id 会**覆盖/复用**旧会话 → 实现层禁用该调用，M0 绑定只走"新建或选择已有"，不影响门禁，但记录为约束。

### 4.8 执行与审计

执行：devops（task-4）；Host 调用复核：backend；独立复跑与证据审计：tester（task-6）；协议符合性：architect；裁定：lead。

---

## 5. V4 · 存储（`storageDomain` 域 `commander`，per-record）

### 5.1 目标

域 `commander`（`layout: 'per-record'`，`version: 1`）可声明、open、写入、读取、更新；key 满足 `[a-zA-Z0-9_-]+`；记录 `version` 字段自增正确、并发写不丢；Host 重启后记录仍在。

> 澄清（现场 API 事实）：`storageDomain` 的 `update(key, fn)` 本身是**单域写链上的原子读改写**，单进程内不存在"两写互斥冲突"。任务记录里的 `version` 是**应用层**字段，用于跨调用幂等与缓存判断；"冲突重试"只在实现检测到 `version` 落后时发生，不是后端冲突。V4 判据按此口径，不要求制造后端冲突。

### 5.2 前置条件

P1：P-A 探针 `apply` 中可 `await ctx.storageDomain.open(commanderDomain)`（域声明与实现蓝图 §4 完全一致，7 张表 + zod schema）；
P2：隔离 Host 的 `$DSH_HOME` 可写、可重启（同一目录再次启动）；
P3：探针不写 live profile 的存储目录（用临时 `$DSH_HOME`）。

### 5.3 探针形态

**P-A**：路由 `GET /probe/v4/run?case=...`，case ∈ `open|roundtrip|keyswitch|update|concurrent|reject|all`；每次操作把 `{case, key, before, after, error}` 追加写到证据文件；`GET /probe/v4/restart-check?file=...` 在重启后读同一 `$DSH_HOME` 验证。

### 5.4 精确步骤

1. `open(commanderDomain)`：7 张表（`config/workspaces/commands/tasks/dispatches/board_edits/sessions`）全部 `domain.table(name)` 可用；`domain.name === 'commander'`。
2. **往返**：`tasks.put('task_test_0001', {...协议最小合法记录...})` → `get` 逐字段相等（含 `version:1`、timeline 数组）。
3. **key 规则**：`sessions.put('ws_htdot__sess_8f31a2', {…})` 成功；`sessions.put('bad/key:1', {…})` 被拒（错误消息含 path-safe/key 规则），且拒绝后域仍可正常读写（不脏）。
4. **更新与 version**：`tasks.update('task_test_0001', rec => ({...rec, status:'proposed', version: rec.version+1, updatedAt: now}))` → 读回 `version===2`、`status==='proposed'`。
5. **并发**：同一 key 连续发起 2 次 `update`（不 await 第一次即发第二次，或 `Promise.all`）→ 两次都 resolve；最终 `version===4`（各 +1），无字段丢失、无部分写。记录执行顺序。
6. **并发异常**：`update` 回调抛错 → 该次 reject；读回状态等于抛错前（不半写）。
7. **重启持久**：关闭域/Host，带同一 `$DSH_HOME` 重启探针，`open` 后 `get` 第 2/5 步记录仍在、`version` 保持；`sessions` 的 `__` key 仍在。
8. **schema 校验**：写入缺必填字段的 `tasks` 记录 → 预期被 zod 拒绝（put 前由实现校验；若实现依赖 `open` 时的 `invalid-record`，则记录"open 拒绝"这一行为，不得静默丢数据）。

### 5.5 可观测证据

`docs/validation/v4-storage.md` + `v4-artifacts/domain-ops.jsonl`（每行一次操作）+ `restart-before.json` / `restart-after.json`。

### 5.6 通过判据（二值）

| ID | 判据 | PASS 条件 |
|---|---|---|
| **V4-C1** | 域可 open | `open` resolve；`domain.name==='commander'`；7 张表（`config/workspaces/commands/tasks/dispatches/board_edits/sessions`）handle 均可取；**表名须匹配平台契约 `/^[a-z][a-z0-9_]*$/`**（`boardEdits`→`board_edits` 是 Lead 2026-11-17 裁定的平台契约修正，见 ARCHITECTURE 文首修正记录与 `docs/validation/v4-storage-domain.md`；键/字段/layout/version/语义不变） |
| **V4-C2** | 往返一致 | put→get 关键字段（`id/v/status/version/timeline`）逐字段相等 |
| **V4-C3** | key 规则 | `ws__sess` 形 key 成功；含 `/` 或 `:` 的 key 被拒，错误可读；拒绝后域可继续正常读写 |
| **V4-C4** | update 与 version | 单次 update 后 `version` 精确 +1，字段按回调生效 |
| **V4-C5** | 并发不丢写 | 2 次并发 update 后 `version` 精确 +2，两次回调效果都在；抛错回调不产生半写 |
| **V4-C6** | 重启持久 | 重启后记录与 version 完整读回，`__` key 正常 |
| **V4-C7** | schema 生效 | 非法记录被拒（写入前校验或 open 时 `invalid-record`），无静默接受 |

**V4 总判据 = C1∧C2∧C3∧C4∧C5∧C6∧C7。**

### 5.7 失败判据与停止条件映射

| 现象 | 结论 | 映射 |
|---|---|---|
| per-record 不可用 / key 限制无法满足（`__` 被拒、或任何合法 id 含非法字符） | V4 FAIL | **NEXT-PHASE §7.4**：先 SQLite 路由或改 key 结构（改结构须 lead 批准，不得自行改冻结 schema） |
| 重启丢数据或 version 漂移 | V4 FAIL | §7.4 同款排查；若为探针 Home 复用问题，记 BLOCKED 重测 |
| 并发 update 丢字段 | V4 FAIL | 实现层错误（未按单写链串行）；修后重测 |

### 5.8 执行与审计

执行：devops（task-4）；存储实现复核：backend；独立复跑与证据审计：tester（task-6）；协议符合性：architect；裁定：lead。

---

## 6. V5 · Jev 派发 50 案例（阈值门禁）

### 6.1 目标

用**真实工作区/会话快照**的 50 条案例跑 `tools/jev-eval.mjs`，校准并冻结 `pWorkspace / pSession / confidence` 阈值与"全量 vs 两层"模式；达标才允许 M1 自动派发。

### 6.2 前置条件

| # | 前置 |
|---|---|
| P1 | `docs/eval/cases.real.jsonl` 存在且 ≥50 条，每行符合 `docs/eval/cases.schema.json`（backend 用 JSON schema 校验并逐行报错；tester 独立复跑审计） |
| P2 | 分层数量满足：**门禁层**=明显工作区（named-cue）12、跨工作区歧义 12、旧会话（7–30 天前）10、应新建 6、应询问用户 5（合计 45）；**观测层**=能力提及 5（不参与门禁）。两份合计 50（Lead 2026-11-17 裁定：能力层降级为观测项） |
| P3 | 标签来自"真实快照 + 人工判定"，不来自最近会话/词面先验（证据里附标注规则与两条抽样对照） |
| P4 | `JEV_API_KEY` 可用（或明确本次为 `--mock` 的 harness 自检，不计入门禁） |
| P5 | **案例快照已冻结**（见 §6.2A）：存在只读冻结副本 + `manifest.json`（sha256/轮次/生成器版本/seed/summaryMode），且报告与证据引用该副本 |
| P6 | **as-of-dispatch 输入完整性通过**（见 §6.2B）：无期望答案泄漏、无未来信息、时间语义在报告中显式声明 |

> 案例采集方式（backend 执行，devops 提供隔离环境的快照导出脚本）：从隔离/只读的 `workspaceRegistry.list()` + 会话列表导出 `{workspaces, sessions}` 快照到案例行；`expected` 由 backend 按"当时的真实派发意图"填写，争议案例可请 lead 抽样仲裁。采集脚本属 `tools/`（非插件生产代码）。

### 6.2A 案例快照冻结与审计链（硬要求；Lead 2026-11-17 增补）

**背景（V5 v1 教训）**：v1 的 `docs/eval/cases.real.jsonl` 在 tester 审计期间被就地覆盖两次（16:52、16:56），v1 输入无法逐字复核，评估结论只能依赖派生物 → 该轮应记 INVALID。

条款（本轮起强制）：

1. **生成即冻结**：每轮 V5（v1/v2/v3…）生成案例后，立即写只读副本 `docs/eval/frozen/cases.<round>.<sha256前12>.jsonl`，并写 `docs/eval/frozen/manifest.json`，至少记录：`round`、`sha256`、`cases` 数、生成器文件哈希与 git rev、`seed`、`summaryMode`、数据源 `$DSH_HOME`（只记路径）、`generatedAt`、`dispatchTime`、分层计数。
2. **只读复跑**：harness、tester 复跑、architect/lead 审计**只读冻结副本**；`docs/eval/cases.real.jsonl` 只是"最新生成"的工作指针，**不得作为任何报告或证据的输入**。
3. **不可覆盖**：重生成只能新增 frozen 文件，不得覆盖已有副本；同一轮报告产出后该副本永久只读。修复输入 = 开新一轮（v2b/v3…），报告须声明与上一轮的差异。
4. **哈希入证**：每份 V5 证据与 `report*.md` 头部必须写 `frozen 路径 + sha256`；harness 报告头打印 `caseSha256 / generatorRev / seed / summaryMode / dispatchTime / violations`。
5. **违规处置**：冻结副本缺失、被改动、或报告引用的哈希与实际不符 → 该轮 V5 结论记 **INVALID（不可复核）**，不是 FAIL、更不是 PASS；必须补冻结后整轮重跑。
6. **双人链**：backend 生成并冻结 → tester 用冻结副本独立复跑 → architect/lead 只读审计；任一角色不得就地修改案例文件。

### 6.2B as-of-dispatch 输入完整性（可检查清单；Lead 2026-11-17 增补）

时间语义二选一并必须写进报告：`replay-at-now`（v1 采用：快照=生成时刻真实状态，任务=历史消息）或 `replay-as-of`（快照回到目标消息时刻）。两种语义下均禁止：

| # | 断言 | 通过条件 |
|---|---|---|
| A1 | new 案例的源会话不得出现在 `sessions` 快照 | 违规数 = 0 |
| A2 | attach 案例的期望会话必须在 `sessions` 快照内 | 违规数 = 0 |
| A3 | 任务文本不得含期望会话 id（含去 `session-` 前缀形式） | 违规数 = 0 |
| A4 | 任务文本不得泄漏**期望会话标题/标题片段**（可执行口径见下方"A4 判定细则"） | 违规数 = 0 |
| A5 | `workspaces.recentTasks` 不得列出期望会话的标题 | 违规数 = 0 |
| A6 | 非 named-cue 层任务文本不得点名期望工作区 name / 路径 basename / id | 违规数 = 0 |
| A7 | named-cue 层（原 obvious）允许点名，按 Lead 裁定作为 easy/回归层单列；**门禁工作区 Top-1 不用它** | 报告同时打印 `all` 与 `non-named-cue` 两套指标；`non-named-cue` = labeled 案例去掉 named-cue 层 |
| A8 | 期望工作区 id 不得出现在任务文本 | 违规数 = 0 |
| A9 | 任务文本（含重建上下文）只能使用目标消息**之前**的会话事件 | 代码断言 + 抽样人工核对（10 条） |
| A10 | `dispatchTime`、`summaryMode`、摘要生成输入、`replay-at-now/as-of` 语义在 labels/report 显式声明 | 报告字段齐全 |
| A11 | **白名单敏感性快照定义可复现**（见 §6.2C）：两套候选域（全量允许集 / 现实白名单）由固定规则生成，规则、参数、输入快照与派生物哈希可在大纲级复算 | 报告含 `whitelistVariant` 定义 + 生成规则 + 两套结果；同输入重跑得到同一集合（抽 5 案例校验） |
| A12 | **dispatchAt 定义与申报一致**（见下方"dispatchAt 精确定义"）；报告须打印规则与偏差分布 | 规则字段齐全 + 报告披露偏差（MEDIUM 及以上）且未来重开按被测消息时间重冻结 |

**A4 判定细则（Lead 2026-11-17 裁定，backend `audit-cases.mjs` 必须按此对齐）**

仅当任务文本（`task.title` / `task.goal` / `command.text`，含重建上下文）满足以下**任一**才算 A4 违规：

- **(a) 期望会话标题全文**：`expected.sessionId` 对应会话的标题，去空白/大小写归一后作为连续子串出现在任务文本中；
- **(b) 标题 ≥8 个 CJK 汉字连续片段**：取期望会话标题中的所有 **≥8 个连续 CJK 汉字**子串（不含数字/英文/标点；标题本身 <8 个 CJK 连续汉字则本条不适用），任一原样出现在任务文本中；
- **(c) oracle 字段**：期望工作区 name、期望工作区 id、期望会话 id（含去 `session-` 形式）、期望会话标题全文、工作区摘要原文，任一原样出现在任务文本中（(c) 与 A3/A6/A8 重叠时按最严者计）。

**不算违规**：与标题共享的通用技术词/产品名/英文词（如 `markdown`、`session`、`jev-desktop`、`agent-desktop`、`terminal`、`playwright`、`dsh` 等）以及单字/双字 CJK 词；这些不承载唯一指向性。

**裁定记录**：该口径由 Lead 于 2026-11-17 裁定，取代 v1/v2 审计中过宽的"任意词重叠"判法；按此口径，tester 在 v2 列出的 5/50 字面命中（v5-21/24/25/43/45）属于共享通用词或非 ≥8 CJK 片段，**不构成泄漏**；因此 v2 仍判 **FAIL（指标不达标）而非 INVALID（输入不合格）**。backend 需据此实现 `audit-cases.mjs`，并把 v2 审计结论从 INVALID 修正为 FAIL（不改 v2 报告指标）。

**dispatchAt 精确定义（Lead 2026-11-17 裁定）**

- 字段：每案例 `_provenance.dispatchAt`（报告可称 `dispatchAt`）。语义应为"假设派发发生的时刻"，即 **被测用户消息的时间**（`_provenance.messageTime`）。
- **v2 生成器实际口径**：`dispatchAt = 该案例源会话最后一条 ≥12 字用户消息的时间`；例外：`old-session` 层按 labels.v2 声明取**生成时刻**（用于检验"旧会话不被忽略"）。因此 v2 中 22/50 案例 `dispatchAt > messageTime`，其中 10 条为 old-session 已声明例外、**12/50（8 obvious + 4 new-session）属未声明偏差**（偏利好模型：能看到被测消息之后的状态）。
- **本轮处置（不重冻结重跑）**：偏差方向偏利好模型且 v2 仍 FAIL，结论稳定；要求 backend 把 `labels.v2.md` 文案改为实际口径，并在 v2 报告/审计中把"12/50 未声明偏差 + 10/50 已声明例外"披露为 **MEDIUM 已知偏差**；`audit-cases.mjs` 的 A12 输出该偏差分布。
- **未来重开 V5（v3 及以后）**：必须按**被测消息时间**生成 `dispatchAt` 并据此重建 as-of 快照，**重新冻结新副本**后重跑；**不得复用 v2 冻结副本**，也不得在旧副本上改 dispatchAt 后直接出结论。A12 校验：报告打印 `dispatchAt 规则 + dispatchAt>messageTime 计数 + 差值 min/p50/max`。

执行方式：backend 提供只读 `tools/eval/audit-cases.mjs` 输出逐条 A1–A12 结果与汇总（有违规 exit≠0）；tester 对冻结副本复跑并把 JSON 作为证据附件；**A4 按上述可执行细则判定，A12 为口径/披露检查**。硬违规（A1/A2/A3/A5/A6/A8 命中，或 A4 三情形命中，或 A12 规则缺失）→ 输入不合格记 INVALID；若仅存在未声明偏差但已按要求披露（A12 通过）→ 结论仍按指标判 FAIL/PASS，不升级为 INVALID。断言的实现细节与现存缺陷见 `docs/architecture/v5-review.md` §9–§11。

### 6.2C 白名单敏感性（诊断项，非门禁变更；Lead 2026-11-17 裁定）

**目的**：同一批冻结案例在"全部允许工作区（门禁口径；v1 为 28 个）"与"现实白名单"两套候选域下的表现差异，用于 M1 配置建议；**门禁仍按 §6.6 原口径（全量候选域）**，白名单结果不改变 PASS/FAIL。

**定义（写死、可复现，backend 按此实现）**：

1. 对每个案例，以 `dispatchTime` 为基准回看 **30 天**窗口，统计该时刻前有活动（会话 `lastActiveAt` 或 `messageTime` 落在窗口内）的工作区集合 `active30`。
2. 现实白名单变体 = `active30` **且** 包含该案例期望工作区；若 `active30` 中活跃工作区数 >8，则按"窗口内会话数降序、同数按 workspaceId 字典序"取前 8，并**强制保留期望工作区**（替换掉第 8 个）。
3. 若期望工作区不在 `active30`（即该案例的期望工作区在 dispatch 前 30 天无活动）：该案例在变体中记 `needs_confirmation`，**不计入 Top-1 分母**，单独计数。
4. 两套候选域使用同一案例文件、同一标签、同一 harness；唯一变量是 `workspaces` 快照（若白名单与全量相同则该案例两套结果一致）。
5. 报告分别给 `all-28` 与 `whitelist` 两套 C2/C4 与 coverage（不合并），并记录每案例实际白名单大小分布（`n_whitelist` 的 min/p50/max）。门禁只取 `all-28` 结果；`whitelist` 结果标注"诊断，仅作 M1 配置建议"。
6. 复现性：生成规则、窗口参数（30 天）、上限（8）、活跃度计算口径写入 `manifest.json`/报告头；A11 抽 5 案例校验同一输入重跑集合一致。

### 6.3 探针形态

**P-B**：`node tools/jev-eval.mjs docs/eval/cases.real.jsonl --out docs/eval/report.md`（现有工具，零依赖）。
**两层模式（B 模式）**：现有 harness 只实现"全量一波"（A 模式）。M1 前由 backend 扩展同一工具（新增 `--mode layered`），契约固定为：

1. 第一次请求只问 `workspace`（criteria=全部 allowed 工作区）；
2. 取 `workspace.choice` 对应工作区，第二次请求问 `session`（该工作区全部非归档会话 + `new`）；
3. 两问各取 `probabilities[choice]` 与 `confidence`；指标/扫描口径与 A 模式**完全一致**；
4. 报告额外输出 `mode: full|layered`、请求数、input/output tokens、p50/p95 时延。

在不扩展工具的前提下，不得用"人工挑工作区"冒充 B 模式。

### 6.4 精确步骤

1. `node tools/jev-eval.mjs docs/eval/cases.sample.jsonl --mock`：harness 自检通过（报告可生成）。
2. **校验冻结副本**：`node tools/eval/validate-cases.mjs docs/eval/frozen/cases.<round>.<sha12>.jsonl` → 50 行通过 schema；门禁分层 12/12/10/6/5（45）+ 能力提及观测层 5；核对 manifest sha256 与文件一致；同时跑 `audit-cases.mjs`（A1–A11 全 0）。
3. A 模式 live：`JEV_API_KEY=… node tools/jev-eval.mjs docs/eval/frozen/cases.<round>.<sha12>.jsonl --out docs/eval/report.md`；保存原始 stdout/stderr 与报告。
4. B 模式 live：`… --mode layered --out docs/eval/report-layered.md`（工具扩展后）。**输入一律用冻结副本，不用 `cases.real.jsonl` 工作指针。**
5. 阈值扫描：按 §6.6 C5/C6 口径（`precision = correct(auto)/autoAll`，should-ask 泄漏必须 0；`coverage = served/labeled(45)`）取 `precision ≥ 0.95` 且 `coverage` 最大的一行；同规则对 B 模式取一行；比较两模式 coverage/precision/tokens/p95。
6. 写回默认配置值：把选中组合写入 **`ConfigRecord.jev.threshold / confidenceFloor` 的默认值**（蓝图 §4 的默认常量；不是运行时值）。若两模式结论不同，按 §6.6 的第 3 条选址。
7. **白名单敏感性诊断（§6.2C）**：用同一冻结副本再跑一次现实白名单变体，报告两套结果；门禁只取全量允许集结果，白名单仅作 M1 配置建议。
8. 校准检查：按 `pMax` 分桶（如 0.5/0.6/0.7/0.8/0.9+）统计正确率，要求单调不降且无严重过自信（最高桶正确率与最低桶差 ≥0 且高桶不低于基线）。

### 6.5 可观测证据

- `docs/eval/report.md`（A）、`docs/eval/report-layered.md`（B）；
- 扫描表前 10 行原样（含 precision/coverage/auto/correct）；
- 逐条 case 判定表（expected vs chosen；冲突计数）；
- 阈值最终值、默认配置落点 diff；
- p50/p95 时延、tokens、请求数；
- 校准分桶表；
- **冻结证明**：`frozen/` 副本路径 + `manifest.json` 摘要 + sha256（与报告头部一致）；
- **输入完整性**：`audit-cases.mjs` JSON（A1–A12；A4 按可执行细则、A12 含 dispatchAt 规则与偏差分布）+ 10 条抽样人工核对表；
- **分层与 named-cue 单列**：逐层 ws/mode/session/target，named-cue / non-named-cue 两套 C2；报告打印 C2 实际 n（v2=28）与 C6 实际 n（v2=40）、dispatchAt 偏差披露；
- 条件指标：`sessionTop1Attach | expectedInScope`、invalid answer 计数、should-ask 泄漏数。

### 6.6 通过判据（二值）

| ID | 指标 | PASS 条件（与 `docs/eval/jev-dispatch-eval.md` §4 一致） |
|---|---|---|
| **V5-C1** | 案例集合格 | 50 条全过 schema；门禁分层=12/12/10/6/5（45）+ 能力提及观测层 5；**并满足 §6.2A 冻结（frozen+manifest+哈希入证）与 §6.2B 输入完整性（A1–A12 全 0 违规/可复现，A12 为口径与披露检查）** |
| **V5-C2** | 工作区 Top-1 | ≥ 85%，分母 = **non-named-cue 门禁层 labeled 案例的实际 n**（门禁层 = 50 − 观测层 5 = 45，再去 should-ask 5 = labeled 40，再去 named-cue 12 → **v2 实际 n=28**）；报告必须打印实际 n，并并列 `all` 与 `non-named-cue` 两套（后者为门禁值） |
| **V5-C3** | 会话 Top-1（attach 案例） | ≥ 70% |
| **V5-C4** | 模式准确率 | ≥ 85% |
| **V5-C5** | 自动派发 precision | ≥ 95%（`correct(auto) / autoAll`，autoAll 含 should-ask 自动放行并计为错误）；**should-ask 自动放行容忍度 = 0/5（严格，泄漏一条即 C5 FAIL）** |
| **V5-C6** | 自动派发 coverage | ≥ 40%，分母 = **门禁层 labeled**（= 45 门禁案例 − 5 should-ask = **v2 实际 n=40**；含 named-cue、**不含** observational 能力提及层）；分子 = 门控放行的门禁层案例数（should-ask 不放行故不进分子）。v2 harness 当前用 28 作 C6 分母属**实现口径偏差**，由 backend 对齐为 40；本轮无 qualifying 组合，**C5/C6 结论不变、无翻转** |
| **V5-C7** | 时延/预算 | p95 < 3s；全量请求 tokens ≤ 24k（超出则必须两层） |
| **V5-C8** | 校准 | 分桶正确率单调不降，无严重过自信 |
| **V5-C9** | 全量 vs 两层结论 | 有明确结论并落到默认模式：A 准确率明显更优（Top-1 差 ≥ +3pp）且 ≤24k → 默认 A；否则默认 B；结论写进 `report.md` |

**V5 总判据 = C1∧…∧C9。** 阈值扫描选出的组合必须同时满足 C5/C6；找不到组合时 **V5 FAIL**（回退 §6.7）。

> **分母口径脚注（Lead 2026-11-17 裁定）**：C2 与 C6 的分母不同且都必须打印实际 n——C2 只看 non-named-cue 门禁层 labeled（v2 n=28），C6 看门禁层 labeled（v2 n=40，含 named-cue、不含 observational）。harness 当前把 C6 也按 28 算是实现偏差，backend 对齐后重算；本轮 v2 在所有扫描组合下均无 qualifying 组合，故口径修正**不改变 v2 结论（仍 FAIL）**。上述为口径澄清，不改任何阈值。

### 6.7 失败判据与停止条件映射

| 现象 | 结论 | 映射 |
|---|---|---|
| precision < 95%（任何阈值组合） | V5 FAIL | **NEXT-PHASE §7.3**：默认"每次派发都确认"，M1 不做自动派发；lead 决定是否继续 M1 |
| coverage < 40% 但 precision ≥ 95% | V5 FAIL（C6） | 同上；可调整候选构造（全量/两层）后重测一次 |
| 工作区 Top-1 <85% / 会话 Top-1 <70% / 模式 <85% | V5 FAIL | 回到候选构造与 criteria 设计（属设计问题，须 lead 批准改动） |
| 50 案例凑不齐或来源不可信 | BLOCKED（C1） | 补案例；**不得用合成文本凑数** |
| 仅 p95>3s | V5 FAIL（C7） | 可先降工作量（两层）重测；仍超则默认全确认 |

### 6.8 执行与审计

执行：backend（task-5，案例标注争议可请 lead 抽样仲裁）；harness 两层扩展：backend；独立复跑与证据审计：tester（task-6）；环境/Key 复核：devops；指标口径：architect；裁定：lead。

---

## 7. 执行与独立审计矩阵

| V | 执行（owner） | 环境/版本 | 实现相关复核 | 独立复跑与证据审计 | 协议 | 门禁裁定 |
|---|---|---|---|---|---|---|
| V1 | devops（task-3） | devops | backend（解析器/回退） | tester（task-6） | architect | lead |
| V2 | devops（task-3） | devops | backend（去重/触发） | tester（task-6） | architect | lead |
| V3 | devops（task-4） | devops（重启步骤） | backend（绑定/resume） | tester（task-6） | architect | lead |
| V4 | devops（task-4） | devops（隔离 Home） | backend（domain/仓储） | tester（task-6） | architect | lead |
| V5 | backend（task-5） | devops（Key/环境） | backend（harness 两层） | tester（task-6） | architect | lead |

> **修正记录（Lead 2026-11-17 裁定）**：V4-C1 的表名口径为 `board_edits` —— 原冻结名 `boardEdits` 违反 DSH per-record 表名契约 `/^[a-z][a-z0-9_]*$/`，V4 实测直接拒绝（`defineDomain` 抛错、`json` 后端 `malformed-medium`），域不可 open；最小适配只改表名，键 `editId`、`BoardEditRecord` 字段、layout/version/语义不变。判据数值未变，仅事实名修正；证据 `docs/validation/v4-storage-domain.md`。

审计的硬要求：tester **独立复跑**关键步骤（同环境、同命令、同输入）并只读核对执行记录，不直接改执行记录；审计结论写在该证据文件末尾（`- 审计人/时间/结论`），并标注"复跑一致 / 不一致（附差异）"。执行人不得同时担任该 V 项的独立审计人；architect 不执行验证、不改执行记录。

---

## 8. 门禁裁定（V0）

lead 在 `docs/validation/GATE.md`（由 lead 维护）中给出裁定，依据：

1. V1–V5 五项结论全 PASS；
2. 每项证据满足 §1.4 格式（含执行人/时间与 tester 的独立复跑审计签名）；
3. V5 的最终阈值与模式已写回蓝图默认值，且 `report.md` 可复现（命令+输入文件+环境版本）；
4. 无 BLOCKED 项遗留；
5. tester 的审计结论为"复跑一致"（不一致项由执行人修正后重审）。

裁定输出三选一：

- **PASS**：进入 M0/M1（按 `implementation-plan.md` 执行）。
- **CONDITIONAL**：仅当 FAIL 项属于环境/工具类（非设计类）且 lead 批准带条件——必须写明补救期限与责任人；V1/V5 原则上不允许 CONDITIONAL。
- **STOP**：按 §9 对应停止条件降级，冻结 M1 auto 或改为"每次确认"。

---

## 9. 失败 → 停止条件映射（汇总）

| V 失败点 | NEXT-PHASE §7 停止条件 | 降级动作 |
|---|---|---|
| V1-C1/C2/C3/C4 | §7.1 | 暂停 M1 auto，先做 inherit 版本；auto 推迟到 V1 修复后 |
| V2-C1/C2 | §7.2 | 回到设计，禁止轮询硬凑；M3 注入推迟 |
| V2-C4 | §7.2（审批准入不可靠） | 注入实现先只处理"无审批的完成回合"？**不允许**——必须过滤正确；否则注入整体暂停 |
| V3-C5 | —（无对应停止条件） | 阻塞 M0 绑定，lead 裁定重绑策略 |
| V4-C1/C3/C6 | §7.4 | SQLite 路由或改 key 结构（改 key 结构须 lead 批准） |
| V5-C5/C6 | §7.3 | 默认每次确认，不自动派发；M1 只做确认式派发 |
| V5-C2/C3/C4 | —（质量不达标） | 回候选构造设计；lead 决定是否推迟 M1 |
| V6–V8（本阶段可并行） | 见 NEXT-PHASE §3 | 不阻塞 V0 门禁，但 V6 fail 时审批降级为只做主窗口 |

---

## 10. 证据落盘清单（执行人产出，tester 审计）

| 文件 | 内容 |
|---|---|
| `docs/validation/v1-capability-panel.md` | §2 证据模板 + artifacts |
| `docs/validation/v2-turn-end.md` | §3 证据 + `v2-artifacts/probe-log.json` |
| `docs/validation/v3-session-controller.md` | §4 证据 |
| `docs/validation/v4-storage.md` | §5 证据 + `v4-artifacts/domain-ops.jsonl` |
| `docs/validation/v5-jev-50cases.md` | §6 证据 + `docs/eval/report.md`、`docs/eval/report-layered.md` |
| `docs/eval/frozen/cases.<round>.<sha256前12>.jsonl` + `manifest.json` | V5 案例冻结副本与元数据（§6.2A；只读，重跑/审计唯一输入） |
| `docs/validation/v5-audit-cases.<round>.json` | `audit-cases.mjs` 的 A1–A10 断言结果（§6.2B；tester 复跑产出） |
| `docs/validation/GATE.md` | lead 的门禁裁定 |

> 目录 `docs/validation/` 不在 architect 的写作用域（`docs/architecture/**`）内；本协议只约定其结构与字段。具体证据文件由执行人（V1–V4 devops、V5 backend）创建，tester 独立复跑并写审计结论，`GATE.md` 由 lead 维护。

---

## 11. 接口占位（等 scout 产出后替换）

本文件以下位置引用 scout 的现场产出；产出前按括号内约定执行，**不得自行臆造字段**：

| 位置 | 引用 | scout 未产出时的约定 |
|---|---|---|
| §1.2 环境基线 | `docs/research/validation-env.md` | 以本文件 §1.2 的实测值为准（profile=desktop、面板 1.19.3、DSH 0.2.2-rc.2），并在证据中注明"env 文件未产出" |
| §1.3 P-A 隔离方式 | 同上（隔离 Home + `--patch`） | 复用 `docs/research/probes/probe.patch.yml` 的同法 |
| §2.3 服务形状 / 错误码全集 | `docs/research/capability-panel-api.md` | 本文件已写 `rank/apply` 入参、成功返回、`code` 已知集合（`bad-request/no-config/empty-capabilities/network` 等）；未知 code 原样记录，不解释为 FAIL |
| §3.4 事件/投影精确字段 | `docs/research/validation-env.md` 的场景脚本 | 以探针实测记录为准；判据只看 `type/seq/turn/reason.kind` 与 `userQuestions.active.length`，不依赖未验证字段 |
| §5.1 `update` 语义 | 同上（存储探针） | 按本文件 §5.1 已核实的"原子读改写 + 应用层 version"口径 |

---

## 12. 风险与开放项（交 lead 裁定，不阻塞 V0 执行）

1. **能力面板版本漂移**：现场 1.19.3 ≠ NEXT-PHASE 的 1.19.2。V1 证据必须写死版本；M0 安装前由 devops 再核一次，版本变化则重跑 V1（只重跑 C1/C2/C3）。
2. **capabilityPanel 是 thunk**：已现场证实。若后续版本改回对象，实现用 §2.3 的双形状解析，不需要重开设计。
3. **V5 两层模式的工具扩展**：属 `tools/jev-eval.mjs`（评估工具），由 backend 实现；若 backend 未排期，V5 的 B 模式结论记 BLOCKED，不得用 A 模式冒充。
4. **审批场景的制造**：探针执行环境若无法稳定触发审批，V2-C4 记 BLOCKED 并改用 Client 侧 `pendingInteraction` 快照 + 会话事件配对证据，交 lead 判断是否可视为 PASS。
5. **注入文本截断阈值 8KB**：沿用 ARCHITECTURE §2.2；若实测会话消息上限不同，以实测为准并回写蓝图，不改本协议判据的"逐字/头尾相等"要求。
