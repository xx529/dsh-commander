# DSH Commander · 同类插件与技术路线调研

> 日期：2026-11-16　调研方式：本地克隆精读源码 + 官方文档 + 运行时观察
> 详细笔记：`research/notes/jarvis.md`、`stardeck.md`、`kanban-commander.md`、`float-tech.md`、`dsh-capabilities.md`
> 目标：回答三件事——**别人做到哪一步、哪些能抄、我们必须自研什么**。

---

## 1. 结论先行

1. **没有现成插件同时满足四条核心能力。** 最接近的组合是：贾维斯（桌面悬浮窗 + 审批）× Super Kanban（任务看板）× stardeck（指挥链编排）× lxl-commander（跨进程委派协议）——四者各缺一块，且互相没有打通。
2. **"全局悬浮球"必须有自己的原生壳。** DSH 官方插件体系里，Host 插件跑在 Node 进程无 GUI，Client 插件最远只到 DSH 页面内的 `shell.overlay`（切走应用就消失）。macOS 上唯一可行路径是「Host 插件 + 原生 GUI 进程」，参考贾维斯（Swift）或 quorfloat（Tauri）。
3. **"指挥官不干活"要靠机制而不是提示词。** stardeck 的教训：只靠 prompt 约束会被越权；权限必须落在**状态门 + 身份门 + 工具白名单**上。
4. **任务看板应当"派发即建卡"，而不是"扫日志反推"。** Super Kanban 的被动提取适合事后归档；指挥官是主动编排，字段在派发时就齐全，日志扫描只用来补进展与证据。
5. **委派协议抄 lxl，UI 与看板抄 Super Kanban/stardeck，悬浮窗抄贾维斯/quorfloat，跨工作区派生自研。**

---

## 2. 样本矩阵

| 样本 | 形态 | 全局悬浮 | 任务看板 | 委派执行 | 审批 | 关键价值 |
|---|---|---|---|---|---|---|
| **贾维斯** dsh-harness-jarvis | Swift NSPanel + Host 插件 | ✅ 跨 Space/全屏 | ❌ | ❌（只有自身会话） | ✅ 竞答 | 悬浮球与审批链路的最完整实现 |
| **quorfloat** | Tauri sidecar | ✅ 大面板 | ❌ | ❌ | ✅ | stdio NDJSON JSON-RPC 协议范本 |
| **dsh-float** | Electron（Win） | ✅ | ❌ | ❌ | ❌ | loopback token 鉴权的安全范本 |
| **petpal** | Swift 宠物 | ✅ | ❌ | ❌ | ❌ | macOS 窗口行为最正确的样本 |
| **selection-tools** | Win32 FFI | ✅ | ❌ | ❌ | ❌ | 证明 Host 插件起不了置顶窗；反例：无鉴权 HTTP |
| **dsh-desktop** | Tauri 桌面壳 | ✅ | ❌ | 多代理平铺 | 仅通知 | 桌面壳 + 浏览器通知的取舍 |
| **Super Kanban** | Host + Client 插件 | ⚠️ 仅 DSH 内 | ✅ 4 列 9 视图 | ❌ 只填草稿 | 待审批条 | 任务模型、待处理聚合、浮窗交互 |
| **stardeck** | Host + Client 插件 | ⚠️ 仅 DSH 内 | ✅ 三列 + 调度条 | ✅ 征召会话 | 人工验收门 | 指挥链、生命周期、治理门 |
| **lxl-commander** | Codex MCP 插件 | ❌ | ❌ | ✅ 跨进程 | 权限转发 | 委派协议与幂等语义 |

---

## 3. 可直接借鉴（按优先级）

### 3.1 悬浮层：借贾维斯 + quorfloat

- **窗口**：`NSPanel(.nonactivatingPanel)` + `level = .statusBar` + `collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`，`LSUIElement`/Accessory 不出 Dock；单实例 pidfile。
- **两层窗口**：一个固定尺寸球体窗口（`ignoresMouseEvents`，点击穿透）+ 一个动态尺寸 overlay（输入条/卡片/播报），按内容 union 矩形。
- **通信**：优先 stdio NDJSON JSON-RPC（`hello/ready`、`ping`、能力表、1 MiB 帧上限），避免端口/token/CORS；独立安装时退回 loopback + per-launch token + epoch。
- **审批**：Host 侧 `ctx.on('approval/request', h, {prepend:true})` 抢先拿到，与主窗口 `next()` 并发竞答，先 settle 者生效；壳不可见时不抢。
- **播报**：第一版壳内气泡 + 托盘角标（零权限）；后续 macOS 通知需签名 bundle。

### 3.2 看板：借 Super Kanban + stardeck

- 任务模型字段：`goal{text,status,source}`、`sessions[] + primarySessionId`、`attention`、`acceptanceCriteria`、`completionBasis`、`history`、`lockedFields`。
- 「待处理」= 多类信号拍平 + rank，其中**待审批/待回答可直接取自 DSH 原生 `pendingInteraction.kind`**（零成本）。
- 卡片可追溯：每条进展带 `seq` 证据，点击跳回会话第 N 条事件。
- 交互：四/五列独立滚动、每列 30 张、完成列可折叠仍可拖入；待审批条钉在入口上方、只有点对号才算确认、`reviewSeen` 防重。
- stardeck 的「四段生命条 + 收件箱老化 + 到访摘要」是 AFK 场景的最小可用人机接口，值得抄。

### 3.3 委派协议：借 lxl-commander

- 每轮注入**短执行约定 + 强制结构化报告**（outcome/summary/changedFiles/checks/unresolved/decision），严格解析，失败打 fallback 标记，绝不当成功。
- `requestId` 幂等 + 指纹比对；`resultVersion` 做已读确认；`waitFor: actionable`（只有轮次结束/待权限/超时才唤醒指挥官）；`waiting_permission` 是一等状态；同目录串行、路由冻结；崩溃只标 interrupted，不重放写操作。

### 3.4 治理：借 stardeck 的三道门

1. **状态门**：只有 `reported/review` 状态才能被验收。
2. **身份门**：只有主会话（指挥官）能改任务状态；worker 只能提交报告。
3. **默认关的自动化**：不自动验收；不默认自愈重放。

---

## 4. 必须自研

| # | 能力 | 为什么没有现成的 |
|---|---|---|
| 1 | **DSH 内跨工作区派生会话** | Super Kanban 只读不写；lxl 从进程外创建；我们要在 Host 插件内按 workspaceId 派生会话并注入 brief |
| 2 | **指挥官 ↔ 执行会话的五种动作语义** | 派发 / 追问 / 打断 / 升级 / 验收，以及它们在会话事件流中的落点 |
| 3 | **指挥视角的悬浮层信息架构** | Super Kanban 的浮窗是"任务四桶"，我们要的是"此刻要你做什么" |
| 4 | **任务状态机与 DSH 事件的映射** | 现有项目要么不驱动会话，要么用手写 JSON 报告 |
| 5 | **多工作区调度与并发策略** | 参考项目都没有"按 workspace 分派 + 汇总"的调度器 |
| 6 | **看板持久化与多窗口一致性** | 建议 Host 单写者 + state.json 原子写 + events.jsonl 追加 |

---

## 5. 推荐架构

```
┌─ DSH 进程 ───────────────────────────────────────────┐
│ Host 插件（commander）                                │
│  ├─ 指挥官会话（特殊 DSH session，自带工作区）         │
│  │    · 澄清/拆解/派发/跟进/汇报                       │
│  │    · 工具：task_* / delegate / briefing / board_*   │
│  ├─ 任务账本（state.json 原子写 + events.jsonl 追加）  │
│  ├─ 会话驱动（创建/复用、prompt、事件订阅、审批拦截）   │
│  ├─ 调度器（按工作区串行、全局并发上限、催办巡检）      │
│  └─ webServer：/commander/*（壳的数据面，兜底）        │
└───────────────┬──────────────────────────────────────┘
                │ stdio NDJSON JSON-RPC + loopback token
┌───────────────▼──────────────────────────────────────┐
│ 原生壳（macOS Swift / 跨平台 Tauri）                  │
│  · 悬浮球 NSPanel（跨 Space/全屏/点击穿透）            │
│  · 指挥面板（聊天 + 任务卡 + 审批卡）                  │
│  · 全局热键、托盘、边缘收起                            │
│  · 播报气泡（后续系统通知）                            │
└──────────────────────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │ DSH Client 插件 │  看板页签 + DSH 内浮层（降级入口）
        └────────────────┘
```

**分层原则**：壳只负责呈现与输入；Host 是唯一事实源；DSH Client 侧是**同源的降级入口**，不是第二套实现。

---

## 6. 关键取舍

| 决策点 | 选择 | 理由 |
|---|---|---|
| 壳技术 | macOS 先 Swift，跨平台再 Tauri | Swift 窗口行为最可控、体积最小；Tauri 的 Space 行为仍要手写 |
| 壳↔Host 通信 | stdio JSON-RPC 优先，HTTP 兜底 | 无端口/token/CORS；HTTP 给"壳独立安装/远程"留口 |
| 审批竞答 | Host 单一裁决点 | 避免双端各答一半 |
| 任务来源 | 派发即建卡，扫描只补证据 | 主动编排需要字段齐全；扫描适合兜底 |
| 自动验收 | 不做 | stardeck 实测机械全绿≠做对；人工门是产品承诺 |
| 执行者 | 顶层会话，非 subagent | stardeck 实证：子代理写权限根继承会破坏工作区隔离 |
| 与会话数 | 任务级会话 + 复用 | 每命令一会话会膨胀（stardeck 教训） |

---

## 7. 风险与未验证项

- 🔶 **待验证**：Host 侧是否有等价 `session/create` 服务，还是只能 Client 侧发起（影响"指挥官在后台自动派发"是否可行）。
- 🔶 **待验证**：DSH 原生 subagent 是否限同一工作区；跨工作区是否必须新建顶层会话。
- 🔶 **待验证**：`openSession(sessionId)` 跨工作区是否自动切换工作区。
- ⚠️ 原生壳代价：多进程守护、IPC 鉴权、签名公证、双 UI 栈、多屏/Space/全屏测试矩阵。
- ⚠️ 事件风暴：必须合并 + 节流 + 优先级，否则播报会毁掉信任。

---

## 8. 来源

- 贾维斯：https://github.com/（本地克隆 `research/jarvis`，0.7.1）
- quorfloat：https://github.com/Azetus/dsh-quorfloat
- dsh-float：https://github.com/18840024879/dsh-float
- petpal：https://github.com/flowers-59f/dsh-petpal
- selection-tools：https://github.com/fyisgod/dsh-selection-tools
- dsh-desktop：https://github.com/FuqiangCraft/dsh-desktop
- Super Kanban：https://github.com/topmindspace/dsh-super-kanban
- stardeck：本地克隆 `research/stardeck`
- lxl-commander：https://github.com/lxl8182/dsh-commander
- DSH 插件文档：`@deepseek-ai/dsh-agent-preset/skills/dsh-doc/references/`

---

## 9. 附：DSH 插件能力边界（已核实，决定架构）

| 能力 | 结论 | 依据 |
|---|---|---|
| 应用内整页浮层 | ✅ `shell.overlay`（root 作用域、整层 click-through、条目自设 `pointer-events:auto`） | `dsh-client-ui-layout/src/client/index.ts:60-121` |
| OS 级悬浮球 | ❌ 必须原生壳（改 `app.asar/lib/main.js` + preload） | `main.js:20261-20274`；Host 是 `ELECTRON_RUN_AS_NODE` 子进程 |
| 编程创建会话并跑 prompt | ✅ `ctx.sessionController.create → selectModel → prompt → cancel` | `dsh-api-session-controller/src/index.ts:306-522` |
| 定时调度 | ✅ `ctx.schedule.create`（最小 60s，Host 需常运行） | `dsh-schedule` 文档 |
| 审批双处处理 | ✅ 同一 `PendingApproval` 双处渲染；❌ 双 answerer | `dsh-client-ui-approval/.../contract/slots.ts:140-185` |
| Host→Client 实时推送 | ✅ 自建 webServer 路由 + SSE；❌ 新增 `$on` 事件 | `dsh-api-remotes/src/remote-events.ts:27-58` |
| 插件持久化 | ✅ `storageDomain`；❌ 会话日志新事件类型 | `references/practices.md:21` |
| 跨插件协作 | ✅ `ctx.provide/inject`、`ctx.tools.execute` | `cordis-api/context.md:286-314` |

**对本项目的三个硬约束**：
1. 悬浮球必须有原生壳；`shell.overlay` 只能做 DSH 内降级入口。
2. 审批只能用"同一实例双处渲染"，不能注册第二个 answerer。
3. 看板状态必须走 `storageDomain`，实时推送走自建 SSE 路由。

---

## 10. 附：Jev 决策模型（派发判定的选型依据）

指挥官需要"派到哪个工作区、新会话还是附加"的判定。调研发现生态里已有成熟的决策模型接入：

| 方案 | 说明 | 证据 |
|---|---|---|
| **TypeSafe Jev** | 带概率/置信度的类型化决策服务，`api.typesafe.ai` | `research/awesome/README.md:3551`、`:853` |
| **TokenRhythm NeoHorse-Jev** | 另一个 Jev 决策提供方 | `research/awesome/README.md:3551` |
| **OpenAI Decisions** | 通用决策接口 | `research/awesome/README.md:3551` |
| **本地 System One** | 本地决策端点 | `research/awesome/README.md:3551` |
| **dsh-decide** | DSH 插件：decide / gate / rerank / judge 工具 + 设置页，key 存 credential store，支持上述多家 | `research/awesome/README.md:3551` |
| **dsh-jev-advisor** | 在 DSH 多选题里给 Jev 建议、概率、置信度、接近警告 | `research/awesome/README.md:853` |
| **dsh-jev-mode** | JEV 决策模式，含桌面凭据设置 | `research/awesome/README.md:3859` |

**结论**：不重复造决策协议。指挥官内部封装一个 `JevProvider` 接口（provider / endpoint / model / key / timeout），默认对接 TypeSafe Jev，兼容 dsh-decide 的判定语义；阈值门控与确认卡由指挥官自己实现。

### 10.1 对本项目的影响

1. Jev key 与端点属于**设置页**内容，不是硬编码。
2. 判定输出需要 `ranked choices + confidence + reasons`，UI 才能展示"建议 + 备选 + 置信度"。
3. Jev 超时/失败必须可降级（暂停询问 / 用模型判断），不能阻塞派发链路。
4. 与 Super Kanban 无任何数据或能力对齐；本项目只参考其看板信息架构。
