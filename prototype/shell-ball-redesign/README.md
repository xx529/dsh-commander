# 壳浮球 · 中心符号与推理状态气泡

> 2026-11-26 最终落地（v0.4）：**76×76 窗口 / 60px 液态金属球 / 8px 透明边**；working 银白卫星、完成 5s 文案后绿色脉冲；状态气泡与快捷输入统一烟熏铬玻璃。B 脉冲核心 / 四套材质 / 三种气泡是早期探索，保留在 `index.html`。最终实现与验证见 `docs/validation/native-shell-metal.md`，契约见 `docs/architecture/native-shell-contract.md` v0.4。

这轮解决两件事：

1. **旗标太突兀**。四套材质默认去掉中心图形，旗标只留在「现状」里做对照；另给五个可选符号，点一下就能套到四套材质上。
2. **推理过程看不见**。球旁边加一条状态气泡，显示「正在理解指令 / 正在创建任务 / 正在更新任务 / 任务已创建 / 更新失败」，并给出单气泡、气泡栈、打字气泡三种形态。

这是原型，不是生产代码。气泡跨出了球窗（当前 76×76 / 球 60；原型早期是 56×56），需要新增一个透明窗；Lite 版不需要 Host activity，activity 版仍是 P2，下面把边界写清楚。

## 最终落地（v0.4，2026-11-26；v0.5 气泡活动已落地）

- **球**：76×76 窗口、60px、8px 透明边；液态金属（银蓝 chrome conic、白色高光、近黑底、银色定向 rim；不透明、无 backdrop；边缘 mask 86/94 + blur 2px rim 光带）。
- **working**：银白卫星沿球缘环行（4.6s）；气泡展示当前活动（工具调用的 `description`、工具之间的 assistant 文本；无活动回退「正在思考」），不再放 spinner。v0.5 落地，验证见 `docs/validation/native-bubble-activity.md`。
- **完成**：气泡「已完成 · 点击球查看」约 5s → 绿色脉冲核心 + 双层绿色声呐未读；点击浮球/打开面板 ack；新回合 busy 重置；连接抖动保留；完成时面板已打开则直接确认。
- **快捷输入**：悬停 0.8s 唤起，复用 336×76 气泡窗；自动聚焦，Enter 发送、Esc 收起；空输入离开球收起，有内容保留；无 placeholder、无关闭按钮。
- **气泡/快捷输入材质**：烟熏铬玻璃 + 银色描边 + 顶部金属反光 + 镀铬 `>`/发送键。
- **未读方向** = 脉冲核心；**3D 材质** = 液态金属；对应原型 `unread.html` 与 `depth.html`。

生产验证：`docs/validation/native-shell-metal.md`、`docs/validation/native-bubble-activity.md`；历史 B/Lite 阶段：`docs/validation/native-pulse-bubble.md`。

## 打开

```bash
pnpm prototype:ball
# → http://127.0.0.1:4314/
```

或直接打开 `index.html`。纯静态，无构建、无外部依赖。

演示入口：

- 顶部工具栏切 **待机 / 悬停 / 思考 / 待处理 / 离线**、深/浅桌面、窗口边界。
- 「中心符号」点任意一张，应用到下面四套材质。
- 「状态气泡」底部按钮播放 **创建任务 / 更新任务 / 派发 / 失败 / 播放推理链**。
- 查询参数：`?demo=working|success|error|chain`、`?state=busy`、`?mark=core`、`?clip=1`、`?theme=light`。

## 硬约束

- **生产球窗固定 76 × 76**，球 60px、inset 8px；hover 1.055 后 63.3px，仍留 6.35px。`index.html` 的四套材质仍按早期 56×56 / 48px 展示，用于历史探索；最终材质与尺寸见 `depth.html` 与生产 CSS。
- **气泡放不进 76 px 球窗**。所以气泡/快捷输入是第二个透明窗，固定 336 × 76。
- 气泡窗 **click-through**，不抢焦点；球窗仍然负责点击、拖动、打开面板。
- 气泡窗的 12 px 内边距用来装阴影和尾巴；系统窗口阴影关闭，避免透明窗在桌面留色块。
- 零运行时依赖；`mask-composite` 用 `-webkit-mask-composite: xor` 兜底，WKWebView 可用。

## 中心符号

四个材质默认 **无符号**。点「中心符号」里的卡片可以换成核心点、三点、折角或环。

| 符号 | 感觉 | 忙时 | 适合 |
|---|---|---|---|
| **无符号** | 材质即身份，最干净 | 只靠材质动 | 默认推荐；气泡负责说话 |
| 核心点 | 一颗会呼吸的活点 | 呼吸加快 | 想要一个视觉焦点，又不想像图标 |
| 三点 | 推理中的三点 | 依次跳动 | 强调「在思考」，和打字气泡同源 |
| 折角 `>` | 命令符，比旗子抽象 | 向右轻推 | 想保留「命令」语义 |
| 环 | 瞳孔 / 准星 | 旋转 | 喜欢 HAL / 镜头感 |

推荐顺序：**无符号** 最稳，**核心点** 是折中，**折角** 是保留命令感的上限。

## 四套材质

材质本身不变，只把中心旗标去掉了：

| | 气质 | 记忆点 | 代价 |
|---|---|---|---|
| A 极光玻璃 | 克制、贵 | 内缘极光 + 指针高光 | 动态最轻 |
| B 脉冲核心 | 安静、设备感 | 中心冷核 + 声呐 | 深色桌面偏暗 |
| C 轨道信标 | 最辨识 | 双弧 + 轨道环 | 待机也在动 |
| D 液态棱镜 | 最张扬 | 液态冷光 + 虹彩边 | 最费 GPU |

## 状态气泡

### 三种形态

| | 结构 | 优点 | 代价 |
|---|---|---|---|
| **单气泡（推荐）** | 一条状态原地更新 | 最省空间，不挡桌面 | 看不到历史 |
| 气泡栈 | 最近三条，新的贴球 | 能看见一小段推理轨迹 | 气泡窗 76 → 172，占用更大 |
| 打字气泡 | 三点等待态，首个动作后换文案 | 回答「还在不在」 | 和单气泡共用窗口，只是首帧 |

单气泡的文案过渡：旧文案上移淡出，新文案从下 4 px 进入；图标从转圈切到勾/感叹号；成功 2.4 s 后收起，失败 5 s，新动作到来立即替换。气泡最短展示 600 ms，避免连续 tool 调用导致闪烁。

气泡里显示的示例：

- `正在理解指令` / `读取绑定会话`
- `正在创建任务` / `修复登录重试`
- `正在更新任务` / `调整优先级`
- `正在派发任务` / `Research · 新会话`
- `任务已创建` / `T-2048 · 待派发`
- `更新失败` / `版本已刷新，请重试`

### 位置与翻转

- 球在屏幕右半边：气泡在球左侧，尾巴指向右。
- 球在屏幕左半边：气泡翻到球右侧，尾巴指向左。
- 垂直方向与球心对齐；顶部/底部空间不够时夹到工作区内。
- 拖球时收起，落点后如果还有活动再出现；打开面板时收起，回到球态再恢复。
- 气泡窗贴边自动翻转；不覆盖球，也不挡球的点击区。

## 动效规格

| 动作 | 规格 |
|---|---|
| 气泡进入 | 180 ms，scale 0.96 → 1，translateX 6 → 0，opacity 0 → 1 |
| 文字切换 | 160 ms，旧文案上移 4 px 淡出，新文案从下 4 px 进入 |
| 图标切换 | 200 ms 弹入；转圈 1 s 线性；成功勾/失败感叹号 |
| 成功收起 | 2.4 s 后 160 ms 淡出 |
| 失败收起 | 5 s 后淡出；轻微 3 px 抖动一次 |
| 推理链 | 理解 0.8 s → 创建 1.0 s → 更新 1.0 s → 派发 1.2 s → 创建成功 → 收起 |
| 减弱动效 | `prefers-reduced-motion` 下全部停掉，只保留状态颜色 |

## 连接状态

球上不再放右下状态点。它和面板头 / 面板脚的文字重复，而且原生壳的球一直显示绿点、没有 tooltip；页内球反而只在 live 之外才显示。现在统一成：

- **live**：材质正常，不额外加点。
- **polling**：面板头琥珀点 + 脚注「轮询同步」；球体不额外加点。
- **offline / reconnecting**：球体整体去饱和并停动，面板头红/灰点 + 文字。
- 「现状」对照保留绿点，只用来看差别。

这也是纯 CSS：球节点不再渲染 `.dshcn-dot`，面板头的 dot 保留；生产给球节点加 `data-conn={view.connection}`，离线/重连时灰化并暂停材质动画。连接状态的文字出口一直在面板头（`connectionLabel`）和脚注里。

## 窗口架构

### 为什么要第二个窗口

球窗（当前 76×76；原型早期 56×56）只能放球。把气泡画在球窗里会被硬裁；把球窗扩大到 336 × 76 又会让整块透明区域拦截桌面点击。所以：

- **球窗**：76×76（当前；早期 56×56），球 60px，可点击、可拖动、置顶。
- **气泡窗**：336 × 76（堆叠 336 × 172），透明、无边框、置顶、`skip_taskbar`、`focused(false)`、`set_ignore_cursor_events(true)`。
- 气泡窗只负责显示，不接收鼠标；球窗仍负责打开面板。
- 面板打开时隐藏气泡；拖球时收起，落点后恢复。
- 气泡窗跟随球的位置；贴左边自动翻到右侧。

Tauri 2 已经支持 `WebviewWindow::set_ignore_cursor_events`，不需要用全局鼠标轮询做命中测试。面板窗口现有的 `shadow(false)`、`transparent`、`always_on_top` 模式可以复用。

### 需要改的位置

| 层 | 文件 | 改什么 |
|---|---|---|
| Native 契约 | `docs/architecture/native-shell-contract.md` | 新增 bubble window、role=bubble、尺寸/位置/翻转/click-through |
| Native | `native/tauri/src/main.rs` | 创建/定位/显示/隐藏气泡窗；`set_ignore_cursor_events(true)`；球移动时跟随；面板打开时隐藏 |
| Window 页 | `src/host/native/window-page.ts`、`src/client/window-role.ts` | 增加 `role=bubble`；窗口页按 role 渲染 |
| Client | `src/client/WindowApp.tsx`、`window-styles.ts` | `BubbleApp`；气泡样式；球体去旗标 + 中心符号层 + 去掉球上 `dshcn-dot`（面板头保留） |
| Client | `src/client/index.tsx` | 球体 slot 不变；气泡窗是独立页面，不占 slot |

球窗的改动很小：把 `.dshcn-flag` 的 CSS 背景块和内联 SVG 旗标删掉，换成可选的 `.dshcn-mark` 层；默认不渲染。状态点、角标、绑定态语义全部不动。

## 数据契约

这是这轮最重的部分。现在 Host 的 `commander-events.ts` 只处理：

- `turn/start` → busy
- `turn/end` → 空闲
- `assistant/message` → 消息

按 M0 契约，**tool / 进度 / chunk 被明确过滤**。所以「正在创建任务」不是 UI 自己编的，需要 Host 新增 activity 通道。

### 推荐事件

```ts
type CommanderActivity = {
  id: string
  phase: 'start' | 'end'
  kind: 'thinking' | 'tool' | 'success' | 'error'
  tool?: string          // commander_task_create
  label: string          // 正在创建任务
  detail?: string        // 修复登录重试
  ok?: boolean
  at: number
}
```

- SSE 事件 `commander.activity`；快照增加 `currentActivity` 和 `recentActivities`（最多 5 条），供气泡窗重连后恢复。
- 气泡窗连接同一套 `/commander/events`；球窗不需要 activity。
- 同一 tool 的 start/end 用 `id` 配对；连续调用时气泡按 600 ms 最短展示时间排队，成功/失败可立即覆盖。

### Tool → 文案

| tool | start | end ok | end error |
|---|---|---|---|
| `commander_task_create` | 正在创建任务 | 任务已创建 | 创建失败 |
| `commander_task_update` | 正在更新任务 | 任务已更新 | 更新失败 |
| `commander_task_dispatch` | 正在派发任务 | 派发完成 | 派发失败 |
| `commander_task_get` / `list` | 正在读取任务 | 已读取 | 读取失败 |
| `commander_task_report` | 正在更新任务进度 | 进度已更新 | 更新失败 |
| `commander_workspace_list` | 正在检查工作区 | 已读取工作区 | 读取失败 |
| `commander_workspace_update` | 正在更新工作区 | 工作区已更新 | 更新失败 |
| `commander_session_list` | 正在查找会话 | 已找到 | 查找失败 |

`detail` 优先取工具参数里的标题/工作区名，取不到就不显示第二行。`tool/call` / `tool/result` 的字段形状要先在隔离会话里探针确认，再写映射；仓库现有的 data-inventory 只证明了事件类型存在，没有样本形状。

### 两档落地

| | Lite | Full |
|---|---|---|
| 气泡文案 | 正在思考 / 本轮完成 | 每个 tool 的具体动作 |
| 数据 | 现有 `turn/start` / `turn/end` + `commander.status` | 新增 `commander.activity` |
| Host 契约 | 基本不动 | 要改 M0 契约与 implementation-plan |
| 观感 | 有气泡，但不知道在做什么 | 用户要的「正在创建任务」 |

如果这轮只想先看到球旁边的气泡，Lite 可以先上；Full 才是这轮描述的完整目标。

## 推荐组合

- **球**：A 极光玻璃 + 无符号。最稳，和面板气质一致。
- **气泡**：单气泡。最省空间，成功/失败自动收起。
- **最终选择**：液态金属 + 无符号 + 银白 working 卫星 + 绿色脉冲未读 + 金属单气泡（见上「最终落地」）；以下 B 脉冲核心为早期探索。
- **想要推理轨迹**：A + 气泡栈；但气泡窗会从 76 长到 172，桌面占用更大。

## 落地清单

1. **已落地（Lite）**：契约 v0.4；Native bubble 窗、悬停轮询、快捷输入、未读脉冲；Client `BubbleApp`、液态金属球、金属气泡；`docs/validation/native-shell-metal.md` 验证 452/452；live 重装 + 重启。
2. **已落地（v0.5，精简版）**：`commander-events.ts` 监听 `tool/call` 的 `description` 与 assistant 文本 → `commander.status.activity` / 快照 `commanderActivity`，气泡单行展示（40 字符 + `...`）。**未做**：`tool/result` 的成功/失败文案映射、气泡栈/推理链、`recentActivities`。

## 资产

| 文件 | 说明 |
|---|---|
| `shots/contact-idle.png` / `contact-busy.png` | 四套材质，无旗标、无右下点，待机 / 思考 |
| `shots/contact-busy.gif` | 四套材质思考态循环 |
| `shots/v2-marks-clean.png` | 五个中心符号 |
| `shots/v2-bubble-rows-clean.png` | 单气泡 / 气泡栈 / 打字气泡 |
| `shots/bubble-chain.gif` | 推理链：理解 → 创建 → 更新 → 派发 → 成功 → 收起 |
| `shots/v2-demo-clip-crop.png` | 球窗 + 气泡窗的边界示意 |
| `shots/v2-demo-success.png` / `v2-demo-error.png` / `v2-demo-light.png` | 成功 / 失败 / 浅色气泡 |
| `shots/strip-1x.png` | 1× 实际尺寸，现状 + 四套 |
| `shots/connection-state.png` | 离线态对照：现状保留红点，新方案靠灰化停动表达 |
| `shots/v3-clean.png` | 整页：去旗标、去右下点后的完整原型 |
| `shots/unread-options.png` | 未读提示 4 方向：现状 / 角标 / 信封核心 / 双环 / 卫星；最终选脉冲核心 |
| `shots/depth-options.png` | 3D 材质 3 方向：深空蓝玻璃 / 虹彩玻璃 / 液态金属；最终选液态金属 |

## 文件

```
prototype/shell-ball-redesign/
├── index.html          中心符号 + 四套材质 + 三种气泡 + 演示
├── styles.css          页面、球体、符号、气泡样式
├── app.js              球体/符号注入、状态机、气泡时序
├── unread.html / .css  未读提示 4 方向（最终选脉冲核心）
├── depth.html / .css   3D 材质 3 方向（最终选液态金属）
├── shot.mjs            整页截图（CDP）
├── record.mjs          四套材质逐帧录制
├── record-bubble.mjs   推理气泡演示录制
├── make-assets.py      四联材质图 + GIF 帧合成
├── cdp.mjs             坐标/表达式探针
├── shots/
└── README.md
```
