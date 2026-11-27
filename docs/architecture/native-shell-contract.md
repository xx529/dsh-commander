# 原生壳浮窗契约（M4 / macOS 先行）

> 版本：v0.6（2026-11-27）　状态：实现契约（P1 骨架；v0.2 球常驻 + 独立面板窗口；v0.3 Lite 状态气泡窗；v0.4 液态金属球 / 金属气泡 / 银白 working 卫星 / 快捷输入 / 悬停高亮 / 未读脉冲；v0.5 气泡展示当前活动：工具 description / assistant 文本；v0.6 气泡多行：336×124、最多 5 行、贴屏幕下方时向上长、输入框优先）
> 上游需求：`docs/PRODUCT-DESIGN.md` §18 M4「原生壳、系统级悬浮、全局热键 → 任意应用可见」
> 技术依据：`research/notes/float-tech.md` §5.2；`research/notes/dsh-capabilities.md` §1.4
> 本文只描述**原生壳**这一层；`/commander/*` 既有数据面契约仍以 `docs/architecture/implementation-plan.md` §8 为准。

---

## 1. 范围

**做**：一个由 Host 插件启动的原生 GUI 进程（Tauri 2 + 系统 WebView），提供：

| 能力 | P1 | P2 |
|---|---|---|
| 独立于 DSH 窗口的悬浮球（无边框、透明、置顶、无 Dock） | ✅ | — |
| 点击打开/收起指挥面板（球 76×76 窗口（球 60，四周 8px 透明边）常驻 + 独立面板窗口 420×660） | ✅ | — |
| 状态气泡（working：当前工具 description / assistant 文本，缺省回退「正在思考」；完成：已完成·点击球查看，独立 click-through 窗 336×124，最多 5 行） | ✅ | — |
| 全局热键（默认 Option+Space，Carbon） | ✅ | — |
| 位置持久化 + 多屏 clamp | ✅ | — |
| 复用 `/commander/*` 数据面（快照、SSE、发消息） | ✅ | — |
| 看板（状态分组、详情、验收/返工/归档） | ✅ | — |
| 权限审批卡（壳聚焦时条件接管，否则回落 DSH） | ✅ | — |
| 跨所有 Space / 全屏应用之上（`collectionBehavior`） | ✅（P1；真机待验证） | — |
| 问答卡（`ask_user_question`）、播报、托盘 | — | ✅ |
| Windows | — | 后续（WebView2 依赖） |

**不做**：替换 DSH 桌面端、改 `app.asar`、在 Host 进程里建窗口、把原生壳做成第二个审批 answerer。

---

## 2. 进程模型

```
DSH Host 进程
└── commander Host 插件
    ├── 既有 /commander/* + SSE（数据面，不改语义）
    ├── 新增 GET /commander/window?token=…（窗口页 HTML，内联窗口 bundle）
    └── native/supervisor（spawn / 握手 / 心跳 / 退避重启 / 退出清理）
          │  stdio：NDJSON 控制帧（一行一个 JSON，stdout 只走协议）
          ▼
    Tauri 2 壳（macOS：.app 内的可执行文件或裸二进制）
    ├── 球窗口 main：透明、无边框、置顶、skipTaskbar、accessory 激活策略
    ├── 面板窗口 panel：透明、无边框、默认隐藏；打开面板时显示并聚焦，球窗口保持可见
    ├── 气泡窗口 bubble：透明、无边框、置顶、skipTaskbar、默认隐藏、click-through，不抢焦点
    ├── 三个 WKWebView 都加载 GET /commander/window（同一 Host origin，role 区分）
    └── 全局热键、位置文件、父 PID 看门狗
```

权威边界：

- **Host 是唯一写者**：壳不写 `commander` 存储域、不直接改配置；只发窗口控制帧，业务写入一律走 HTTP。
- **数据面复用**：壳内页面与 DSH 页内浮窗用同一套 `store` + `/commander/*`；不新增业务协议。
- **审批条件接管**：只有壳 `running + visible + focused` 时才 `prepend` 应答 `approval/request`；否则 `next()` 交回 DSH 主窗。壳退出/心跳失败/超时 → 未决请求以 `cancelled` 结算（fail closed），不重复提示。

---

## 3. 启动与握手

### 3.1 Host → 壳（环境变量）

| 变量 | 必填 | 含义 |
|---|---|---|
| `DSH_COMMANDER_WINDOW_URL` | 是 | `http://127.0.0.1:<port>/commander/window?token=<t>` |
| `DSH_COMMANDER_PARENT_PID` | 是 | Host 进程 pid；壳每 2s `kill(pid, 0)`，连续失败即退出 |
| `DSH_COMMANDER_STATE_DIR` | 是 | 位置/日志目录，默认 `~/.dsh/commander/native` |
| `DSH_COMMANDER_HOTKEY` | 否 | 默认 `Alt+Space`（macOS Option+Space） |
| `DSH_COMMANDER_THEME` | 否 | `light` / `dark` / `follow` |
| `DSH_COMMANDER_LOCALE` | 否 | `zh` / `en` |
| `DSH_COMMANDER_LOG` | 否 | `1` 时壳把诊断写 stderr |

### 3.2 帧协议（NDJSON，1 MiB/帧）

壳 → Host：

```ts
{ type: 'hello', protocol: 1, platform: 'darwin', arch: 'arm64', pid: number,
  capabilities: ['ball','panel','bubble','hotkey'], hotkey: string | null }
{ type: 'pong', at: number }
{ type: 'window/visibility', visible: boolean, panelOpen: boolean, focused: boolean }
{ type: 'window/bounds', x: number, y: number, width: number, height: number, scale: number }
{ type: 'log', level: 'info' | 'warn' | 'error', message: string }
```

Host → 壳：

```ts
{ type: 'ready', origin: string, theme: 'light'|'dark'|'follow', locale: 'zh'|'en',
  ball: { size: number }, panel: { width: number, height: number },
  entryPos: { x: number, y: number } | null, hotkey: string }
{ type: 'ping', at: number }
{ type: 'shutdown' }
```

规则：

- stdout **只写协议帧**；日志一律 stderr。
- `hello` 必须含 `protocol: 1`；不匹配时 Host 记录并停止重启（避免死循环）。
- Host 每 10s 发 `ping`；30s 无 `pong` 判死并退避重启。
- 壳收到 `shutdown` 后 1s 内退出；Host 2s 后 `SIGKILL`。
- 壳自身的退出会先写 `{type:'log'}` 说明原因（可选），再退出。

### 3.3 生命周期

- Host `apply` 里创建 supervisor，`ctx.effect` 清理时 `stop()`。
- 单实例：supervisor 每 Host 进程最多一个壳；壳侧用 `stateDir/shell.pid` 防重复启动。
- 启动失败/产物缺失：**不阻塞插件**，降级为页内 `shell.overlay`，`GET /commander/health` 增加 `nativeShell: 'absent' | 'starting' | 'running' | 'failed'`（加法字段）。
- 退避：750ms → 1.5s → 3s → 6s → 12s → 30s，最多 12 次；稳定运行 3 分钟后重置计数。
- 用户主动关闭壳（点窗口关闭）：壳退出后 Host 不再自动重启，直到用户从设置页「重新打开浮窗」或重启 DSH（P1 用环境变量/设置页按钮实现）。

---

## 4. 窗口行为

| 项 | P1 实现（v0.6 三窗口：球 76×76 / 面板 420×660 / 气泡 336×124） |
|---|---|
| 窗口 | 球窗口 `main`（透明、无边框、`always_on_top`、`skip_taskbar`、`resizable: false`、76×76）；面板窗口 `panel`（透明、无边框、`skip_taskbar`、`resizable: true`、默认 `visible: false`，展开时 `always_on_top: false`）；气泡窗口 `bubble`（336×124、透明、无边框、`always_on_top`、`skip_taskbar`、`resizable: false`、默认 `visible: false`） |
| 激活策略 | macOS `Accessory`（无 Dock 图标、不抢焦点）；气泡窗 `set_ignore_cursor_events(true)`，点击穿透 |
| 悬浮球 | 76×76 窗口、60px 圆形（8px 透明边），**液态金属**：银蓝 chrome conic + 左上白色高光 + 近黑底部 + 银色定向 rim；不透明、无 backdrop；边缘 `mask 86/94` + `blur 2px` rim 光带，不再有 1px 白边；42px 冷核；无中心符号、无右下连接点；working 时**银白卫星**沿球缘环行（4.6s）；显示可操作数徽标；**面板打开时仍然常驻可见**，点击切换面板打开/收起。完成气泡收起后进入未读态：绿色脉冲核心 + 双层绿色声呐，直到点击浮球/打开面板清除。 |
| 悬停高亮 | 原生每 80ms 在主线程读 `NSEvent.mouseLocation` 与球窗 `NSWindow.frame`，光标进入/离开球圆时发 `commander:ball-hover`（球页 + 气泡页）；球页面加 `is-hover`，气泡页用于「空输入 + 离开球」收起。不依赖窗口焦点，也不需要先点一下。 |
| 快捷输入 | 光标在球内停留 0.8s → 复用 bubble 窗（336×124）：`set_ignore_cursor_events(false)`、show、set_focus，页面从状态气泡切到输入；与状态气泡同一套**烟熏铬玻璃**（银色描边、顶部金属反光、镀铬 `>` 与发送键）；输入条只有「> / 输入 / 发送」，无 placeholder、无关闭按钮；Enter 发送、Esc 收起；空输入时光标离开球自动收起，有内容则保留；发送走既有 `POST /commander/message`；收起后状态气泡恢复；光标离开球后才重新武装，避免原地反复弹；面板打开时关闭。 |
| 状态气泡 | 监听 `commanderBusy` + `commanderActivity`：working 时气泡为**烟熏铬玻璃**（银色描边、顶部金属反光），显示**当前活动文案**——`tool/call` 参数含非空 `description` 时显示该值（没有则跳过、保留上一条），工具调用之间的 `assistant/message` 文本也显示；文案自然换行、**最多 5 行**（`line-clamp: 5`，行高 16.2 px），第 5 行尾部省略；宽度按内容取 `min(312, 文本宽 + 内边距)`，高度按行数取 `44 → 99`；无活动时回退「正在思考」，**无 spinner**；success 才有绿色检查/绿色呼吸，球上是银白卫星环行；busy 结束时气泡显示**最后一轮 assistant 回复**（同样最多 5 行、超出截断），外框保留绿色打勾 + 绿色呼吸表示「这是回复、不是工作过程」，取不到回复时才回退「已完成 · 点击球查看」；约 5s 后文案收起，浮球转为未读绿色脉冲核心 + 双层声呐，直到用户点击浮球/打开面板（`commander:mode` true）确认。新回合 busy 时重置；连接短暂抖动不清掉已完成的未读，只有点击浮球/打开面板才 ack。面板打开时若已完成则直接确认、不再提醒。不改消息通道（`commander.message` 仍只发 assistant 文本），活动只作为 `commander.status` 的加法字段。球在右侧时气泡在左、在左侧时翻到右；拖球时跟随；气泡窗阴影收在 12px 内边距。**锚定**：球在屏幕上半区时气泡顶边与球窗顶对齐（`y = ball.y`）、只向下长；球在屏幕下半区（`ball.y + 124 + 8 > 屏幕底`）时翻成底边对齐（`y = ball.y + 56 - 124`）、只向上长；两种锚定下尾巴都固定在球心高度（距 pill 顶/底 22 px），不随高度移动。**动效**：pill 常驻，文案切换 160 ms 等时长线性交叉（单行）/ 先出后进 240 ms（多行，避免两段多行叠字）；高度 210 ms `cubic-bezier(.2,.9,.3,1)`。**窗口显隐**：入场 180 ms 弹入、退场 150 ms 淡出，退场动画结束后才 `set_bubble(false)`，不再瞬时硬切。**输入框优先**：快捷输入打开时气泡先退 100 ms、输入框 100 ms 后入场，两者不叠加；输入框收起后气泡才恢复。 |
| 面板 | 420×660（看板 980×700 级别按屏幕比例）；首次打开居中，用户本次运行内调整过的 frame 记在内存 |
| 拖动 | 前端 pointer 事件：位移 > 4px 调 `startDragging()`（作用于当前窗口）；拖动后的 click 不切换面板 |
| 位置 | 球的 x/y 存 `stateDir/window.json`（移动 debounce 300ms 写回）；面板 frame 只在本次运行内存中记录 |
| 热键 | `tauri-plugin-global-shortcut`，默认 `Alt+Space`；打开/收起面板（球始终存在）；失败时降级为 `Ctrl+Alt+Space` 并在 hello 中上报 |
| 关闭 | 球窗口关闭 = 退出壳；面板窗口关闭 = 收起面板（隐藏，不退出）；气泡窗口关闭 = 隐藏气泡（不退出） |
| 退出 | 父 PID 看门狗 + Host 清理；不常驻 Dock/托盘（P2 可加托盘） |

跨 Space/全屏（P1 已启用）：macOS `NSWindow.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`（`enable_all_spaces`，objc2-app-kit 0.3.2，与 Tauri 同版本）。

---

## 5. 数据面与窗口页

- 窗口页地址：`GET /commander/window?token=<一次性 token>`，token 由 supervisor 每次启动生成（32 hex），仅内存保存。
- 壳按窗口角色追加查询参数：球窗口 `role=ball`，面板窗口 `panel=1&role=panel`，气泡窗口 `role=bubble`；`role` 只在取值合法时透传给窗口 bundle 的 `__COMMANDER_SHELL__.role`。`role=ball` 的页面只渲染球（点击发 `set_mode`），`role=panel` 的页面只渲染面板，`role=bubble` 的页面只渲染气泡；不带 `role` 时保持旧的同窗两态（浏览器直接打开 `?panel=1` 调试也走这条）。气泡窗不注入 fallback 球。
- token 校验通过后返回 HTML（内联窗口 bundle），并 `Set-Cookie: commander_window=<token>; Path=/commander; HttpOnly; SameSite=Strict`。
- 窗口页内同源访问 `/commander/state`、`POST /commander/message`、SSE，与 DSH 页内 client 完全同源同语义。
- 静态资源（`lib/window.js`）由 Host 在 HTML 中内联返回；不额外暴露静态目录。
- **已知限制（P1）**：`/commander/*` 写接口仍与现状一致，未对窗口页单独鉴权（loopback 信任）；token 只防止任意网页打开窗口页。P2 再评估全局 token。
- 气泡窗与球窗共用同一套 store / SSE；working 活动来自 `commander.status.activity`，快照 `commanderActivity` 用于重连/首次打开恢复。
- **v0.5 气泡活动（加法字段，不改既有事件语义）**：Host 在 `tool/call` 时解析 `data.arguments`（JSON 字符串）的顶层 `description`，非空则更新 `activity={text,at}`；为空/缺失/解析失败则跳过。工具调用之间的 `assistant/message` 文本也更新 activity。`turn/start`、`turn/end` 清空。Host 折叠空白并截到 200 字符（补 `...`）；Client 展示前再截到 120 字符（约 5 行），超出由 `line-clamp: 5` 兜住。`commander.message` 通道仍只发 assistant 文本，不新增消息类型、不落库。

### 5.1 气泡窗命令与事件（v0.4；v0.5 增加 SSE `commander.status.activity`）

| 方向 | 名称 | 语义 |
|---|---|---|
| 气泡页 → 壳 | `invoke('set_bubble', { visible: boolean })` | 状态气泡显隐；working/success 由页面驱动；快捷输入打开时忽略，关闭后由页面重新驱动 |
| 气泡页 → 壳 | `invoke('set_quick_input', { open: boolean })` | 收起/打开快捷输入；打开时气泡窗变为可交互、可聚焦 |
| 气泡页 → 壳 | `invoke('set_ball_unread', { unread: boolean })` | 5s 文案收起后打开浮球未读绿色脉冲；点击浮球/打开面板时清除 |
| 壳 → 气泡页 | `emit_to('bubble', 'commander:bubble-side', 'left'\|'right')` | 气泡在球左/右侧翻转；页面据此改尾巴方向 |
| 壳 → 气泡页 | `emit_to('bubble', 'commander:bubble-anchor', 'top'\|'bottom')` | 气泡贴屏幕上方（顶边对齐、向下长）还是下方（底边对齐、向上长）；页面据此改 pill 对齐与尾巴位置 |
| 壳 → 球页/气泡页 | `emit_to('main'/'bubble', 'commander:ball-hover', boolean)` | 原生轮询到的球悬停状态；球页 `is-hover`，气泡页空输入离开时收起 |
| 壳 → 气泡页 | `emit_to('bubble', 'commander:quick-input', boolean)` | 0.8s 停留后切到快捷输入；收起时切回状态气泡。输入框打开期间气泡不渲染（优先级高于状态气泡） |
| 壳 → 球页 | `emit_to('main', 'commander:ball-unread', boolean)` | 完成提示收起后的未读脉冲状态 |
| 壳内部 | `show_bubble` / `position_bubble` / `spawn_hover_watcher` / `show_quick_input` / `close_quick_input` | 贴球定位、翻转、面板打开时隐藏、球移动时跟随、悬停/停留检测、快捷输入聚焦/收起 |

ACL：`build.rs` 的 `app_manifest.commands` 加入 `set_bubble`、`set_quick_input`、`set_ball_unread`；`capabilities/default.json` 加入 `bubble` 窗口、`allow-set-bubble`、`allow-set-quick-input`、`allow-set-ball-unread`。

---

### 5.2 审批桥（P1）

- Host `src/host/native/approval-bridge.ts` 以 `{ prepend: true }` 监听 `approval/request`。
- 接管条件：supervisor `phase === 'running' && visible && focused`；任一不满足直接 `next()`（DSH 页内审批卡照旧）。
- 请求视图只含 `id/toolName/reason/at`（不含工具参数；与 DSH 的 `ApprovalRequest` 口径一致）。
- 通道：SSE `native.approval`（新请求）/ `native.approval.resolved`（结算）；`GET /commander/native/approvals` 补拉；`POST /commander/native/approval/:id` 回答 `{outcome:'allowed-once'|'rejected'}`。
- 超时 10 分钟 → `cancelled`；壳退出/心跳失败 → 所有未决 `cancelled`。
- 已知取舍：一旦接管，DSH 主窗的官方审批卡不再显示该请求；壳崩溃只能拒绝，不能回落给 DSH（waterfall 已越过其他应答者）。这是 P1 的显式边界。

## 6. 配置

- `ui.nativeShell`（boolean，缺省 true）：设置页「外观 → 桌面浮窗」开关；保存后**重启 DSH** 生效（Host 的 supervisor 在 apply 时读取一次）。
- 环境变量：`DSH_COMMANDER_NATIVE_SHELL=0` 仍可强制禁用（优先级最高）；`node --test` 进程（`NODE_TEST_CONTEXT`）默认禁用，隔离 e2e 用 `1` 显式开启。
- 位置：壳自己的 `window.json`；Host 启动时把 `ui.entryPos` 经 `ready` 下发，壳优先采用 `entryPos`（设置页「重置位置」重启后生效）。
- 主题/语言：从 `config.ui.theme` 与 DSH locale 推断，经 `ready`/环境变量下发。
- 设置页文案 key：`settings.appearance.nativeShell*`（zh/en 两份字典同改）。

---

## 7. 构建与安装

| 项 | 规则 |
|---|---|
| 源码 | `packages/dsh-commander/native/tauri/`（Cargo 工程，不加入 pnpm workspace） |
| 构建 | `pnpm --filter dsh-commander build:native` → `cargo build --release --no-bundle` → 产物复制到 `packages/dsh-commander/native/dist/<platform>-<arch>/` |
| 产物 | 裸可执行文件（macOS 可直接 spawn；不依赖 .app、不需要 Dock 图标） |
| 安装 | 产物随插件包进入 profile 的 `node_modules/dsh-commander/native/dist/...`；`package.json.files` 必须含 `native/dist` |
| 签名 | P1 ad-hoc：`build.sh` 复制后执行 `codesign --force --sign -`（macOS 26 上 linker-signed 二进制可能出现 `SIGKILL (Code Signature Invalid)`，显式重签可解）；分发前需 Developer ID + 公证 |
| 体积 | 约 10–20MB（Tauri 2）；`cargo` 工具链只在构建机需要 |

构建失败或产物缺失时，插件必须正常降级（见 §3.3）。

---

## 8. 测试与验收

| 层 | 用例 | 方式 |
|---|---|---|
| 单测（Host） | 帧编解码、token、supervisor 握手/心跳/退避/退出、路径解析、审批桥接管/回落/超时/退出取消、窗口页 role 注入 | `packages/dsh-commander/tests/unit/native-*.test.ts`，fake ChildProcess |
| 单测（Client） | 窗口页 App 的球/面板/发送渲染；`role` → 渲染决策 | `tests/client/window-*.test.ts`（tsx + jsdom harness） |
| 构建 | `tsc`、`tsdown`（client + window）、`cargo build` | 本地 |
| 集成 | 隔离 `DSH_HOME` 启动 Host → 壳 spawn → 窗口页 200 → 发一条消息 | `packages/dsh-commander/tests/e2e/m4-e2e.mjs`（macOS 真机） |
| 手工 | 球置顶/拖动/热键/多屏/重启恢复、看板操作、壳内审批 | 用户走查（截图证据入 `docs/validation/**`） |

验收（P1）：DSH 窗口最小化或切到别的应用后，悬浮球仍在最前；Option+Space 呼出/收起面板；**面板打开时球仍然常驻可见、可再次点击收起**；面板能收发消息；Host 退出后壳 2s 内退出；`/commander/health` 的 `nativeShell` 状态正确。

---

## 9. 风险与开放项

1. **Tauri 透明窗口**：macOS 需要 `macos-private-api` feature；首次构建需验证透明背景与圆角。
2. **WebView 加载 loopback http**：WKWebView 默认允许；若 DSH 路由返回 CSP/安全头，需要放行 `connect-src` 到自身 origin。
3. **热键冲突**：Option+Space 可能被输入法/其他应用占用；失败时降级并上报。
4. **未签名分发**：Gatekeeper/SmartScreen 提示；本机 `file:` 安装不触发。
5. **Windows 父进程看门狗**：`parent_alive` 在 Windows 返回 true（P2 接入 `OpenProcess`/`tasklist`），保留代码路径但本机不验证。
5. **双 UI 栈**：窗口页与 DSH 页内浮窗共用 store 与文案字典，但布局独立；后续抽公共组件。
6. **P2 审批**：需要先改 `m2m3-contract-patch.md` §3.3 的「审批只在 Client」边界，禁止直接实现。
