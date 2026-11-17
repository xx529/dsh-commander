# DSH 指挥官插件 · 技术可行性核对

> 核对对象：Desktop 版 DSH，运行版本 `0.2.2-rc.3`（`ASAR/package.json` 与 `@deepseek-ai/dsh/package.json` 一致）。
> 核对方式：只读。技能文档 + `docs/` 子系统文档 + 各包 `src/` 源码 + Electron 外壳 `lib/main.js` / `lib/preload-app.cjs`。
> 命名说明：本版本没有 `dsh-service-*` 包；服务实现按领域命名（`dsh-session` / `dsh-agent` / `dsh-schedule` …），服务键是 `ctx.<name>`，完整映射见 `DOC/capability-seams.md:655-766`。
> 路径缩写（下文所有证据路径都以此开头）：
>
> - `ASAR` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
> - `A` = `ASAR/dsh/node_modules/@deepseek-ai`
> - `DOC` = `A/dsh/docs`
>
> 标注约定：**【实证】**= 源码/文档直接写明；**【推断】**= 由多条实证推出、未在运行态验证；**【未验证】**= 需要实测。

---

## 0. 一句话结论

| 需求 | 结论 | 归属 |
|---|---|---|
| 浏览器内悬浮球 / 悬浮面板 | **能做**，`shell.overlay` 就是为此设计的根级浮层 | Client 插件 |
| 看板整页 / 侧栏页 / 右侧浮动面板 | **能做**（`main` keyed + `ctx.layout.selectPanel`，或 `sidebarRightTabs` + `float()`） | Client 插件 |
| 常驻会话 + 编程式建会话 + 跑 prompt | **能做**，`ctx.sessionController`（GUI 同款）或 `ctx.agents.create()` | Host 插件 |
| 后台定时调度 | **能做**，`ctx.schedule` 支持 `new_once` + `cwd` + `agentPreset` | Host 插件 |
| 审批「悬浮窗与主窗口竞答、先到者生效」 | **能做成"同一 PendingApproval 双处渲染"**；**不能**用两个独立 answerer 抢答（waterfall 串行） | Client 插件 |
| 插件间协作（指挥官调 super-kanban） | **能做**（Cordis 服务 `ctx.provide` / `inject` / `ctx.get`、共用 tools 注册表）；**不能**在 Client 侧临时发现别人的 `@Remote` | Host 为主 |
| 独立 BrowserWindow / 窗口外绘制 / OS 级置顶悬浮球 | **做不到**，必须改原生壳（`ASAR/lib/main.js` + preload） | 原生壳 |

---

## 1. Client 插件能注册哪些 Slot？有没有 shell 级 / 覆盖整个应用窗口的槽位？

### 1.1 机制

- Slot 是 Web Client 的类型化 React 组合系统；插件通过 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 贡献 UI，**从不 import 其它特性插件的组件**。证据：`DOC/subsystems/slots.md:5`、`:27`、`:226`。
- 槽位由"声明它的组件"拥有，`root` 是唯一内建声明、由 Cordis 服务自己渲染；注册未被声明的槽或重复声明都会在插件激活期失败。证据：`DOC/subsystems/slots.md:21-25`。
- 基数 5 种（`single` / `list` / `keyed` / `chain` / `hoc`），作用域 3 种（`root` / `session-maybe` / `session`）。证据：`DOC/subsystems/slots.md:58-67`。
- 全量槽位目录（脚本统计约 116 个 key，其中 57 个 root 作用域）由构建期生成：`A/dsh-cordis-client-runner/src/client/slot-catalog.ts:1-5870`，含每个 key 的基数、作用域、owner props、当前占用者、替换风险、示例代码。文档指向：`DOC/subsystems/slots.md:221`。运行态可用 `cordis_inspect what:"client"` 查活槽位树。

### 1.2 壳层槽位——7 个，全部 root 作用域（`root` + 6 个 shell/sidebar/main/rightbar 位）

| 槽位 | 类型 | 用途 | 关键约束（原文要点） |
|---|---|---|---|
| `root` | single | 整棵渲染树根，被 ui-layout 的 `AppFrame` 占用 | **不要替换**；注册到这里等于换掉整个应用外壳 |
| `sidebar` | single | 左侧整列，被 ui-sidebar 的 `SidebarRoot` 占用 | 注册即"替换导航列"，其内部 seat 一并消失；要加东西请用内部 seat |
| `main` | keyed | 中央主面板，`conversation` 是保留 key | 插件可用新 key 注册**整页**，用 `ctx.layout.selectPanel(id)` 切过去 |
| `rightbar` | single | 右列，被右侧栏占用 | 由占用者自己报告宽度/全屏状态 |
| `shell.bottom` | single | 三列下方通栏 | 高度由占用者决定；空内容不占位 |
| `shell.overlay` | **list** | **覆盖整个 frame 的浮动层**，在所有列之上、滚动容器之外 | 层本身 `click-through`，**条目自行 opt-in 指针事件**；新 id 是"并列新增"，不会替换既有条目 |
| `shell.leading` | single | 左上角窗口镶边位（macOS 红绿灯旁） | 已被 ui-sidebar 的"重开侧栏 / 新会话"占用 |

证据：`A/dsh-client-ui-layout/src/client/index.ts:60-121`（逐槽 JSDoc，`shell.overlay` 在 `:97-107`，`main` 在 `:71-75`，`sidebar` 在 `:60-70`，`rightbar` 在 `:76-89`，`shell.bottom` 在 `:90-96`，`shell.leading` 在 `:108-121`）；运行期声明在 `:192-205`；`shell.overlay` 的目录条目与 20 个现有占用者见 `A/dsh-cordis-client-runner/src/client/slot-catalog.ts:4008-4076`（占用者列表 `:4052-4073`，`replaceRisk: none` 在 `:4074`）。

`shell.overlay` 的官方定位原文（`A/dsh-client-ui-layout/src/client/index.ts:99-106`）：

> "Frame-wide floating layer, above every column and outside their scroll containers. Deliberately generic and unowned by any feature: a badge, a toast stack or a status pill all belong here… The layer itself is click-through — entries opt back into pointer events — so an occupant never blocks the app underneath. This is the additive seat for a frame-wide surface of your own."

**这就是悬浮球 / 悬浮面板的正解**：在 `shell.overlay` 里注册一个自己的 id（例如 `commander.floating`），DOM 上 `position: fixed`，容器不给 `pointer-events`，只在自己的球/面板根节点设 `pointer-events: auto`，就不会挡住下面的输入框。

### 1.3 与"悬浮入口 / 看板"相关的其它高价值槽位

| 槽位 | 类型 / 作用域 | 用途 | 证据 |
|---|---|---|---|
| `sidebar.panellist` + `sidebar.panel.icon` | list / root | 侧栏面板列表项与其图标（新增一个"指挥官"入口） | `DOC/subsystems/slots.md:13`；catalog root 列表 |
| `sidebar.right.tab.guide` | chain / root | 替换右栏 guide 页 | `A/dsh-client-ui-sidebar-right/README.md:90` |
| `sidebar.right.pane.tab` | keyed / session | **右栏标签页正文**（第三方可注册新 tab 类型） | `A/dsh-client-ui-sidebar-right/README.md:83-86` |
| `conversation.composer.dock` | list / session | 输入框下沿一块自有空间（小挂件） | `A/dsh-agent-preset/skills/dsh-doc/references/ui-plugin.md:5` |
| `conversation.session.header.actions` | list / session | 会话头部按钮 | `DOC/subsystems/slots.md:35-51` |
| `conversation.chat.node` | keyed / session | 自定义对话节点渲染（按注册的 event kind） | `DOC/subsystems/slots.md:37` |
| `settings.section` / `plugins.*` | list / root | 设置页、插件详情页扩展 | catalog root 列表 |

右栏的第三方 tab 类型是完整能力，不止"放个图标"：`ctx.sidebarRightTabs.register({ id, kind, title, guide, keepMounted })` 声明类型，`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)` 提供正文；还可用 `ctx.sidebarRight.openTab(kind)`、`float(tabId, rect)`、`split(paneId)`、`destination: 'float'` 让面板浮起来。证据：`A/dsh-client-ui-sidebar-right/README.md:83-86`、`:101`、`:103`。

### 1.4 明确边界：能不能建独立 BrowserWindow / 在窗口外绘制？

**不能。** 证据链（全部实证）：

1. Client 插件代码跑在渲染进程页面里，页面 `webPreferences` 为 `nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true`（`ASAR/lib/main.js:20261-20274`）——页面拿不到 Node、拿不到 Electron 模块，无法 `new BrowserWindow()`。
2. 所有 `BrowserWindow` 创建点都在 Electron 主进程 `ASAR/lib/main.js`（导入在 `:2`，`createWindow()` 在 `:20243`，另有 welcome/update 等 4 处），**没有任何面向插件的注册入口**；插件只能拿到 preload 用 `contextBridge` 暴露的固定面：
   - `window.dshDesktop`（`ASAR/lib/preload-app.cjs:2112`），实现是 `createProductApi()`（`:1998-2015`）：`fileActions` / `browser` / `fileDrag` / `deviceInfo` / `keyboard` / updates 等，**没有建窗、没有置顶、没有屏幕坐标绘制**；
   - `dshPlatform`（`:2103`）只有 `open/setBounds/close`，且只服务内嵌 Platform 页；
   - `dshDesktopBoot`、`__DSH_DIRECTORY_PICKER__`、`__DSH_HOST_PATHS__`、`__DSH_LOCALE__` 等均为窄面。
3. Host 插件也不在 Electron 主进程：Desktop 用子进程跑 DSH Host，环境变量 `ELECTRON_RUN_AS_NODE: "1"`（`ASAR/lib/main.js:11553`），入口 `@deepseek-ai/dsh-desktop-host/lib/index.js`（`:11784-11802`，`spawn(..., ['--expose-internals', entry, ...])`）。node 模式下 `require('electron')` 拿不到 `BrowserWindow`/`app`（实测该运行时下 `require('electron')` 无法解析到模块，抛出 `Cannot find module 'electron'`）。
4. `shell.overlay` 的"整个应用"指 **frame（页面布局视口）**，不是 OS 窗口；文档明确它是"页面内的浮层"而非原生窗口（`DOC/subsystems/slots.md:5`；`A/dsh-client-ui-layout/README.md:38`："`shell.overlay` covers the whole frame"）。

**结论边界**：插件可以在 DSH 窗口**内部**任意位置悬浮/覆盖（含 `position: fixed`、全屏遮罩、浮层面板），但**不能**：创建第二个窗口、窗口透明/置顶/无边框、画到窗口外、控制 Dock/托盘/原生菜单、跨应用画中画。这些只能改原生壳（`ASAR/lib/main.js` 增加窗口 + IPC 通道 + preload 暴露），属于"必须原生壳"的一类。

> 附：Desktop 里确实存在一个内嵌 `<webview>` 通道（`window.dshDesktop.browser.acquire(workspace)` → `dsh-desktop:browser-acquire`，`ASAR/lib/preload-app.cjs:1967-1995`；主进程 `DesktopBrowserGuests` 在 `ASAR/lib/main.js:18091-18180`）。它按 lease + partition 严格校验，只服务右侧栏浏览器（`webview[data-sidebar-browser-frame]`），**不是**通用"插件窗口"API；拿它做非预期用途属于内部行为，不建议作为方案。

---

## 2. Host 插件能拿到哪些服务？

Host 插件形态：`apply(ctx, config)` 或 Service 类，`inject` 声明依赖，所有注册用 `ctx.effect`/`ctx.on` 收尾（`A/dsh-agent-preset/skills/dsh-doc/references/host-plugin.md:60-65`）。
服务全景（含 owner / consumer / 语义）见 `DOC/capability-seams.md:655-766`。与会话指挥相关的能力如下。

### 2.1 会话与 Agent

| 服务 | 关键方法 | 证据 |
|---|---|---|
| `ctx.sessions` (`SessionStore`) | `create(id?, {seed, meta})`、`prepare/enter/announce`、`flush`、`get`、`list`、`fork(source, boundary?, childId?)` | `DOC/subsystems/session.md:1143`、`:1164-1200`、`:1215`、`:1222`、`:1228`、`:1246` |
| `ctx.agents` (`AgentRegistry`) | `create(options) → AgentHandle`、`resume({resumeSessionId, …})`、`get(id)`、`list()`、`setFactory`、`turnBoundaryOf`、`withInitiator` | `DOC/subsystems/core.md:771`、`:780`、`:833`、`:839`、`:696`、`:733` |
| `Agent` 句柄 | `send(message, target, wakeup)`、`followup(msg)`（唤醒跑一轮）、`steer(msg)`、`inject(msg)`（不唤醒）、`cancel(cause, {keepInbox})`、`whenIdle()`、`runMaintenance(task)`、`readonly session/model/inbox/status/ctx` | `DOC/subsystems/core.md:55`、`:85-143` |
| `ctx.sessionController`（Host 侧 GUI 同款控制器） | `create(request)`、`selectModel`、`modelCatalog`、`prompt(request, signal)`、`cancel`、`fork`、`rename`、`openWorkspacePath`、`list`、`search` | `A/dsh-api-session-controller/src/index.ts:281-522`（`create` `:306`、`prompt` `:467`、`cancel` `:519`、`modelCatalog` `:343`） |
| `ctx.agentLoop` | "唯一的 concrete loop 插件"，扩展包依赖 `dsh-agent` 服务与事件，**不直接依赖它** | `DOC/capability-seams.md:733`；`DOC/subsystems/core.md:20` |
| 会话事件 | `agent/created|disposed|status|error|assistant-stream|pre-step|request-error|turn-stopping`、`session/event`、`turn/end`、`tool/result` | `DOC/subsystems/core.md:846-1152`；`references/practices.md:26-28` |

### 2.2 工作区 / cwd

- `ctx.workspaceRegistry`：`create(path, title?)`、`get(id)`、`list()`、`delete`、`insertBefore`、`archiveSession/unarchiveSession`、`pinSession/unpinSession`、`resolveByPath(path)`。证据：`DOC/subsystems/workspace.md:520-644`。
- cwd 存在**会话头**里：`CreateAgentOptions.meta.cwd`（必须是绝对路径），工作区成员资格由头部 cwd 与目录 realpath 比对推出。证据：`A/dsh-agent/src/index.ts:80-87`；`DOC/subsystems/workspace.md:19`、`:28-30`、`:78-79`。
- `ctx.workingDirectory`：会话级"有效执行目录"投影服务（供 tool-fs / tool-bash 等消费）。证据：`DOC/capability-seams.md:673`。

### 2.3 审批 / 用户提问

- `ctx.approval`（`ApprovalService`）：`request(req) → ApprovalOutcome`（唯一放行值是 `allowed-once`）、`setPolicy(agent, policy)`、`effectivePolicy(session)`、`overrideOf(session)`。证据：`DOC/subsystems/approval.md:100-140`。
- 事件 `approval/request`：**waterfall**，`(req, next) => Promise<ApprovalOutcome>`，返回结果即认领、`next()` 交给下一个 answerer；agent 作用域过滤。证据：`DOC/subsystems/approval.md:148-169`。
- `ctx.userQuestions`（`UserQuestionService`）：`ask(request)`、`askTimed(request, callId, timeoutMs)`、`answer(agent, callId, answer)`（Remote）、`attachWait(agent, callId, signal)`（Remote stream）。证据：`DOC/subsystems/user-questions.md:232-297`。
- 事件 `user-questions/request`：**waterfall**，`(request, next) => Promise<AskUserQuestionAnswer>`。证据：`DOC/subsystems/user-questions.md:299-323`。

### 2.4 模型清单

- `ctx.llm`（`LlmRuntime`）：`listProviders()`、`listConfigurableProviders()`、`listModels(provider)`、`resolveModelInfo(provider, model, signal?)`、`resolveCallConfig`、`prepareCall`、`stream`、`registerAdapter`。证据：`DOC/subsystems/llm-streaming.md:1041`、`:1057`、`:1135`、`:1146`、`:871`。
- 变更通知：`llm/adapters-updated`、`llm/models-updated`（`DOC/subsystems/llm-streaming.md:1196-1229`），且这两个事件在对客户端转发的白名单里（见 2.7）。
- 默认模型：`ctx.agentDefaultModel`（读/存 `ModelSelection`），`ctx.sessionController.modelCatalog()` 直接给出前端同款分组目录。

### 2.5 定时任务 / 后台作业

- `ctx.schedule`（Host 级、与会话激活解耦）：`create(request, actorSessionId?, signal?)`、`list`、`catalog`、`view`、`history`、`edit`、`deleteInactive`、`run({id})`、`deliveryLimits`。证据：`DOC/subsystems/schedule.md:91-102`、`:150-270`。
- 投递目标三种：`session`（复用现有会话）、`new_once`（预留 id、首次投递建会话后复用）、`new`（每次新建）。`new`/`new_once` 的创建值 **`cwd` 与 `agentPreset` 可指定**，缺省走 Host 默认。证据：`DOC/subsystems/schedule.md:78-84`。
- 语义坑：单任务最小投递间隔 60s；Host 必须在运行；接收写先于回执写（崩溃可能重复投递一次）；活跃任务会阻止目标会话归档。证据：`DOC/subsystems/schedule.md:129-131`。
- `ctx.jobs`（后台进程注册表，不是定时器）：producer 注册运行中的 bash/pwsh/PTY，`tool-jobs`/`api-job-controller` 读取与 kill。证据：`DOC/capability-seams.md:754`；`DOC/subsystems/jobs.md`。

### 2.6 设置 / 存储 / HTTP

- `ctx.settings`：把活跃 profile 条目的 **volatile Config** 投影成表单（`describe/update/replace/mutate/configure/prepareDocument`），**不持久化插件自有数据**。证据：`DOC/subsystems/settings.md:5`、`:27-71`。
- `ctx.configEditor`：`editor.edit(entry, current => next)` 才是"改自己配置"的正规写入路径；不允许插件自己去改写 profile 的 `cordis.patch.yml`。证据：`A/dsh-agent-preset/skills/dsh-doc/references/configuration.md:3-12`。
- 插件自有持久化：`ctx.storage`（hub，`register`/`mount`）+ `ctx.storageDomain`（唯一的类型化数据门面，kv）。证据：`DOC/subsystems/storage.md:1-40`；`DOC/capability-seams.md:713-714`。
- 密钥：`ctx.credentials.modifyRecord()`，不要塞进 config。证据：`references/configuration.md:12`。
- `ctx.webServer`（`WebServer`）：`getOrigin()`、`register(route|resourceRoute)`（重复 `(kind,path)` 抛错）、`registerUpgrade(route)`、`claim fallback`、`readResource`。route handler 持有完整响应生命周期，**可以挂住连接做 SSE**。证据：`DOC/subsystems/web-server.md:106`、`:207-239`；`WebRoute.handler` 注释 `:22-24`。

### 2.7 客户端 ↔ 服务端通信

| 通道 | 形态 | 证据 |
|---|---|---|
| Remote unary | `POST /api/<namespace>/<method>`，JSON，可带二进制附件 | `DOC/api-gateway.md:126-130` |
| Remote stream | `/api/remote.mux` WebSocket（浏览器）；Desktop 由壳 carrier 提供同一逻辑流 | `DOC/api-gateway.md:60`；`A/dsh-client-connection/README.md:30-40` |
| 精确 Fetch 路由 | 插件在 `ctx.webServer` 注册 exact route，客户端直接 fetch（非 RPC 信封，可 SSE） | `DOC/api-gateway.md:166`；`DOC/subsystems/web-server.md:22-24` |
| Host→Client 事件 | `ctx.remote.$on(event, listener)`，**key 集 = 应用编译期的转发白名单**，不是插件可扩展的 | `A/dsh-api-gateway/README.md:68`；白名单 `A/dsh-api-remotes/src/remote-events.ts:27-58` |
| 白名单实际内容（节选） | `approval/request`(waterfall)、`user-questions/request`(waterfall)、`api-session/added`、`api-session/removed`、`api-session/status`、`api-session/activity`、`api-session/error`、`schedule/changed`、`llm/models-updated`、`settings/document-updated`、`commands/change`、`cordis/*`、`plugin-manager/*` | `A/dsh-api-remotes/src/remote-events.ts:28-58` |

**Desktop 特有事实（很重要）**：文档说 `ctx.webServer` "只服务浏览器，Electron 走 file:// + IPC bridge"（`DOC/subsystems/web-server.md:5`），但**本版本 Desktop 的外壳已经把 `dsh-app://app/<任意非静态路径>` 反向代理到 Host HTTP**：`ASAR/lib/main.js:20791-20798`（`protocol.handle(SCHEME, …)`，非 `index.html`/`assets` 的路径走 `forwardWebRequest(request, hostUrl, hostCookie)`），`forwardWebRequest` 用 `fetch(..., { body: request.body, duplex: 'half' })` 并把 `response.body` 原样透传（`ASAR/lib/main.js:15348-15378`）——**流式/SSE 可通**。WS 也被代理并注入 host cookie（`ASAR/lib/main.js:20832-20839`）。

因此：**插件在 `ctx.webServer` 注册的 HTTP 路由，在 Desktop 窗口里用同源相对路径 fetch 是可达的**（推断：同源 = `dsh-app://app`；未在运行态实测）。
反面：**插件不能新增 `$on` 事件**（白名单编译期固定，且 Client 端 Remote 契约来自生成产物），也不能让 Client 侧"发现"你新加的 `@Remote`（`DOC/api-gateway.md:82`、`:164`；`A/dsh-api-gateway/README.md:68`）。

---

## 3. 能否以编程方式"新建会话并让它跑一个 prompt"？

**能，两条路径。**

### 路径 A（推荐，GUI 同款）：`ctx.sessionController`

```ts
// Host 插件内
const { sessionId } = await ctx.sessionController.create({
  cwd: '/Users/lzx/work/project',   // 或 workspaceId（二者互斥）
  agentPreset: 'standard',          // 可选，缺省用配置的默认 preset
  // sessionId?: SessionId         // 可选：复用空白会话 / 指定新会话 id
})
await ctx.sessionController.selectModel({ sessionId, provider: 'tokfans', model: 'deepseek-flash', reasoningEffort: 'high' })
await ctx.sessionController.prompt({
  requestId, sessionId, mode: 'queue',
  content: [{ type: 'text', text: '开始今天的排期' }],  // 结构见 PromptContentPart
})
// 中断
ctx.sessionController.cancel({ sessionId })
```

证据：`create` 签名与请求体 `A/dsh-api-session-controller/src/index.ts:306-309` + `src/types.ts:268-285`；`selectModel` `:316-319`；`prompt` `:467-492` + `src/types.ts:324-331`；`cancel` `:519-522`；`modelCatalog` `:343-346`。
这是 Web GUI 自己用的同一条路径（Remote 名 `session`），所以它建出来的会话会走正常控制器事件（`api-session/added`），侧栏能看到。【推断/需实测：插件在非模型 turn 中调用 `prompt` 的权限与时机没有额外栅栏】

### 路径 B（更底层，可定制 agentCtx）：`ctx.agents.create`

```ts
const handle = await ctx.agents.create({
  sessionId,                       // 调用方提供的唯一 id
  meta: { cwd, agentPreset, origin?, parentSession?, isSeeded?, delegationDepth? },
  agentOptions: { provider, model, reasoningEffort, maxTokens },
  setup(agentCtx, agent) {         // 可注入 scoped tools / prompt section / listeners
    agentCtx.tools.register(myTool)
    return { commit() {} }
  },
})
handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '…' }], source: { kind: 'user' } }))
// 销毁：await handle.dispose()
```

证据：`CreateAgentOptions` 全字段 `A/dsh-agent/src/index.ts:66-121`（`meta.cwd` `:80-87`、`agentOptions` `:98`、`setup` `:101-120`）；`create` 返回 `AgentHandle{agent, dispose}` 见 `DOC/subsystems/core.md:43-46`、`:771`；`followup` 语义"排一轮普通后续并唤醒 driver"见 `DOC/subsystems/core.md:119-124`；`createUserMessage` 见 `A/dsh-llm/src/message.ts:246-253`（消息体是 `content` + `source`，`UserMessage` 定义 `:162-164`）。
注意：**不要用 `sessionController.create` 之后再 `ctx.agents.create` 同一个 id**；两条路互斥。`ctx.agents.create` 的 Agent 生命周期归调用方 fiber，插件卸载会 dispose（`A/dsh-agent/src/index.ts:29-46` 的 ownership 说明）。

### 参数支持一览

| 参数 | 路径 A | 路径 B |
|---|---|---|
| 工作目录 | `cwd` 或 `workspaceId` | `meta.cwd`（绝对路径，必填校验） |
| Agent preset | `agentPreset` | `meta.agentPreset` |
| provider/model/reasoningEffort | `selectModel`（会话级，落 `model/selection`） | `agentOptions`（路由回退；会话记录的选择优先） |
| 初始 prompt | `prompt({ mode: 'queue' 或 'steer' })` | `followup` / `steer` / `inject` |
| 中断 | `cancel` | `agent.cancel(cause)` |
| 观察 | 客户端事件 / `sessionQuery` | `agent/status`、`turn/end`、`session/event`、`whenIdle()` |

---

## 4. 审批请求的事件模式与回传；能否做"悬浮窗与主窗口竞答"

### 4.1 事件模式（实证）

- `approval/request`：**waterfall**，签名 `(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>`；"Return an outcome to claim the request or call `next()` to delegate"；agent 作用域过滤。证据：`DOC/subsystems/approval.md:150-169`。
- 结果集是封闭的：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，只有 `allowed-once` 是放行；answerer 缺失/抛错/返回值不合规一律降级 `unavailable`（fail-closed）。证据：`DOC/subsystems/approval.md:21-29`。
- `ctx.approval.request(req)` 要求"请求方会话处于已打开的 turn 内"，会先落 `approval/asked`、再落 `approval/decided` 审计对；`never` 策略在 waterfall 之前强制执行，后注册的 `prepend` answerer 也绕不过。证据：`DOC/subsystems/approval.md:86`、`:105-132`。
- 回传不是"另一个 API"：**answerer 的返回值就是答案**。真实例子是 Web 端监听器：

```ts
ctx.remote.$on('approval/request', function (request, next) {
  return answerApproval(ctx, this, request, next, registerPendingInteraction)
})
```

证据：`A/dsh-client-ui-approval/src/client/index.ts:107-109`；其内部把请求包装成 `PendingApproval` 并注册到会话的 pending-interaction 域（`:90-92`、`:56-71`）。
用户提问同理：`user-questions/request` waterfall；`ask()` 是阻塞版，`askTimed()` + `attachWait` 是"限时等待、超时转 pending、稍后可 `answer()` 补答"的版本。证据：`DOC/subsystems/user-questions.md:299-323`、`:147-208`、`:252-292`。

### 4.2 「悬浮窗与主窗口竞答，先到者生效」——可以，但不是"两个 answerer"

**不能**简单再注册一个 `approval/request` 监听器去抢：waterfall 是按注册顺序串行调用、每个 answerer 会 await 到用户作答（`A/dsh-client-ui-approval/src/client/index.ts:38-72` 里 `await pending.result`，只有 delegate 才 `next()`）。第二个监听器在第一个认领期间根本轮不到，做不到"谁的 UI 先点谁生效"。而且 waterfall 语义是"第一个返回值占住唯一决策位"（`DOC/subsystems/approval.md:86`），不存在并行竞速。

**正解**：只保留一个审批消费者，把**同一个 `PendingApproval` 实例**喂给两个 UI 位置：

1. 会话标准状态里已经暴露了"当前待交互请求"：`SessionStatus.pendingInteraction`（`A/dsh-client-ui-session/src/client/index.ts:59-67`），通过标准 hook `useSessionStatus`（`:69-72`）在**任意槽位**可读（`DOC/subsystems/slots.md:107-110`，`useSessionStatus` 是 every-scope 标准 props）。
2. `PendingApproval` 自身就是一次性结算对象：`answerable`（`…/contract/slots.ts:140-142`）、`answer(outcome)`（`:148-152`）、`delegate()`（`:154-158`）；内部 `finish()` 二次结算会抛 `pending approval <key> is already settled`（`:178-185`）。
3. 于是：主窗口继续用官方 composer 卡片（`conversation.composer` chain + `conversation.approval.card`，`A/dsh-client-ui-approval/src/client/index.ts:93-106`），你的悬浮面板在 `shell.overlay` 里读同一个 `pendingInteraction` 渲染一份精简版；两边都调 `answer('allowed-once'|'rejected')`，先点的把 Promise resolve，后点的必须检查 `answerable` 并吞掉异常——**天然"先到者生效"**。
4. 请求结束后 `registerPendingInteraction` 的 disposer 会把 pending 移除（`…/index.ts:57-71` 的 `finally { remove() }`），两个 UI 同时消失，不会留下僵尸卡片。

【未验证】`PendingApproval` 是 `@deepseek-ai/dsh-client-ui-approval` 的运行时类；外部插件不需要 import 它的值也能工作（只读对象上的 `answer`/`answerable`），但类型声明需要 `import type` 该契约，或自行按结构化类型声明。若该包被用户禁用，则 `pendingInteraction` 不会出现，需要 fallback 到自建 answerer（此时才考虑 Host 侧仲裁）。

**如果坚持要两个独立 answerer**：只能在 Host 侧写一个"仲裁 answerer"——它 `prepend` 到 `approval/request`，同时向两处 UI 广播同一次请求（自建 client 通道），`Promise.race` 取先到者返回；输的一侧必须自行撤卡。代价：绕开官方 `PendingApproval` 生命周期、要自己处理 abort/`cancelled`、且 `never` 策略下仍然不该被调用。**不推荐**。

### 4.3 相关坑

- `ctx.approval.request` 必须有打开的 turn，空闲时直接 reject（`DOC/subsystems/approval.md:86`、`:132`）。
- 取消语义：`req.signal` abort → 立即结算 `cancelled`，迟到的答案被丢弃（`DOC/subsystems/approval.md:76-80`）。所以"先到者生效"后**不要**用 abort 去关另一张卡，那会变成取消；靠 `answerable` + 卸载即可。
- `ask()` 对 subagent 来源的调用方直接拒绝（`DELEGATED_CALLER`），`askTimed` 才有"限时 + 迟到补答"（`DOC/subsystems/user-questions.md:278-292`、`:147-156`）。

---

## 5. 插件之间如何互相发现与协作？

### 5.1 机制（按推荐度）

1. **Cordis 服务注册表（首选）**：`ctx.provide(name, value)` 注册、`inject: ['name']` 声明依赖、`ctx.get('name')` 惰性取；作用域内同名重复注册抛错，disposer 注销。证据：`DOC/cordis-api/context.md:286-314`。Client 侧同样可用（`ctx.reflect.provide('layout', layout)` 就是官方范例：`A/dsh-client-ui-layout/src/client/index.ts:191`）。
   → commander 与 super-kanban 互相调用，最干净的方式是各自 `provide` 一个窄接口对象（例如 `provide('superKanban', { listBoards, moveCard, subscribe })`），对方 `inject` 后直接调方法。
2. **共用 tools 注册表**：`ctx.tools.register(definition)` / `get(name, scope?)` / `executable` / `definitions(scope?)` / `execute(batch)`。证据：`DOC/subsystems/tools.md:650-750`。
   → 若 super-kanban 的能力是**模型工具**，Host 侧可以用 `ctx.tools.execute({ calls, signal, agent })` 以某个 Agent 的作用域直接执行（`:729-735`、`:235-265`），不必绕模型；但要注意 scope 可见性（scoped 覆盖 global、`restrict` 会藏起来）。
3. **Typed events**：Cordis 的 `emit/waterfall/parallel/serial/bail`，事件名靠 declaration merging 共享；没有"全局广播总线"这一独立设施。证据：`DOC/cordis-primer.md:12`、`:15-27`。
4. **UI 组合**：Slot 是跨插件 UI 的唯一正道（`DOC/subsystems/web-client.md:91`）。
5. **运行态自省**：`ctx.cordisInspect`（Host/Client 的 Cordis 树查询），供调试与 `cordis_inspect` 工具用，不适合做业务耦合（`DOC/capability-seams.md:765`）。

### 5.2 明确的"不能"

- Client 侧**不能**在运行时发现并调用别的插件新加的 `@Remote` 方法：Client 的 Remote 方法集是构建期生成并显式 `$mount` 的（`DOC/api-gateway.md:82`；`DOC/api-gateway.md:164`；`A/dsh-api-gateway/README.md:68`）。
- **不能**给 `ctx.remote.$on` 增加新事件：key 集是应用装配的转发白名单（`A/dsh-api-remotes/src/remote-events.ts:1-7`、`:27-58`）。
- 因此"commander 的 Client 端要拿 super-kanban 的数据"只有三条路：① 走 Host 服务（commander Host 调 super-kanban Host 服务，再通过 commander 自己的 HTTP 路由喂给前端）；② 复用白名单里已有的数据流；③ 让 super-kanban 自己把 UI 注册进同一个槽位（组合而非调用）。

### 5.3 给"指挥官调 super-kanban"的推荐契约

```ts
// super-kanban Host 侧
ctx.provide('superKanban', {
  listBoards(workspaceId?): Promise<BoardSummary[]>,
  getBoard(id): Promise<Board>,
  moveCard(boardId, cardId, toColumn, index?): Promise<void>,
  on('card-moved' | 'board-changed', listener): () => void,  // 自己实现订阅
})
// 指挥官 Host 侧
export const inject = ['superKanban', 'sessionController', 'schedule', 'storageDomain']
```

若 super-kanban 只暴露了模型工具而没有服务，指挥官可以用 `ctx.tools.execute` 以指定 agent 执行其工具（可行但耦合在 schema 上，不如服务接口稳）。若它既无服务也无工具，则只能由指挥官维护自己的映射表（脆弱）。

---

## 6. 「常驻会话 + 看板 UI + 悬浮入口 + 后台调度」应如何分层

### 6.1 分层原则

1. **Host 拥有真相**：会话、调度、审批、看板数据、持久化都在 Host（Node 进程）；Client 只做呈现与输入。依据：`DOC/subsystems/web-client.md:9-20`、`:54`；`references/practices.md:7`（会话日志是唯一真源）。
2. **Client 不得持有业务真相**：slot store 只放"视图状态"（`DOC/subsystems/slots.md:227`）。
3. **跨层只有两条管道**：HTTP exact route（可 SSE）或已有 Remote 命名空间；不要指望新 `@Remote`/新转发事件。
4. **一个 bundle，两半入口**：`package.json` 同时声明 `dsh.bundle.patch`（Host 行）与 `dsh.client`（浏览器模块），这是官方支持的单包双面形态（`references/ui-plugin.md:3`；`references/host-plugin.md:5-27`）。

### 6.2 推荐结构（文字版）

```
┌────────────────────────────── 一个 bundle: @local/dsh-commander ──────────────────────────────┐
│                                                                                              │
│  Host 半（Node，跑在 DSH Host 子进程；ELECTRON_RUN_AS_NODE=1）                                 │
│  ├─ state/            board 数据、映射表 → ctx.storageDomain（kv）或 ctx.storage                  │
│  ├─ resident/         常驻会话：ctx.sessionController.create({cwd, agentPreset})                │
│  │                    → 记住 sessionId（durable）→ 启动时 resume/复用；prompt() 投喂            │
│  ├─ scheduler/        ctx.schedule.create({ timing:{kind:'every'|'cron'|'rrule'},              │
│  │                       target:{ kind:'session', sessionId } })  ← 心跳/巡检                 │
│  ├─ cards/            卡片状态机：把 turn/end、tool/result、agent/status 折叠成卡（投影）        │
│  ├─ api/              ctx.webServer.register({ kind:'prefix', path:'/commander/api', … })      │
│  │                    + GET /commander/events (SSE, handler 持有 res)                          │
│  ├─ approval/（可选）  approval/request 的 Host 侧仲裁（仅在不用 PendingApproval 方案时）        │
│  └─ tools/            给模型用的 commander_* 工具（ctx.tools.register）                        │
│                                                                                              │
│  Client 半（浏览器，dsh-app://app 页面内）                                                    │
│  ├─ floating/         shell.overlay  → 悬浮球（pointer-events:auto）+ 展开浮层面板              │
│  │                    数据：fetch('/commander/api/…') + EventSource('/commander/events')       │
│  ├─ board/            main[key='commander'] 整页（ctx.layout.selectPanel('commander')）        │
│  │              或     sidebarRightTabs.register + sidebar.right.pane.tab（可 float()）         │
│  ├─ entry/            sidebar.panellist + sidebar.panel.icon（侧栏入口）                       │
│  ├─ approval-view/    读 useSessionStatus(…).pendingInteraction → 渲染/answer 同一实例         │
│  └─ store/            纯视图状态（选中列、展开态），不存业务真相                                 │
│                                                                                              │
│  Preset 半（可选，第三个 bundle）：                                                          │
│  └─ @local/dsh-commander-preset → 常驻会话专用 persona + tools + skills（agentPreset: 'commander'）│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 关键决策点与理由

- **浮层选 `shell.overlay`，不选 `shell.bottom`/`rightbar`**：后两者是 `single` 且已被占用（替换会顶掉官方 UI）；`shell.overlay` 是 `list` + `replaceRisk: none` + click-through（`A/dsh-cordis-client-runner/src/client/slot-catalog.ts:4074`、`A/dsh-client-ui-layout/src/client/index.ts:97-107`）。
- **看板优先放 `main` keyed 页**（全宽、独立路由、不挤压对话），次选右侧栏新 tab（可 `float(tabId, rect)` 变浮动面板，`A/dsh-client-ui-sidebar-right/README.md:101-103`），再次才是 overlay 里塞整页（会盖住输入框）。
- **常驻会话用 `new_once` 语义**：用 `ctx.sessionController` 建一次、把 id 存进 storage、之后用 `session` 目标调度；不要每次 `new`（会无限长会话树，且 `new` 有最小投递间隔与 `pendingDelivery` 重试语义，`DOC/subsystems/schedule.md:78-84`、`:127-131`）。
- **心跳/巡检用 `ctx.schedule`，不要自己起 setInterval**：schedule 与会话激活解耦、持久化在 Host、支持 cron/rrule（`DOC/subsystems/schedule.md:5`、`:26-34`）。真要进程内定时器，必须放在 `ctx.effect` 里并在 disposer 清掉（`references/practices.md:29`）。
- **状态折叠用 `ctx.sessionProjections`**（而不是自己订阅 `session/event` 全量扫），`apply(state,event)` 纯函数 + `stateOf()`（`references/practices.md:26-27`）。
- **审批竞答用"同一 `PendingApproval` 双渲染"**（见 §4.2），不要双 answerer。
- **前后端数据用 exact route + SSE**，不要试图新增转发事件或客户端 Remote（见 §2.7、§5.2）。
- **常驻会话的归属**：`ctx.sessionController` 建的会话归控制器管理；`ctx.agents.create` 建的归你的 fiber，插件卸载/升级会 dispose——如果希望"永久常驻"，用前者并在启动时按 id `resume`，别把 handle 当成永久资源。

---

## 7. 官方文档写明的能力边界 / 限制 / 坑

### 7.1 硬边界

| 边界 | 原文/证据 |
|---|---|
| Client 插件只存在于 Web GUI 页面；没有"CLI/headless 的 slot" | `DOC/subsystems/web-client.md:5`（"browser-side Cordis application"）；`DOC/subsystems/slots.md:5`；`references/ui-plugin.md:1` |
| 不得替换应用根、不得往 `document.body` 追加第二个应用 | `references/ui-plugin.md:13`；`references/practices.md:36` |
| 不得在组件外写 DOM / 操纵别人的 DOM、样式、组件源码 | `references/practices.md:36`；`references/ui-plugin.md:13` |
| 不得用 Host 渲染 HTML + iframe 嵌进页面（拿不到主题/暗色/locale） | `references/practices.md:33` |
| 不得 `require` 任何 Harness Client 包（含 `ui-primitives`）；组件抛错会把 slot 条目整块变空 | `references/practices.md:35` |
| 不得给会话日志加新 `type`；`appendPluginRecord()` 保留给 DSH 实验包 | `references/practices.md:21` |
| waterfall 监听器不拥有决策时必须 `next()`；改写决策要展开保留字段 | `references/practices.md:16` |
| 安装 bundle = 在 Host 进程执行插件代码，需要 Full access 或审批 | `references/compositions.md:69` |
| `never` 审批策略在 answerer 之前生效，后注册也绕不过 | `DOC/subsystems/approval.md:86` |
| `ctx.approval.request` 必须在打开的 turn 内 | `DOC/subsystems/approval.md:86`、`:132` |
| 不得靠读写/过滤 profile 的 `cordis.patch.yml` 持久化自己的配置 | `references/configuration.md:3-10` |
| 图标 ≤ 256 KiB 且必须在包内（禁绝对路径/URL/外链符号链接）；详情文档 ≤ `pluginManager.detailMaxBytes`（默认 1 MiB），超限会显示失败而非回退 README | `references/host-plugin.md:52`、`:34` |
| 会话日志是唯一真源；插件内存只是派生缓存 | `references/practices.md:7` |
| 不要在 `agent/status` 上轮询；用 `turn/end`/`assistant/message`/`tool/result` 等持久事件 | `references/practices.md:28` |

### 7.2 结构性坑（本项目最容易踩）

1. **审批"竞答"**：waterfall 串行 + 唯一决策位（§4.2）。做成双 answerer 会互相饿死。
2. **新事件转发**：`ctx.remote.$on` 的 key 是编译期白名单（`A/dsh-api-remotes/src/remote-events.ts:1-7`），第三方插件加不进去；Host→Client 推送请走 HTTP/SSE 或复用已有流。
3. **新 Remote 方法**：Client 侧方法集是生成产物，`api-remotes` 显式 mount（`DOC/api-gateway.md:80-82`）；插件新增 `@Remote` 对现有前端不可见（除非自带生成产物 + 装配层改动，【未验证】可行性）。
4. **Desktop 传输与 Web 不同**：Remote 流由壳 carrier 承载（`A/dsh-client-connection/README.md:30-40`），但 exact HTTP 路由经 `dsh-app://` 反代可达（`ASAR/lib/main.js:20791-20798`、`:15348-15378`）；别再按"webServer 只服务浏览器"的旧文档下结论。
5. **插件重载会中断常驻会话**：Agent 生命周期绑定 fiber（`A/dsh-agent/src/index.ts:29-46`），升级插件=卸载+重装；常驻会话要能"断开后可 resume"。
6. **多窗口/多标签**：Host 只有一个，Client 每个页面一棵树；审批 pending 在每个页面各自实例化（`client-ui-approval` 的监听器每个页面注册一次），跨标签页"竞答"实际是"各自 answer，Host 只认第一个到达的返回值"——【推断】Host waterfall 的 answerer 若按页面各注册一份，先返回者仍占决策位，但两张卡会各自停留到各自超时/卸载；需要实测。
7. **`shell.overlay` 的点击穿透**：整层 click-through，条目必须自己 `pointer-events: auto`，否则悬浮球点不到；反过来，覆盖全屏的浮层若忘了这层，会让整个应用"点不动"。
8. **样式只能用主题 token**（`--dsw-alias-*`），字面色只允许出现在 artwork（`references/practices.md:34`）；token 改名只会"变丑"不会崩，但不要硬编码颜色。
9. **`single` 槽位是替换点**：`sidebar`/`rightbar`/`root`/`shell.bottom`/`shell.leading` 注册即顶掉官方 UI（`DOC/subsystems/slots.md:69`、`:230`）；新增请用 `list`/`hoc` 的新 id 或未占用的 keyed key。
10. **`main` keyed 页会顶掉对话**：`ctx.layout.selectPanel(id)` 切走后当前会话仍保留（layout README `:36`），但用户会"看不见对话"；看板页要有明确的返回对话入口，或改用右侧栏 tab。

### 7.3 能力归属总结

| 能力 | 能做 | 必须原生壳 | 需要妥协 |
|---|---|---|---|
| 悬浮球 / 悬浮面板（应用内） | ✅ `shell.overlay` | | 只在窗口内，不置顶、不出窗口 |
| OS 级悬浮球 / 透明置顶 / 第二窗口 | | ✅ 改 `ASAR/lib/main.js` + preload + IPC | |
| 看板整页 | ✅ `main` keyed | | 顶掉对话视图 |
| 看板侧栏页 / 浮动面板 | ✅ `sidebarRightTabs` + `float()` | | 仍是应用内浮层 |
| 常驻会话 + prompt | ✅ `sessionController` / `agents` | | 插件重载会断，需要 resume |
| 后台调度 | ✅ `ctx.schedule` | | 最小 60s 间隔；Host 必须运行 |
| 审批双处竞答 | ✅ 同一 `PendingApproval` | | 不能双 answerer；后点方要吞异常 |
| Host→Client 实时推送 | ✅ HTTP/SSE 或已有流 | | 不能新增转发事件/新 Remote |
| 跨插件调用 | ✅ `ctx.provide`/`inject`/tools | | 依赖方要显式声明服务名 |
| 插件持久化 | ✅ `storageDomain` / `storage` | | 不能塞进会话日志新事件类型 |

---

## 附录：证据索引（按问题）

**Q1 Slots / 窗口**
- `A/dsh-client-ui-layout/src/client/index.ts:60-121`（壳层 6 槽 + overlay 语义）、`:192-205`（运行期声明）
- `A/dsh-client-ui-layout/README.md:36-47`（main 面板、shell.bottom、overlay 覆盖整 frame）
- `A/dsh-cordis-client-runner/src/client/slot-catalog.ts:3944-4076`（shell.bottom / shell.leading / shell.overlay 全字段）、`:4052-4073`（现有占用者）
- `DOC/subsystems/slots.md:5-27`、`:54-69`、`:107-118`、`:221`
- `DOC/subsystems/web-client.md:5`、`:9-20`、`:91`
- `references/ui-plugin.md:5`、`:13`
- `references/practices.md:33-36`
- `ASAR/lib/main.js:2`、`:20243`、`:20261-20274`、`:11550-11558`、`:11784-11802`、`:15348-15378`、`:20791-20798`、`:20832-20839`
- `ASAR/lib/preload-app.cjs:1967-1995`、`:1998-2015`、`:2112`

**Q2 服务**
- `DOC/capability-seams.md:681`(llm)、`:688`(sessionController)、`:713-714`(storage)、`:717`(workspaceRegistry)、`:723`(tools)、`:724`(userQuestions)、`:726`(agentPresets)、`:727`(commands)、`:731`(agents)、`:733`(agentLoop)、`:735`(schedule)、`:744`(approval)、`:754`(jobs)、`:758`(webServer)、`:765`(cordisInspect)
- `DOC/subsystems/session.md:1106-1247`
- `DOC/subsystems/core.md:22-56`、`:684-840`
- `DOC/subsystems/approval.md`、`DOC/subsystems/user-questions.md`
- `DOC/subsystems/llm-streaming.md:1022-1186`
- `DOC/subsystems/schedule.md:86-102`、`:150-270`
- `DOC/subsystems/settings.md:1-71`；`references/configuration.md`
- `DOC/subsystems/web-server.md:5`、`:22-24`、`:106`、`:203-239`
- `DOC/api-gateway.md:60`、`:80-82`、`:126-130`、`:164`；`A/dsh-api-gateway/README.md:68`（$on 白名单）
- `A/dsh-api-remotes/src/remote-events.ts:27-58`
- `A/dsh-client-connection/README.md:20-45`

**Q3 建会话 + prompt**
- `A/dsh-api-session-controller/src/index.ts:306-346`、`:467-522`
- `A/dsh-api-session-controller/src/types.ts:268-285`、`:324-331`
- `A/dsh-agent/src/index.ts:66-144`
- `DOC/subsystems/core.md:24`、`:43-46`、`:55-143`、`:771-840`
- `A/dsh-llm/src/message.ts:110-180`、`:246-253`
- `DOC/subsystems/schedule.md:78-84`（new/new_once 的 cwd + agentPreset）

**Q4 审批**
- `DOC/subsystems/approval.md:21-29`、`:76-86`、`:100-169`
- `DOC/subsystems/user-questions.md:147-208`、`:232-323`
- `A/dsh-client-ui-approval/src/client/index.ts:38-72`、`:90-109`
- `A/dsh-client-ui-approval/src/client/contract/slots.ts:84-186`、`:206-230`
- `A/dsh-client-ui-session/src/client/index.ts:59-72`
- `DOC/subsystems/slots.md:107-110`（useSessionStatus 为 every-scope 标准 props）

**Q5 互操作**
- `DOC/cordis-api/context.md:286-314`（provide）
- `DOC/subsystems/tools.md:650-750`
- `DOC/cordis-primer.md:12`、`:15-27`
- `A/dsh-api-gateway/README.md:68`；`DOC/api-gateway.md:80-82`；`A/dsh-api-remotes/src/remote-events.ts:1-7`

**Q6/Q7 分层与边界**
- `references/practices.md:7`、`:16-29`、`:36`
- `references/host-plugin.md:5-27`、`:34`、`:52`、`:60-65`
- `references/compositions.md:69`
- `references/configuration.md:3-12`
- `DOC/subsystems/schedule.md:127-131`
- `A/dsh-client-ui-sidebar-right/README.md:83-86`、`:101-103`

---

## 附：待实测清单（写代码前先验）

1. Desktop 页面内 `fetch('/commander/api/ping')` 是否经 `dsh-app://app` 反代到 Host（预期 200；`ASAR/lib/main.js:20791-20798` 已具备条件）。
2. 同一路由的 SSE 在 Desktop 是否持续流式（`forwardWebRequest` 透传 `response.body`，预期可；需验证心跳与关闭）。
3. `ctx.sessionController.prompt` 在"插件自己没有打开的 turn"时是否被拒（文档只对 `ctx.approval.request` 明说要 open turn）。
4. `ctx.agents.create` 建出的会话是否出现在官方侧栏（`api-session/added` 是否触发；还是必须走 `sessionController`）。
5. `useSessionStatus(...).pendingInteraction` 在 `shell.overlay`（root 作用域）里能否读到当前会话的 pending（root 作用域没有绑定 session，需要 `useSessions` 选定当前会话 id 再查）。
6. 多标签/多窗口下同一审批的两个 `PendingApproval` 是否独立、后到者是否收到 `gateway/...` 或 `already settled`。
