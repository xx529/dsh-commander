# DSH Commander · M0/M1 实现蓝图

> **2026-11-22 定案更新**：任务状态机、工具契约、看板与依赖编排以 `docs/architecture/task-state-machine-final.md` v1.0 为准；本文 §9.4/§10.3 已同步。


> 版本：v1.0　日期：2026-11-17
> 角色：architect（只写架构/协议文档，不写生产代码）。本文件把 `docs/NEXT-PHASE.md` §4/§5 与 `docs/ARCHITECTURE.md` v2.4 落成**可直接照做**的实现契约。
> 读者：backend（Host）、frontend（Client）、tester、devops。
> 冲突处理：本文件不新增产品概念、不改冻结决策（NEXT-PHASE §2 十条）；与现场 API 事实不一致处一律在 §15 列出（D1/D2/D9 已裁定，见 §15.1），**实现不得自行改冻结设计**。

---

## 0. 依据与硬边界

| 依据 | 用途 |
|---|---|
| `docs/NEXT-PHASE.md` §2 | 十条冻结决策（指挥官是普通会话、只注入最后回复、无 scheduler、任务记录唯一真相、Jev 全量优先、能力交给面板、审批只在界面、看板自主维护、一期只在 DSH、不新增概念） |
| `docs/NEXT-PHASE.md` §4/§5 | M0/M1 范围、验收、代码结构、DoD |
| `docs/ARCHITECTURE.md` v2.4 | 数据模型、工具、Jev、状态机、注入规则 |
| `docs/PRODUCT-DESIGN.md` v1.8 | 设置页分组、看板列、确认卡、职责边界 |
| `docs/research/dsh-capabilities.md` | 已核实的 DSH 扩展点（槽位、`sessionController`、`turn/end`、`storageDomain`、`webServer`、审批双处渲染） |
| `docs/architecture/validation-protocol.md` | V1–V5 门禁；**V1–V5 全过才进 M0** |
| `docs/research/capability-panel-api.md`（scout，待产出） | `capabilityPanel` 精确形状；本文件 §6 以其为准，产出前按 §6.1 的实测形状实现 |

**本文件不覆盖**：产品文案、原型视觉细节（见 `prototype/README.md`）、V6–V8 验证协议细节（见 NEXT-PHASE §3）。

---

## 1. 仓库与包布局

```
/Users/lzx/Documents/GitHub/dsh-commander/
├── package.json                     # 根：pnpm workspace（仅 packages/*）
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── packages/dsh-commander/          # 唯一的插件包（双半 bundle）
    ├── package.json                 # dsh.bundle.patch + dsh.client 双半
    ├── cordis.patch.yml             # 插入 commander host 行
    ├── tsconfig.host.json           # Host：tsc → lib/host/
    ├── tsconfig.client.json         # Client：tsc 类型检查（由 tsdown 转译）
    ├── tsdown.config.ts             # Client：→ lib/client.js（模块表 lazy factory）
    ├── locale/{en,zh}.json          # 插件管理页 meta.title/description
    ├── docs/DETAIL.md               # 插件详情页（单图 markdown，可后置）
    ├── icon.svg                     # 插件图标（≤256KiB，原创/可再分发）
    ├── src/
    │   ├── host/
    │   │   ├── index.ts             # name/inject/Config + apply() 装配顺序
    │   │   ├── config.ts            # 运行期常量（默认阈值、预算、限长）
    │   │   ├── domain.ts            # commanderDomain（7 表，per-record，v1）
    │   │   ├── schema.ts            # zod schema（7 表记录 + 枚举）
    │   │   ├── store/               # 每表一个仓储，唯一写者
    │   │   │   ├── config.ts  workspaces.ts  commands.ts  tasks.ts
    │   │   │   ├── dispatches.ts  boardEdits.ts  sessions.ts
    │   │   ├── tools/               # 模型工具（create/get/update/dispatch/list/report；只注册到指挥官会话）
    │   │   │   ├── index.ts         # 统一 registerForCommander(agentCtx)
    │   │   │   ├── commander_task_create.ts  commander_task_update.ts  commander_task_dispatch.ts  commander_task_list.ts
    │   │   │   ├── commander_task_report.ts   # M3：整理最后回复为验收/证据（不评估）
    │   │   ├── dispatch/            # 派发编排（无对话状态机）
    │   │   │   ├── candidates.ts    # 候选构造（两段式）
    │   │   │   ├── gate.ts          # 纯函数门控
    │   │   │   ├── service.ts       # commander_task_dispatch 全流程
    │   │   │   ├── capability.ts    # capabilityPanel 适配（软依赖）
    │   │   │   └── spawn.ts         # 建会话 + 能力 + prompt brief
    │   │   ├── jev/                 # 派发 Jev 客户端（与能力面板 Jev 分离）
    │   │   │   ├── client.ts        # HTTP、超时、重试、key 解析
    │   │   │   ├── request.ts       # state/questions 构造
    │   │   │   └── parse.ts         # answers → probabilities/confidence
    │   │   ├── trigger/             # M3 启用：turn/end → 最后回复注入（M1/M2 不注册）
    │   │   │   ├── subscribe.ts     # ctx.on('session/event')
    │   │   │   ├── extract.ts       # 最后 assistant 文本 + 截断
    │   │   │   ├── pending.ts       # 审批/提问挂起判定
    │   │   │   └── inject.ts        # 去重 + 投递队列
    │   │   ├── session/             # 指挥官绑定 / 懒 resume / 投递
    │   │   │   ├── binding.ts  deliver.ts  resume.ts
    │   │   └── api/                 # /commander/* + SSE
    │   │       ├── server.ts        # webServer.register
    │   │       ├── state.ts         # 快照构造
    │   │       ├── sse.ts           # 事件中心（rev + 广播）
    │   │       └── routes/          # 每路由一个 handler（M0/M1/M2/M3 分文件）
    │   └── client/
    │       ├── index.tsx            # dsh.client 入口：apply + slots
    │       ├── overlay.tsx          # 球 + 面板（M0 空面板）
    │       ├── settings/            # 设置页四组（M0 骨架）
    │       ├── board/               # M2：main keyed `commander-board` 整页（看板六列/卡片/详情抽屉/回收站）
    │       ├── approval/            # M3：shell.overlay 审批悬浮卡（读 pendingInteraction，不注册第二 answerer）
    │       ├── state.ts             # SSE 客户端 + 视图状态
    │       └── api.ts               # /commander/message + SSE 客户端（不直连 ctx.remote.session；见补丁 §1）
    └── tests/
        ├── fakes/                   # 契约型 fake（见 §13.3）
        ├── unit/  integration/  e2e/
```

**包名与行 id**（固定）：包名 `dsh-commander`；bundle 行 id `commander`；`dsh.client` 模块 id 等于包名（模块表按包名注册）。

**根 workspace**：`pnpm-workspace.yaml` 只有 `packages/*`；根 `package.json` 只放 scripts 转发，不装依赖。

---

## 2. 双半 bundle 清单

### 2.1 `package.json`（关键字段）

```json
{
  "name": "dsh-commander",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" },
  "exports": {
    ".": "./lib/host/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["lib", "cordis.patch.yml", "locale/*.json", "docs", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  },
  "scripts": {
    "build": "pnpm run build:host && pnpm run build:client",
    "build:host": "tsc -p tsconfig.host.json",
    "build:client": "tsdown",
    "typecheck": "tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit",
    "test": "node --test tests/unit/*.test.ts tests/integration/*.test.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsdown": "^0.4.0",
    "@types/node": "^22.0.0"
  }
}
```

- `dsh.client.inject` 只做**装配顺序**声明（谁先谁后），不授予能力；`shell.overlay`、`settings.section` 的注册仍靠 `ctx.slots.inject`。`@deepseek-ai/dsh-client-ui-layout` 提供 `shell.overlay`，`@deepseek-ai/dsh-client-ui-settings` 提供 `settings.section` 契约；**M0 不依赖 `@deepseek-ai/dsh-api-remotes`**（消息走 Host `POST /commander/message`，见补丁 §1.2）。
- **零运行时依赖**：Host/Client 都不 `import` 任何 `@deepseek-ai/*` 包（避免 peer 解析与版本锁）。所需的少量类型写在 `src/host/dsh-types.ts`（§3.1），Client 只依赖浏览器模块表里的 `react`、`react-dom`、`react/jsx-runtime`。
- `engines.dsh` 必须声明；安装/启动时 dsh 会校验（见 `docs/user/develop/basic/publish.md`）。

### 2.2 `cordis.patch.yml`

```yaml
# 双半 bundle：Host 行由本 patch 插入；Client 半由 dsh.client 扫描，
# 不进 patch。安装到 profile 后由 dsh 把 packages/dsh-commander 追加到
# dsh.profile.bundles。
- insert:
    - id: commander
      name: 'dsh-commander'
```

- 不写 `config`（运行期配置全部落 `commander` 域；patch config 只留给调试开关，M0 不需要）。
- 不覆盖任何既有行；不 `disabled` 别的插件。

### 2.3 展示资源（M0 必须齐）

- `locale/en.json` + `locale/zh.json`：`meta.title`、`meta.description`（一句话能力描述）、可选 `meta.detail: "docs/DETAIL.md"`。文案只写已实现行为。
- `icon.svg`：原创或可再分发，≤256 KiB，包内相对路径。
- `docs/DETAIL.md`：单图 markdown；M0 可先写功能/用法/限制三段，图片可后补（缺失会导致详情页显示失败，不阻塞功能）。

---

## 3. Host 模块边界

### 3.1 `index.ts`（组合根，唯一 export apply/inject/Config）

```ts
export const name = 'commander'
export const inject = ['storageDomain', 'webServer']   // 唯一强依赖；sessionController/sessions/workspaceRegistry/capabilityPanel 全部 ctx.get 软解析（M0/M1 实现口径，复核 C4）
export function apply(ctx, config) { … }
```

- **只强依赖 `storageDomain` + `webServer`**：缺任一即抛清晰错误（存储不可用时拒绝启动，不静默降级内存）；`sessionController`/`sessions`/`workspaceRegistry`/`capabilityPanel` 全部 `ctx.get` 软解析——缺失时对应功能降级（未绑定/健康面板 absent/派发 rejected），**不阻塞插件启动**（M0-4/M1-4）。面板通过 `ctx.get('capabilityPanel')` 软解析（§6.1）。
- 所有注册用 `ctx.effect`/`ctx.on` 收尾，disposer 幂等。
- **装配顺序（固定，不可换）**：

```
1. domain.open(commanderDomain)         → 仓储可用（失败则插件初始化失败，报错清晰）
2. store 实例化（7 仓储，唯一写者）
3. config 读写就绪；若 config.singleton 不存在 → 写默认配置（不建会话）
4. binding 就绪：读 config；不主动 resume；若从未绑定 → 标记 unbound（M0 首次由设置页/首次消息触发绑定）
5. api.server 注册路由 + SSE hub（依赖 store + sse）
6. trigger.subscribe（依赖 store + sessionProjections + session.deliver）
7. session.deliver 就绪（依赖 sessionController；懒 resume 在首次投递时发生）
8. tools.installCommanderTools（全局定义对象 + `when` 限定当前指挥官会话；M1 才真正注册）
```

启动期**不调用** `sessionController.create`/`prompt`：指挥官绑定与首次消息由用户动作触发（设置页绑定 / 面板发消息 / 事件注入）。这样插件重载不会因 Host 未就绪而卡住。

### 3.2 `dsh-types.ts`（本地最小类型）

只声明本插件实际用到的形状（避免 import DSH 包）：

- `CordisContext`：`get(name, strict?)`、`on(event, listener)`、`effect(fn)`、`logger`。
- `SessionController`：`create(req)`、`selectModel(req)`、`prompt(req, signal?)`、`cancel(req)`。
- `StorageDomain`：`open(spec)` → `Domain`；`Domain.table(name)` → `{ get/entries/keys/put/update/delete/deleteMany/size }`。
- `Session`：`id`、`header`、`seq`、`events`、`eventAt(seq)`。
- `SessionEvent`：`{ seq, type, data }`（联合类型按 §7 用到的分支窄化）。
- `SessionProjections`：`snapshot(session)`（读 `userQuestions` 视图）。
- `WebServer`：`register({ kind, path, handler })`。
- `Tools`：`register(definition, { when })`（**全局**注册 + step 级 `when` 限定；注册到 agent 作用域会丢失插件归属）。
- `CapabilityPanel`：thunk 或对象形态 + `jev.{getConfig,rank,apply}`。

### 3.3 模块依赖方向（禁止反向依赖）

```
api → store
trigger → store + sessionProjections + session.deliver
dispatch → store + jev + dispatch.capability + spawn + session.binding
tools → store + dispatch.service + session.binding
session.deliver → sessionController + session.resume
store → domain
index → 全部（只装配，不含业务逻辑）
```

- `trigger` 不得 import `dispatch`；`api` 不得 import `trigger`。
- 纯函数（gate、去重键、截断、candidates）不得依赖 ctx，必须可单测。

### 3.4 各文件职责 / 禁止事项

| 文件 | 职责 | 禁止 |
|---|---|---|
| `domain.ts` | `defineDomain` v1、per-record、7 表 | 新增表/全局槽；改 version |
| `schema.ts` | 7 表 zod schema + 枚举 | 用 `unknown` 放行；允许 null |
| `store/*.ts` | 单表 CRUD + key 归一化 + version 自增 + timeline 上限 | 跨表事务；Client 直写 |
| `tools/*.ts` | 模型工具定义（`defineTool`）与参数校验 | 在工具里绕开 service 直接写 store |
| `dispatch/*.ts` | 候选、门控、Jev、能力、建会话、写记录 | 编排对话流程；自建能力目录/阈值 |
| `jev/*.ts` | 派发 Jev HTTP 客户端 | 复用能力面板的 Jev 配置/Key；记录明文 Key |
| `trigger/*.ts` | 订阅事件、取最后回复、判 pending、去重注入 | 轮询 `agent/status`；注入中间事件 |
| `session/*.ts` | 绑定、懒 resume、串行投递 | 启动时主动建会话；直接 answer 审批 |
| `api/*.ts` | 路由 + 快照 + SSE | 业务写逻辑（必须走 store/dispatch）；第二个 SSE 端口 |

---

## 4. `commander` 域（7 张表 · 照搬 ARCHITECTURE §3.2/3.3/3.4）

### 4.1 声明

```ts
export const commanderDomain = defineDomain({
  name: 'commander',
  version: 1,
  layout: 'per-record',
  tables: {
    config:     domainTable(ConfigRecordSchema),
    workspaces: domainTable(WorkspaceRecordSchema),
    commands:   domainTable(CommandRecordSchema),
    tasks:      domainTable(TaskRecordSchema),
    dispatches: domainTable(DispatchRecordSchema),
    board_edits: domainTable(BoardEditRecordSchema),
    sessions:   domainTable(SessionLinkRecordSchema),
  },
})
```

> **平台契约修正（Lead 裁定 2026-11-17）**：第 6 张表名由 `boardEdits` 改为 `board_edits`。原因：DSH `storageDomain` 的 per-record 表名必须匹配 `/^[a-z][a-z0-9_]*$/`；V4 实测中驼峰表名被 `defineDomain` 与 `json` 后端双重拒绝（`table name 'boardEdits' must match …` / `invalid table name 'boardEdits' in unit 'commander'`），域根本无法 open。适配范围：**只改表名**——键仍为 `editId`、接口 `BoardEditRecord` 字段不变、`layout: 'per-record'` 与 `version: 1` 不变、语义不变；改后 V4-C1–C7 全部通过。证据：`docs/validation/v4-storage-domain.md`；上游修正记录见 `docs/ARCHITECTURE.md` 文首。（`src/host/store/boardEdits.ts` 只是仓储模块文件名，不是表名，保持接口/模块命名与 `BoardEditRecord` 一致，无需改动。）`docs/NEXT-PHASE.md` 中的 `boardEdits` 提法是平台适配前的口径，以本文件 `board_edits` 为准（NEXT-PHASE 不做修改）。

### 4.2 表与 key（不新增表、不改 key 语义）

| 表 | key | 内容 | 保留 |
|---|---|---|---|
| `config` | `singleton` | 指挥官绑定、Jev、board、ui、updatedAt | 永久 |
| `workspaces` | `workspaceId`（归一化，见 §4.4） | 白名单、摘要、能力策略 | 永久 |
| `commands` | `commandId` | 用户原话（≤8KB）、会话、seq、taskIds | 与任务同寿命 |
| `tasks` | `taskId` | **权威任务记录**（状态 + 有界 timeline） | 归档后 90 天 |
| `dispatches` | `decisionId` | 候选、Jev 输出、最终选择 | 1 年 |
| `board_edits` | `editId` | 人工改动 + 注入状态 | 90 天 |
| `sessions` | `<workspaceId>__<sessionId>`（两段都归一化） | 会话↔任务↔角色、`lastInjected` | 与任务同寿命 |

字段与类型**逐字照搬** `docs/ARCHITECTURE.md` §3.3 的 interface（`ConfigRecord/WorkspaceRecord/CommandRecord/TaskRecord/AcceptanceItem/CapabilityPlan/TaskTimelineItem/DispatchRecord/SessionLinkRecord/BoardEditRecord`）。实现时把这些 interface 原样转成 zod schema；**任何字段增删必须先改 ARCHITECTURE 并由 lead 批准**。

### 4.3 写入协议（实现约束）

1. **单写者**：只有 Host 写域；Client 一律走 `/commander/*`。
2. **单记录更新**：一次状态迁移只 `update` 一条 `tasks` 记录（timeline 追加在回调里完成）；无跨表事务。
3. **原子读改写**：一律用 `table.update(key, fn)`；`version` 只在回调里 `+1`；缺失 key 视为 bug（先 `put` 再 update）。
4. **幂等**：工具调用带 `requestId`；注入去重用 `sessions.lastInjected`；人工改动用 `board_edits.injectionKey`。
5. **key 归一化**（`sanitizeKey`）：保留 `[a-zA-Z0-9_-]`，其余字符替换为 `-`；若发生替换，追加 `--` + `sha1(raw)` 前 8 位 hex 防碰撞；结果仍匹配 `[a-zA-Z0-9_-]+`。id 生成规则：`task_`+时间戳36进制+6位随机、`cmd_`/`edit_` 同法；`decisionId = 'dec_' + sha256(taskId + '\u0000' + requestId).slice(0,24)`（确定性，便于幂等回放）。
6. **timeline 上限**：≤100 条；超过时把最旧 20 条压成一条 `{type:'status', text:'…（已折叠 N 条）'}` 摘要，保留首条 `created`。
7. **崩溃恢复**：记录本身完整；未完成工具调用由调用方重试；注入失败按 `lastInjected` 补一次；`dispatches` 终态记录即幂等回放源。
8. **归档**：`tasks.status='archived'` 时 timeline 压成 1 条摘要，记录保留。

### 4.4 存储目录与路由

- 物理位置由 `storageDomain` 后端决定（推荐 `json`，`root: ~/.dsh/storages`）；插件**不直接碰文件**。
- `domain.close()` 挂在 `ctx.effect` disposer 上（facility 也会兜底关闭）。
- 若 profile 未配置 `storageDomain` 路由：插件初始化失败并打印明确错误（不静默降级到内存，避免"看起来能跑但重启丢数据"）。

---

## 5. 指挥官会话绑定与 resume 生命周期

### 5.1 绑定记录

`ConfigRecord.commander = { workspaceId, workspacePath, sessionId, model, agentPreset?, rotation? }`。

`rotation` 为 R1 加法字段（见 §5.6 与 `rotation-contract-patch.md`）；缺省时行为与本条历史版本完全一致。

### 5.2 状态与转移

| 状态 | 触发 | 行为 |
|---|---|---|
| `unbound` | `config.singleton` 缺失或 `commander.sessionId` 为空 | 面板显示"未绑定"；发消息前先引导绑定（设置页或首次消息自动建） |
| `bound` | 写 config 成功 | 不主动 resume；所有投递走懒 resume |
| `rebound` | 设置页"绑定到新会话/选择已有" | 写新 `sessionId`/`workspacePath`；**旧会话保留在 DSH，不删除**；`sessions` 表中旧 commander link 标 `missing` 但有界保留；**不生成交接简报**（R1/D1） |
| `rotated` | `POST /commander/rotation` 或到点自动换任（仅 `rotation.enabled=true`） | 见 §5.6：新会话 `create → inject(交接简报) → 写 config → 旧 link 标 retired`；旧会话退役不删除，可人工绑回 |

### 5.3 懒 resume（关键设计）

- **启动不 resume**：Host 启动只读 config，不调用 `sessionController`。
- 首次需要给指挥官投递（用户消息 / `turn/end` 注入 / 看板改动）时：`sessionController.prompt({ requestId, sessionId, mode:'queue', content })` —— 该调用自身会 resolve 并 resume 已有会话（V3-C5 已验证此路径）。
- resume 失败（`session/writer-held`、会话不存在）：`binding.markBroken(reason)`，把错误推给设置页（面板顶部红条），不自动新建会话（避免静默丢记忆）；用户可"绑定到新会话"。
- 插件重载/升级后不新建会话：绑定 id 不变，懒 resume 自然复用。

### 5.4 首次绑定（M0）

1. 用户在设置页点"绑定到新会话"：`POST /commander/binding { mode:'new', workspaceId }`。
2. Host：`sessionController.create({ workspaceId, agentPreset })` → `sessionId`；可选 `selectModel(config.commander.model)`；写 config；在 `sessions` 表写 `{role:'commander', taskId:'', mode:'new', status:'idle'}`。
3. 也可"选择已有会话"：`mode:'select', sessionId, workspaceId` → 校验会话存在且 cwd 属于该 workspace（`sessionQuery`/列表只读）→ 写 config。
4. 重绑不删旧会话、不迁移历史。

### 5.5 投递队列（`session.deliver`）

- 全局串行队列（一次只给指挥官一个 prompt）；投递前若指挥官有进行中的 turn（`sessions`/`agents` 状态不可直接读，则以 `sessionController.prompt` 的 `accepted` 为准），后续消息按 `queue` 模式排队。
- 同一工作会话连续两次停止：合并为一条（只保留最新 `turn/end`），在队列里替换未发出的同 `sessionId` 项。
- 投递失败（会话丢失）：写 `sessions.status='missing'`，任务转 `blocked`（code=`commander_delivery_failed`），下次成功投递前只累积不重试风暴（最多补一次）。

### 5.6 会话轮换（R1，默认关闭）

> 唯一口径：`docs/architecture/rotation-contract-patch.md`（本小节只列骨架）。用户 2026-11-19 决策：默认关；周期 1–7 天；`turn/end` 触发 + 投递前兜底；简报含用户最近原话；context 注入交付。

- **开关**：`config.commander.rotation = { enabled(false), periodDays(1, 1..7), includeUserTail(true), generation?, generationStartedAt? }`。关闭时无任何行为差异，唯一路径仍是设置页「绑定到新会话」，且**不生成简报**。
- **到点判定**：`now - generationStartedAt >= periodDays*86_400_000`（纯时间差，无定时器、无 scheduler）。
- **门控**：不 busy + 无 `pendingDispatch` + 无未 flush 的看板注入 + 无并发换任 + 本周期有活动；不满足则跳过、下次边界重试。
- **触发**：① 指挥官会话 `turn/end`（异步、不阻塞）；② `POST /commander/message` 在 `admit()` 之后、`prompt()` 之前兜底换任（失败不阻塞投递）；③ 手动 `POST /commander/rotation`（`force` 跳过周期/活动判定）。
- **简报**：`buildHandoffBrief` 纯函数，从 tasks + 旧会话用户原话确定性生成，≤4096 字；不含 Jev 配置/工具结果/审批内容。
- **注入**：`agents.get(newSessionId).inject(buildContextMessage(brief, {kind:'commander-handoff', summary, generation}))`；不唤醒、不产生用户气泡、不额外调用模型。
- **提交顺序**：`create → inject → 写 config（提交点）→ 旧 link=retired + 新 link`；提交前任一步失败都保持旧绑定，**不调用 `markBroken`**。
- **状态**：`sessions.status` 增 `'retired'`（与 `'missing'` 区分）；旧会话不删除、不 archive，可用 `mode:'select'` 绑回。
- **接口**：`POST /commander/rotation`；`GET /commander/state` 增 `rotation` + `formerCommanders`（≤10）；SSE 增 `rotation.updated`；错误码 `rotation_disabled`/`rotation_busy`/`rotation_failed`。
- **不新增**表、工具、DSH 事件类型；不新增第三方依赖。

---

## 6. capabilityPanel 软依赖与 auto 调用顺序

### 6.1 解析（软依赖，唯一入口 `dispatch/capability.ts: resolvePanel()`）

```ts
const raw = ctx.get('capabilityPanel')            // 可能 undefined
const panel = typeof raw === 'function' ? raw() : raw   // 1.19.3 现场是 thunk
if (!panel || typeof panel.jev?.rank !== 'function' || typeof panel.jev?.apply !== 'function') return undefined
return panel
```

- **每次调用重新解析**（不缓存），因为面板可能后加载/热重载。
- 面板缺失、形状不符、解析抛错：记录 `reason`（`panel_unavailable` / `panel_shape_mismatch` / `panel_threw`），策略回退 `inherit`，**不阻塞派发**。
- 不读也不写面板的配置文件；只用 `panel.jev.getConfig()` 的**返回视图**取阈值（§6.3）。

### 6.2 触发条件

只有**新建会话**且该工作区 `capabilityPolicy.mode === 'auto'` 时调用；`attach` 到已有会话不调用（沿用会话自身配置）。策略默认 `inherit`。

### 6.3 auto 调用顺序（固定）

```text
1. sessionController.create({ workspaceId | cwd, agentPreset })   → sessionId
2. threshold = (await panel.jev.getConfig()).decisionThreshold ?? 0.5   // 面板所有，默认 0.5
3. rank = await panel.jev.rank({ sessionId, draft, cwd })
4. plan = rank.items.filter(i => i.applicable && i.score >= threshold)
                 .map(i => ({ id, kind, name, enabled: true }))
5. apply = await panel.jev.apply({ sessionId, plan, cwd })
6. sessionController.prompt({ requestId, sessionId, mode:'queue', content: briefText })
```

规则：

- **`draft` 内容**：`任务标题 + 目标 + capabilityNeeds`（指挥官润色后的能力需求，≤40 字/项），不超过 8000 字符（面板入参上限）。
- **阈值不落本插件配置**：来自面板 `decisionThreshold`；读不到时用 0.5 并在 `CapabilityPlan.reason` 注明 `threshold_defaulted`。
- **rank 的失败码**分两类：`bad-request/empty-capabilities` → 记 `status='fallback'`（面板无可用能力，等价 inherit）；`no-config/network/auth/timeout` → `status='fallback'` + 原因。两者都继续派发。
- **apply 的结果映射**（面板返回计数而非名称列表，已裁定见 §15.1-D1）：记录里**只写提交给 `apply` 的 plan 项 name**，不写计数、不新增字段。
  - 成功：`status:'applied'`，`enabled` = 第 4 步提交的 plan 项 `name`（去重排序）；`disabled` = 同一次提交中显式 `enabled:false` 的 name（M1 的 plan 只提交 `enabled:true`，故 `disabled` 为 `[]`）；`durationMs` = `apply.elapsedMs`；
  - 展示摘要（`启用 N 项 / 未启用 M 项`）由 rank 结果**另行派生**，只进确认卡/详情/SSE 摘要，不写入 `CapabilityPlan`；
  - 冷会话 `pending:true`：仍记 `status:'applied'`，`reason:'pending_replay_on_agent_created'`；后续 `agent/created` 后以 `rank` 的 `enabledInSession` 复核一次并更新 `WorkspaceRecord.capabilityPolicy.lastSelection`；
  - `failed` 非空或 `ok:false`：已裁定（§15.1-D9）—— **能力面板不可用 / rank / apply 失败一律回退 inherit 并继续派发**，记 `status:'fallback'`、`reason:'apply_failed'`，**不 blocked、不中止会话创建**；M1 不产生 `CapabilityPlan.status='failed'`；ARCHITECTURE §7 的 `capability_apply_failed → blocked` 属旧口径，以冻结决策 7 + §4.3 为准。
- 结果写两处：`TaskRecord.capabilities`（派发提交后不可变）与 `WorkspaceRecord.capabilityPolicy.lastSelection`（摘要）。
- 确认卡/任务详情只展示摘要：`启用 N 项 · 禁用 M 项 · 耗时 Xms`（`reason` 时显示 fallback 原因），不展开目录。

### 6.4 与 Jev 的边界

- 派发 Jev（§9）负责"选工作区/会话"；能力面板 Jev 负责"选能力"。两者**配置独立、互不读取**：派发 Jev 用本插件 `ConfigRecord.jev`（默认 `JEV_API_KEY`），能力面板用面板自己的 Jev 配置（默认 `TYPESAFE_API_KEY`）。实现不得把两者混用或互相写配置。

---

## 7. `turn/end` 触发与去重（trigger）

> **范围（Lead 2026-11-17/18 裁定）**：本章的 **`turn/end` 最后回复注入属 M3**。M1/M2 **只**订阅 `turn/start` 做机械状态更新（task `queued→running`）与 `sessions.status` 维护；**不注册 `turn/end` 注入、不写 `lastInjected`、不调 `session.deliver`**。以下 §7.1–§7.6 为 M3 的实现契约（M3 启用；细节与 §7.5 格式以 `m2m3-contract-patch.md` §3.1 为准）。

### 7.1 订阅

```ts
ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') handleTurnEnd(session, event) })
```

- DSH 没有独立的 `ctx.on('turn/end')`；`turn/end` 是**会话事件类型**，经 `session/event` 到达（payload：`event.data = { turn: number, reason: TurnEndReason }`，`event.seq` 为事件 seq）。
- 只处理 `sessions` 表中存在的 `role:'work'` 会话（有任务绑定）；指挥官会话自身的事件永不再注入。
- 只在 `reason.kind ∈ {'completed','error','blocked','max-tokens'}` 时进入注入；`aborted`、`interrupted` 跳过（原因写入观测日志，不写任务记录）。

### 7.2 取最后回复

1. 在该会话事件日志中，从 `turn/end.seq` 向前找最近的 `turn/start`（同 `turn` 号），得到区间 `[startSeq, endSeq)`。
2. 区间内**最后一个** `assistant/message` 即"最后回复"；`lastSeq = event.seq`。
3. 拼装 `data.message.content` 中 `type==='text'` 的 block（按顺序）。
4. 空文本：默认注入一条 `[session-reply] 本轮无文本回复`（配置项 `injectEmptyReply` 默认 `true`，放 `ConfigRecord.board` 之外的域字段？→ 见 §15.2-D4：M1 先用常量，M3 再暴露配置）。
5. 长度 > 8KB：保留头 6KB + 尾 2KB，中间 `\n…[truncated N bytes]…\n`，并标 `truncated:true`。

### 7.3 pending 判定（不注入的唯一真条件）

两路信号任一成立即判 pending：

1. **审批**：该会话日志中最近一条 `approval/asked` 没有配对的 `approval/decided`（`approval/asked`/`approval/decided` 是会话事件类型；按 `approvalId` 配对）。
2. **用户提问**：`ctx.sessionProjections.snapshot(session)` 的 `userQuestions` 视图中 `active.length > 0`。

pending 时不注入，但把该停止记入观测计数（`skipped_pending`）与 `sessions` 的待处理标记；**不轮询、不重试**（一旦会话再次停止（新 `turn/end`）自然重新判断）。若同一 turn 在审批恢复后**没有**新的 `turn/end`（因为审批发生在 turn 内），则以审批恢复后的第一个 `turn/end` 为准。

### 7.4 去重

- 键：`<sessionId>:<turnId>:<lastSeq>`（`turnId = event.data.turn`）。
- 存储：`SessionLinkRecord.lastInjected = { turnId, seq, at }`；写入用 `sessions.update`。
- 判定：若 `lastInjected.turnId === turnId && lastInjected.seq === lastSeq` → 跳过（`reason='duplicate'`）。
- 注入成功后立即写 `lastInjected`（先写后投递？→ **先投递成功再写**，投递失败允许补一次；补一次后无论成败都写，避免风暴）。
- 同一会话连续停止合并：若投递队列中存在同 `sessionId` 未发出项，替换其内容而不是新增。

### 7.5 注入文本格式

```
[session-reply] <最后回复原文>
---
taskId=<id> sessionId=<id> turnId=<n> seq=<n> truncated=<bool>
```

- 这是 Host 生成的普通用户消息（`content:[{type:'text',text}]`），**不是用户原话**；指挥官收到后按普通回合处理，可以只回一句，也可以调工具更新看板。
- 审批/提问全文、tool/result、进度一律不注入（§7.3）。

### 7.6 观测（不落任务记录）

内存计数器 + `/commander/state` 暴露 `metrics`：注入次数、去重数、pending 跳过数、注入失败数、注入到回复时延（若可从指挥官 `turn/end` 关联，M3 再算）。

---

## 8. `/commander/*` HTTP + SSE 契约

> **M0 实现以 `docs/architecture/m0-contract-patch.md` 为准（sha256 `4e8bfb930057a5e9b481f64171db8c88371c7a2d956594d404a96f7a9d447354`），本节已合并其 §1/§2 口径**：面板消息通道（`POST /commander/message`、`commander.message`/`commander.status`、快照 `messages`/`commanderBusy`）、三个设置写接口 schema 与新增错误码。两处冲突时以补丁为准；补丁保留为详细契约与历史（不删除）。
>
> **M1 实现以 `docs/architecture/m1-contract-patch.md` 为准（sha256 `23e2d17544ad745c4f38dd66c7e007a2edd948f19b271e4a933cc0ccb005c2f9`），本节 §8/§9/§11 已合并其 §1–§4 口径**：全确认语义（`autoDispatch=false`、首次恒 `needs_confirmation`、decision TTL/幂等）、`pendingDispatch` 完整字段 + `dispatch.updated`、`GET /commander/tasks/:id`、`POST /commander/jev/test`、`tasks[]` capability 摘要。冲突以补丁为准；补丁保留为详细契约与历史（不删除）。
>
> **M1R/M2/M3 以 `docs/architecture/m2m3-contract-patch.md` 为准（sha256 `28a1c1d75142c53f34392439bb2617748e35789638833c356f2857ba8d65e265`），本节 §8/§10/§11 已合并其 §1–§4 口径**：M1 余项自定义 attach（`GET /commander/sessions`）、M2 看板整页与人工改动/归档/停滞徽标/`[board-edit]` 注入、M3 turn/end 注入 + `commander_task_report` + 审批悬浮卡 + accept/continue + 播报。**M2 看板入口默认「主面板整页」（`main` keyed `commander-board`）；右侧栏 tab 仅保留为后续可选，本轮不实现。** 冲突以补丁为准。

### 8.1 注册方式

```ts
ctx.webServer.register({ kind: 'prefix', path: '/commander', handler: dispatch })   // 一条前缀路由
```

- 前缀路由内按 method+path 分发；handler 拥有完整响应生命周期（SSE 直接持有 `res`）。
- Desktop 下页面同源 `dsh-app://app/commander/...` 经壳反代可达（`docs/research/dsh-capabilities.md` §2.7 已核）；M0 验收含一次真实可达性检查。
- 不新增第二个端口、不复用 `/api` RPC 信封。

### 8.2 路由表（按里程碑）

| 里程碑 | Method + Path | 用途 | 写盘 |
|---|---|---|---|
| M0 | `GET /commander/state` | 快照；`Accept: text/event-stream` 时升级为 SSE | 否 |
| M0 | `GET /commander/health` | `{ok, version, panel:'present'\|'absent', binding:'bound'\|'broken'\|'unbound'}`（`broken` 为 M0 复核 C2 增补：绑定会话不可恢复） | 否 |
| M0 | `GET /commander/config` | 只读可展示配置视图（Client 设置页启动探测用；不含 Jev Key 明文；加法只读路由，M0 补丁未列、复核 C2 增补） | 否 |
| M0 | `POST /commander/message` | 面板发用户消息：`{text(≤8192),requestId}` → 校验绑定 → `sessionController.prompt({mode:'queue'})`；返回 `{messageId,accepted,queued,busy,rev}`（见补丁 §1.3） | 否（不落 domain） |
| M0 | `PUT /commander/config` | 设置页保存（指挥官模型/agentPreset、Jev、外观） | 是 |
| M0 | `PUT /commander/workspaces` | 白名单/摘要/能力策略保存（数组整体替换） | 是 |
| M0 | `POST /commander/binding` | `{mode:'new'\|'select', workspaceId?, sessionId?}` | 是 |
| M1R | `GET /commander/sessions?workspaceId=…&limit=` | 自定义确认 attach 的只读会话列表（顶层非归档非子 agent） | 否 |
| M1 | `GET /commander/tasks/:id` | 任务详情（含 dispatch、capabilities、timeline；M2 起补 `boardEdits`/`stale`/`archivedAt`） | 否 |
| M1 | `POST /commander/jev/test` | 派发 Jev 连通性（服务端发一次探针） | 否 |
| M2 | `PATCH /commander/board/tasks/:id` | 人工改看板 `{field:'status'|'priority'|'title', value, editId, requestId}` → 写 tasks + `board_edits` → 30s 合并注入 `[board-edit]`；`done/archived` 拒绝 | 是 |
| M2 | `POST /commander/tasks/:id/archive` | 归档（review/done/cancelled → archived，timeline 压一条） | 是 |
| M2 | `POST /commander/tasks/:id/restore` | 回收站恢复（archived → draft，唯一口径） | 是 |
| M2 | `GET /commander/archive?limit=&cursor=` | 回收站列表（archived/cancelled，只读） | 否 |
| M3 | `POST /commander/tasks/:id/accept` | **唯一验收入口**（人专用） | 是 |
| M3 | `POST /commander/tasks/:id/rework` | 返工，生成续做 brief 并发回原会话 | 是 |
| R1 | `POST /commander/rotation` | 手动/强制换任 `{requestId, force?}` → `create → inject(交接简报) → 写 config → retired`；仅 `rotation.enabled=true`（§5.6 / `rotation-contract-patch.md`） | 是 |

- **派发确认没有专门路由**（冻结决策）：确认卡的"采用建议/自定义"由 Client 向指挥官会话发一条普通消息，指挥官再调 `commander_task_dispatch`。
- 人专用路由只由界面调用，不注册为模型工具。

### 8.3 快照结构（`GET /commander/state`）

```json
{
  "rev": 42,
  "serverTime": 1763450000000,
  "binding": { "workspaceId": "htdot", "workspacePath": "/abs/path", "sessionId": "sess_x", "model": { "provider": "tokfans", "model": "deepseek-flash", "reasoningEffort": "high" } },
  "commanderStatus": "bound",
  "commanderBusy": false,
  "panel": "present",
  "counts": { "draft": 0, "proposed": 1, "queued": 0, "running": 2, "blocked": 0, "review": 0, "done": 3 },
  "tasks": [ { "id": "task_…", "title": "…", "status": "running", "workspaceId": "htdot", "priority": "normal", "primarySessionId": "sess_y", "sessionCount": 1, "capability": { "status": "applied", "enabledCount": 3, "disabledCount": 12, "durationMs": 240 }, "updatedAt": 1763… } ],
  "workspaces": [ { "id": "htdot", "name": "HtDot", "path": "/abs", "allowed": true, "summary": "电商后台…", "policy": "inherit", "lastSelection": null } ],
  "pendingDispatch": { "decisionId": "dec_…", "taskId": "task_…", "recommendation": { "workspaceId": "htdot", "mode": "new" }, "pMax": 0.62, "reason": "low_confidence" },
  "messages": [
    { "messageId": "req_7f3c…", "role": "user", "text": "…", "at": 1763450000000, "order": 41, "truncated": false },
    { "messageId": "asst_4_37", "role": "assistant", "text": "…", "at": 1763450002100, "order": 42, "turnId": 4, "seq": 37, "truncated": true, "fullChars": 12034 }
  ],
  "metrics": { "injections": 12, "deduped": 1, "pendingSkipped": 2, "injectFailures": 0 }
}
```

- `tasks` ≤200 条（按 `updatedAt` 倒序，其余靠 `GET /commander/tasks/:id`）；`rev` 每次快照/事件单调自增。
- `tasks[]` 的 `capability` 摘要（`status/enabledCount/disabledCount/durationMs|reason`）由 `CapabilityPlan` 派生（补丁 §3.2）；M0 恒 `none`，M1 填 applied/fallback/inherit。
- `pendingDispatch`：M0 恒 `null`；**M1 填充完整字段**（`decisionId/taskId/taskTitle/candidates≤8/recommendation/scores{pW,pS,pMax,concentration}/reason/createdAt/expiresAt`，见补丁 §3.1），同时由 `dispatch.updated` 推送；最多 1 条（新覆盖旧）。
- **M2 派生字段**（只读展示，不改任务记录 schema）：`tasks[]` 每项加 `stale`（`queued/running` 且 `now-lastActivityAt>20min`，只读）、`sessionCount`、`acceptanceCount`、`evidenceInsufficientCount`；快照顶层加 `archiveSummary{archivedCount,cancelledCount}`；`tasks` 默认不含 archived（≤200），回收站走 `GET /commander/archive`。
- **M3 派生字段**：`workSessions: [{sessionId,taskId,title?}]`（≤200，派生自 tasks.assignments/primarySessionId + sessions 表）供审批悬浮卡使用；`metrics` 增加注入计数（injections/deduped/pendingSkipped/injectFailures）。
- `messages`：最近 ≤200 条（Host 进程内环 ≤500），按 `order` 升序；`user` 消息 `messageId=requestId`、`assistant` 为 `asst_<turn>_<seq>`；`text` >8192 字符按头 6144 + 尾 2048 截断并标 `truncated:true`/`fullChars`（规则见补丁 §1.6）。消息不落 domain、不打日志；Host 重启后 best-effort 从 live 会话回填 ≤200。
- `commanderBusy`：指挥官会话是否有进行中的 turn（`turn/start`→true、`turn/end`→false；无法判定时默认 false，见补丁 §1.5）。
- **R1 加法字段**（`rotation.enabled=false` 时仍返回，均为只读）：`rotation: {enabled, periodDays, includeUserTail, generation, startedAt, dueAt, due, rotating, lastError?}`；`formerCommanders: [{sessionId, generation, startedAt, retiredAt}]`（≤10，`retiredAt` 倒序，来自 `sessions` 表 `role='commander' && status='retired'`）。详见 `rotation-contract-patch.md` §7.2。
- 快照只含展示所需字段，不含 Jev Key、不含会话正文、不含审批内容。

### 8.4 SSE（`GET /commander/state`，`Accept: text/event-stream`）

- 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 首帧（连接后 ≤200ms）：`event: snapshot` + `data: <§8.3 JSON>`。
- 后续事件（`id:` = `rev`）：

| event | data | 触发 |
|---|---|---|
| `snapshot` | 完整快照 | 连接/重连 |
| `task.updated` | `{task, rev}` | 任务记录任何写 |
| `tasks.changed` | `{counts, rev}` | 计数变化（可与 task.updated 合并发送） |
| `dispatch.updated` | `{pendingDispatch\|null, rev}` | needs_confirmation/确认/取消 |
| `commander.message` | `{messageId, role:'user'|'assistant', text, at, order, turnId?, seq?, truncated?, fullChars?}` | 用户 echo（prompt 接受）/ 助手文本到达（补丁 §1.4/§1.7） |
| `commander.status` | `{busy, lastTurnId, rev, at}` | `turn/start`→busy true、`turn/end`→busy false（补丁 §1.5） |
| `binding.updated` | `{binding, commanderStatus, rev}` | 绑定/重绑/损坏 |
| `rotation.updated` | `{rotation, formerCommanders, rev}` | 轮换开始/提交/失败（R1；见 `rotation-contract-patch.md` §7.3） |
| `capability.applied` | `{taskId, summary, rev}` | auto 结果落盘 |
| `heartbeat` | `{t, rev}` | 每 15s（防止代理超时） |

- 重连：Client 断线后**直接重新 `GET /commander/state` 拉快照**（不实现 Last-Event-ID 增量补齐；DSH 页面内 SSE 断线频率低，快照 ≤200 条可接受）。Client 侧以 `rev` 丢弃乱序旧事件。
- 多标签页：每个连接独立 hub 订阅；写动作仍通过 Host 串行化。
- 关闭：`req.on('close')` 移除连接；插件 unload 时广播 `event: bye` 并 `res.end()`。

### 8.5 错误响应

```json
{ "ok": false, "code": "invalid_request", "message": "…" }
```

| code | 场景 |
|---|---|
| `invalid_request` | 路径/JSON/字段校验失败 |
| `not_found` | task/session/workspace 不存在 |
| `conflict` | 状态机不允许（如 accept 非 review 任务） |
| `panel_unavailable` | auto 请求但面板不可用（仅用于 `/jev/test` 类查询） |
| `binding_required` | 未绑定指挥官（`POST /commander/message` 等）→ 面板引导设置页 |
| `binding_broken` | 绑定会话不存在/`writer-held`/`missing` → 面板红条并引导重绑 |
| `prompt_failed` | `sessionController.prompt` 抛错/`accepted!==true`（脱敏 message） |
| `workspace_conflict` | `POST /commander/binding` select 的会话 cwd 不属于指定 workspace |
| `preset_unknown` | agentPreset 不存在 |
| `create_failed` | `sessionController.create` 失败 |
| `decision_expired` | M1：`commander_task_dispatch` 确认时 decisionId 不存在/过期/已提交（要求重新派发；补丁 §1.5） |
| `decision_required` | M1：确认时缺 decisionId 且无唯一 pending decision（补丁 §1.5 兼容路径） |
| `delivery_failed` | M3：rework 续做 brief 投递失败（502；不改状态，可重试） |
| `storage_error` | 域写失败（附 `retryable`） |
| `internal` | 未分类 |

写操作幂等：body 带 `requestId`；同一 `requestId` 在 5 分钟内重复提交返回首次结果（内存 LRU），不重复写。

---

> **M5 补丁（2026-11-20）以 `docs/architecture/m5-continue-dispatch.md` 为准**：`commander_task_dispatch` 允许 `draft/proposed/review`；`review` 续派 = round+1、上一轮验收进 `acceptanceHistory`、默认原会话、复用 autoDispatch 门控（门控通过可自动开新一轮）；`queued/running/blocked` 仍拒绝。本节以下 M1 规则（draft/proposed 门禁、brief 模板、autoDispatch）按该补丁扩展；`review→running` 已从状态机删除，`review→queued` 只由 dispatch 内部写。

## 9. `commander_task_dispatch` 门控与幂等（M1）

### 9.0 M1 全确认模式（覆盖 §9.2 的"放行"判定；补丁 §1 为权威）

> 用户 2026-11-17 决策：M1 采用全确认（`DEFAULTS.autoDispatch=false` 运行期常量，**不改 `ConfigRecord` 冻结 schema**；V5 指标豁免）。补丁 `m1-contract-patch.md` §1 为本节权威，冲突以补丁为准。

1. **首次调用恒确认**：无论 scores 多高，`commander_task_dispatch` 首次调用都返回 `needs_confirmation`，字段：`decisionId`（`dec_`+sha256(taskId+'\0'+requestId) 前 24 hex）、`candidates≤8`、`recommendation`、`scores{pWorkspace,pSession,pMax=min,concentration=min}`、`reason ∈ {user_confirm_required, jev_unavailable, low_confidence, decision_required}`、`expiresAt=createdAt+30min`。§9.2 第 5 步门控**只计算** recommendation/scores，**不再决定自动放行**；第 6 步**恒执行**。
2. **二次确认**：`commander_task_dispatch({taskId, decisionId, confirmTarget, requestId})`；兼容路径：无 `decisionId` 但带 `candidate` 且该 task 恰有 1 条未用 pending decision → 视为确认（必须 `taskId+requestId`；0 条→`decision_required`、≥2 条→`decision_required`）。通过校验后执行 §9.2 第 7 步。
3. **decision 生命周期**：仅内存（不写 `DispatchRecord` pending 态）；TTL 30min 惰性清理（`commander_task_dispatch` 入口/confirm 查找/state 快照构造时，不新建定时器）；重启或过期 → `rejected(code='decision_expired', message='确认已过期，请重新 commander_task_dispatch')`；同 decision 只提交一次，重复调用**幂等回放**首次 `dispatched` 结果（不新建会话）。
4. **requestId 幂等**：工具层 5min LRU（与 HTTP 路由 LRU 独立）；同 requestId 重复首次调用返回同一 `needs_confirmation`（同一 decisionId）。
5. **确认卡消息协议**（补丁 §2）：卡片三动作只发普通用户消息（`POST /commander/message`），文本含 `[dispatch-confirm]`/`decisionId`/`taskId`/`target`；**不新增确认路由**；指挥官 prompt 约束见补丁 §2.2。
6. **投递失败**：会话创建/`prompt` 失败 → task `blocked(code='session_create_failed'|'delivery_failed')`，不自动重试/不新建第二个会话（plan §5.5）。
7. **自动派发（2026-11-19 用户决策）**：`ConfigRecord.jev.autoDispatch`（可选字段，默认 `false`，可 `PUT /commander/config`）。开启且 `evaluateGate` 通过（Jev 可用、无 conflict、`pWorkspace ≥ workspaceThreshold` 且 `pSession ≥ sessionThreshold`）→ 首次 `commander_task_dispatch` **直接派发**，`dispatches.outcome='auto'`，不创建 pending decision；未通过仍返回 `needs_confirmation`。UI 设置页「派发模式」开关与阈值一起保存。

### 9.1 工具入参/出参

逐字照搬 `docs/ARCHITECTURE.md` §4.1 的 JSON（`taskId/candidate/decisionId/confirmTarget/capabilityNeeds/requestId`；输出 `dispatched|needs_confirmation|rejected` 三支）。实现不得增删必填字段。

### 9.2 Host 内部流程

```text
commander_task_dispatch(args)
├─ 1. 校验：task 存在且 status ∈ {draft, proposed}；requestId 非空；workspace 白名单校验
│     └─ 失败 → rejected(code)（不写盘）
├─ 2. 幂等回放：decisionId 派生（dec_…）；dispatches 有终态记录 → 返回首次结果
├─ 3. 候选构造（candidates.ts）
│     ├─ allowedWorkspaces = workspaces.allowed===true（0 个 → rejected(code='no_workspace')）
│     ├─ sessions = 该工作区全部非归档会话（按 lastActiveAt 倒序，排除指挥官自身/子会话/归档）
│     └─ 每个工作区附 recentSessionTitles[≤10]（同一份会话列表按 workspaceId 聚合）
├─ 4. Jev 调用（jev/client.ts）：固定两段，均为 POST /v1/systemone，model=jev-latest，timeout=ConfigRecord.jev.timeoutMs(1500)
│     ├─ 4.1 工作区段：state={task,command}；criteria={w_i:{name,path,what,recentSessionTitles}}
│     ├─ 4.2 会话段：state 同上；criteria={new, s_i:{what,lastActiveAt?,contextUsage?}}，仅该工作区会话（≤250）
│     ├─ 429/529 退避重试 1 次；4xx 不重试
│     └─ 任一段超时/网络失败 → config.onTimeout：
│          ├─ pause_and_ask（默认）→ needs_confirmation(reason='jev_unavailable')，推荐=模型候选
│          └─ use_model → 按模型 candidate 放行，记录降级
├─ 5. 门控（gate.ts 纯函数）
│     ├─ 一致性：会话段只含所选工作区会话，天然一致；确认路径仍校验 attach 归属/归档
│     └─ pass ⟺ pWorkspace ≥ workspaceThreshold && pSession ≥ sessionThreshold
│          （两段阈值默认均 0.80，启动时取 ConfigRecord.jev；旧配置的 threshold 作为两者回退）
├─ 6. 不通过 → needs_confirmation
│     ├─ 生成 decisionId（§4.3），内存 Map<decisionId,{taskId,candidates,jev,createdAt,used:false}>（TTL 30min）
│     ├─ task.status → 'proposed'；timeline 追加 dispatch 项
│     └─ 返回 {status:'needs_confirmation', decisionId, candidates(≤8), recommendation, scores, reason}
└─ 7. 通过 → 提交（spawn.ts）
      ├─ 目标 mode='new'：capability auto（§6）→ create 会话 → prompt brief
      ├─ 目标 mode='attach'：不调面板 → 直接 prompt 到已有会话（校验会话属于该工作区且非归档）
      ├─ task.status → 'queued'；primarySessionId/assignments 写入
      ├─ 写 dispatches 终态（outcome='auto' 或 'confirmed'/'overridden'）
      ├─ 写 sessions link {role:'work', mode, status:'queued'}
      └─ 返回 {status:'dispatched', taskId, decisionId, sessionId, sessionCreated, target, scores, capabilities}
```

确认路径（第二次调用，带 `decisionId + confirmTarget`）：

- 查内存 pending decision：存在 → 校验 `confirmTarget`（白名单 + attach 会话归属）→ 走第 7 步，`outcome='confirmed'`（用户选择与 recommendation 不同则 `'overridden'`）。
- 不存在（重启 / TTL 过期 / 已被提交过）→ 返回 `rejected(code='decision_expired', message='确认已过期，请重新 commander_task_dispatch')`（已裁定见 §15.1-D2）。**不允许**凭 `confirmTarget` 直接派发而丢候选审计。
- **用户可见行为（D2 已裁定）**：指挥官收到 `decision_expired` 后按 system prompt 重新走一次完整 `commander_task_dispatch`（重新构造候选 + 调 Jev），在对话里对用户说一句"确认已过期，我重新判定一次"；**不会自动派发**，是否需要用户再次确认取决于新一轮门控结果。重启后未决决策不恢复，任务保持 `proposed`（可由用户/指挥官重新派发或取消）。
- **TTL 清理时机（不引入 scheduler/定时器）**：惰性清理——每次 `commander_task_dispatch` 调用入口、每次 confirm 查找、以及 `/commander/state` 快照构造时各扫一次 `createdAt + 30min` 过期项；不新建后台定时任务（冻结决策 4）。被清理的 decisionId 后续 confirm 即 `decision_expired`。

### 9.3 幂等

| 场景 | 行为 |
|---|---|
| 同 `requestId` 重复调用 | 返回首次结果（dispatches 终态回放；pending 内存决策返回同一 decisionId） |
| 同一 decision 第二次提交 | 若已有终态记录 → 回放；否则执行一次并置 `used` |
| 派发过程中崩溃 | 会话可能已建但任务未 queued：启动时对 `sessions` 表 `status='queued'` 但任务 `proposed` 的孤儿做核对（有会话 → 补 queued；无会话 → 保持 proposed） |

### 9.4 状态机与事件驱动

**2026-11-22 定案 v1.0（唯一口径见 `docs/architecture/task-state-machine-final.md`）**

- 所有状态写入经 `src/host/tasks/state-machine.ts` 的 `transitionTask`：迁移图 + actor 权限 + 守卫 + 副作用；禁止各写入口自行判断。
- `draft→proposed/queued`、`proposed→queued`、`review→queued`：`commander_task_dispatch`（首派/确认/续派）。
- `queued/blocked→running`：`turn/start`（blocked 也可 recover/ report no_progress）。
- `queued/running/blocked→review`：`commander_task_report`（acceptance≥1）。
- `draft/proposed/queued/running→blocked`：dispatch spawn 失败或 `commander_task_update(action=block)`（reason 必填）。
- `blocked→proposed`：`commander_task_update(action=recover)`，仅 round 1 且无验收历史。
- `review→done`：仅 `POST /accept`（人，幂等）；`→archived` 仅 `POST /archive`（人）。
- `→cancelled`：`commander_task_update(action=cancel)` 或 `POST /cancel`；先停 running/queued 会话，失败不落状态。
- `archived→archivedFrom`：仅 `POST /restore`（人）。
- `commander_task_update` 必带 `expectedRevision`，不匹配 → `task_stale_revision` 且不落盘；不再接受裸 `status`。
- 依赖：`dependsOn`（≤5、无环）由 create/set_dependencies 校验；dispatch 前置检查 `dependenciesMet`（非 ready）；accept 首次成功只提醒 commander（一次一条），cancel/review 来源 archive 提醒受阻后继；Host 不自动派发、不自动改后继状态。
- 不变量：`review` 至少 1 条 acceptance；`queued` 有 primarySessionId；`blocked` 有 reason；审批/提问不写任务记录；工具改状态必须以用户可见回复结束（prompt 约束，Host 不强制）。

### 9.5 派发 brief 文本（写入工作会话的第一条 prompt）

```
任务：<title>
目标：<goal>
验收提示：<acceptance[].text，≤5 条>
约束：你是工作会话，自己拆分与执行；结束时在会话里说明产出与证据（文件路径/命令/结果），不要维护看板。
```

> 2026-11-18 修正：不再输出 `[commander-dispatch]` 头与 `---` 下的 `taskId/decisionId/sessionId`——工作会话不需要这些内部关联 id，关系只保存在插件持久化（tasks/dispatches/sessions 表）。

- 不写"验收清单"（那是指挥官职责），只给"验收提示"。
- 不附能力目录；auto 的能力选择已由面板完成。

---

> **M5 补丁（2026-11-20）**：`commander_task_dispatch` 增加 `instruction`（本轮要求，≤1000）与 `userRequest`（用户原话，≤2000），输出增加 `kind`/`round`；`commander_task_report` 在 round>1 时只接受当前轮主会话，并写 `reportSummary.round`/timeline.round。详见 `m5-continue-dispatch.md` §5/§10。
>
> **材料补丁（2026-11-20）**：`commander_task_report` 新增可选 `materials[]`（link/file/image），并自动归并工作会话 `deliverables/presented` 事件；`TaskRecord.reportMaterials` / `AcceptanceRound.materials` 保存报告级材料；任务详情返回 `imageUrl`，新增签名资产路由 `GET /commander/tasks/:id/materials/:materialId`。详见 `materials-contract-patch.md`。

## 10. 工具清单（M0/M1）

### 10.1 可见性与注册方式

- 工具定义模块在插件 `apply` 内经 `ctx.tools.register(definition, { when })` **全局注册一次**（来源归属=本插件；注册到 agent 作用域会被工具面板判成「Agent 预设注入/来源未识别」）。
- `when: ({agent}) => 该 agent 的会话 id === config.commander.sessionId`（每次 step 求值，绑定可后置）：其他会话的 system prompt 里看不到、也调用不了。
- 工具内再校验"调用方会话 = 指挥官会话"并取 `taskId` 归属（防御）。

### 10.2 M0

**不注册任何模型工具**。M0 的指挥官只做普通对话（NEXT-PHASE §4 M0 范围不含工具）。`tools/` 目录留空实现，仅装配点存在。

### 10.3 M1

| 工具 | 入参（要点） | 出参（要点） | 写盘 |
|---|---|---|---|
| `commander_task_create` | `title/goal/workspaceId?/priority?/commandId?/dependsOn?` | `{taskId,status:'draft',version,dependsOn,waitingFor,ready}` | tasks + commands |
| `commander_task_get` | `taskId` | 单条任务（version/status/round/dependsOn/waitingFor/ready/block/pendingDispatch/acceptanceCount/…） | 否 |
| `commander_task_update` | `taskId + expectedRevision + action`；字段按 action 严格校验 | `{taskId,status,version}` | tasks（统一状态机） |
| `commander_task_dispatch` | §9.1 + 依赖/单卡守卫 | §9.1 + `dependency_unmet`/`pending_dispatch_exists` | tasks/dispatches/sessions/workspaces |
| `commander_task_list` | `statuses?/includeArchived?/q?/searchIn?/timeField?/since?/until?/limit?/offset?` | `{total,offset,limit,returned,hasMore,nextOffset,now,counts,columns,pendingDispatch,tasks[]}`；行含 `version/round/dispatchable/waitingFor/blockReason/acceptanceCount/stale` | 否 |
| `commander_workspace_list` | 无 | `{total, workspaces:[{id,name,path,summary,policy,sessionCount}]}`；只出已启用（allowed）工作区 | 否 |
| `commander_session_list` | `workspaceId`（必填：id/名称/路径/cwd 子目录）+ `q?/includeArchived?/since?/until?/limit?/offset?` | `{total,offset,limit,returned,hasMore,nextOffset,now,workspace,sessions[]}`；只出根会话 | 否 |

- 取消/归档/恢复/验收是**人专用 HTTP 路由**，不是模型工具；不存在 `follow_up`/`task_cancel`/`task_archive` 工具。
- 工具 `output.schema`/`output.render` 必须与真实返回一致（`commander_task_dispatch` 用 `oneOf`；`commander_task_get` 为紧凑 JSON）。

> **查询工具补丁（2026-11-23）**：`commander_task_list` 查询化（筛选/分页/计数，明细留给 `commander_task_get`），并从任务工具拆出 `commander_workspace_list`（只出已启用工作区）与 `commander_session_list`（必须指定工作区、只出根会话）。时间参数用人类格式字符串、固定 `createdAt`/`lastActiveAt` 倒序、默认隐藏回收站、`includeArchived` 放开的规则见 `task-query-design.md` §3–§10；工具面与不变量同步登记在 `task-state-machine-final.md` §5.8。工具总数 6 → 8。

**M3 工具（同作用域，仅指挥官会话）**

| 工具 | 入参（要点） | 出参（要点） | 写盘 |
|---|---|---|---|
| `commander_task_report` | `taskId/sessionId/seqFrom/seqTo/outcome`（`delivered|partial|blocked|no_progress`）+ `acceptance[{text,verify?,evidence?,derivedFromSeq?}]` + `summary(≤800，必填)` | `{taskId,status,evidenceState:'complete'|'insufficient',insufficient[]}` | tasks（acceptance/timeline/status=review|blocked/reportSummary；seq 越界 → error；不评估） |
- **M3 新增**：`commander_task_report`（同指挥官会话作用域；schema/行为见 `m2m3-contract-patch.md` §3.2；只整理不评估；seq 越界拒绝；写 acceptance/timeline/status=review|blocked；`summary`（指挥官对最后回复的归纳，Host 不核对来源）原文落 `TaskRecord.reportSummary={text,at}`，经 `GET /commander/tasks/:id` 透出到看板抽屉「整理报告」行的「结论」卡（4 行折叠））。
- **accept/archive/restore/cancel/continue 是「人专用 HTTP 路由」，不是模型工具**（`POST /commander/tasks/:id/accept|archive|restore|cancel|continue`，仅在界面调用；`done` 只能由 accept 进入）。
- 工具 `output.schema` 必须与真实返回一致（`commander_task_dispatch` 用 `oneOf` 覆盖三 variant；`commander_task_report` 输出字段完整），`output.render` 决定模型可见内容；不能用 `tools.schemas()` 作为动态注册的可见性判据。
- `commander_task_update` 不接受 `status`；`done`/`archived` 不在模型可写集合内。
- 所有工具 `execute` 返回结构化对象（供模型读），失败返回 `{ok:false, code, message}` 而不是抛异常（工具错误不等于插件崩溃）。

### 10.4 指挥官 system prompt（`agent.ctx.systemPrompt.section()`，仅指挥官作用域）

必须包含（M1 版本，完整文案由 backend 落 `src/host/session/prompt.ts`）：

1. 你是调度者：澄清、建任务、派发、维护看板；**不拆分工作、不评估结果、不写代码、不碰审批**。
2. 派发必须调 `commander_task_dispatch`；`needs_confirmation` 时原样给候选/置信度/原因，等用户答复再带 `decisionId+confirmTarget` 重调。
3. 用户自定义选择时以其选择为准，记录 override 由 Host 完成。
4. 收到 `[session-reply]` 注入时：读最后回复，决定回一句或调 `commander_task_get`/`commander_task_update`/后续工具；改任务前先取 `expectedRevision`，**凡是通过工具改了任务状态的回合，必须以一条用户可见回复结束**。
5. 审批/提问不属于你的上下文；不要尝试回答或复述。
6. 能力：只写 `capabilityNeeds`（自然语言短语），不指定能力名、不读目录、不配阈值。
7. 查询：看板用 `commander_task_list`（筛选/分页/计数），单任务明细用 `commander_task_get`；派发目标用 `commander_workspace_list`（只含已启用工作区），attach 目标用 `commander_session_list({workspaceId})`；**不得猜 workspaceId/sessionId**，也不得把工作区目录塞进任务查询。

---

> **M5 补丁（2026-11-20）**：新增 `POST /commander/tasks/:id/continue`（`/rework` 兼容别名）；它只写 `pendingInstruction`+timeline 并通知指挥官，任务保持 review；accept 仍唯一 `review→done`。详见 `m5-continue-dispatch.md` §8。

## 11. M0/M1/M2/M3 验收映射（NEXT-PHASE §4）

| 验收项 | 实现模块 | 验证方式 | 证据 |
|---|---|---|---|
| **M0-1** 安装插件、刷新 DSH，球出现 | bundle（§2）+ `client/overlay.tsx` + `shell.overlay` 注册 | 手工/半自动：安装 → 刷新 → 截图 + `cordis_inspect_query` 槽位条目 | `docs/validation/m0-accept.md` |
| **M0-2** 能打开面板并发一条消息，指挥官正常回复 | `api/routes/message` + `api/sse` + `session/deliver` + binding（§5）；**走 `POST /commander/message` + `commander.message`/`commander.status`（按补丁 §1）** | 点击球 → 输入 → `POST /commander/message` 返回 `accepted:true` → SSE 收到 user echo 与 ≥1 条 assistant 文本 → 快照 `messages` 含两条且 `messageId/order` 正确、`commanderBusy` true→false | 同上（会话 id + messageId/order/turnId/seq） |
| **M0-3** 重启 DSH 后绑定不丢 | `config.singleton` + 懒 resume（§5.3） | 重启后 `/commander/state` 的 `binding` 与重启前一致；对绑定会话再发一条消息仍成功 | 同上（重启前后快照） |
| **M0-4** 面板不存在时插件仍能启动（inherit 降级） | `inject` 不含面板 + `resolvePanel()`（§6.1） | 隔离 profile 禁用面板后启动插件 → `/commander/health` 返回 `panel:'absent'`；派发判定走 inherit（单测 + 隔离环境） | 单测报告 + 隔离启动日志 |
| **M1-1** **确认后派发成功**（全确认：首次恒 `needs_confirmation` → 二次确认 → `queued` → 工作会话 `turn/start` 后 `running`） | `dispatch/service` + `jev` + `spawn` | e2e 固定脚本：高/低分样本各至少 1 条，均先 `needs_confirmation`；采用建议确认 → 任务 queued → 开回合后 running；证据含两次返回原文 | `docs/validation/m1-e2e.md` + dispatches 记录 |
| **M1-2** 低置信任务返回 `needs_confirmation`，二次确认后派发 | `gate` + 内存决策 + 确认路径（§9） | e2e：低置信样本 → `needs_confirmation` → 带 decisionId+confirmTarget 重调 → dispatched | 同上（两次返回原文） |
| **M1-3** auto 能力：面板返回 enabled/disabled，会话里能力生效 | `dispatch/capability`（§6） | e2e：auto 工作区 → 任务详情 `capability.status='applied'` + 二次 rank `enabledInSession` 为真（V1-C4 同法） | 同上 + V1 证据复用 |
| **M1-4** 面板不可用：回退 inherit，派发仍成功并记录 fallback | `capability.ts` fallback | 隔离环境禁用面板 → 派发成功 + `capability.status='fallback'` + `reason` | 同上 |
| **M1-5** ~~50 案例指标达标~~ **按用户决策豁免**（V5 FAIL 保留、M1 全确认；以"默认每次确认"替代 auto 门禁） | —（不设） | 证据引用用户决策与 `docs/validation/V0-GATE.md`；**不得表述为 V5 PASS** | `docs/validation/m1-e2e.md` 附决策引用 |

| **M2-1** 看板整页与六列/详情抽屉 | `client/board/*`（`main` keyed `commander-board`）+ `api/state` 派生字段 + `GET /commander/tasks/:id` | 面板「看板」→ `ctx.layout.selectPanel('commander-board')`；六列映射与计数正确（无状态拖拽）；**默认主面板整页，右侧栏 tab 本轮不实现**；详情抽屉含 dispatch/capability/acceptance/sessions/timeline/boardEdits | `docs/validation/m2-accept.md` |
| **M2-2** 一条命令从 `proposed` 走到 `queued/running` | `dispatch` + 看板投影 | e2e：建卡→确认派发→queued→`turn/start`→running；看板卡片落列正确 | 同上（dispatches/tasks 证据） |
| **M2-3** 重启后看板不变 | `tasks` 域 + 快照重建 | 重启 Host → `/commander/state` 与重启前一致（任务/状态/列/计数） | 同上（重启前后快照 JSON） |
| **M2-4** 人工改看板 → 指挥官收到 `[board-edit]` 且不重复注入 | `api/routes/board` + `board_edits` + 30s 合并注入 | PATCH 一次/多次（30s 内合并）→ 指挥官会话恰好 1 条 `[board-edit]`（injectionKey/injectedAt 证据）；非法迁移 `conflict`；archive/restore 正常；stale 徽标（伪造 lastActivityAt 单测） | `docs/validation/m2-accept.md` |
| **M3-1** 工作会话结束后指挥官收到最后回复并更新看板 | `trigger/*`（turn/end）+ `commander_task_report`/`commander_task_update` | e2e：完成/错误回合 → 恰好 1 次注入（去重/pending 过滤/8KB 截断/忙合并）；指挥官回合内更新任务 → 看板变化 | `docs/validation/m3-accept.md` |
| **M3-2** 不打开会话即可完成审批与验收（审批不进上下文/任务记录） | Client `approval/*`（pendingInteraction 同一实例）+ `accept` 路由 | 审批悬浮卡与主窗口同请求、先答生效、后答吞 `already settled`、不注册第二 answerer；`POST accept` review→done；`/commander/state` 与 `tasks` 无审批内容 | 同上（截图 + state/tasks 证据） |
| **M3-3** 返工生成续做 brief 并发回原会话 | `POST /commander/tasks/:id/rework` + `sessionController.prompt` | `review→running` 且工作会话收到 `[commander-rework]` brief；投递失败 502 且状态不变；`commander_task_report` 验收条目 seq 越界拒绝 | 同上（prompt 记录 + tasks 证据） |

> **M1 范围注**：M1 只做 `turn/start → running` 的机械状态更新与 `sessions.status` 维护；`turn/end` 最后回复注入、`commander_task_report`、看板页、accept/continue、审批/播报均属 M2/M3（见 §7 顶部注与 `m2m3-contract-patch.md` §3）。

**每个阶段的 DoD（NEXT-PHASE §6）在交付时逐条勾**：可复现验证记录、≥1 自动化测试覆盖关键路径（门控/去重/回退/状态迁移）、失败路径有降级、不引入新概念、文档只改事实。

---

## 12. 构建、打包与安装

### 12.1 工具链选择（固定）

| 半 | 语言 | 构建 | 产物 |
|---|---|---|---|
| Host | TypeScript（ESM） | `tsc -p tsconfig.host.json`（`module: NodeNext`，`outDir: lib/host`） | `lib/host/index.js` + 分模块 js |
| Client | TSX | `tsdown`（esbuild 内核）→ 单文件 lazy-CJS factory | `lib/client.js` |

- 不打包 `react`/`react-dom`/`react/jsx-runtime`（由浏览器模块表提供，构建时标 external，运行期 `require("react")`）。
- 不 import 任何 `@deepseek-ai/*` 运行时包（§2.1），因此无 peer 解析问题；TypeScript 类型用本地声明（§3.2）。
- 测试运行：`node --test`（Node ≥22.18 原生 TS 类型剥离）。**M0 第一步先验证**该路径；不可用则加 `vitest` devDependency（只影响测试，不影响产物）。

### 12.2 Client bundle 产物格式（必须逐字一致）

```js
window.__ModuleLoader__.load({
  id: "dsh-commander",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    const react = require("react")
    const jsxRuntime = require("react/jsx-runtime")
    // …产物代码（exports.apply / exports.inject 供 Cordis 装配）…
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
```

- `id` 必须等于包名（模块表按包名注册）；`tsdown.config.ts` 用 banner/footer 包裹 + `format: 'cjs'` + `external: ['react','react-dom','react/jsx-runtime']`。
- **构建 spike（M0-0，devops 执行）**：先跑通"空 client.js 产物 → 安装 → 刷新页面 → 控制台无 `slot entry crashed`"。若 tsdown 无法稳定产出该包裹形态，**回退方案**：按官方 `templates/decoration` 手写 `lib/client.js`（不用 JSX，`React.createElement`；源码仍可用 TS 只做类型检查）。回退是方案许可项，不算设计变更，但必须在 M0 证据里记录。

### 12.3 构建命令

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm install                       # 仅根与 packages/dsh-commander 的 devDeps
pnpm --filter dsh-commander build  # tsc + tsdown
pnpm --filter dsh-commander typecheck
pnpm --filter dsh-commander test
```

构建后检查：`lib/host/index.js` 可 `node --input-type=module -e "import('./lib/host/index.js')"` 独立加载（不依赖真正 DSH 服务的模块顶层副作用）；`lib/client.js` 头尾包裹正确；`files` 字段包含所有运行期文件。

### 12.4 安装到 profile（devops）

**方式 A（推荐，CLI）**：在用户授权下、由 devops 操作：

```bash
dsh plugin --profile desktop add ./packages/dsh-commander
dsh --profile desktop --dump-config | grep -A3 'dsh-commander'   # 确认 layer 出现
```

**方式 B（插件管理器）**：由具备发起权限的 agent 调 `plugin_manager action=install_bundle target=<绝对包目录>`（需用户批准；安装 = 在 Host 执行插件代码）。

- profile 固定 `desktop`；本机 `dsh` 在 `/Users/lzx/.nvm/versions/node/v24.19.0/bin/dsh`（PATH 里若无，用绝对路径）。
- 安装后需刷新页面，**替换已装包需要重启 DSH 才能加载新 JS**（HMR 只对新装 bundle 与 client 重建生效）。
- **重启 DSH 会中断当前 agent 会话进程**（本验收会话跑在同一 DSH 内）：重启由**用户选择安全时点**执行，agent 不自行重启；重启后按 `m0-contract-patch.md` §3.2/§3.3 验收（M0-1 球出现、M0-3 绑定不丢）。
- 升级流程：重新 build → `remove` + `add`（或覆盖后重启）→ 刷新页面；绑定不丢（§5.3）。
- 回滚：`dsh plugin --profile desktop remove dsh-commander` + 刷新；任务记录留在 storage（域数据不随插件删除清空，见 storage 后端位置）。
- **禁止**手写 profile 的 `package.json`/`cordis.patch.yml`、禁止在 profile 目录跑 pnpm（由 `dsh plugin` 管理）。

### 12.5 验收前置检查（devops）

1. `/commander/health` 可达（页面同源 fetch）。
2. 插件管理页显示 `dsh-commander` 名称/描述/图标（locale + icon 生效）。
3. `--dump-config` 中出现 `commander` 行。
4. 重启 DSH 后插件自动加载、绑定不丢（M0-3）。

---

## 13. 测试分层与 mock 策略

### 13.1 分层

| 层 | 位置 | 覆盖 | 运行方式 |
|---|---|---|---|
| unit | `tests/unit/` | 纯函数：`gate`、`candidates` token 估算/分层选择、去重键、截断、`sanitizeKey`、`decisionId` 派生、timeline 折叠、状态机允许迁移、capability 结果映射、schema 校验 | `node --test`，无 ctx |
| integration | `tests/integration/` | `apply()` 装配烟测：fake ctx + fake 服务，断言注册的路由/监听/工具；失败路径：面板缺失/thunk/rank 失败/apply 失败；trigger 的 pending/去重；dispatch 的 needs_confirmation→confirm 幂等；API handler 的请求/响应/错误码 | `node --test` |
| e2e | `tests/e2e/` | NEXT-PHASE §4 的 M1 固定脚本 5 条 + M0 4 条；真实安装环境下由实现对应方执行（M0/M1 以 backend + devops 为主，键控脚本 + 手工步骤说明），tester 独立复跑审计；证据落 `docs/validation/` | 手工/半自动，不在 CI |

### 13.2 必须有的关键路径单测（NEXT-PHASE §6 DoD）

1. 门控：pass/低 pWorkspace/低 pSession/低 confidence/冲突/超时分支。
2. 去重：同键跳过、跨 turn 放行、投递失败补一次。
3. 回退：面板缺失/thunk 形状/rank 失败/apply 失败 → `inherit` 且派发继续。
4. 状态迁移：`draft→proposed→queued→running`、非法迁移被拒、`done` 仅人路径。
5. dispatch 幂等：同 requestId 回放、decision 二次提交、decision 过期。
6. key 归一化：非法字符、`__` 保留、碰撞后缀。
7. SSE：快照 rev 单调、事件 payload、断线重连拉快照。

### 13.3 fake 清单（契约型，不 mock 语义）

| fake | 契约 | 用途 |
|---|---|---|
| `FakeCtx` | `get/on/effect/logger`；`effect` 返回 disposer；`on` 可手动 emit | 装配测试 |
| `FakeSessionController` | `create/selectModel/prompt/cancel` 返回与现场一致的形状；可注入失败码 | V3 分支、懒 resume、投递失败 |
| `FakeCapabilityPanel` | 两种形态（thunk/对象）；`jev.getConfig/rank/apply` 可按场景返回成功/`pending`/`code` 失败；`items` 字段与现场一致 | §6 全分支 |
| `FakeStorageDomain` | `open` → `Domain`；表实现 `get/entries/keys/put/update/delete/deleteMany/size`；`update` 原子、key 校验、可选"重启后仍存在"（跨实例内存） | store/trigger/幂等/重启 |
| `FakeSessionProjections` | `snapshot(session)` 返回 `userQuestions:{active,settled}` | pending 判定 |
| `FakeWebServer` | `register({kind,path,handler})` 记录并暴露 `invoke(method,path,body)` | API 契约测试 |
| `FakeTools` | `register(def)` 记录，`execute(name,args)` 手动调用 | 工具单测 |

- fake 必须与真实现形状一致；每引入一个 fake 事实字段，测试注释里标来源（V 证据/现场源码路径）。**不得用 fake 绕过 domain 直写内存**。
- e2e 不做 mock；真实工作区与会话由执行人准备（测试用 workspace，避免污染真实任务），tester 独立复跑审计。

---

## 14. 明确不做什么（M0/M1）

1. **原生壳**：不做独立 BrowserWindow、系统级置顶、窗口外绘制、Dock/托盘（二期）。
2. **能力目录 / Resolver / 能力阈值**：不维护目录、不做匹配、不配阈值、不读面板配置文件；只调 `capabilityPanel.jev.rank/apply`（冻结决策 7）。
3. **scheduler / 定时轮询 / 巡检**：没有 `ctx.schedule` 心跳，不轮询结果；非空闲 >20min 的"疑似停滞"徽标是 M2 只读展示，不做后台扫描任务。
4. **投影 / 事件表 / 回放**：不新增会话事件类型、不写事件表、不做任务投影；任务记录就是唯一真相（冻结决策 5）。
5. **`brief_user`**：不存在；播报由界面对任务状态与新消息派生（M3）。
6. **审批仲裁 / 第二个 answerer**：只在界面层读 `pendingInteraction` 双处渲染；Host 不改审批所有权（冻结决策 8）。
7. **FTS / 全文检索**：一期不做；`commander_task_list` 只做过滤与摘要。
8. **多 Host / 跨进程锁**：单 Host 进程假设；不实现分布式写锁。
9. **自动验收 / 自动派发学习**：验收只能人触发；Jev 结果只记录，不训练、不自动调阈值。
10. **M2/M3 功能**：看板 CRUD、board_edits 注入、accept/continue、commander_task_report、审批悬浮卡、消息播报均不在 M0/M1（M2/M3 另行交付）。
11. **M0 不注册模型工具**；M1 不做 `commander_task_report`。

---

## 15. 裁定记录（Lead）与开放决策

### 15.1 裁定记录（Lead，2026-11-17）

| # | 裁定 | 理由/依据 | 落到本文档 |
|---|---|---|---|
| **D2** | **通过**：`needs_confirmation` 的未决决策只存内存 + TTL 30 分钟；重启或 TTL 过期后 confirm 返回 `decision_expired`；不扩展冻结的 `DispatchRecord` schema、不新增 pending 状态。 | 冻结决策 5「任务记录就是唯一真相」要求记录可解释，而 `DispatchRecord.outcome` 是封闭集合、无 pending 变体；M1 验收不含"重启后继续确认"。已提交决策用 `dispatches` 终态做幂等回放；未决决策丢失的代价只是重新判定一次。 | §9.2（确认路径 / TTL 惰性清理时机 / 用户可见行为）、§9.3 |
| **D9** | **按冻结决策 7 + ARCHITECTURE §4.3 执行**：能力面板不可用 / `rank` / `apply` 失败 → 回退 inherit 并**继续派发**，写 `CapabilityPlan.status='fallback'` + `reason`，**不 blocked、不中止会话创建**。 | 冻结决策 7 明确"面板不可用/失败 → 回退 inherit，不阻塞派发"；§4.3 同款。ARCHITECTURE §7 表"能力应用失败 → 不启动会话 blocked(capability_apply_failed)"属旧口径，本阶段以冻结决策为准；不回改 ARCHITECTURE，本文档标注该冲突已裁定。 | §6.3、§15.2 表 D9 行（历史条目） |
| **D1** | **通过**：`CapabilityPlan.enabled/disabled` 只写"提交给 `apply` 的 plan 项 `name` 列表"；不用面板计数、不新增字段；计数只作为展示摘要另行派生。 | 保持冻结 schema 的 `string[]` 语义；面板 `apply` 返回计数与 `skipped`，无法反推名称，因此以"提交了什么"为记录真相，展示需求（启用/未启用数）由 `rank` 结果派生，只进界面/SSE 摘要。 | §6.3 |

裁定后不再"默认处理"，实现不得偏离；若后续要改，必须先改 `docs/ARCHITECTURE.md` / `DispatchRecord` schema 并由 lead 批准。

### 15.2 仍开放 / 仅知悉项

| # | 事项 | 当前处理 | 状态 |
|---|---|---|---|
| **D3** | 哪些 `TurnEndReason` 触发注入：冻结文档只写"会话停止且空闲" | 注入 `completed/error/blocked/max-tokens`；跳过 `aborted/interrupted`（V2 实测后如遇场景缺口再调，调前报 lead） | 待 lead 确认默认集合 |
| **D4** | 空回复/超长回复的注入策略（ARCHITECTURE §2.2 写"可配置"） | M1 用常量（空回复注入占位、8KB 头尾截断）；配置项 M3 再暴露，不新增表字段 | 待 lead 确认 M1 先用常量 |
| **D5** | V5 两层模式（B 模式）需要扩展 `tools/jev-eval.mjs` | 由 backend 扩展（评估工具，非插件生产代码），接口见 `validation-protocol.md` §6.3 | 待 lead 排期 |
| **D6** | Client 发用户消息的通道 | **已裁定（2026-11-17，M0 补丁）**：采用 Host 路由 `POST /commander/message`（面板不直连 `ctx.remote.session`）；assistant 回复经 Host 订阅 + SSE `commander.message` 回面板。详见 `m0-contract-patch.md` §1 与本节 §8 | 已裁定；补丁为 M0 实现口径 |
| **D7** | 能力面板版本：现场 1.19.3 ≠ NEXT-PHASE 记 1.19.2 | 以现场为准；M0 安装前 devops 再核对，版本变化只重跑 V1 的 C1/C2/C3 | lead 已知悉 |
| **D8** | `CapabilityPanel` 现场为 thunk（`ctx.get` 返回函数） | §6.1 双形状解析（兼容 thunk 与对象）；M0 装配时把实测形状写进 `docs/research/capability-panel-api.md` | lead 已知悉 |
| **D9（历史）** | ARCHITECTURE v2.4 内部冲突：§7 写"能力应用失败 → 不启动会话，blocked(capability_apply_failed)"，§4.3 与冻结决策 7 写"回退 inherit 继续派发" | **已裁定见 §15.1**：以冻结决策 7 + §4.3 为准；§7 该行为旧口径 | 已裁定 |

---

## 16. 门禁与交付证据清单

进入 M0 前（V0 门禁，由 lead 裁定）：

- [ ] `docs/validation/v1-capability-panel.md` … `v5-jev-50cases.md` 五项 PASS：执行人记录（V1–V4 devops、V5 backend）+ tester 独立复跑审计签名 + 协议符合性（validation-protocol §7/§8）。
- [ ] `docs/eval/report.md`（A 模式）与 `docs/eval/report-layered.md`（B 模式），最终阈值写回 §9.2 默认值。
- [ ] `docs/validation/GATE.md` 裁定 PASS。

M0 交付证据：

- [ ] 构建产物（`lib/host/*`、`lib/client.js`）+ `pnpm build` 日志。
- [ ] 安装记录（`dsh plugin add` 输出 / `plugin_manager` 返回）+ `--dump-config` 片段。
- [ ] `docs/validation/m0-accept.md`：M0-1…M0-4 逐条证据（含截图路径、快照 JSON）。
- [ ] 单测/集成测试通过记录（关键路径覆盖清单）。

M2/M3 交付证据：

- [ ] `docs/validation/m2-accept.md`：M2-1..M2-4 逐条证据（截图/JSON/注入原文/重启前后快照）。
- [ ] `docs/validation/m3-accept.md`：M3-1..M3-3 逐条证据（注入 SSE/消息证据、审批双处截图、accept/continue 记录）。
- [ ] 契约补丁 `m2m3-contract-patch.md` 合并记录（本文件 §8/§10/§11）与 tester 独立复核（`docs/validation/audit-m2m3.md`，如适用）。

M1 交付证据：

- [ ] `docs/validation/m1-e2e.md`：NEXT-PHASE §4 M1 五条验收逐条证据（含 dispatch 记录、任务记录、capability 结果、能力面板 fallback 日志）。
- [ ] `docs/validation/m1-gate.md`：门控/幂等/回退/状态迁移的单测与集成测试清单。
- [ ] 阈值生效证据：`ConfigRecord` 默认值 diff + 用最终阈值重跑的门控样本。

---

## 17. 观测指标（实现内建，M1 起暴露在 `/commander/state.metrics`）

注入次数/去重数/pending 跳过数/注入失败数、Jev 时延与失败率、派发自动 vs 确认比例、能力 apply 成功/fallback/failed 计数、任务记录 update 重试次数、SSE 连接数。只做内存计数（不落表、不新增事件类型），重启归零。