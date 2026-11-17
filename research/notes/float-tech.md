# DSH 系统级悬浮窗技术调研（macOS / Windows）

> 目标：为「指挥官」插件选型——需要一个覆盖所有应用的悬浮球 + 聊天面板 + 审批卡片 + 任务播报。
> 调研时间：2026-11-16。证据标注：`【代码】` 表示直接读到的源码/配置，`【文档】` 表示作者 README/架构文档，`【推断】` 表示基于平台机制的推论（未在本机实测）。

---

## 0. TL;DR

1. **DSH 官方插件体系本身做不到“覆盖所有应用”**。Host 插件跑在 dsh 进程里（Node），能跑 agent、订阅事件、抢审批、加 webServer 路由，但没有窗口/全局输入能力；Client 插件跑在 WebUI 页面里，`shell.overlay` 只是**页面级**整屏槽位，最远只覆盖 DSH 窗口；webServer 是 loopback HTTP，适合当“原生壳 ↔ Host”的桥，不是窗口 API。
2. 五个能覆盖桌面的样本走同一条路：**官方插件 + 一个独立的原生壳进程**。差别只在壳的技术栈（第六个 cockpit 是反例）：
   - Tauri/Rust：`dsh-quorfloat`（最完整）
   - Electron：`dsh-float`（Windows，最快出 UI）
   - Swift/AppKit + WKWebView：`dsh-petpal`（macOS 覆盖最正确）
   - Win32 + GDI+ FFI：`dsh-selection-tools`（Windows 最轻）
   - 完整桌面壳：`dsh-desktop`（不是插件悬浮窗，是替换 DSH 桌面端）
   - 纯页内浮层：`dsh-project-cockpit`（反例，说明 client 插件边界）
3. **给指挥官的建议**：macOS 优先选 **Tauri sidecar（照抄 quorfloat 的 Host↔壳协议）**，但必须补上 quorfloat 没做的 `NSWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]`；若只做 macOS 且追求极小体积，选 **Swift + WKWebView（petpal 模式）**。Electron 仅在 Windows 优先、团队熟 Electron 时选。

---

## 1. 六方案总表

| 项目 | 悬浮窗类型 | 技术栈 | 置顶 / 跨 Space / 全屏 | Host↔壳 通信 | 全局热键 | 特殊权限 | 能否满足指挥官 |
|---|---|---|---|---|---|---|---|
| **dsh-quorfloat** | **原生窗口**（Tauri） | TS Host 插件 + Rust Tauri sidecar + React | 置顶 ✅；跨 Space ❌（作者明确接受）；全屏 ❌ | **stdio NDJSON JSON-RPC 2.0**（无端口、无 token） | ✅ `global-hotkey` crate，默认 Option+Space | 无 AX / 无录屏；**不签名不公证** | 聊天/审批/追问最完整；缺悬浮球形态、跨 Space、播报 |
| **dsh-float** | **原生窗口**（Electron） | Host 插件 + Electron 43 helper + 原生 HTML/JS | 置顶 ✅（`screen-saver` 级）；`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`；但仅 Windows | **loopback HTTP + 随机 token + epoch**，端口经 stdout 上报 | ✅ Electron `globalShortcut`，Alt+Space→Ctrl+Alt+Space | Windows 无需授权；exe 未签名 | 聊天/切模型/截图够用；**无审批**、仅 Windows |
| **dsh-desktop** | 完整 **Tauri 桌面壳**（桌宠是 Tauri 子窗口） | Rust/Tauri + Node sidecar + 双面 Cordis 插件 | 桌宠窗口置顶 ✅、skipTaskbar；无跨 Space 处理 | sidecar：stdio NDJSON + loopback HTTP + runtime generation；壳↔前端：capability-scoped IPC | ✅ Rust `global-shortcut`，Alt+Space 显示主窗 | Windows WebView2；**签名自动更新**（minisign） | 不是“插件式悬浮窗”；采用它=替换整个 DSH 桌面端 |
| **dsh-petpal** | **原生窗口**（Swift / WPF） | Host 插件 + 预编译 Swift.app / C#.exe | 置顶 ✅；**macOS 跨所有 Space + 全屏辅助 ✅**；Windows 仅启动它的虚拟桌面 | **纯文件轮询**（ui.json / activity.json，0.35s），不开端口 | ❌ 无 | 无 AX / 无录屏；**ad-hoc 签名**，未公证 | 悬浮球/气泡/播报参考价值最高；无聊天、无审批 |
| **dsh-selection-tools** | **原生窗口**（Win32 分层窗口 + GDI+ 自绘） | Cordis Host 插件 + Node 伴生进程（koffi FFI） | `WS_EX_TOPMOST` + `WS_EX_TOOLWINDOW/NOACTIVATE` ✅；仅 Windows | loopback HTTP，端口由 stdout 正则解析；**无 token** | ❌ 无热键；全局鼠标轮询（40ms） | Windows UIA 无需授权；未签名 | 划词/浮层/流式回答参考；**无审批、无 macOS** |
| **dsh-project-cockpit** | **浏览器内 fixed overlay**（反例） | Host webServer 路由 + React `position:fixed; z-index:999999` | 仅 DSH 页面内 | loopback HTTP，`X-DSH-Request` 头 | ❌ | 无 | 只能做 DSH 窗口内浮层，不能覆盖其他应用 |

---

## 2. 逐项拆解

### 2.1 Azetus/dsh-quorfloat —— 最接近“生产级”的参考架构

**形态**：三类进程。`src/` 是 TypeScript Host 插件；`quorfloat/` 是 Rust/Tauri sidecar（编译成单文件可执行，前端资源编译期内嵌）；`quorfloat/frontend/` 是 React 面板。`【文档】ARCHITECTURE.md §2.1` `【代码】Cargo.toml / tauri_main 相关`

**窗口创建与置顶** `【代码】quorfloat/src/main.rs`
- Tauri `WebviewWindowBuilder`：`decorations(false)`、`transparent(true)`、`skip_taskbar(true)`、`always_on_top(settings.always_on_top)`。
- 启动时 `app.set_activation_policy(ActivationPolicy::Accessory)`：无 Dock 图标、不抢主应用身份；托盘进菜单栏。
- 收起时不仅 `window.hide()`，还 `app_handle.hide()`（macOS 上是 `[NSApp hide:nil]`），把焦点还给上一个应用——accessory 应用只 hide 窗口会把用户原应用 deactivate。
- 宽度固定 640，高度按内容增长（默认最大 560）；位置存 `~/.dsh-quorfloat/window.json`，显示前做显示器 work area 守卫（顶部拖动条至少 64×24 logical px 可见）。
- **明确不支持跨 Space**：`ARCHITECTURE.md §10.2` 写「macOS 呼出后切 Space，面板留在原 Space（普通 NSWindow 行为，已接受）」；且 §11.2 明确否决了 `tauri-nspanel`。这是它相对 petpal 的最大缺口。

**与 Host 通信** `【文档】§4` `【代码】src/bridge/*`
- **stdio 上的 NDJSON JSON-RPC 2.0**，一行一个 JSON；stdout 只走协议帧，日志走 stderr；单帧 1 MiB。
- 握手：sidecar 先发 `hello`（协议/产品版本、平台、架构、能力表、热键状态），Host 回 `ready`（窗口/主题/语言/心跳配置）。心跳是 `ping` **请求**而非通知（通知只能证明写成功）。
- 方法表覆盖 workspaces/sessions 列表、session create/attach/prompt/cancel/history、模型与权限预设、`interaction/answer`、`panel/lifecycle`、`diag/snapshot`。
- 生命周期：Host supervisor 负责启动、退避重启、故意停止路径、退出确认；每个 Host 实例最多一个 sidecar。
- **鉴权**：依赖 stdio 私有管道，没有 token；能力协商 + 协议版本 + 帧上限是安全边界。

**全局热键** `【代码】quorfloat/src/runtime/hotkey.rs`
- 用 `global-hotkey 0.8`，**不用 Tauri 插件**：因为要在窗口创建前就拿到注册结果，好让 `hello` 如实上报。
- 默认 `Alt+Space`（macOS 即 Option+Space）；严格解析、不猜错拼写；注册失败时**保留旧快捷键**并报告原因（`attempted` / `held` 两个字段分开）。
- 平台差异写在注释里：macOS 要求**主线程注册**；Windows 的 manager 是隐藏窗口 + `RegisterHotKey(hwnd,..)`，Win32 把窗口绑到创建线程，所以 **grab 必须活在主线程**（`unsafe impl Send for Grab` 只是为满足 Tauri managed state 的 `Send`）。
- 事件由独立线程 `recv` 阻塞等待 `GlobalHotKeyEvent`，只处理 `Pressed`，避免一次按键 toggle 两次。

**权限 / 分发**
- 不需要辅助功能、不需要屏幕录制（不做截屏、不读选区）。
- `ARCHITECTURE.md §9.1`：产物**不签名、不公证**；macOS 用 `lipo` 合 arm64+x86_64 universal；Windows 仅 x64；Linux 不支持。
- 能力：Markdown/代码块/表格、工作区与会话切换、pin、模型/推理档位/权限预设、审批与追问、诊断日志导出 `~/.dsh-quorfloat/logs/`。

**审批/追问归属（对本项目最关键）** `【文档】§6`
- 审批是 agent 作用域 waterfall，`dsh-api-remotes` 已注册一个“转发给已连接浏览器且不调 next()”的监听器；quorfloat 用 `{prepend:true}` 排到它前面才能拿到请求，**一旦领取就不再出现在 Harness 界面**（排他）。
- presence 判据：界面**可见且 `document.hasFocus()`**；浏览器侧 5 秒心跳、30 秒过期。
- 答案形状：`{answers:[{id, selected(label), custom?}]}`；迟到/重复/过期答复返回 `accepted:false`，不重复执行。

**对指挥官的可用性**：聊天面板、审批卡、追问、模型切换、诊断都有现成范式；但它是“一个大面板”，没有悬浮球；不跨 Space；没有任务播报（无系统通知/推送）。

---

### 2.2 18840024879/dsh-float —— Windows 上最快的 Electron 路线

**形态**：Host 插件 `lib/index.js` + 独立 Electron helper 进程（`runtime/electron-helper/`），UI 是原生 HTML/JS（含本地 KaTeX）。**仅 Windows 10/11 x64**。`【文档】README`

**窗口** `【代码】runtime/electron-helper/window.js`
- `BrowserWindow`：`transparent:true`、`frame:false`、`skipTaskbar:true`、`alwaysOnTop:true`、`acceptFirstMouse:true`、`useContentSize:true`、`resizable:false`（自己实现边缘拖拽 resize）。
- 置顶：`setAlwaysOnTop(true,'screen-saver')` + `moveTop()`。代码注释点出 Windows 坑：**透明无边框窗口以 hidden 创建时 topmost 不粘**，所以每次 `show()` 都重新断言，并在 `win.on('show')` 再断言一次。
- 跨桌面：`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。这是 Electron 的跨平台 API；在 Windows 上实际是 no-op（Windows 无公开的“固定到所有虚拟桌面”接口，见 petpal 文档同结论）。
- 位置/尺寸记忆到 `~/.dsh/dsh-float/window.json`，按 `screen.getDisplayNearestPoint` 的 workArea 夹取；最小 320×420。

**与 Host 通信** `【代码】bridge.js + lib/index.js`（**这是本项目最值得抄的鉴权模型**）
- 双通道、刻意不对称：
  - helper → host：stdout 每行一个 JSON 帧（Electron 在 Windows 读不了 piped stdin，所以 Host 从不写 stdin）。
  - host → helper：helper 起 **loopback HTTP**（`listen(0,'127.0.0.1')` 随机端口），Host POST `/bridge`。
- **发现**：helper 发 `{type:'ready', port, pid, token}`；Host 记下 port/token。
- **鉴权**：每次启动 `crypto.randomBytes(16)` 生成 token，请求头 `x-dsh-float-token` 不符直接 403；帧里 `epoch` 不符 409（防旧进程/旧帧）。
- 存活：Host 每 2s `process.kill(pid,0)`；helper 每 15s 收 ping；单实例锁；崩溃退避 750ms→30s，最多 12 次，稳定 3 分钟后重置计数。
- 渲染进程 `contextIsolation:true`、`nodeIntegration:false`、严格 CSP；宿主只接受白名单临时目录的 PNG/JPEG/WebP。

**热键** `【代码】main.js`
- `globalShortcut.register('Alt+Space')`，失败自动降级 `Ctrl+Alt+Space`，再失败提示改用托盘；注册结果写回配置。退出时 `unregisterAll()`。

**截图提问**：预热隐藏 overlay 窗口；优先屏幕流取帧，失败退 `desktopCapturer`，再失败 PowerShell 截屏；遮罩绘好才淡入。

**权限**：Windows 无系统级授权弹窗；Electron 运行时需下载约 110 MB（可用 `DSH_FLOAT_ELECTRON_PATH` 复用）；exe 未签名，SmartScreen 可能提示。

**对指挥官的可用性**：聊天、流式、切模型、历史、截图都够；**没有审批/追问**，没有跨平台，UI 与 DSH 两套；作为“Windows 快速验证”很合适，作为长期主线偏重。

---

### 2.3 FuqiangCraft/dsh-desktop —— 是“桌面壳”，不是“插件悬浮窗”

**形态**：Rust/Tauri 桌面应用 + 受监管的 Node sidecar + 双面 Cordis 插件（`packages/dsh-desktop-plugin`）。`【文档】README / docs/RUST_ARCHITECTURE.md`

**插件侧能做什么**
- 浏览器桌面通知：监听 sessions store，会话进入 approval/question/plan review 时发 Web Notification，点击跳会话。
- `screen_capture` 模型工具：Host 侧，默认关闭，仅主显示器，需 `screenCapture: true` 显式开启。
- 多代理平铺画布：client 侧 `conversation.view` 只读网格。
- 桌宠：client 侧浮层 + 状态机；`shell.overlay` HUD **在已发布 client runtime 里还没有该槽位**，组件就绪但挂不上。

**壳侧原生能力** `【代码】packages/dsh-desktop-rust/src/tauri_main.rs`
- 主窗：无边框 WebView2 + 自绘标题栏。
- 桌宠：`WebviewWindowBuilder("pet")`，`decorations(false)`、`transparent(true)`、`always_on_top`、`skip_taskbar(true)`、`shadow(false)`、`resizable(false)`、`set_ignore_cursor_events` 点击穿透、位置持久化。
- 全局快捷键：Rust `global-shortcut` 注册 `Alt+Space` → 显示主窗口（README 说“快捷面板 planned”，但代码已注册主窗快捷键）。
- 托盘、最近会话、单实例、崩溃恢复窗、**签名自动更新**（minisign 公钥编译进二进制，拒绝非 HTTPS）。

**通信**：Rust ↔ Node sidecar = stdio 换行 JSON（握手含 loopback origin、端口、协议版本、runtime generation）；Node ↔ 前端 = loopback HTTP + DSH transport；壳 ↔ 前端 = capability-scoped Tauri IPC。

**局限**：Windows 优先（NSIS/WebView2，未见 macOS 打包证据）；采用它意味着**替换 DSH 桌面端**，而不是给现有 DSH 加一个悬浮窗；桌宠窗口没有跨 Space / 全屏处理。

**对指挥官的价值**：证明“Tauri 壳 + Node sidecar + 签名更新”的完整工程路径；`shell.overlay` 的现状也证明 client 插件做不了系统级 HUD。

---

### 2.4 flowers-59f/dsh-petpal —— macOS 悬浮窗行为最正确的样本

**形态**：Host 插件（`index.js`，注册 `/petdex` 路由、投影会话事件）+ 每平台原生小应用（macOS Swift+WKWebView / Windows C# WPF），安装包自带编译产物。

**macOS 窗口** `【代码】desktop/main.swift`
- `NSWindow(styleMask:[.borderless])`，`isOpaque=false`、`backgroundColor=.clear`、`hasShadow=false`。
- `window.level = .floating`。
- **`window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`** —— 这一行就是“出现在所有桌面空间 + 浮在全屏应用之上”的关键；quorfloat 没有它，所以留在原 Space。
- `NSApp.setActivationPolicy(.accessory)` + `Info.plist` `LSUIElement=true`：无 Dock、不抢焦点；用 `orderFrontRegardless()` 而非 `makeKeyAndOrderFront`。
- `ignoresMouseEvents` 由 `visible/clickThrough` 控制；`alphaValue` 控制显隐。
- 页面通过 `WKScriptMessageHandler` 上报自然尺寸与气泡矩形，Swift 据此 resize；点击/拖动用本地事件监视器 + 60Hz timer 驱动（WebKit 忙时也能拖）。
- 浮层透明背景坑：WKWebView 必须 `setValue(false, forKey:"drawsBackground")` + `underPageBackgroundColor = .clear`。

**Windows 窗口**（README 补充）
- 始终置顶、不抢焦点、不进任务栏和 Alt+Tab；逐像素透明分层窗口，支持多显示器与高 DPI。
- **虚拟桌面**：Windows 没有让普通窗口固定到所有虚拟桌面的公开接口，宠物留在启动它的那个桌面。
- **独占全屏游戏/视频**：置顶窗口可能被盖住（Windows 窗口层级限制）。

**与 Host 通信**：**不开端口、不联网**。Host 写 `~/.dsh/pets/.petdex/ui.json`（外观/开关/webhook）与 `activity.json`（各会话最近活动），桌面端每 0.35s 轮询；桌面端把窗口位置写回 ui.json；`app.pid` 防重复启动；`PETDEX_PARENT_PID` + 每 2s `kill(pid,0)` 实现随 Harness 退出（2 秒内），不留孤儿。

**通知**：不走 macOS 通知中心，而是 Host 侧 HTTPS 调**企业微信群机器人 webhook**（approval/asked、turn/end）。这绕开了“未签名 .app 发系统通知不可靠”的问题。

**权限 / 签名** `【代码】desktop/build.sh` `Info.plist`
- 无辅助功能、无屏幕录制、无网络权限。
- `swiftc -O` 直接编译，`codesign --force --sign -`（**ad-hoc**），`LSMinimumSystemVersion 12.0`；**未公证**。Windows 侧未签名 exe，从压缩包运行会提示未知发布者。

**对指挥官的可用性**：悬浮球/多会话气泡/点击穿透/跨 Space/随主进程退出——全部可直接借鉴；但**没有聊天输入、没有审批交互**，状态是单向投影。

---

### 2.5 fyisgod/dsh-selection-tools —— Windows 原生浮层的极限做法

**形态**：Cordis Host 插件（`ctx.webServer` 路由 + `ctx.agents` 跑真实会话回合）+ Node 伴生进程（用 dsh 自带的 koffi FFI 调 user32/gdi32/gdiplus）。**仅 Windows**。

**为什么需要伴生进程** `【文档】README 架构段`
> “DSH 插件跑在 dsh 进程里，拿不到全局鼠标、也起不了置顶窗口。”

这句话是本次调研最直接的一条官方边界证据。

**窗口** `【代码】companion/native/window.mjs`
- 自建 `WS_POPUP` + `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`。
- GDI+ 画一帧到 32bpp DIB，`UpdateLayeredWindow` 带 alpha 贴屏；无边框、置顶、不抢焦点；逐像素透明圆角/阴影。
- 两个独立窗口：划词菜单 236×104，回答窗 400×480；8 方向缩放靠 `WM_NCHITTEST` + 纯函数命中区（边 6 DIP / 角 16 DIP，角要比边宽，因为透明像素不接收鼠标）。
- 启动第一件事 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，否则坐标落在缩放虚拟空间（实测 144dpi 被谎报 96dpi）。

**全局手势/取词**：40ms 轮询左键 + 位移判定；UI Automation `TextPattern` 读选区与所在段落；只有 UIA 读不到才注入一次 Ctrl+C 读剪贴板，并做属主/序号/用户是否正在按 Ctrl+C 的多重校验，读完还原。同步 COM 放 worker 线程 + 超时。

**与 Host 通信** `【代码】src/companion.ts + companion/main.mjs`
- 伴生进程 `server.listen(0,'127.0.0.1')` 随机端口，stdout 打印 `listening on http://127.0.0.1:<port>`，Host 用正则解析端口。
- Host 通过环境变量传 `DSH_SELECTION_DSH_ORIGIN`（取 `ctx.webServer.port`，兜底 3080）；伴生进程反向调 Host 的 `/api/dsh-selection-tools/*`（SSE 流式）。
- **安全**：源码里没有 token/Authorization 校验（grep 确认），仅靠 loopback + 随机端口；`/simulate`、`/click`、`/capture`、`/probe` 等调试端点同样无鉴权。这是可改进点，不建议照抄。
- 生命周期：spawn / 端口上报 / 退避重启（1s/2s/4s…上限 30s，最多 5 次）/ 停止宽限 800ms 后 `taskkill /T /F` / 重启要等老进程真的退出，避免两个进程各挂一个全局钩子。

**热键**：无。Esc 由浮层全局处理。剪贴板复制/朗读（SAPI）是面板按钮，不是热键。

**权限 / 分发**：UIA 在 Windows 无需授权；不装任何运行时、不起浏览器；未签名。

**对指挥官的可用性**：全局手势 + 原生浮层 + 会话复用 + 生命周期管理都值得抄；但 UI 是自绘 markdown-lite（无交互卡片能力），无审批，仅 Windows。

---

### 2.6 Boris-boomer/dsh-project-cockpit —— 反例：浏览器内浮层

- 纯 client 插件：`FloatingPanel.tsx` 用 `position:'fixed'`、`zIndex:999999`；`index.tsx` 注入 `position:fixed; z-index:999998` 的入口按钮。
- Host 侧 webServer 聚合路由 `/__dsh/project-cockpit/*`，要求 `X-DSH-Request: project-cockpit` 头。
- 结论：**页面内浮层**，切到别的应用就被 DSH 窗口遮住；不能作为系统级悬浮窗方案，但可作为“DSH 内 HUD”的补充。

---

## 3. 平台机制拆解（写原生壳时真正要处理的）

### 3.1 macOS

| 需求 | 做法 | 权限/代价 |
|---|---|---|
| 无边框透明窗 | `NSWindow(.borderless)` + `isOpaque=false` + clear background + `hasShadow=false`；WKWebView 需关 `drawsBackground` | 无 |
| 浮在其他应用之上 | `window.level = .floating`（更高可用 `.statusBar`/`.screenSaver`，慎用） | 无 |
| 跨所有桌面空间 | `collectionBehavior` 含 `.canJoinAllSpaces` | 无；不设就固定在原 Space（quorfloat 现状） |
| 浮在全屏应用上 | `collectionBehavior` 含 `.fullScreenAuxiliary` | 无；缺它时全屏 Space 里看不到 |
| 不抢焦点/无 Dock | `LSUIElement=true` 或 `setActivationPolicy(.accessory)`；`orderFrontRegardless()` | 无 |
| 点击穿透 | `ignoresMouseEvents = true`（可动态切换，实现“平时穿透、按住某键可点”） | 无 |
| 全局热键 | Carbon `RegisterEventHotKey`（`global-hotkey` crate / Electron `globalShortcut` 底层） | **不需要辅助功能**；必须在主线程注册 |
| 读其他应用选区 | Accessibility API（`AXUIElement` + `AXIsProcessTrustedWithOptions`） | **辅助功能授权**（TCC，用户手动开关） |
| 模拟按键/鼠标 | `CGEventPost` | 通常也需辅助功能/输入监控 |
| 截屏 | ScreenCaptureKit / `CGWindowListCreateImage` | **屏幕录制授权**（TCC） |
| 系统通知 | `UNUserNotificationCenter` | 需要 bundle id + 有效签名；ad-hoc/未签名不可靠 → petpal 改用 webhook |
| 分发 | Developer ID 签名 + 公证 + staple | 99 USD/年；否则用户首次打开被 Gatekeeper 拦（右键打开可绕过） |
| 自动更新 | Sparkle 或 Tauri updater（minisign） | 需签名与更新通道 |

补充：ad-hoc 签名（`codesign -s -`）足以让本机运行的 .app 正常启动，但**过不了公证**；从网络下载带 quarantine 属性时仍会被拦。quorfloat 直接不分发 .app（裸二进制 + 插件安装），petpal 分发 ad-hoc .app，二者都未公证。

### 3.2 Windows

| 需求 | 做法 | 注意 |
|---|---|---|
| 无边框透明窗 | `WS_POPUP` + `WS_EX_LAYERED` + 逐像素 alpha（`UpdateLayeredWindow`）；或 Electron `transparent:true` | 透明窗口以隐藏状态创建时 topmost 可能不生效，显示时重新断言（dsh-float 实测） |
| 置顶 | `WS_EX_TOPMOST` / `SetWindowPos(HWND_TOPMOST)`；Electron `setAlwaysOnTop(true,'screen-saver')` | `hWndInsertAfter` 必须声明成 `intptr_t`（`-1` 传给 `void*` 会被拒，selection-tools 踩过） |
| 不进任务栏/Alt+Tab | `WS_EX_TOOLWINDOW`；Electron `skipTaskbar:true` | — |
| 不抢焦点 | `WS_EX_NOACTIVATE`；Electron `acceptFirstMouse` + 不 focus | `ShowWindow(SW_SHOWNOACTIVATE)` |
| 跨虚拟桌面 | **没有公开 API**；普通窗口留在启动它的桌面 | petpal README 明确；UWP 的 `ApplicationView` 不适用于 Win32 |
| 浮在独占全屏游戏上 | 通常做不到 | petpal README 明确 |
| 全局热键 | `RegisterHotKey(hwnd, id, mod, vk)`；Electron `globalShortcut` | 注册/注销都必须在创建 hwnd 的线程 |
| 读其他应用选区 | UI Automation `TextPattern` | 无需授权；同步 COM 要放 worker + 超时 |
| 截屏 | `desktopCapturer` / GDI / PowerShell 兜底 | 无需授权弹窗 |
| 分发 | 代码签名证书（EV 更贵） | 未签名触发 SmartScreen“未知发布者” |

### 3.3 跨平台差异小结（选型时最痛的三点）

1. **“所有 Space”是 macOS 独有且免费**（`canJoinAllSpaces`）；Windows 没有对应能力，只能接受“留在当前虚拟桌面”。
2. **热键**：macOS 的 Carbon 全局热键不需要辅助功能；但一旦要读选区/模拟输入，就要 TCC 授权。Windows 的 RegisterHotKey 与 UIA 都不弹权限。
3. **通知**：macOS 系统通知与签名强绑定；Windows toast 相对宽松。跨端推送（企微/飞书 webhook）反而是最省事的播报通道（petpal 验证）。

---

## 4. 通用结论：DSH 官方插件体系能做到哪一步

### 4.1 三层能力边界

| 层 | 能做什么 | 不能做什么 |
|---|---|---|
| **Host 插件**（Node，跑在 dsh 进程） | 跑真实 agent 回合（`ctx.agents`）、订阅会话/审批/追问事件、用 `{prepend:true}` 抢审批、`ctx.webServer` 加路由、`ctx.effect` 管生命周期、`child_process` 拉起原生进程 | 没有 GUI 工具包：**不能创建窗口、不能置顶、不能注册全局热键、不能读全局鼠标/选区**（selection-tools README 原话） |
| **Client 插件**（浏览器 JS） | 页面内任意 UI：面板/标签页/设置卡/`shell.overlay` 整页浮层、Web Notification、读 sessions store | 不能离开 DSH 窗口；不能设置窗口置顶；不能全局热键；不能画在别的应用上；`shell.overlay` 在已发布 runtime 里甚至还没上线（dsh-desktop 实证） |
| **webServer** | loopback HTTP/SSE 路由，给原生壳当数据面：会话、模型、审批、事件流 | 不是窗口 API；鉴权要自己做（selection-tools 没做，dsh-float 做了 token） |

### 4.2 所以：必须借助原生壳

在 macOS 上要“覆盖所有应用的悬浮球”，**唯一可行路径 = 官方插件 + 一个原生 GUI 进程**。可选壳与代价：

| 壳 | 代表 | 体积/依赖 | 优点 | 代价 |
|---|---|---|---|---|
| **Swift/AppKit + WKWebView** | petpal | ~170 KB 二进制，零运行时 | 窗口行为最正宗（level/collectionBehavior/accessory/click-through 全可控）；启动快；权限最少 | 只能 macOS；UI 要用 Web 或 SwiftUI 重写；窗口拖拽/缩放/多屏要自己处理；需 Xcode CLT 构建；签名/公证自理 |
| **Tauri/Rust** | quorfloat、dsh-desktop | 单文件 ~10–20 MB，系统 WebView | 跨 macOS/Windows；热键/托盘/窗口 API 成熟；可复用 React；内存比 Electron 低 | Rust 工具链 + 两平台构建；macOS 细节仍要写 objc2/NSWindow；WebView 版本差异；签名/更新自理 |
| **Electron** | dsh-float | ~110 MB 运行时 + 100 MB 内存 | UI 迭代最快（就是 Web）；`setVisibleOnAllWorkspaces` 一行搞定 | 体积/内存大；需管理 Electron 下载与版本；原生能力仍受 BrowserWindow 限制；未签名分发难 |
| **Win32 FFI** | selection-tools | 零运行时 | 最小、最快、无浏览器 | 只能 Windows；UI 自绘（markdown-lite），交互卡片成本高 |

### 4.3 代价清单（做原生壳一定会付的）

1. **多一个进程**：启动/守护/退避重启/单实例/孤儿清理（父 PID 看门狗）/故意停止路径。
2. **一套 IPC**：协议版本、握手、心跳、帧上限、幂等键；发现机制（stdio 握手 / stdout 端口行 / 固定文件）；鉴权（stdio 管道天然私有；HTTP 必须 token+epoch，或至少 loopback+随机端口）。
3. **平台代码**：macOS 的 Space/全屏/激活策略、Windows 的 topmost/虚拟桌面/DPI；两套行为差异要写进产品文案。
4. **权限与签名**：辅助功能/屏幕录制（若做选区/截屏）、Developer ID + 公证、自动更新签名。
5. **双 UI 栈**：DSH 页面内一套、原生壳内一套；主题/文案/状态词要同口径。
6. **测试矩阵**：多显示器、缩放、Space 切换、全屏应用、休眠唤醒、热插拔。
7. **不能上 Mac App Store**（读其他应用/全局热键类应用通常被拒）。

---

## 5. 对「指挥官」的选型建议

### 5.1 能力缺口矩阵

| 能力 | quorfloat | dsh-float | dsh-desktop | petpal | selection-tools | 结论 |
|---|---|---|---|---|---|---|
| 悬浮球（常驻小窗） | ❌（大面板） | ❌（大面板） | ✅（桌宠） | ✅（宠物） | ❌ | 需自研；petpal 形态最贴近 |
| 聊天面板 | ✅ | ✅ | ✅（主窗） | ❌ | ✅（回答窗） | quorfloat 最完整 |
| 审批卡片 | ✅ | ❌ | ❌（仅通知跳转） | ❌ | ❌ | 只有 quorfloat 做了 |
| 任务播报 | ❌ | ❌ | ✅（通知） | ✅（企微） | ❌ | 通知用壳/推送，别用 client 插件 |
| 跨所有 Space | ❌ | ⚠️（API 有，Windows 无效） | ❌ | ✅（macOS） | ❌ | 必须显式设置 collectionBehavior |
| 全局热键 | ✅ | ✅ | ✅（主窗） | ❌ | ❌ | 用 global-hotkey / Electron |
| 划词/选区 | ❌ | ❌ | ❌ | ❌ | ✅（Win） | macOS 需 AX 授权，成本高，后置 |
| 截图 | ❌ | ✅（Win） | ✅（主屏） | ❌ | ❌ | macOS 需屏幕录制授权 |

### 5.2 推荐架构

```
┌─ DSH 进程 ────────────────────────────────┐
│ Host 插件（指挥官）                        │
│  · ctx.agents 跑回合 / 订阅事件            │
│  · prepend 抢审批、追问 → interaction/answer│
│  · ctx.webServer: /commander/*（可选兜底）  │
│  · 侧车 supervisor（启动/重启/退出）        │
└───────────────┬───────────────────────────┘
                │ stdio NDJSON JSON-RPC（首选）
                │ 或 loopback HTTP + token（壳独立安装时）
┌───────────────▼───────────────────────────┐
│ 原生壳（macOS: Swift 或 Tauri）            │
│  · 悬浮球 NSPanel(.nonactivatingPanel)     │
│  · 聊天面板（同一窗口变形 / 第二窗口）      │
│  · collectionBehavior                     │
│      [.canJoinAllSpaces, .stationary,      │
│       .fullScreenAuxiliary]                │
│  · level .floating / .statusBar           │
│  · 全局热键（Carbon）                      │
│  · 托盘/菜单栏、点击穿透                   │
│  · 审批卡渲染 + 回传                        │
└───────────────────────────────────────────┘
```

- **协议**：照抄 quorfloat 的 NDJSON JSON-RPC：`hello/ready` 握手、`ping` 心跳、能力表、1 MiB 帧上限、幂等键。比 HTTP 少一层端口/token/CORS 问题。
- **窗口**：悬浮球用 `NSPanel` + `.nonactivatingPanel` + `becomesKeyOnlyIfNeeded`，避免点击抢焦点；展开聊天时再允许成为 key window。如果是 Tauri，需要在 Rust 侧补 `collectionBehavior`（quorfloat 没做）。
- **审批**：Host 侧 `prepend:true` 抢 `approval/request`，presence 用“壳可见且聚焦”判定；壳未展开时不抢，避免和 DSH 主窗打架。答案严格用 label，处理 `accepted:false`。
- **播报**：第一版用壳内气泡 + 托盘角标（零权限）；第二版 macOS 用 `UNUserNotificationCenter`（需签名 bundle）；跨端用 webhook（企微/飞书），petpal 已验证。
- **分发**：先接受“未签名/ad-hoc + 用户右键打开”，等产品稳定再上 Developer ID + 公证；自动更新用 Tauri updater 或 Sparkle，签名密钥独立。

### 5.3 明确不建议

- ❌ 只做 client 插件 + `position:fixed`：切应用即消失（cockpit 反例）。
- ❌ 试图在 Host 插件里直接 `new BrowserWindow`/`NSWindow`：dsh 进程没有 GUI 运行时，且会污染宿主生命周期。
- ❌ Windows 上追求“所有虚拟桌面”：没有公开 API，投入产出比极低。
- ❌ 未鉴权的 loopback HTTP（selection-tools 现状）：本机任意进程都能调 `/simulate`、`/capture`。至少加 per-launch token + 校验 `Origin`/`Host`。

---

## 6. 风险与待验证项

1. **`shell.overlay` 的可用性**：dsh-desktop README 说该槽位在 master 有、已发布 runtime 没有；需在本机 DSH 版本确认，否则“DSH 内 HUD”也要降级为自建 fixed 浮层。
2. **审批排他性**：quorfloat 领取后 DSH 界面不再显示；若壳崩溃，审批不能自动批准，必须回落到 DSH 主窗（quorfloat 有 `interaction/hint` 机制）。指挥官需设计同样的回落。
3. **macOS TCC 授权**：若后续做“选中文本提问”，必须引导用户开辅助功能；若做截图，必须开屏幕录制。首次拒绝后再次弹窗受限，需要设置页深链。
4. **签名/公证成本**：Developer ID 99 USD/年 + 公证流程；ad-hoc 在 macOS 15 上对下载分发的限制更严（需实测目标系统版本）。
5. **Tauri vs Swift 的维护成本**：Tauri 跨平台但要维护 Rust + 前端两套；Swift 只 macOS 但窗口行为最可控。若指挥官明确 macOS 优先，Swift 的代码量其实不大（petpal 主文件约 20 KB）。
6. **quorfloat 的固定 640 宽**：不适合“悬浮球 → 展开面板”的形变；需改成两段式窗口或两个窗口。
7. **Windows 置顶丢失**：透明窗口以隐藏状态创建时 topmost 不粘，必须每次 show 重新断言（dsh-float 实测）。

---

## 7. 来源

### 仓库主页
- Azetus/dsh-quorfloat — https://github.com/Azetus/dsh-quorfloat
- 18840024879/dsh-float — https://github.com/18840024879/dsh-float
- FuqiangCraft/dsh-desktop — https://github.com/FuqiangCraft/dsh-desktop
- flowers-59f/dsh-petpal — https://github.com/flowers-59f/dsh-petpal
- fyisgod/dsh-selection-tools — https://github.com/fyisgod/dsh-selection-tools
- Boris-boomer/dsh-project-cockpit — https://github.com/Boris-boomer/dsh-project-cockpit

### README / 架构文档（raw）
- quorfloat README：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/README.md
- quorfloat ARCHITECTURE：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/ARCHITECTURE.md
- dsh-float README：https://raw.githubusercontent.com/18840024879/dsh-float/HEAD/README.md
- dsh-desktop README：https://raw.githubusercontent.com/FuqiangCraft/dsh-desktop/HEAD/README.md
- dsh-desktop Rust 架构：https://raw.githubusercontent.com/FuqiangCraft/dsh-desktop/HEAD/docs/RUST_ARCHITECTURE.md
- dsh-desktop 插件 README：https://raw.githubusercontent.com/FuqiangCraft/dsh-desktop/HEAD/packages/dsh-desktop-plugin/README.md
- petpal README：https://raw.githubusercontent.com/flowers-59f/dsh-petpal/HEAD/README.md
- selection-tools README：https://raw.githubusercontent.com/fyisgod/dsh-selection-tools/HEAD/README.md
- cockpit README：https://raw.githubusercontent.com/Boris-boomer/dsh-project-cockpit/HEAD/README.md

### 关键源码
- quorfloat 窗口/激活策略：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/quorfloat/src/main.rs
- quorfloat 全局热键：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/quorfloat/src/runtime/hotkey.rs
- quorfloat Tauri 配置：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/quorfloat/tauri.conf.json
- quorfloat Cargo 依赖：https://raw.githubusercontent.com/Azetus/dsh-quorfloat/HEAD/quorfloat/Cargo.toml
- dsh-float 窗口：https://raw.githubusercontent.com/18840024879/dsh-float/HEAD/runtime/electron-helper/window.js
- dsh-float 主进程/热键：https://raw.githubusercontent.com/18840024879/dsh-float/HEAD/runtime/electron-helper/main.js
- dsh-float 桥接鉴权：https://raw.githubusercontent.com/18840024879/dsh-float/HEAD/runtime/electron-helper/bridge.js
- dsh-float Host 侧：https://raw.githubusercontent.com/18840024879/dsh-float/HEAD/lib/index.js
- dsh-desktop Tauri 主程序：https://raw.githubusercontent.com/FuqiangCraft/dsh-desktop/HEAD/packages/dsh-desktop-rust/src/tauri_main.rs
- petpal macOS 窗口：https://raw.githubusercontent.com/flowers-59f/dsh-petpal/HEAD/desktop/main.swift
- petpal 打包/签名：https://raw.githubusercontent.com/flowers-59f/dsh-petpal/HEAD/desktop/build.sh
- petpal Info.plist：https://raw.githubusercontent.com/flowers-59f/dsh-petpal/HEAD/desktop/PetdexPet.app/Contents/Info.plist
- selection-tools 伴生进程管理：https://raw.githubusercontent.com/fyisgod/dsh-selection-tools/HEAD/src/companion.ts
- selection-tools 伴生进程主体：https://raw.githubusercontent.com/fyisgod/dsh-selection-tools/HEAD/companion/main.mjs
- cockpit 浮层：https://raw.githubusercontent.com/Boris-boomer/dsh-project-cockpit/HEAD/src/client/components/FloatingPanel.tsx

### 元数据（GitHub API，2026-11-16）
- quorfloat：3 stars，TypeScript，MIT，最后推送 2026-11-06
- dsh-float：0 stars，JavaScript，MIT，最后推送 2026-10-29
- dsh-desktop：5 stars，TypeScript，MIT，最后推送 2026-09-08
- petpal：1 star，JavaScript，MIT，最后推送 2026-10-25
- selection-tools：1 star，JavaScript，MIT，最后推送 2026-09-24
- cockpit：0 stars，JavaScript，MIT，最后推送 2026-11-10

> 注：star 数普遍很低，说明这批项目都还很早期；选型应以**代码结构是否可复用**为主，而非社区成熟度。
