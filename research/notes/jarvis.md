# dsh-harness-jarvis（贾维斯）技术调研笔记

> **调研对象**：`dsh-harness-jarvis` 0.7.1（commit `759d44a`），DSH Desktop 桌面悬浮窗助手。
> **代码根**：`/Users/lzx/Documents/GitHub/dsh-commander/research/jarvis`（下文所有相对路径均相对此目录）。
> **目的**：为「DSH 指挥官」插件评估技术可行性，重点看全局悬浮窗、会话托管、审批竞答、模型复用与扩展点。
> **方法**：静态精读 `README.md`、`cordis.patch.yml`、`package.json`、`src/`、`macos/`、`docs/`；**未**执行 `npm run build` / `swift build` / 真机验证。凡是推断而非代码直证，文中标注「推断」。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 悬浮窗技术 | **原生 Swift**：AppKit `NSPanel` + SwiftUI + Metal，**不是 Electron / Tauri**；DSH 宿主只负责拉起进程与提供 HTTP 通道 |
| 与宿主通信 | **本机 HTTP**：宿主在 `webServer` 上注册 `/jarvis` 前缀；面板从 `~/.dsh/jarvis/runtime.json` 读 `origin`/`token`/`rendererHeader`，用 Bearer + 能力头请求；**没有 WebSocket / Electron IPC** |
| 会话 | 插件用 `agentLoop.createAgent()` 自建**唯一** Jarvis agent（`sessionId='jarvis'`），工作区固定为 `jarvisCwd`（默认 `~/jarvis`）；其他 DSH 会话只被发现和「托管」，不由插件创建 |
| 审批 | `ctx.on('approval/request', handler, { prepend: true })` 抢在 DSH 主窗口之前拿到请求；`live.holdApproval()` 让面板与 `next()`（主窗口链路）**并发竞速**，先 settle 者生效；600ms 内被主窗口答掉的请求通常不会出现在面板 |
| 模型 | `Config.provider/model` 默认空 → 自动取 `llm.adapters` 第一个 provider 及其第一个 model；创建 agent 时写入 `agentOptions`，之后改 provider/model 需重启 DSH |
| UI | 140×140 粒子光球（Metal；300/600/900 粒子）、320pt HUD 输入条/审批卡、六种状态动效、青/琥珀/红/紫四色、贴边融成细带 |
| 扩展点 | Host 扩展点很多（`tools`/`systemPrompt`/`agentLoop`/`webServer`/`settings`/审批瀑布…）；**Client Slots 使用数量为 0**（没有客户端插件，全部 UI 在独立 Swift 进程） |
| 主要局限 | 仅 macOS 14+；单 Jarvis 实例；无看板；审批卡最多 3 张；历史 20 条；无语音输入；依赖 DSH 内部服务且大量 `any` 强转；`jobs` 声明为硬依赖但实际未使用 |

---

## 1. 全局悬浮窗的实现

### 1.1 技术选型：原生 Swift，不是 Electron

- 面板是独立可执行文件 `jarvis-panel`，SwiftPM 包声明 macOS 14+；`JarvisPanelCore` 放无 AppKit 的纯逻辑便于单测，`JarvisPanel` 放窗口/渲染/系统观察：
  - `macos/Package.swift:4-13`（`jarvis-panel` 可执行产物、`platforms: [.macOS(.v14)]`）
  - `macos/Package.swift:20-25`（executableTarget 为 `JarvisPanel`）
- 光球用 Metal 实例化四边形渲染，着色器源码在运行时编译（SwiftPM 无需 `.metal` 构建步骤）：
  - `macos/Sources/JarvisPanel/OrbMetalView.swift:8-66`（`particleVertex` / `particleFragment` / `underlayFragment`）
  - `macos/Sources/JarvisPanel/OrbMetalView.swift:94-105`（`MTLCreateSystemDefaultDevice()`、透明 clearColor）
- 宿主侧只做两件事：**spawn 进程** 和 **提供 HTTP 接口**，不参与渲染：
  - `src/index.ts:351-359`（注释：非 detached 子进程，生命周期跟 DSH 绑定）
  - `src/index.ts:390-417`（`spawn(join(pkgRoot,'macos','jarvis-panel'))`、`stdio:'ignore'`、`unref()`）
  - `src/index.ts:602-619`（`webServer` 注入后才 `panel.start()`）
- 因此：**没有 Electron 窗口、没有 Tauri、也没有把 UI 塞进 DSH renderer**。

### 1.2 两个 `NSPanel`：光球窗口 + 覆盖层窗口

- **OrbPanel**：固定 140×140 的无边框面板，装 Metal 光球和角标：
  - `macos/Sources/JarvisPanelCore/Placement.swift:79-80`（`orbWindow = 140`、`orbRadius = 60`）
  - `macos/Sources/JarvisPanel/OrbPanel.swift:19-47`（`styleMask: [.borderless, .nonactivatingPanel]`、`level = .statusBar`、透明、无阴影、`ignoresMouseEvents = true`）
  - `macos/Sources/JarvisPanel/OrbPanel.swift:49-54`（不能成为 key/main；`collectionBehavior` 见下）
- **OverlayPanel**：一个**动态尺寸**的透明面板，覆盖光球周围所有可能出现的内容（悬浮按钮、输入条、审批卡、历史、字幕、toast）：
  - `macos/Sources/JarvisPanel/OverlayPanel.swift:12-30`（同样是 `.borderless + .nonactivatingPanel + .statusBar`，初始 10×10，后续按内容 `setFrame`）
  - `macos/Sources/JarvisPanel/AppController.swift:190-232`（把 hover/quick bar/caption/auto-approval 的矩形 union 成 overlay 区域，`area.insetBy(dx:-16,dy:-16)`）
  - `macos/Sources/JarvisPanel/OverlayRootView.swift:12-40`（SwiftUI 根视图；`onPreferenceChange(HitRectsKey.self)` 收集可点击矩形）
- **跨所有 App / 所有 Space / 全屏之上**：
  - `level = .statusBar`（NSStatusWindowLevel，25）高于普通应用窗口；`collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, ...]` 让它出现在所有 Space，并能叠加在全屏应用上：
    - `macos/Sources/JarvisPanel/OverlayPanel.swift:32-37`
    - `macos/Sources/JarvisPanel/OrbPanel.swift:52-54`
  - Mission Control 隐藏通过 `.transient` 切换；不隐藏时用 `.stationary`：
    - `macos/Sources/JarvisPanel/OverlayPanel.swift:35-37`
    - `macos/Sources/JarvisPanel/AppController.swift:587-593`（`setMissionControlHidden(s.hideInMissionControl)`）
  - 面板是 `.accessory` 激活策略（不出现在 Dock），单实例由 pidfile 保证：
    - `macos/Sources/JarvisPanel/JarvisPanelApp.swift:13-18`（`setActivationPolicy(.accessory)`）
    - `macos/Sources/JarvisPanel/JarvisPanelApp.swift:27-37`（`~/.dsh/jarvis/panel.pid`，`kill(pid,0)` 探活）

> **注意**：`level = .statusBar` 能压住普通应用窗口，但并不等于「高于所有系统 UI」（例如屏保、部分系统浮层）。README 的「所有应用之上」在实际使用中成立，但精确语义应理解为 status-bar level + all-spaces + fullscreen-auxiliary。

### 1.3 点击穿透：按「命中矩形」动态开关，而不是窗口级永久穿透

这不是常见的 `NSWindow.ignoresMouseEvents = true` 一开了之，而是**每帧判定鼠标是否落在可交互区域**，再切换两个窗口的 `ignoresMouseEvents`：

1. 两个 panel 初始都 `ignoresMouseEvents = true`：
   - `macos/Sources/JarvisPanel/OrbPanel.swift:37`
   - `macos/Sources/JarvisPanel/OverlayPanel.swift:23`
2. 安装全局 + 本地鼠标移动/拖拽监听（`NSEvent.addGlobalMonitorForEvents` + `addLocalMonitorForEvents`），点击监听用于「点外部关闭输入条」：
   - `macos/Sources/JarvisPanel/AppController.swift:311-326`
3. `trackMouse()` 计算：
   - 是否在光球圆内或贴边细带内（`Placement.overOrb`，含 120pt 长、22pt 厚的 strip 命中区）
   - 是否在 overlay 的 `hitRects` 内（SwiftUI `GeometryReader` + `PreferenceKey` 收集，内缩 -3pt 容错）
   - 再设置 `orb.ignoresMouseEvents = !onOrb` / `overlay.ignoresMouseEvents = !onOverlay`
   - `macos/Sources/JarvisPanel/AppController.swift:328-345`
   - `macos/Sources/JarvisPanel/OverlayPanel.swift:101-103`（`hits`）
   - `macos/Sources/JarvisPanel/OverlayPanel.swift:106-119`（`HitRectsKey`、`hitArea()`）
4. 悬浮层弹起后，鼠标移动事件可能不再到达（窗口非 key），所以另开 30Hz 定时器轮询光标：
   - `macos/Sources/JarvisPanel/AppController.swift:349-358`
5. overlay 只在需要时 `orderFrontRegardless()`，空闲 3 秒后 `orderOut` 释放 backing store，避免大面积透明窗口常驻：
   - `macos/Sources/JarvisPanel/AppController.swift:568-583`
6. 因为是 accessory app、没有 Edit 菜单，overlay 自己接管 ⌘A/⌘C/⌘V/⌘Z 和 ⌘1…⌘9 目标选择：
   - `macos/Sources/JarvisPanel/OverlayPanel.swift:41-61`
   - `macos/Sources/JarvisPanel/AppController.swift:73`（`onCommandDigit` 绑定到 `model.selectTarget`）

> **效果**：透明区域点击穿透到下面的应用；只有按钮/输入框/卡片区域吃掉点击。代价是依赖鼠标位置轮询与 SwiftUI 布局回传，存在「窗口刚出现、hitRects 还没回传」的极短竞态（推断，代码未显式处理首帧）。

### 1.4 拖拽、贴边、融边

- **拖拽**在 `OrbContainerView` 里手写：`mouseDown` 记录起点，`mouseDragged` 超过 4pt 阈值才算拖动，`mouseUp` 区分点击/拖拽：
  - `macos/Sources/JarvisPanel/OrbPanel.swift:59-90`
  - `Placement.dragThreshold = 4`：`macos/Sources/JarvisPanelCore/Placement.swift:83`
- 拖动时按「屏幕工作区」夹取，工作区扣掉菜单栏，并把 Dock 的实际占用当作障碍物：
  - `macos/Sources/JarvisPanelCore/Placement.swift:35-74`（`Workspace.make`，根据 `visibleFrame` 推 Dock 边与长度）
  - `macos/Sources/JarvisPanelCore/Placement.swift:94-111`（`clampOrigin`，避免压住 Dock）
  - `macos/Sources/JarvisPanel/AppController.swift:159-187`（Dock 长度估算：读 `com.apple.dock` 的 `tilesize`/`persistent-apps`/运行中应用数）
- **贴边吸附**：松手时若距工作区边缘 ≤10pt，吸附到左/右/上/下或四角，并返回 `DockEdge`；刘海下方不吸顶：
  - `macos/Sources/JarvisPanelCore/Placement.swift:82-83`（`snapDistance = 10`）
  - `macos/Sources/JarvisPanelCore/Placement.swift:121-166`（`snap`，含 `notchX` 排除）
  - `macos/Sources/JarvisPanel/AppController.swift:434-462`（0.18s easeOut 动画移动窗口；`savePosition()`）
- **融边成细带**：贴边后不是隐藏窗口，而是让粒子模拟进入 `docked` 状态，在 140×140 窗口内画一条贴边细带；角落画成 L 形；说话时细带厚度随语音包络呼吸：
  - `macos/Sources/JarvisPanelCore/ParticleSim.swift:292-337`（`stepDocked` / `dockTarget`）
  - `macos/Sources/JarvisPanel/AppController.swift:395-407`（`openStrip` / `closeStrip`）
  - `macos/Sources/JarvisPanelCore/Placement.swift:169-194`（`stripRects`：边 22pt 厚、120pt 长；角 100pt 臂长）
- **悬停唤醒**：鼠标进入细带命中区 → `enterHover()` → `openStrip()` 让粒子涨回球；离开 0.4s 后收起：
  - `macos/Sources/JarvisPanel/AppController.swift:360-407`
- **位置记忆**：按显示器 `NSScreenNumber` 分别保存位置与吸附边；切换屏幕参数时恢复或重排：
  - `macos/Sources/JarvisPanel/AppController.swift:154-157`（屏幕 key）
  - `macos/Sources/JarvisPanel/AppController.swift:263-307`（`restorePosition` / `savePosition` / `screensChanged`）
  - `macos/Sources/JarvisPanelCore/PanelSettings.swift:61-62`（`positions: [String: SavedPosition]`）

### 1.5 全局快捷键

- 用 **Carbon `RegisterEventHotKey`**，不是 `CGEventTap`，因此不需要「辅助功能/键盘监听」权限：
  - `macos/Sources/JarvisPanel/HotKey.swift:5-58`（`InstallEventHandler` + `RegisterEventHotKey`，`kEventHotKeyExclusive`）
- 默认 `⌃⌥J`：`keyCode 38`（J）+ `control | option`：
  - `macos/Sources/JarvisPanelCore/HotKeySpec.swift:12-13`
- 注册失败（被占用）→ 报「快捷键被占用」，设置页可重录；重录只监听当前聚焦的录制按钮，不做全局键盘监听：
  - `macos/Sources/JarvisPanel/AppController.swift:88-92`
  - `macos/Sources/JarvisPanel/AppController.swift:619-627`
  - `macos/Sources/JarvisPanel/HotKeyRecorder.swift:4-5`（注释：only the focused control receives keys）
  - `macos/Sources/JarvisPanel/SettingsView.swift:63-73`
- 快捷键动作是「开/聚焦/关」三态：输入条已开且聚焦 → 关；已开未聚焦 → 聚焦；未开 → 开：
  - `macos/Sources/JarvisPanelCore/HotKeySpec.swift:56-62`
  - `macos/Sources/JarvisPanel/AppController.swift:466-482`

### 1.6 与 DSH Host 进程通信：runtime.json + 本机 HTTP + 能力头

**没有** WebSocket / Electron IPC / stdio RPC；全部是 HTTP。

1. 宿主在 `webServer` 注入后生成/读取 token，写运行时文件：
   - `src/index.ts:335-342`（token：`randomBytes(24).toString('hex')`，优先复用旧文件）
   - `src/index.ts:343-349`（`runtime.json` 目录 0700、文件 0600）
   - `src/index.ts:607-616`（`origin = http://<webServer.host>:<port>`；写入 `pid`、`writtenAt`；`desktopBrowserAccess.rendererHeader` 也写入）
2. 面板每次请求都重读 `runtime.json`，所以宿主重启换端口/token 后无需重启面板：
   - `macos/Sources/JarvisPanelCore/JarvisClient.swift:26-36`（默认 `~/.dsh/jarvis/runtime.json`，可用 `JARVIS_RUNTIME_FILE` 覆盖）
   - `macos/Sources/JarvisPanelCore/JarvisClient.swift:117-124`（`loadRuntime()`）
   - `macos/Sources/JarvisPanelCore/JarvisClient.swift:126-148`（`Authorization: Bearer <token>` + `rendererHeader`，5s 超时）
3. 宿主侧鉴权是「本机回环 + token」：
   - `src/index.ts:327-330`（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）
   - `src/index.ts:331-334`（Bearer 或 `?token=`）
   - `src/index.ts:619-623`（`/jarvis` 前缀统一 403 拦截）
4. **`rendererHeader` 是关键**：DSH Desktop 的 `webServer` 即使在本机回环也要求 renderer 能力头，否则拒绝路由：
   - `src/index.ts:610-614`（从 `desktopBrowserAccess.rendererHeader` 取）
   - `macos/Sources/JarvisPanelCore/JarvisClient.swift:3-5`（注释：Desktop shell rejects routes lacking the renderer capability header）
   - `src/index.ts:1314-1322`（调用 voice-mini 时也带这个头）
5. **接口清单**（全部挂在 `/jarvis` 前缀下）：

| 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|
| GET | `/jarvis/state` | 一次性返回会话、计数、pending、voice、autoApprovals | `src/index.ts:625-654` |
| GET | `/jarvis/wait?since=&timeout=` | 长轮询变更（版本号） | `src/index.ts:655-665`；`src/live-state.ts:127-134` |
| POST | `/jarvis/pending/answer` | 回填审批/问题答案 | `src/index.ts:666-673` |
| GET | `/jarvis/approval-rules` | 列出工作区审批预设 | `src/index.ts:674-677` |
| POST | `/jarvis/approval-rules/remove` | 删除预设 | `src/index.ts:678-683` |
| POST | `/jarvis/voice` | 静音/取消静音/暂停/继续/跳过/清空（转发 voice-mini） | `src/index.ts:684-696` |
| POST | `/jarvis/read` | 标记已读 | `src/index.ts:697-701` |
| POST | `/jarvis/open` | 唤起 DSH Desktop | `src/index.ts:702-708` |
| GET | `/jarvis/providers` | 列出 `llm.adapters` | `src/index.ts:709-711` |
| GET | `/jarvis/models?provider=` | 列出某 provider 模型 | `src/index.ts:712-719` |
| GET | `/jarvis/sessions` | 当前托管集 | `src/index.ts:720` |
| POST | `/jarvis/managed` | 托管/取消托管 | `src/index.ts:721-728` |
| POST | `/jarvis/narration` | 切换 self/relay 播报 | `src/index.ts:729-738` |
| GET | `/jarvis/agents` | 列出可注入的 agent/session | `src/index.ts:739-758` |
| GET | `/jarvis/messages?session=` | 读 Jarvis 或某 worker 的对话（最多 20 条） | `src/index.ts:759-773` |
| GET | `/jarvis/debug` | 诊断信息 | `src/index.ts:774-811` |
| GET | `/jarvis/config` | 返回 provider/model/edgeVoice | `src/index.ts:812` |
| POST | `/jarvis/input` | 用户输入，触发 Jarvis 一轮 | `src/index.ts:813-848` |

6. **长轮询**细节：
   - 宿主 `LiveState` 维护单调递增 `seq`，任何状态变化 `bump()` 唤醒等待者；`waitForChange` 在版本已变时立即返回，否则最多等 25s：
     - `src/live-state.ts:122-142`
     - `src/live-state.ts:102`（`MAX_WAIT_MS = 25_000`）
   - Swift 侧循环：`refresh()` → `waitForChange(timeout: hidden ? 5 : 1)`；失败则退化为普通 sleep：
     - `macos/Sources/JarvisPanel/AppController.swift:108-114`
     - `macos/Sources/JarvisPanelCore/PanelModel.swift:222-252`
7. **进程生命周期**：
   - 宿主 `webServer` 就绪才 spawn 面板；面板不存在二进制时只记日志、不崩溃：
     - `src/index.ts:392-393`
   - 面板是「非 detached」子进程，但 `unref()` 以免宿主阻塞；宿主卸载时 `SIGTERM`：
     - `src/index.ts:395-411`、`src/index.ts:425-435`
     - `src/index.ts:1141-1151`（`apply()` 返回 disposer，`panel.dispose()`）
   - 崩溃重启 1s/5s/30s；10 分钟内第 4 次崩溃则「停止自动重启」并语音播报：
     - `src/panel-supervisor.ts:5-6`、`src/panel-supervisor.ts:24-38`
     - `src/index.ts:371-388`
   - 单实例：面板自己用 pidfile 防重复；宿主侧重复 `webServer` 注入不会重复拉起（测试覆盖）：
     - `macos/Sources/JarvisPanel/JarvisPanelApp.swift:27-37`
     - `tests/panel-wiring.test.ts`（“同一 webServer 重复注入不替换现有进程”）

> **与 voice-mini 的关系**：Jarvis 还会探测/调用同宿主上的 voice-mini（`/voice-mini/state`、`/test`、`/pause` 等），这是可选的旁路集成，不属于面板通信主链：
> - `src/index.ts:1252-1276`、`src/index.ts:1295-1340`
> - `src/index.ts:1132-1134`（`ctx.inject(['voice:tts'])` 仅探测）

---

## 2. DSH 会话（agent session）的创建与管理

### 2.1 自建唯一 Jarvis agent：`agentLoop.createAgent()` / `resume()`

- 必需服务只有 `tools`、`userQuestions`、`jobs`；`agentLoop`、`llm`、`systemPrompt`、`webServer`、`settings` 都是**可用才接**：
  - `src/index.ts:136-139`
  - `README.md:77-79`
- 在 `ctx.inject(['agentLoop'])` 回调里创建：
  - `src/index.ts:901-969`
  - 关键参数：
    - `sessionId: entry.jarvisSessionId`（默认 `'jarvis'`）
    - `meta: { cwd: resolveDir(entry.jarvisCwd), agentPreset: 'jarvis' }`
    - `agentOptions: { provider: entry.provider, model: entry.model }`
    - `setup(agentCtx)`：注册 persona、memory、工具
  - 证据：`src/index.ts:932-939`
- 若 `createAgent` 报 `already exists`，改用 `resume()`（重启场景）：
  - `src/index.ts:947-967`
- 首次安装会发一条 `followup("你好"/"Hello")` 把 session 真正「跑起来」（注释说 createAgent 只创建对象，首次 LLM turn 才持久化 session）：
  - `src/index.ts:1178-1200`
- 重启场景不发 LLM，只随机播欢迎语：
  - `src/index.ts:1202-1215`、`src/index.ts:1154-1169`
- 标题固定为「贾维斯」：通过 `sessionTitle.rename()`，只在启动时尝试一次：
  - `src/index.ts:884-895`、`src/index.ts:1366-1373`

**Host 服务使用表**

| 服务 | 接线方式 | 实际用途 | 证据 |
|---|---|---|---|
| `tools` | 硬 `inject`；`agentCtx.tools.register` | 注册 11 个工具（审批规则/记忆/口播/提问/注入/托管） | `src/index.ts:139`、`src/index.ts:1425-1597` |
| `userQuestions` | 硬 `inject`；`ctx.get('userQuestions').ask` | Jarvis 的 `ask_user` 工具；问题会进入面板/主窗口竞答 | `src/index.ts:518-528`、`src/index.ts:1486-1510` |
| `jobs` | 硬 `inject` | **完全未使用**（无 `ctx.get('jobs')`） | `src/index.ts:139` |
| `agentLoop` | `ctx.inject`；`createAgent/resume` | 创建/恢复唯一 Jarvis agent | `src/index.ts:901-969` |
| `llm` | `ctx.inject`；`adapters/listModels/stream` | 自动选模型；judge/自动审批/代答/转述 | `src/index.ts:597-601`、`src/index.ts:911-924`、`src/llm.ts:41-69` |
| `systemPrompt` | `agentCtx.inject`；`section` + `system-prompt/assemble` | persona + memory 提示词 | `src/index.ts:1379-1406` |
| `webServer` | `ctx.inject`；`register({kind:'prefix', path:'/jarvis'})` | 面板 HTTP 入口；拿 host/port | `src/index.ts:602-854` |
| `settings` | `ctx.inject`；`installSection(ctx,'jarvis',...)` | DSH 设置页 | `src/index.ts:868-883` |
| `sessionTitle` | `ctx.inject`；`rename/get` | 固定「贾维斯」标题 | `src/index.ts:892-895`、`src/index.ts:1366-1373` |
| `desktopBrowserAccess` | `ctx.inject`；`rendererHeader` | 面板请求的能力头 | `src/index.ts:610-617` |
| `agents` / `sessions` / `sessionQuery` / `workspaceRegistry` | `(ctx as any).get` | worker 枚举/状态/标题/工作区/归档 | `src/index.ts:86-133`、`src/index.ts:565`、`src/index.ts:743` |
| `voice:tts` | `ctx.inject`（仅探测） | 检测外部 TTS，不实际调用 | `src/index.ts:1132-1134` |


### 2.2 Persona、记忆与工具：agent 作用域装饰

- `decorateJarvisAgent(agentCtx, ...)` 里用 **agentCtx**（不是全局 ctx）注入 `systemPrompt`：
  - `src/index.ts:1376-1411`
- 注册两个 section：
  - `jarvis:persona`，order 50，内容见 `COMMANDER_PERSONA`
  - `jarvis:memory`，order 60
  - 证据：`src/index.ts:237-250`、`src/index.ts:1379-1393`
- 记忆 section 需要异步刷新，因此监听 `system-prompt/assemble` 瀑布，在 `next()` 前替换 section 文本：
  - `src/index.ts:1395-1406`
- 注册 11 个工具（`agentCtx.tools.register(defineTool(...))`）：
  - `list_approval_rules` `src/index.ts:1432-1437`
  - `remove_approval_rule` `src/index.ts:1438-1445`
  - `remember` `src/index.ts:1447-1458`
  - `recall` `src/index.ts:1460-1470`
  - `say_to_user` `src/index.ts:1472-1484`
  - `ask_user` `src/index.ts:1486-1510`
  - `inject_to_session` `src/index.ts:1512-1537`
  - `list_managed` `src/index.ts:1539-1554`
  - `manage_session` `src/index.ts:1556-1567`
  - `set_session_narration` `src/index.ts:1569-1584`
  - `release_session` `src/index.ts:1586-1596`

### 2.3 工作区绑定：固定 `jarvisCwd`，不跟随用户当前工作区

- Jarvis 自己的会话工作区是配置项 `jarvisCwd`，默认 `~/jarvis`：
  - `src/index.ts:167-168`
  - `cordis.patch.yml:26-27`（注释：`jarvisSessionId: jarvis` / `jarvisCwd: ~/jarvis  # visible workspace (not hidden ~/.dsh/)`）
  - `src/index.ts:932-935`（写入 `meta.cwd`）
- 注意：`meta` 里还写死了 `agentPreset: 'jarvis'`，但仓库内**没有**这个 preset 的定义。推断：这依赖 DSH 宿主已存在名为 `jarvis` 的 agent preset，或宿主对未知 preset 有兜底；属于未文档化的隐式依赖，接入前需确认。
- Jarvis **不创建** worker 会话；worker 是用户/DSH 原本就有的会话。插件通过 `agents` 注册表枚举、通过 `managed.json` 决定「谁交给 Jarvis」：
  - `src/index.ts:86-98`（`listWorkerIds`：`agents.keys()/list()/迭代`，排除 Jarvis 自身与已归档）
  - `src/index.ts:495-500`（`setManaged`：只允许当前可见 worker）
  - `src/managed.ts:5-67`（`ManagedSet`，持久化为 id 数组或 `{managed, narration}`）
  - 会话工作区通过 `sessions.get(id).header.cwd` 读取，仅取 basename 用于显示/去重：
    - `src/index.ts:100-103`
    - `src/sessions.ts:42-46`（`workspaceName`）
- 审批预设的「工作区」是另一个概念：预设键是 `(fingerprint, tool, workspace)`，`workspace` 通常等于该会话的 `cwd`：
  - `src/approval-presets.ts:8-16`
  - `src/index.ts:1026-1029`（`operation.cwd = sessions.get(sid).header.cwd`，`presetOperation.workspace = operation.cwd`）
- 结论：Jarvis 与 worker 的关系是**消息路由 + 托管标记**，不是把 worker 迁移到 `~/jarvis`，也没有「切换 worker 工作区」的能力。

### 2.4 worker 发现、标题、状态

- 标题批量读取：`sessionQuery.readTitleSnapshots(ids)`，10 秒缓存：
  - `src/index.ts:107-133`（兼容 array/object 两种返回形状）
  - `src/index.ts:471-486`（`sessionRows()`，把 title/status/unread/managed/narration/workspace/task 组装成 `SessionRow`）
- 运行状态优先用 `agents.get(id).status`，事件流作为兜底：
  - `src/index.ts:1357-1363`（`agentRunning`）
  - `src/live-state.ts:172-192`（`turn/start` / `turn/end` 维护 busy/unread/failed）
- 面板拿到的是精简行（只有未完成任务才带 `task`，且只暴露 status + 摘要）：
  - `src/session-state.ts:9-35`
- 归档会话从列表排除：`workspaceRegistry.archivedSessionIds`：
  - `src/index.ts:95-97`

### 2.5 消息投递：`steer` > `followup` > `inject`

- `deliver()` 根据 agent 是否 running 选择投递方式：running 优先 `steer`（插入当前轮），否则 `followup`（新起一轮），最后才 `inject`（只排队不唤醒）：
  - `src/sessions.ts:18-39`
- `/jarvis/input`：
  - 不带 session：直接把用户文本作为 `UserMessage` 投给 Jarvis（`followup` 优先，其次 `inject`）
  - 带 session：用 `routedInput()` 包装成「用户要求把以下内容发给会话 X。请优化说法后用 inject_to_session 发送：…」，让 Jarvis 自己决定改写后再注入
  - 证据：`src/index.ts:813-848`、`src/conversation.ts:11-14`
- Jarvis 的 `inject_to_session` 只能发给托管集里的会话，不能发给自己：
  - `src/index.ts:1512-1537`
- 面板历史把 `routedInput` 拆回原文，并显示「→ 目标会话」：
  - `src/conversation.ts:19-52`、`macos/Sources/JarvisPanel/HistoryView.swift:51-55`

### 2.6 完成判断与续做（多任务感的来源）

- 每个托管会话有一份 `TaskLedger` 记录（`open/judging/done/unsatisfied/dropped`），24h TTL、最多 200 条：
  - `src/tasks.ts:5-24`、`src/tasks.ts:44-76`、`src/tasks.ts:132-158`
- `turn/end` 时 `CompletionJudge` 用 LLM 判断「是否满足原始请求」：
  - `src/index.ts:972-1000`（事件入口）
  - `src/completion.ts:54-151`（judge → `satisfied/unclear/unsatisfied`）
  - `src/judge.ts:45-50`（评审 system prompt）
- 若未满足且未超过 `maxContinueRounds`（默认 2），向 Jarvis 发一条 plugin notice，要求它用 `ask_user` 问「继续 / 不用了」，用户选继续才 `inject_to_session`：
  - `src/completion.ts:121-136`
  - `src/index.ts:245-246`（persona 里的续做规则）
  - `src/index.ts:161-162`（`maxContinueRounds` 默认 2）
- 两个播报模式：
  - `self`：worker 自己做完了用 voice-mini 的 `speak` 汇报，Jarvis 不花 token
  - `relay`：Jarvis 在 turn end 总结后用自己声音转述
  - 证据：`src/narration.ts:1-31`、`src/turn-end.ts:1-12`、`src/completion.ts:106-115`
- 完成播报有 1.5 秒聚合，避免多个会话同时结束连播：
  - `src/output.ts:40-65`

---

## 3. 权限审批的拦截与回传

### 3.1 拦截点：`approval/request` 瀑布，`prepend: true`

- DSH 的审批是 waterfall：handler 收到 `(req, next)`，`next()` 继续走后续答者（包括 DSH 主窗口）。Jarvis 用 `{ prepend: true }` 插到最前面：
  - `src/index.ts:1002-1004`
  - `src/index.ts:1101`（`{ prepend: true } as any`）
- 在把请求交给面板之前，先把**审批快照**冻结下来，避免 DSH 恢复后 session 变化：
  - session id：`req.agent.id`
  - 消息：`req.agent.session.deriveMessages()`
  - 工具调用参数：`approvalOperation(messages, req.callId)`，从 toolCall block 里找 `command` / `path` / 原始 args
  - 工具名：`req.toolName`
  - cwd：`sessions.get(sid).header.cwd`
  - 任务上下文：`ledger.peekCurrent(sid)?.request`，否则最后一条 user 消息文本
  - 证据：`src/index.ts:1005-1037`
  - `approvalOperation` 实现：`src/approvals.ts:44-59`
- `current()` 会在真正采用自动审批结果前重新校验：工具/命令/参数/cwd/任务 id/上下文/最后一条 user 消息都没变，且 signal 未 abort：
  - `src/index.ts:1038-1051`

### 3.2 竞答核心：`LiveState.holdApproval()` 双答者赛跑

- 宿主把请求交给 `live.holdApproval(req, next, command, preset, note)`：
  - `src/index.ts:1052-1064`
  - `src/live-state.ts:265-313`
- `holdApproval` 做的事：
  1. 生成 `id`，把 `req.signal` 换成 `AbortSignal.any([original, downstream])`，这样面板赢时可以 abort 下游答者（主窗口），但**不会** abort 拥有该请求的 agent 原始 signal；
     - `src/live-state.ts:267-270`
     - `src/live-state.ts:396-409`（`swapSignal`，可恢复）
  2. 把 `HeldApproval` 放进 `held` map，面板通过 `/state` 的 `pending` 看到它；
  3. **同时**执行 `next()`（DSH 主窗口链路）；
  4. 谁先 settle 谁赢：`settle()` 只执行一次，`release(id)` 后另一个答者的结果被忽略；
  5. `finally` 里 `downstream.abort(new Error('Approval settled through another answerer'))` 并恢复 signal，主窗口的待答提示随之消失；
  6. 返回 DSH 约定的 outcome：`allowed-once` / `rejected` / `cancelled` / `unavailable`。
  - 证据：`src/live-state.ts:273-313`
- **600ms 宽限**：请求被 hold 后 600ms 内不展示到面板（`visibleHeld` 过滤 `at <= now-600`）；如果主窗口在这 600ms 内已经答掉，面板根本不会闪一下：
  - `src/live-state.ts:94-95`（`PENDING_GRACE_MS = 600`）
  - `src/live-state.ts:376-393`（`hold` 的 600ms timer + `visibleHeld`）
  - `tests/approvals-wiring.test.ts`（“面板拒绝经过真实 holdApproval 并记录一次”，用 `now += PENDING_GRACE_MS` 让卡片可见）
- 回传路径：面板 `POST /jarvis/pending/answer` → `live.answer(body)`：
  - `src/index.ts:666-673`
  - `src/live-state.ts:337-353`（审批：`decision: allow|deny|always`）
  - 面板侧：`macos/Sources/JarvisPanelCore/PanelModel.swift:407-434`
  - 按钮：`macos/Sources/JarvisPanel/PendingCardView.swift:57-75`
- 审批的 `always`：
  - 只有 `canAlwaysAllow()` 为真才显示「总是允许（此工作区）」；
  - `canAlwaysAllow` = 有 presetOperation + operation + `classify(operation) !== 'high'` + `canPresetApproval(presetOperation)`；
  - 面板点 always → `held.always = true` → resolve 为 `allowed-once` → `holdApproval` 的 `then` 里调用 `preset.onAlways()`；
  - `onAlways` 用 `setImmediate` 异步写 `approvals.json`，先返回审批结果再做磁盘 I/O；
  - 证据：`src/index.ts:1052-1064`、`src/live-state.ts:286-305`、`src/approval-presets.ts:49-61`

### 3.3 自动审批（可选）：`off` / `safe` / `safe+grey`

- 配置默认 `off`；`safe` 只对只读白名单自动放行；`safe+grey` 额外启用工作区预设、历史与灰区 LLM 判断：
  - `src/index.ts:156`（`autoApprove`）
  - `src/index.ts:1065-1074`（先跑 `autoApproval.decide()`；只有 `valid` 且状态未变才 `allowed-once`，否则转面板）
  - `src/auto-approval.ts:30-82`
- 分级规则（`classify`，纯函数）：
  - `safe`：`read/glob/grep/search/list/.../web_search` 等只读工具
  - `medium`：写工作区内路径、`git commit/push`（受限参数）、安装依赖到工作区等
  - `grey`：未知简单命令、项目脚本（`npm test` 等）
  - `high`：`sudo`、`rm -r`、`git reset --hard`、`git clean`、解释器/`sh`/`eval`、重定向到工作区外、`.ssh/.dsh` 等
  - 证据：`src/approval-tier.ts:18-44`、`src/approval-tier.ts:122-165`、`src/approval-tier.ts:166-237`、`src/approval-tier.ts:241-273`
- 自动审批策略：
  - `safe`：直接 allow，reason「只读白名单」
  - `safe+grey` 且 `medium`：命中工作区预设 → allow；否则同一操作历史 ≥2 次用户批准且 0 次拒绝 → allow
  - `grey`：历史有拒绝 → 不自动放行（仍交给人）；否则 LLM 判断，置信度 ≥0.9 才 allow
  - `high`：永远 fallback 给人
  - 证据：`src/auto-approval.ts:41-74`
- 自动批准后的审计：
  - `AutoApprovalState` 只保留最近 5 条，高危不得进入
  - 面板「最近自动审批」卡片可撤销预设；撤销只影响后续，不回滚已执行操作
  - 证据：`src/auto-approval-state.ts:8-17`、`src/index.ts:1088-1096`、`macos/Sources/JarvisPanel/AutoApprovalsView.swift:7-59`
- **风险点**：`classify` 对 `SAFE_TOOLS` 直接返回 `safe`，**不做路径边界检查**；因此若 DSH 对工作区外读取发起审批，`autoApprove='safe'` 会直接放行（例如 `read ~/.ssh/id_rsa`）。`writeInside` 的路径保护只覆盖写工具与预设创建。接入时应把只读工具也纳入边界校验（推断 + 代码直证：`src/approval-tier.ts:18`、`src/approval-tier.ts:263-271`、`src/approval-tier.ts:73-80`）。

### 3.4 审批记录与回传后的副作用

- 结果确定后，不在 waterfall 调用栈里做磁盘 I/O，而是 `setImmediate` 异步写 HTML 审批记录：
  - `src/index.ts:1075-1100`
  - 记录内容：`fingerprint/ts/session{id,cwd,managed}/operation{tool,command,args}/context/decision{allow,source,reason}/tier`
  - `src/approvals.ts:1-35`
  - hard-link 发布，绝不覆盖已有记录：`src/approval-store.ts:18-41`
- 记录位置默认 `~/.dsh/jarvis/memory/approvals`：
  - `src/index.ts:147`（`approvalsDir` 默认）
  - `README.md:111`（本地存储说明）
- 面板只展示「最近自动审批」与审批预设，不提供完整审批记录浏览 UI（HTML 文件是主要审计载体）。

### 3.5 问题（user questions）也走同一套竞答

- `ctx.on('user-questions/request', handler, { prepend: true })`：
  - `src/index.ts:1126-1128`
- 先尝试 `AskInterceptor` 自动代答（需显式开启 `askInterception`，只对托管会话、低风险选择题、置信度 ≥0.85、全有或全无）：
  - `src/index.ts:1102-1125`
  - `src/ask-intercept.ts:52-55`（system prompt：高风险一律 null）
  - `src/ask-intercept.ts:64-123`
- 不代答时走 `live.holdAsk(req, next)`，面板与主窗口 `Promise.race`：
  - `src/live-state.ts:315-334`
  - 多问题用 `heldId#questionId` 逐题回填，全部答完才 resolve：
    - `src/live-state.ts:336-374`
  - 面板问题卡：选项 + 「我来回答」（自定义文本）：
    - `macos/Sources/JarvisPanel/PendingCardView.swift:67-75`
- Jarvis 自己的 `ask_user` 工具走 `userQuestions.ask()`；`user-questions/request` 瀑布是全局的，所以它也会进入面板/主窗口的竞答，但 `AskInterceptor` 不会替它代答（`managed` 判断排除 Jarvis 会话）：
  - `src/index.ts:516-536`、`src/index.ts:1103-1104`、`src/index.ts:1486-1510`（工具描述明确「悬浮窗和 DSH 窗口都会弹出」）

### 3.6 竞答语义小结

| 场景 | 行为 |
|---|---|
| 面板先点 | `held.resolve` → `settle` → 返回 outcome；`downstream.abort` 让主窗口提示消失 |
| 主窗口先点 | `next()` resolve → `settle` → 释放 held；面板卡片消失/不出现 |
| 600ms 内主窗口已答 | 面板基本看不到（`visibleHeld` 宽限） |
| 面板点「总是允许」 | 先按 `allowed-once` 返回，再异步写工作区预设 |
| 自动审批命中 | 不展示卡片，直接返回 `allowed-once`，异步写审计 |
| 审批 signal 被 abort | 面板 outcome `cancelled` |

---

## 4. 模型复用与配置 schema

### 4.1 `Config`：composition-owned 的完整 schema

- `Config` 用 `@deepseek-ai/schemastery` 定义，包含路径、身份、TTS、审批、判断模型等 25 项：
  - `src/index.ts:141-172`
- 面向 DSH 设置页的 `SettingsSchema` 只是子集，刻意不暴露 composition-owned 的路径与身份：
  - `src/index.ts:174-190`
  - 暴露项：`provider`、`model`、`edgeVoice`、`greetings`、`askInterception`、`autoApprove`、`managedNarration`、`judgeEnabled`、`judgeProvider`、`judgeModel`、`judgeTimeoutMs`、`maxContinueRounds`
- 默认 provider/model 是**空字符串**，注释明确「空 = auto，绝不写死厂商默认」：
  - `src/index.ts:162-166`
  - `cordis.patch.yml:24-25`（示例 `bailian` / `qwen3.8-max-0902`，注释要求替换成自己 profile 里配置的模型）
- README 的配置表由 `src/index.ts` schema 生成：
  - `README.md:87-101`
  - 生成脚本：`scripts/readme-config.mjs`、`package.json:44`

### 4.2 空值自动解析：第一个 provider + 第一个 model

- 在 `agentLoop` 注入回调里解析：
  - 若 `provider` 为空：取 `llm.adapters`（Map）第一个 key
  - 若 `model` 为空：取 `llm.listModels(provider)` 第一个 id/name
  - 结果写回 `entry.provider/model`，供 judge fallback、`/config`、settings pinning 使用
  - 证据：`src/index.ts:911-924`
- 创建 agent 时把结果放进 `agentOptions`：
  - `src/index.ts:932-935`
- `agentModelSelected = true` 后，settings 的 provider/model 改动不会热更新到活着的 agent：
  - `src/index.ts:858-866`（`refreshSettings` 里把 provider/model 还原为创建时的值）
  - `src/index.ts:930`
  - `README.md:89`（provider/model 改动需重启 DSH）、`README.md:107`（同）
- 判断/自动审批/代答模型都有 fallback：
  - `judgeProvider/judgeModel` 为空时使用 `provider/model`
  - 证据：`src/auto-approval.ts:67-69`、`src/ask-intercept.ts:99-102`、`src/completion.ts:100-104`
- `oneShot()` 统一走 `llm.stream({ provider, model, system, messages, maxTokens, purpose, signal, reasoningEffort:'low' })`；若 provider 不支持 reasoning effort，会重试一次去掉该参数：
  - `src/llm.ts:41-69`

### 4.3 DSH 设置页接入

- `settings.installSection(ctx, 'jarvis', SettingsSchema, settingsBase, { setSource, onChange })`：
  - `src/index.ts:868-883`
- `mergeSettings` 以 composition base 为底，逐字段校验类型/范围，非法值回退默认：
  - `src/settings.ts:22-44`
- `/jarvis/providers` 与 `/jarvis/models` 暴露了 `llm.adapters` / `llm.listModels` 供设置 UI 查询：
  - `src/index.ts:709-719`
- 但 **Swift 面板并没有调用这两个接口**：`JarvisAPI` 协议里没有 provider/model 方法，`SettingsView` 也没有 provider/model 选择器。推断：这两个端点是给未来设置页或外部客户端预留的，目前是「有接口、无消费者」的死代码。

---

## 5. 悬浮窗 UI：视觉、交互、尺寸与局限

### 5.1 形态与尺寸

| 元素 | 尺寸/参数 | 证据 |
|---|---|---|
| 光球窗口 | 140×140 pt，光球设计直径 120pt，按 92% 绘制（视觉直径约 110pt） | `macos/Sources/JarvisPanelCore/Placement.swift:79-80`；`macos/Sources/JarvisPanelCore/ParticleSim.swift:59-62`（`unitPoints=55.2`、`windowHalf=70/55.2`） |
| 粒子数量 | 极简 300 / 精简 600 / 默认 900 | `macos/Sources/JarvisPanelCore/PanelSettings.swift:3-21` |
| 悬浮按钮 | 半径 88pt 的弧上，按钮 30pt，间隔 30° | `macos/Sources/JarvisPanelCore/Placement.swift:84-86` |
| 状态读数 | 列表宽 110pt、行高 20pt；或胶囊高 24pt | `macos/Sources/JarvisPanel/HoverLayerView.swift:12-45` |
| 输入条 | 宽 320pt、基础高 40pt；输入框 1–3 行（行高 17pt） | `macos/Sources/JarvisPanel/QuickBarView.swift:6-7`；`macos/Sources/JarvisPanel/InputField.swift:8-9` |
| 审批卡 | 宽 320pt，自动换行 pill；最多同时显示 3 张，多余显示「还有 N 件」 | `macos/Sources/JarvisPanel/PendingCardView.swift:48-55`；`macos/Sources/JarvisPanelCore/PanelModel.swift:68`；`macos/Sources/JarvisPanel/OverlayRootView.swift:76-86` |
| 历史 | 最大高 360pt，最多 20 条，单条预览 280 字符/8 行 | `macos/Sources/JarvisPanel/HistoryView.swift:7-8`；`macos/Sources/JarvisPanelCore/Snapshot.swift:278-293` |
| 自动审批卡 | 宽最多 320pt，高 88 + 5×60 pt | `macos/Sources/JarvisPanelCore/Placement.swift:239-255` |
| 设置窗 | 460×720 pt，Form 分组 | `macos/Sources/JarvisPanel/SettingsView.swift:100-102` |
| 字幕 | 320×56 pt 的被动区域，播报结束后保留 1.5s | `macos/Sources/JarvisPanel/AppController.swift:200-205`；`macos/Sources/JarvisPanelCore/Caption.swift:17-41` |

### 5.2 状态动效：六种 motion

`OrbMotion` 定义六种：`idle / awaiting / thinking / speaking / attention / error`（README 说「五种状态」，代码实际是六种，error 单列）：

- 定义：`macos/Sources/JarvisPanelCore/OrbAppearance.swift:3-6`
- 参数：`macos/Sources/JarvisPanelCore/ParticleSim.swift:27-58`

| 状态 | 粒子行为 | 颜色 | 触发 |
|---|---|---|---|
| `idle` | 回到核心，低亮度缓慢漂移，偶尔换位 | 青 | 无活动 |
| `awaiting` | 扩散到内环，各自绕圈 | 青 | 输入条打开 / 等托管会话 |
| `thinking` | 内环快速重定向，速度发光 | 青 | Jarvis 正在跑 |
| `speaking` | 内环随语音包络呼吸（`voiceEnv`） | 青/紫 | voice-mini 播报 |
| `attention` | 外环，1.6s 双拍心跳（`pulse`） | 琥珀 | 有 pending |
| `error` | 内环 + 噪声 + 闪烁 | 红 | 宿主离线/失败 |

- 状态解析优先级（颜色）：宿主错误 > pending > failed > 默认青；若正在播报且来源是其他会话，青色变紫色：
  - `macos/Sources/JarvisPanelCore/OrbAppearance.swift:52-74`
- 动效优先级：speaking > thinking > error > attention > awaiting/standby > idle：
  - `macos/Sources/JarvisPanelCore/OrbAppearance.swift:67-73`
- 角标优先级：pending > failed > running > unread dot；角标数字最多 99+：
  - `macos/Sources/JarvisPanelCore/OrbAppearance.swift:75-84`
  - `macos/Sources/JarvisPanel/OrbPanel.swift:136-159`

### 5.3 配色与 HUD

- 四色（sRGB）：
  - 青 `(92,225,255)`：默认/运行中
  - 琥珀 `(255,194,77)`：需要你处理（审批/问题）
  - 红 `(255,95,95)`：错误/失败
  - 紫 `(178,140,255)`：其他会话的播报，避免误认成 Jarvis 自己
  - 证据：`macos/Sources/JarvisPanelCore/OrbAppearance.swift:9-21`
- HUD 表面：深海军蓝 `rgb(10,16,30)`、86% 不透明、青色 22% 描边、圆角 12：
  - `macos/Sources/JarvisPanel/Theme.swift:7-16`
  - `macos/Sources/JarvisPanel/Theme.swift:38-51`（`HUDSurface`）
- 文字：白 92%（主）/55%（次）/35%（弱）；字体用系统字体 9–13pt，命令用 monospaced：
  - `macos/Sources/JarvisPanel/Theme.swift:11-13`
  - `macos/Sources/JarvisPanel/PendingCardView.swift:29-36`（命令块 monospaced 11）
- 输入框光标也是青色：`macos/Sources/JarvisPanel/InputField.swift:33`

### 5.4 卡片结构

- **审批卡**：
  - 顶部：琥珀圆点 + `会话名 · 请求执行/问题` + 右上「回到 DSH 查看」箭头
  - 中部：审批命令用 monospaced 深色块（最多 3 行）；问题显示标题 + 详情 + note
  - 底部 pills：批准（琥珀填充）/ 拒绝 / 总是允许（此工作区）；问题则显示选项 + 「我来回答」
  - 证据：`macos/Sources/JarvisPanel/PendingCardView.swift:10-96`
- **输入条**：
  - `[目标 chip ▾] [多行输入] [历史图标] [发送圆钮]`
  - 目标 chip 带状态点 + 名称；历史图标翻转；发送钮空文本时变暗
  - Tab 切目标、⌘1–⌘9 直选；Enter 发送，Shift+Enter 换行（最多 3 行）；Esc 第一次提示、第二次关闭
  - 证据：`macos/Sources/JarvisPanel/QuickBarView.swift:17-107`、`macos/Sources/JarvisPanelCore/PanelModel.swift:287-303`、`macos/Sources/JarvisPanel/InputField.swift:91-112`
- **目标列表**：
  - 上半是 Jarvis + 已托管会话；下半「交给贾维斯…」展开候选；行内 hover 出现「播报切换」「移出托管」
  - 证据：`macos/Sources/JarvisPanel/QuickBarView.swift:133-287`
- **历史**：
  - 无边框气泡，自己右侧青色 18%，对方左侧 HUD 表面；顶部/底部渐隐；显示「→ 目标会话」
  - 证据：`macos/Sources/JarvisPanel/HistoryView.swift:6-63`
- **自动审批卡**：
  - 标题「最近自动审批」+ 条数；每条：会话/工具 + 分级标签 + 命令 + 「撤销此规则」；底部说明「撤销仅影响后续审批」
  - 证据：`macos/Sources/JarvisPanel/AutoApprovalsView.swift:7-59`

### 5.5 播报形式

- 启动问候：重启时随机播一条（内置 `欢迎回来/欢迎回归` 或用户配置的附加问候），不写 session、不跑 LLM：
  - `src/index.ts:1154-1169`、`src/index.ts:1202-1215`
- 对话口播：`say_to_user` 工具 → 优先 voice-mini `/test`（带提示音），否则内置 edge-tts 合成 + `afplay`：
  - `src/index.ts:1219-1242`、`src/index.ts:1252-1276`
- 内置 TTS 单独子进程跑（`ELECTRON_RUN_AS_NODE=1`），规避 Electron 主进程 WebSocket 不稳定：
  - `src/index.ts:270-309`
- 字幕：播报文本显示在输入条上方/旁边的 320×56 区域，Jarvis 青色、其他会话紫色；播报结束后保留 1.5s：
  - `macos/Sources/JarvisPanel/CaptionView.swift:9-24`
  - `macos/Sources/JarvisPanelCore/Caption.swift:17-41`
  - `macos/Sources/JarvisPanel/OverlayRootView.swift:20-26`
- 静音：悬停光球出现静音/取消静音按钮；静音抑制所有播报：
  - `macos/Sources/JarvisPanelCore/PanelModel.swift:205-209`
  - `src/index.ts:71-73`、`src/index.ts:1225`

### 5.6 可见性策略（不打扰）

- 前台是 DSH：不透明度 100%；其他应用：35%（可调 15%–100%）：
  - `macos/Sources/JarvisPanelCore/PanelSettings.swift:50-53`
- 鼠标靠近 80pt 内渐显；需要处理/出错时保持 ≥0.85；贴边细带 ≥0.8；输入条打开时强制 100%：
  - `macos/Sources/JarvisPanelCore/VisibilityPolicy.swift:45-70`
- 全屏应用、App Launcher、Mission Control、用户指定 App 前台时可隐藏：
  - `macos/Sources/JarvisPanelCore/VisibilityPolicy.swift:55-58`
  - `macos/Sources/JarvisPanel/SystemObserver.swift:81-107`（前台 PID + 全屏窗口 + Spotlight 启动器扫描）
- 「减少动态效果」可跟随系统：`macos/Sources/JarvisPanel/AppController.swift:600-603`、`macos/Sources/JarvisPanelCore/PanelSettings.swift:59`

### 5.7 明显局限

1. **平台锁定**：仅 macOS 14+，需要 Swift 6 工具链；没有 Windows/Linux；README 路线图才提「跨平台面板」：
   - `README.md:53`、`README.md:120-127`
   - `macos/Package.swift:10`
2. **单 Jarvis / 单面板**：
   - 只创建一个 `jarvisSessionId`：`src/index.ts:167`、`src/index.ts:932-939`
   - 面板 pidfile 是全局 `~/.dsh/jarvis/panel.pid`：`macos/Sources/JarvisPanel/JarvisPanelApp.swift:27-37`
   - 推断：多个 DSH profile/实例同时跑时，`panel.pid` 与全局 `runtime.json` 会互相争用，只有一个面板能连上一个宿主。
3. **多任务只是「多 worker 托管」，不是多指挥官**：
   - 可同时托管多个会话、显示多张 pending 卡（最多 3 张）
   - 但只有一个 Jarvis agent；`ask_user` 通过 `OutputCoordinator` 串行排队（`src/output.ts:67-99`）
   - 没有并行 Jarvis 对话、没有 per-session 独立输入框
4. **没有看板**：
   - 只有目标列表 + 状态点 + 任务状态 pill（进行中/判断中/未完成）+ 顶部计数
   - 没有列/泳道/拖拽/排序/依赖关系；`SessionRow.task` 也只暴露 status + 摘要
   - 证据：`src/session-state.ts:9-35`、`macos/Sources/JarvisPanel/QuickBarView.swift:166-242`、`src/index.ts:643-648`
5. **审批卡容量小**：
   - 最多 3 张，超出只显示「还有 N 件」，不能滚动查看全部
   - `macos/Sources/JarvisPanelCore/PanelModel.swift:68`、`macos/Sources/JarvisPanel/OverlayRootView.swift:76-86`
6. **历史容量小**：
   - 20 条、单条预览 280 字符/8 行；长文本被截断
   - `macos/Sources/JarvisPanel/HistoryView.swift:8`、`macos/Sources/JarvisPanelCore/Snapshot.swift:278-293`
7. **无语音输入**：没有麦克风/唤醒词；只有输出播报：
   - `README.md:113`（no microphone capture）、`README.md:119`（roadmap voice input）
8. **TTS 受限**：内置只支持 edge；依赖 macOS `afplay`；语音文本会发给 Microsoft：
   - `src/index.ts:151`（`ttsBackend: z.union(['edge'])`）
   - `src/index.ts:286-295`（`afplay`）
   - `README.md:111`
9. **打包不完整**：`package.json.files` 没有包含 `macos/`，npm 发布包不会带面板源码/二进制；README 也承认「预编译面板」尚未完成：
   - `package.json:27-38`
   - `README.md:120`
10. **安全验收未完成**：
    - `README.md:127`
    - 审批记录/日志含敏感操作上下文：`README.md:113`
11. **对 DSH 内部服务强耦合**：
    - `agents`、`sessions`、`sessionQuery`、`workspaceRegistry`、`desktopBrowserAccess` 都通过 `(ctx as any).get?.(...)` 取，没有类型保障
    - `src/index.ts:86-98`、`src/index.ts:100-103`、`src/index.ts:110-114`、`src/index.ts:565`、`src/index.ts:612`、`src/index.ts:743`、`src/index.ts:783`
12. **`jobs` 是假硬依赖**：`inject` 声明必需，但全仓库没有任何 `ctx.get('jobs')` 或 `jobs` 服务调用；缺它插件不会加载，却完全没用到：
    - `src/index.ts:139`
    - 搜索证据：除 `inject` 和 `completion.ts` 内部 `jobs` Map（同名不同物）外无引用
13. **保留/死配置**：
    - `archiveIdleDays`、`titlePrefix` 在 cordis.patch.yml 注释里标 reserved：`cordis.patch.yml:20,23`
    - `/providers`、`/models` 无 Swift 消费者：`src/index.ts:709-719` vs `macos/Sources/JarvisPanelCore/JarvisAPI.swift:29-47`
14. **README 与代码的小偏差**：README 说「五种状态动效」，代码是六种（含 `error`）：
    - `README.md:23` vs `macos/Sources/JarvisPanelCore/OrbAppearance.swift:3-6`

---

## 6. 扩展点：Client Slots 与 Host 扩展点

### 6.1 Client Slots：**0 个**

- `package.json` 只声明了 `dsh.bundle.patch`，没有 `dsh.client` / client entry / slot 注册：
  - `package.json:46-48`
  - `package.json:22-26`（`exports` 只有 `"."`）
- 仓库里没有 `src/client`、没有 `registerSlot`/`ctx.slot` 调用；唯一出现 “slot” 的是粒子模拟的 slot 布局：
  - `macos/Sources/JarvisPanelCore/ParticleSim.swift:51`、`:82`、`:100-122`（与 DSH 无关）
- 所有 UI 都在独立 Swift 进程（`macos/Sources/JarvisPanel/*`），DSH renderer 不参与。
- **结论**：Jarvis 不能作为「DSH Client Slot 用法」的参考；它走的是「原生进程 + HTTP 能力接口」的旁路架构。若「DSH 指挥官」要做 renderer 内 UI（跨平台、跟 DSH 主题/布局一致），需要另找 DSH 客户端插件文档；若要做真正的全局常驻窗口，Jarvis 的原生方案是已验证路径。

### 6.2 Host 扩展点（具体名称）

#### A. 插件/打包层

| 名称 | 用途 | 证据 |
|---|---|---|
| `dsh.bundle.patch` → `cordis.patch.yml` | 作为 bundle layer 插入插件行 | `package.json:46-48`；`cordis.patch.yml:11-27` |
| `insert[].id/name/config` | 插件在 deployment 中的 id、服务名、配置 | `cordis.patch.yml:12-27` |
| `name` / `inject` / `Config` / `apply` / default export | Cordis 插件模块契约 | `src/index.ts:136-172`、`src/index.ts:439`、`src/index.ts:1599` |

#### B. 服务注入与提供

| 名称 | 用途 | 证据 |
|---|---|---|
| `ctx.inject(['llm'])` | 可选：拿 `llm.adapters` / `listModels` / `stream` | `src/index.ts:597-601` |
| `ctx.inject(['webServer'])` | 可选：注册 `/jarvis`、拿 host/port | `src/index.ts:602-619` |
| `ctx.inject(['desktopBrowserAccess'])` | 可选：拿 `rendererHeader` | `src/index.ts:610-617` |
| `ctx.inject(['settings'])` + `settings.installSection(...)` | DSH 设置页分区 | `src/index.ts:868-883` |
| `ctx.inject(['sessionTitle'])` + `sessionTitle.rename(...)` | 固定 Jarvis 标题 | `src/index.ts:892-895`、`src/index.ts:1366-1373` |
| `ctx.inject(['agentLoop'])` + `agentLoop.createAgent/resume` | 创建/恢复 Jarvis agent | `src/index.ts:901-969` |
| `ctx.inject(['voice:tts'])` | 仅探测外部 TTS 是否存在 | `src/index.ts:1132-1134` |
| `ctx.provide('jarvis', {...})` | 向 voice-mini 等插件导出 `sessionId/cwd/speech()/claimsTurnEnd()` | `src/index.ts:539-556` |
| `userQuestions.ask({questions, agent, signal})` | Jarvis 的 `ask_user` 工具 | `src/index.ts:516-536` |

#### C. 事件与瀑布

| 名称 | 类型 | 用途 | 证据 |
|---|---|---|---|
| `session/event` | 通知 | 捕获 `turn/start`、`turn/end`、`user/message`；维护 busy/unread/failed、触发完成判断 | `src/index.ts:972-1000` |
| `approval/request` | **瀑布**（`next`） | 审批拦截/回传/竞答；`{ prepend: true }` | `src/index.ts:1004-1101` |
| `user-questions/request` | **瀑布**（`next`） | 问题代答/面板竞答；`{ prepend: true }` | `src/index.ts:1126-1128` |
| `system-prompt/assemble` | **瀑布**（agent 作用域） | 异步刷新 memory section | `src/index.ts:1395-1406` |

#### D. Agent 作用域（setup 回调里）

| 名称 | 用途 | 证据 |
|---|---|---|
| `agentCtx.inject(['systemPrompt'])` | agent 级注入 | `src/index.ts:1379` |
| `systemPrompt.section({ name, order, text })` | 注册 `jarvis:persona`（order 50）、`jarvis:memory`（order 60） | `src/index.ts:1385-1393` |
| `agentCtx.on('system-prompt/assemble', ...)` | 在提示词组装前替换 section 文本 | `src/index.ts:1395-1406` |
| `agentCtx.tools.register(defineTool({...}))` | 注册 11 个工具 | `src/index.ts:1425-1597` |

#### E. 通过 `ctx.get` 读的内部服务（非正式注入）

| 名称 | 用途 | 证据 |
|---|---|---|
| `agents`（`keys/list/get`） | 枚举 worker、取 status、给 `inject_to_session` 找目标 | `src/index.ts:87-94`、`src/index.ts:743`、`src/index.ts:1524` |
| `sessions.get(id).header.cwd` | 取会话工作区 | `src/index.ts:100-103`、`src/index.ts:1026` |
| `sessionQuery.readTitleSnapshots(ids)` | 批量标题 | `src/index.ts:107-133` |
| `workspaceRegistry.archivedSessionIds` | 排除归档会话 | `src/index.ts:95-97` |
| `desktopBrowserAccess.rendererHeader` | 面板能力头 | `src/index.ts:610-614` |
| `sessionTitle.get/rename` | 标题 | `src/index.ts:1366-1373` |

#### F. 来自 DSH 包的类型/工具

| 名称 | 来源 | 证据 |
|---|---|---|
| `defineTool` | `@deepseek-ai/dsh-tools` | `src/index.ts:18` |
| `MessageId` / `UserMessage` | `@deepseek-ai/dsh-llm` | `src/index.ts:19-20` |
| `PromptAssembly` | `@deepseek-ai/dsh-system-prompt` | `src/index.ts:21` |
| `z`（schemastery） | `@deepseek-ai/schemastery` | `src/index.ts:16-17` |

### 6.3 对「DSH 指挥官」的复用判断

| 能力 | 建议 | 理由 |
|---|---|---|
| 审批拦截 + 双答者竞答 | **直接复用** | `prepend` 瀑布 + `holdApproval` + signal swap + 600ms 宽限是完整可抄的实现；注意 `approval/request` 是全局的，不限于托管会话 |
| runtime.json + HTTP + rendererHeader | **直接复用** | 已验证的宿主↔外部进程桥；`rendererHeader` 是 DSH Desktop 的硬要求 |
| `agentLoop.createAgent` + setup 装饰 | **直接复用** | 自建 agent、persona、tools、systemPrompt 的完整范式 |
| `settings.installSection` + Config/SettingsSchema 分离 | **直接复用** | 设置页与 composition 配置解耦，适合指挥官的多项策略配置 |
| 长轮询 `/wait` 状态源 | **直接复用** | 比固定间隔轮询更省电、更及时 |
| 原生 NSPanel 配方 | **可复用，但接受 macOS 锁定** | statusBar + allSpaces + fullScreenAuxiliary + ignoresMouseEvents 切换 + Carbon 热键 + 逐矩形命中 |
| Client Slots | **不可复用（本仓库没有）** | 若指挥官要做 DSH renderer 内 UI，需另找客户端插件方案 |
| 单 agent 架构 | **谨慎** | 指挥官若要多任务/多角色，需要多个 agent 或任务编排层，Jarvis 只做了单 agent + 多 worker 托管 |
| 自动审批策略 | **谨慎** | `safe` 对只读工具无路径边界；`safe+grey` 依赖模型置信度；高危始终人工，但整体仍属「策略组件」而非安全边界 |
| 看板/多任务 UI | **不可复用** | 需要自建 |

---

## 7. 关键风险清单（给指挥官）

1. **内部 API 耦合**：`agents/sessions/sessionQuery/workspaceRegistry/desktopBrowserAccess` 都是 `any` 读取，DSH 版本升级可能直接崩；需要版本适配层与降级路径。
2. **审批元数据脆弱**：命令/路径来自 `deriveMessages()` + `callId` 扫描；拿不到时 `cwd=''` → `classify` 返回 `high`，面板只剩工具名，预设不可用。
3. **只读工具越界**：若 DSH 为工作区外读取发起审批，`autoApprove='safe'` 会直接放行；建议指挥官默认关闭自动审批，或把路径边界校验加到只读工具。
4. **本地 token 可被同用户进程读取**：`runtime.json` 0600，但同用户恶意进程仍可读并调用 `/jarvis/input`、`/pending/answer`；回环限制不等于进程隔离。
5. **多实例冲突**：全局 `panel.pid` + `runtime.json` 不适合多 DSH 实例；指挥官若要支持多 profile，需要按 profile/端口分目录。
6. **模型热切换不可用**：provider/model 在创建 agent 时固定；改配置需重启。指挥官若要多模型路由，需要自建 per-agent 或 per-request 选择。
7. **隐私**：审批记录/日志含命令与上下文；模型服务会收到对话；edge-tts 会把播报文本发给 Microsoft。
8. **无安全验收**：README 明确说安全审查与真机验收未完成，不能把 Jarvis 的实现当作已认证的安全边界。
9. **`jobs` 假依赖**：如果指挥官的宿主环境没有 `jobs`，Jarvis 会直接不加载；但代码根本没用它。接入时可去掉。
10. **打包缺口**：`package.json.files` 不含 `macos/`，npm 包无法自带面板；发布需额外处理。

---

## 8. 附录：证据索引与未使用项

### 8.1 最值得先读的文件

| 目的 | 文件 |
|---|---|
| 插件入口/全部接线 | `src/index.ts`（1599 行） |
| 审批竞答核心 | `src/live-state.ts`（410 行） |
| 审批分级/预设/自动审批 | `src/approval-tier.ts`、`src/approval-presets.ts`、`src/approval-risk.ts`、`src/auto-approval.ts` |
| 会话托管/消息投递 | `src/sessions.ts`、`src/managed.ts`、`src/tasks.ts`、`src/completion.ts` |
| 悬浮窗窗口/几何 | `macos/Sources/JarvisPanel/AppController.swift`、`OverlayPanel.swift`、`OrbPanel.swift`、`JarvisPanelCore/Placement.swift` |
| 视觉/状态 | `macos/Sources/JarvisPanelCore/OrbAppearance.swift`、`ParticleSim.swift`、`macos/Sources/JarvisPanel/Theme.swift` |
| 通信客户端 | `macos/Sources/JarvisPanelCore/JarvisClient.swift` |
| 设置 | `src/settings.ts`、`macos/Sources/JarvisPanel/SettingsView.swift`、`macos/Sources/JarvisPanelCore/PanelSettings.swift` |
| 设计稿 | `docs/design/orb-states.html`、`docs/design/orb-visual-direction.html`、`docs/design/*.gif` |

### 8.2 保留/未使用项

- `jobs`：声明为必需，无实际调用（`src/index.ts:139`）。
- `archiveIdleDays`：默认 7，注释 reserved，未实现自动归档（`cordis.patch.yml:23`、`src/index.ts:153`）。
- `titlePrefix`：默认 `贾维斯-`，注释 reserved，无 worker 重命名（`cordis.patch.yml:20`、`src/index.ts:150`）。
- `lockFile`：仅内存写入诊断，不是跨进程锁（`cordis.patch.yml:18`、`src/memory/README.md:25`）。
- `/providers`、`/models`：宿主有路由，Swift 无消费者（`src/index.ts:709-719`、`macos/Sources/JarvisPanelCore/JarvisAPI.swift:29-47`）。
- `package.json.files` 不含 `macos/`（`package.json:27-38`）。
- README 说五种状态，代码六种（`README.md:23`、`OrbAppearance.swift:3-6`）。

### 8.3 本次未验证项

- 未执行 `npm ci` / `npm run build` / `swift build` / `swift test`，因此**运行时行为、Swift 编译兼容性、DSH 版本兼容性**未实测。
- 未在真机观察「所有 Space / 全屏应用之上 / Mission Control 隐藏」的实际表现；结论基于 `NSPanel` 配置。
- 未验证 `agentPreset: 'jarvis'` 在目标 DSH 版本中是否必须存在同名 preset。
- 未验证多 DSH 实例/多 profile 下 pidfile 与 runtime.json 的实际冲突行为（推断）。
