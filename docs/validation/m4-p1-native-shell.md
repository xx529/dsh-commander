# M4 P1 原生壳（macOS / Tauri 2）实现与验证

> 日期：2026-11-19　执行：Lead（根 agent）　范围：M4 P1 骨架（原生壳 + Host supervisor + 窗口页）
> 契约：`docs/architecture/native-shell-contract.md`　产品需求：`docs/PRODUCT-DESIGN.md` §18 M4「任意应用可见」

## 0. 结论

**P1 实现完成，自动化证据 PASS；live 视觉/热键/壳内审批为 UNVERIFIED（需用户安装后走查）。**
已交付：可脱离 DSH 窗口的 Tauri 悬浮球 + 面板（消息、看板、验收/返工/归档、审批卡）、Host 进程 supervisor、窗口页与独立 bundle、构建脚本与探针。

未完成（P2）：跨所有 Space/全屏辅助、问答卡、播报/托盘、Windows、签名/公证、设置页开关、与 DSH 页内浮球互斥。

## 1. 环境

| 项 | 值 |
|---|---|
| 机器 | macOS arm64（Apple Silicon） |
| Node / pnpm | v22.22.2 / 11.22.0 |
| Rust / Cargo | 1.99.1 / 1.99.1 |
| Tauri | 2.12.7（`tauri-plugin-global-shortcut` 2.4.1） |
| DSH | CLI 0.2.2-rc.2 / Desktop 0.2.2-rc.3（未重启、未修改 live profile） |
| 构建缓存 | `CARGO_HOME=<repo>/.cargo-home`、`CARGO_TARGET_DIR=<repo>/target/native-shell`（不写 `~/.cargo`、不进安装包） |

## 2. 证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm --filter dsh-commander typecheck` | exit 0 |
| 全量单测 | `pnpm --filter dsh-commander test` | **282/282 pass**（新增 protocol 3、supervisor 8、window-page 3、approval 5） |
| Host 构建 | `pnpm --filter dsh-commander build:host` | exit 0（`lib/host/native/*` 就位） |
| 窗口 bundle | `pnpm --filter dsh-commander build:window` | `lib/window.js` 261,480B（IIFE，React 打包） |
| Client bundle | `pnpm --filter dsh-commander build:client` + `verify-bundle.mjs` | wrapper 有效、未打包 React、344,428B |
| 原生壳 | `pnpm --filter dsh-commander build:native` | `native/dist/darwin-arm64/dsh-commander-shell` 4,475,600B，`codesign -dv` → `flags=0x2(adhoc)` |
| 壳协议 smoke | `node tools/dev/native-shell-smoke.mjs` | PASS：hello → ready/ping → 窗口页请求 → WebView JS beacon → pong → shutdown |
| 真实窗口 bundle | `node tools/dev/native-window-probe.mjs` | PASS：`lib/window.js` 在 WKWebView 执行，请求 `/commander/state`、`/commander/config`、`/commander/native/approvals` |
| 隔离 Host e2e（M0） | `node packages/dsh-commander/tests/e2e/m0-e2e.mjs` | **20/20 PASS**（含重启绑定不丢） |
| 隔离 Host e2e（M2/M3） | `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **25/25 PASS**，0 FAIL，3 INFO；health 含 `nativeShell:"disabled"`（隔离脚本显式禁用壳） |
| 隔离 Host e2e（M4 原生壳） | `node packages/dsh-commander/tests/e2e/m4-e2e.mjs` | **10/10 PASS**：隔离 Host 拉起壳、`health.nativeShell=running` + `nativeShellPid`、kill 壳后自动重启（pid 变化）、Host 停止后壳退出、`PUT ui.nativeShell=false` 后重启 Host → `nativeShell:"disabled"` |

## 3. 实现要点

- **壳**：Tauri 2 透明无边框窗口、`always_on_top`、`skip_taskbar`、`collectionBehavior=[canJoinAllSpaces,stationary,fullScreenAuxiliary]`、accessory 激活策略；球 56×56 ↔ 面板 420×660（逻辑像素统一）；Option+Space（失败降级 Ctrl+Alt+Space）；位置写 `~/.dsh/commander/native/window.json`；父 PID 看门狗；stdout 只走 NDJSON。
- **Host**：`supervisor`（握手/心跳/退避重启/退出清理/可执行位修复）；`GET /commander/window?token=`（一次性 token + 内联 `lib/window.js`）；`health.nativeShell`；`GET /commander/native/approvals`、`POST /commander/native/approval/:id`；`ctx.effect` 生命周期；测试进程（`NODE_TEST_CONTEXT`）与 `DSH_COMMANDER_NATIVE_SHELL=0` 禁用。
- **审批桥**：壳 `running+visible+focused` 时 `prepend` 接管 `approval/request`，否则 `next()` 回落 DSH；壳退出/心跳失败/10 分钟超时 → `cancelled`（fail closed）；SSE `native.approval` / `native.approval.resolved`。
- **窗口页**：复用 `createCommanderStore`（同源 `/commander/*` + SSE）；「对话 / 看板」两视图；看板按状态分组、详情抽屉、accept/rework/archive；审批卡允许一次/拒绝。
- **双球互斥**：`/commander/state` 快照新增 `nativeShell`；壳 `running` 时 DSH 页内球（及其 hover 标签）隐藏，入口交给桌面球；壳停止/失败自动恢复页内球。
- **设置开关**：`ui.nativeShell`（默认 true）接入设置页「外观 → 桌面浮窗」，保存后重启 DSH 生效；`DSH_COMMANDER_NATIVE_SHELL=0` 仍可强制禁用。
- **origin 解析**：优先 `DSH_WEB_URL`，否则 `webServer.getOrigin()` / `webServer.port`（隔离 CLI 下也正确，不再依赖 3080 fallback）。

## 3.1 已踩并修复的坑

1. **macOS 26 的 linker-signed ad-hoc 签名被判无效**：加 objc2/collectionBehavior 后，`cargo build` 产物启动即 `SIGKILL (Code Signature Invalid)`（报告 `~/Library/Logs/DiagnosticReports/dsh-commander-shell-*.ips`）。修复：`native/build.sh` 复制后 `codesign --force --sign -`；smoke 恢复 PASS。
2. **窗口坐标**：Tauri `position/inner_size` 是逻辑像素，早期按物理传会在 Retina 偏移；已统一逻辑坐标。
3. **启动顺序**：先注册 `/commander/*` 路由再拉起壳，避免首个 window 页 404。
4. **origin**：隔离 CLI 下 `DSH_WEB_URL` 可能缺失，改用 `webServer.getOrigin()` 兜底。

## 3.2 视觉证据（2026-11-19 10:05）

用 `node tools/dev/native-shell-shot.mjs` 启动壳（假 Host 数据面返回 `nativeShell:"running"`）后 `screencapture -x` 全屏截图：
`docs/validation/m4-artifacts/native-shell-ball.png`。

- 桌面右下角可见**独立蓝色悬浮球**（白旗标 + 绿色连接点），浮在 DSH 页面之上；
- 同一帧里 DSH 页内球未出现（假快照 `nativeShell:"running"` → 双球互斥生效）；
- 球与 DSH 原生按钮是分离窗口（球来自 Tauri 壳，不是页面 DOM）。

![原生壳悬浮球](./m4-artifacts/native-shell-ball.png)

## 3.3 live 首启问题与修复（2026-11-19 10:4x）

用户首次安装后反馈：点击球只看到 56×56 的小方块、无法拖动。复现与定位：

1. **远程页面 IPC 被拦**：壳加载 `http://127.0.0.1:<port>/commander/window`，Tauri 默认不允许远程 origin 使用 IPC。`webview` 里 `window.__TAURI__` 存在，但 `invoke` 报 `Command set_mode not allowed by ACL`。
2. **自定义命令未生成 ACL**：Tauri 2 需要为 `invoke_handler` 的自定义命令声明权限。

修复：
- `capabilities/default.json` 增加 `remote.urls: ["http://127.0.0.1:*"]`；
- `build.rs` 用 `tauri_build::Attributes::app_manifest(AppManifest::new().commands(&["set_mode","open_external","quit"]))` 生成 `allow-set-mode` 等权限，并加入 capability；
- 新增 `tools/dev/native-ipc-probe.mjs` 复现/回归。

回归证据：`beacons: tauri=object&core=function → invoke=ok`，`bounds: 56x56 → 420x660`。

## 3.4 live 二轮问题与修复（2026-11-19 10:5x）

用户反馈：① 面板展开后跑到屏幕正中央；② 点「看板」只看到面板收起。

定位与修复：

1. **位置**：`set_window_mode` 混用物理/逻辑坐标。改为全程逻辑坐标（`outer_position().to_logical(scale)`、`LogicalSize/LogicalPosition`）。`native-ipc-probe` 回归：展开后 bounds `1476,348 420x660`（右下球附近，非中央）。
2. **看板按钮**：header 的 `onPointerDown` 把按钮点击当成拖动起点，`pointerup` 未移动 → 触发 `collapse`。修复：按钮加 `data-no-drag`，`beginDrag` 只在非 `[data-no-drag]` 目标上启动；球自身不带标记，仍可拖。
3. 诊断：`set_mode` 写 `~/.dsh/commander/native/last-mode.json`（before/target/after/scale），便于后续排查位置。

## 3.5 Markdown 渲染（2026-11-19 10:5x）

用户反馈窗口页 assistant 消息把 `**粗体**`/列表原样显示。原因：DSH 的 `MarkdownText` 来自浏览器模块表（`@deepseek-ai/dsh-client-ui-primitives`），原生壳的独立 IIFE bundle 拿不到。

修复：新增 `src/client/window-markdown.tsx`（零依赖轻量渲染：段落/标题/有序无序列表/代码块/引用/粗斜体/行内代码/http 链接），窗口页 assistant 消息改用 `WindowMarkdown`，并在 `window-styles.ts` 补 `.dshcn-md-*` 样式。

视觉验证（真实壳 + 假 Host 数据面 + `screencapture`）：`docs/validation/m4-artifacts/window-panel-markdown.png`；可见粗体/列表/编号/引用/代码块正确渲染，面板在球附近（非屏幕中央）。复现：`node tools/dev/native-shell-shot.mjs`。

## 3.6 看板泳道 + 球位置恢复（2026-11-19 11:1x）

用户反馈：① 看板不是五列泳道；② 点球展开再收起，球位置漂移。

修复：
1. **看板复用 BoardPage**：窗口页看板改为直接渲染 DSH 页内的 `BoardPage`（五列泳道/拖拽改状态/回收站/详情抽屉），并在 `window-styles.ts` 为 `.dshcn-board-wrap` 映射 `--dsw-alias-*` 主题变量、五列均分。看板模式把壳窗口加宽到 980×700（`set_mode('board')`），切回对话恢复 420×660。
2. **球位置恢复**：`AppState.ball_pos` 在从球态展开时记录球的逻辑坐标，收起时恢复；`Moved` 事件在球态实时更新。`native-ipc-probe` 回归：`1840,952 56×56 → 1476,348 420×660 → 1840,952 56×56`，位置一致。

视觉证据：`docs/validation/m4-artifacts/board-five-lanes.png`（五列泳道全部可见）。

## 3.7 首次点击与 hover（2026-11-19 11:3x）

用户反馈：鼠标移到球上要点一下（激活窗口）再点一下才能打开；期望 hover 变大、单击直接展开。

修复：
- 壳窗口 builder 增加 `.accept_first_mouse(true)`（macOS `acceptsFirstMouse`），非激活窗口的第一次点击直接传给页面，不再被系统吃掉。
- 球 hover 从 `scale(1.03)` 提到 `scale(1.12)` + `:active` 回弹。
- 说明：hover 依赖 WKWebView 在非激活窗口收到 `mouseMoved`；若真机仍不放大，需要改用窗口级 `NSTrackingArea`/全局鼠标监听（P2）。

## 3.8 失焦/头部点击误收起（2026-11-19 11:4x）

用户反馈：点击其他应用后，面板自动收起变回球。

排查与修复：
- 面板头部（拖动区）的 pointerdown/up 在未移动时也会走 `collapse()`；且拖动进行中指针移出窗口/失焦后 `pointerup` 可能丢失，残留监听会在下一次点击时误触发。
- 修复：只有**球**的点击（未移动）才 toggle；面板头部点击/拖动只移动窗口，不收起。`window.blur` 时取消未完成拖动并移除 move 监听。

## 3.9 问答卡（2026-11-19 11:5x）

用户反馈：`ask_user_question` 的提问卡在窗口页不出现（DSH 页内有）。

实现：
- Host `src/host/native/question-bridge.ts`：以 `{prepend:true}` 监听 `user-questions/request`。壳 `running+visible+focused` 时接管（否则 `next()` 回落 DSH Web 回答者），把问题批次经 SSE `native.question` 推给窗口页；回答走 `POST /commander/native/question/:id`（校验每个问题恰好一条 answer、selected 必须是选项 label、multiSelect 单选约束）。壳退出/超时 → 返回全部 `selected: []`（合法"跳过"，工具继续）。
- 窗口页：问答卡（问题/描述/单选多选/自定义输入/提交/跳过），`GET /commander/native/questions` 补拉；球徽标计入待答批次。
- 单测 `tests/native-question.test.ts` 4 条（接管/回落/非法答案/退出跳过/超时）。

视觉证据：`docs/validation/m4-artifacts/question-card.png`（"需要你回答"卡片 + 选项 + 自定义输入）。

## 3.10 看板可缩放 + 切换位置稳定（2026-11-19 12:2x）

用户反馈：① 看板大小需要能拖拽缩放；② 打开看板再关闭，对话面板位置奇怪。

修复：
1. **可缩放**：展开态 `set_resizable(true)`（球态仍固定 56×56），拖窗口边缘即可放大/缩小；对话/看板布局按窗口 100% 自适应。
2. **锚点统一为球位置**：`panel → board → panel` 切换都以 `ball_pos` 为锚点展开（首次展开记录当前球位置），不再以看板左上角作为对话面板位置。
- 探针回归（`native-ipc-probe`）：`1840,952 56×56 → 1476,348 420×660 → 916,308 980×700 → 1476,348 420×660 → 1840,952 56×56`，两次 panel 坐标一致。

## 3.11 壳内会话窗口（2026-11-19 13:0x）

用户需求：看板里点任务关联会话，应用内打开对应 session；应用外需要打开一个窗口看对话内容，而不是跳转 DSH。

实现：
- Host 新增 `GET /commander/session-transcript?sessionId=&limit=`：从会话事件提取真实 user/assistant 文本（跳过注入来源），最多 200 条。
- 壳新增 `open_session_window(sessionId)` command：在壳进程内新建一个普通 Tauri 窗口（560×760，系统标题栏可关闭，label `session-*`），加载同一 `/commander/window?token=…&session=<id>`；capability `windows` 增加 `session-*`，并生成 `allow-open-session-window` ACL。
- 窗口页按 boot `session` 分派到 `SessionTranscriptApp`：只读消息列表 + Markdown 渲染；看板 `openSession` 接到 `bridge.openSessionWindow`。
- 单测/视觉：`native-shell-shot` 假数据验证截图 `docs/validation/m4-artifacts/session-window.png`（标题“会话 session-demo-1234” + 用户消息 + Markdown 回复）。

限制：会话窗口是打开时的只读快照（不自动跟随新消息）；需要实时跟随可后续加轮询/SSE。

## 3.12 会话窗口 Markdown 增强（2026-11-19 14:1x）

用户反馈：壳内打开的会话窗口里 assistant 文本没有正常 Markdown 渲染。

增强 `window-markdown.tsx`：
- GFM 表格（表头/分隔行/单元格）；
- 有序/无序列表（含缩进续行）；
- 代码块、引用、标题、粗体/斜体/行内代码；
- 跨行链接 `[text](\n/url)` 合并，避免 URL 泄漏；
- 非 http(s) 链接（本地绝对路径）降级为只显示链接文字，避免长路径刷屏。

视觉验证：`docs/validation/m4-artifacts/session-window.png`（标题/表格/列表/代码块正常；本地路径链接只显示文字）。

## 3.13 窗口层级（2026-11-19 14:2x）

用户反馈：打开看板后再打开会话窗口，看板始终在最前，其他窗口无法覆盖。

修复：层级跟随状态——球态 `set_always_on_top(true)`（常驻桌面）；展开成面板/看板时 `set_always_on_top(false)`，允许其他应用/会话窗口覆盖；收起回球恢复置顶。

## 3.14 派发确认卡对齐（2026-11-19 14:2x）

用户需求：应用内（DSH 页内面板）有派发确认提示，应用外窗口缺失，需要能力对齐。

实现：
- 窗口页复用应用内的 `DispatchConfirmCard`：`view.pendingDispatch` 存在时显示建议目标、Jev pMax/阈值、候选目标、自定义选择/采用建议/取消；动作仍走 `buildDispatchActionMessage` + `POST /commander/message`，与页内完全同一条通道。
- 每秒刷新倒计时；`decisionId` 变化时重置本地“已发送”状态；发送后显示“已发送确认，等待指挥官处理…”。
- 窗口页注入共享 `STYLES`，并把 `--dsw-alias-*` 主题变量提升到 `:root`（深/浅色两套），派发卡的按钮/卡片样式与页内一致。

视觉证据：`docs/validation/m4-artifacts/dispatch-card.png`（派发确认卡 + 问答卡 + 看板 + 会话窗口同屏）。

## 3.15 审批/提问双处可见（2026-11-19 15:0x）

用户需求：DSH 内 session 的审批/提问要同时在 DSH 页内和浮窗看到，且两边都能操作。

现状与边界：
- **双处可见**已实现：审批桥/问答桥即使不接管，也会把请求以只读视图推给浮窗（`canAnswer:false`），DSH 页内照常显示；浮窗实时出现卡片并提示“请在 DSH 中处理”。
- **浮窗可操作**：壳 `running+visible+focused` 时 `prepend` 接管，浮窗显示允许/拒绝/提交；此时该请求由浮窗独占（DSH 页内不再作为应答者）。
- **两边同时可操作未实现**：DSH 的 `approval/request` / `user-questions/request` 是 waterfall，首个返回者独占决策；浮窗不是 DSH Remote client，无法与 DSH 页内共享同一个 PendingApproval/Question 实例。要做到“两边都能点、先答生效”需要把浮窗接入 DSH 的 Remote client（第二个 UI client），属于较大改造。

## 3.16 待办改为底部抽屉（2026-11-19 15:4x）

用户反馈：窗口页的问答/审批/派发卡直接铺在消息区上方，样式与应用内的底部抽屉不一致。

实现（对齐应用内 `dshc-sheet` 设计）：
- 派发确认、审批、提问统一放进面板底部抽屉：grab 条 + 标题「待处理 N」+ 副标题 + 可滚动 body + 半透明遮罩，点击遮罩或再次点入口收起。
- 有待办时自动弹出；收起后底部出现「待处理 N」浮动按钮，点击重新展开。
- 卡片在抽屉 body 内滚动，不再挤压消息区；问答多题/审批多卡均适用。
- 复用应用内 `.dshc-sheet-*` 样式与 `--dsw-alias-*` 主题变量。

视觉证据：`docs/validation/m4-artifacts/todo-sheet.png`。

## 3.17 与应用内设计逐项对齐（2026-11-19 15:5x）

逐个检查窗口页 vs DSH 页内面板，能直接复用的都改成复用：

| 能力 | 应用内来源 | 窗口页 | 结论 |
|---|---|---|---|
| 派发确认卡 | `DispatchConfirmCard` | 直接复用 | ✅ 一致 |
| 审批卡 | `ApprovalFloatCard` | 直接复用（数据由 Host 桥适配成 `PendingApprovalItem`） | ✅ 一致 |
| 问答卡 | `QuestionCard`（分页/多选/自定义/跳过） | 直接复用（数据由 Host 桥适配成 `PendingQuestionItem`） | ✅ 一致 |
| 看板 | `BoardPage`（五列/抽屉/拖拽/回收站） | 直接复用 | ✅ 一致 |
| 系统消息卡 | `interpretCommanderMessage` + `.dshc-system-card` | 直接复用（session-reply/board-edit 不再显示原始标记） | ✅ 一致 |
| 设置页 | `CommanderSettingsSection` | 直接复用（面板 header「设置」入口） | ✅ 一致 |
| 底部抽屉 | `.dshc-sheet-*` | 直接复用样式/结构 | ✅ 一致 |
| 消息 Markdown | `MarkdownText`（浏览器模块表） | `WindowMarkdown` 自写（模块表不可用） | ⚠️ 语法覆盖略少 |
| 悬浮球 | `.dshc-ball` | `.dshcn-ball` 自写（56px 窗口适配） | ⚠️ 视觉接近，未复用 |
| 状态 popover/播报 | `uiSession` / 广播 | header 简化显示连接/绑定 | ⚠️ 未复用 |
| 数据来源 | `uiSession.pendingInteraction` | Host 桥 `native.*` SSE | 架构差异（组件已复用） |

视觉证据：`docs/validation/m4-artifacts/settings-reuse.png`（复用设置页）。

## 3.18 透明背景（2026-11-19 16:5x）

用户反馈：重启后球/面板周围仍有半透明色块（球窗口方形底、面板左/右边缘竖条）。

定位：不是窗口阴影（已关），而是 WKWebView / NSWindow 的默认背景：
- 球窗口 56×56 内球外区域显示灰底；
- 面板窗口 `inset` 边缘显示竖条。

修复（两层）：
1. `WebviewWindowBuilder::background_color(Color(0,0,0,0))` + `window.set_background_color(Some(Color(0,0,0,0)))`（WebView 背景）；
2. macOS `make_window_transparent`：`NSWindow.setOpaque(false)`、`setHasShadow(false)`、`setBackgroundColor(clearColor())`，在创建后与显示前各调用一次。

## 3.19 展开居中 + 内存记住用户调整（2026-11-19 18:2x）

用户要求：点击球后面板/看板在屏幕正中央按屏幕比例显示；球位置不影响展开位置；用户调整过的位置/大小仅在本次运行内记住，重启恢复默认。

实现（壳 Rust）：
- `default_expanded_frame`：对话默认 `46% × 86%`、看板默认 `90% × 82%`（逻辑像素、按当前显示器居中）。
- `set_window_mode`：展开位置不再使用球锚点；有内存 frame 用内存，否则默认居中；收起恢复球位置。
- `expanded_frames: Mutex<HashMap<mode, frame>>`：`Moved`/`Resized` 时记录当前展开窗口的 frame（用户拖动/缩放后保留，切对话/看板各自保留）；进程重启即清空。
- `save_window` 只在球态写 `window.json`：面板/看板不持久化，重启默认居中；球位置保留上次拖动。

探针回归（`native-ipc-probe`）：`1840,952 56×56 → 518,76 884×929 → 96,98 1728×886 → 518,76 884×929 → 1840,952 56×56`（居中、比例、切模式保留、球恢复）。

## 3.20 展开后键盘焦点（2026-11-19 18:4x）

用户反馈：点球展开后第一次 ESC 无效，必须先点一下对话框。

原因：点球展开时窗口尺寸/位置变更，窗口/WebView 没有拿到键盘焦点；点击面板后窗口成为 key，ESC 才进入页面。

修复：
- 壳：展开时 `set_focus()` 后延迟 150ms 再聚焦一次（窗口尺寸变更后系统可能重排）。
- 窗口页：展开后 220ms 自动聚焦输入框（`inputRef.focus()`），保证键盘事件进入 WebView。

## 3.21 重启后球消失（2026-11-20 09:3x）

用户反馈：有时重启后应用外悬浮球不见了。

检查现场：`nativeShell:"running"`、`window.json` 记录 `x=995, y=1610`（逻辑坐标），超出当前屏幕可见范围 —— 球被创建在屏幕外，所以“存在但看不见”。原因通常是上次把球拖到外接屏/屏幕边缘，重启后显示器顺序或连接变化，保存的坐标越界。

修复：
- `create_window` 与 `set_window_mode('ball')` 都用 `clamp_ball_position`：中心点落在任一当前可见显示器内才沿用，否则回主屏右下；再夹到安全边距。
- `default_ball_position_handle` 用 `AppHandle` 计算主屏右下。

## 3.22 重启后球固定在主屏（2026-11-20 10:3x）

用户提供 `startup.json`：`{"visible":true,"pos":[1990,3220],"size":[112,112],"scale":2}` —— 物理坐标 (1990,3220) 对应逻辑 (995,1610)，超出主屏可见高度；`clamp_ball_position` 因外接屏/虚拟屏的显示器列表误判为“可见”，球落在屏幕外。

修复：`create_window` 不再读取 `window.json` 的旧球坐标，启动时固定用 `default_ball_position`（主屏右下）；运行中拖动/收起仍用内存 `ball_pos` 并 clamp。重启后面板/看板默认居中，球固定主屏右下。

## 3.23 拖动后出现多个球（2026-11-20 14:1x）

用户反馈：拖动球之后出现多个悬浮球。

原因：supervisor 的 `exit` 与心跳超时都可能调用 `scheduleRestart`，且没有防重入；旧壳进程在重启时也没有被显式 kill。一次异常导致多次 `launch()`，多个壳进程各自显示一个球窗口（父 PID 都存活，所以不会自动退出）。

修复：
- `scheduleRestart` 在已有 `restartTimer` 时直接返回（防重入）；
- `launch()` 前 SIGKILL 旧 child；
- 旧 child 的 `exit` 事件只处理"当前 child"，避免旧进程退出触发二次重启；
- 壳侧新增单实例锁 `shell.pid`（存活则退出）；Host supervisor `start()` 前清理旧锁，避免旧 Host 的锁阻塞新壳。

## 3.24 点击面板后球消失 → 球窗口常驻 + 独立面板窗口（2026-11-26 09:1x）

用户反馈：应用外的悬浮球点击后出现对话框，但球同时消失；期望球常驻。

原因：壳是**单窗口两态**（`main` 窗口在 56×56 ↔ 420×660 间 resize/移动），打开面板必然把球窗口变成面板，球视觉上消失。

修复（契约 `docs/architecture/native-shell-contract.md` v0.2）：

- 壳改为**双窗口**：`main`（球，56×56、透明置顶）常驻；`panel`（面板，默认 `visible:false`，展开时 show + focus，收起时 hide）独立存在。`CloseRequested`：球窗口 = 退壳；面板窗口 = 收起。
- 窗口页按角色加载：球窗口 URL 追加 `role=ball`，面板窗口追加 `panel=1&role=panel`；`window-page.ts` 只接受合法 role 并写入 `__COMMANDER_SHELL__.role`，缓存按角色区分。
- Client：`window-role.ts` 的 `showsPanel(role, expanded)` 决定渲染——球窗口恒球、面板窗口恒面板、无 role 保持旧同窗两态（浏览器调试不受影响）。
- capability `windows` 增加 `panel`，否则面板窗口的 `invoke('set_mode')` 会被 ACL 拒绝。

验证（本次全部实跑）：

- `pnpm --filter dsh-commander typecheck` 通过；全量单测 **434/434**（新增 `window-page` role 透传/缓存、`window-role` 渲染决策）；client harness `smoke 51/51 + interact 195/195`。
- `pnpm --filter dsh-commander build:native` → release 构建成功（53.68s），产物写入 `packages/dsh-commander/native/dist/darwin-arm64/`。
- `node tools/dev/native-ipc-probe.mjs` **PASS**：window urls 同时出现 `?token=ipc&role=ball` 与 `?token=ipc&panel=1&role=panel`；12 次 `window/bounds` 全部 `56x56` 且坐标不变（球窗口在 panel/board/panel/ball 切换中不动）；`invoke('panel'|'board'|'panel'|'ball')` 全部 ok。
- `node tools/dev/native-shell-smoke.mjs` PASS；`node tools/dev/native-window-probe.mjs` PASS（真实窗口 bundle 执行并请求数据面）。
- `node packages/dsh-commander/tests/e2e/m4-e2e.mjs` **10/10 PASS**。
- 视觉：`tests/artifacts/m4/shots/window-panel.png`（本地生成，含桌面内容，**不入库/不外发**）——面板窗口打开时右下角球窗口仍在，徽标可读。

部署：壳二进制 + Client 窗口 bundle 均变 → `pnpm --filter dsh-commander build && pnpm --filter dsh-commander build:native`，然后**重装 + 重启 DSH**（安装是快照式）。

## 4. 未验证 / 边界（如实标注）

1. **窗口视觉/热键/拖动**：需用户安装后真机走查；当前沙箱不能写 `~/Library/WebKit`，只能证明 WebView 加载与 JS 执行。
2. **壳内审批**：单测覆盖接管/回落/超时/取消；真实 waterfall 与 DSH 主窗并存的排他行为需真机验证。
3. ~~DSH 页内浮球未互斥~~：已实现（壳 running 隐藏页内球）；壳停止时自动恢复。
4. **未签名**：本地 `file:` 安装可运行；对外分发需 ad-hoc/Developer ID。
5. **m23 e2e 的 3 条 INFO**（stale 时钟、审批 pending 注入、live 走查）仍沿用既有口径，未因本轮改变。

## 5. 安装（用户终端）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm --filter dsh-commander build
pnpm --filter dsh-commander build:native
dsh plugin --profile desktop remove dsh-commander
dsh plugin --profile desktop add /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
# 重启 DSH
```

预期：桌面出现蓝色悬浮球；Option+Space 切换；点击展开面板；`GET /commander/health` 出现 `nativeShell:"running"`。
关闭壳：启动 DSH 前设 `DSH_COMMANDER_NATIVE_SHELL=0`（P2 做设置页开关）。
