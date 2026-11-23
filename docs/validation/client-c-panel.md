# 指挥官面板 C 方案（处理抽屉 + 新悬浮入口）实现记录

- 日期：2026-11-19
- 范围：`packages/dsh-commander/src/client`（`Overlay.tsx` / `styles.ts` / `locales.ts` / `DispatchCard.tsx` / `ApprovalFloat.tsx`）+ client harness
- 性质：纯 Client 改动；未改 Host，未改 `/commander/*` 线格式，未改派发/审批语义

## 1. C 方案落点（逐项核对）

| 视觉块 | 数据来源 | 缺省/边界 |
|---|---|---|
| 面板头部 | `panel.title` + 看板/关闭 | 不再放状态 pill、模型、待处理 chip |
| 状态条 | `commanderStatus`、`binding.sessionId`（短 id）、`counts` / `tasks` 状态、`connection` | 没有「指挥官会话标题」字段；只显示短 id，不伪造标题 |
| 指挥状态浮层 | 绑定（会话 id / 工作区 / 模型 / 连接）+ 任务列表 + 连接 | 点击状态条打开；未绑定显示 `status.unbound` 与绑定提示 |
| 对话区 | `messages` + `busy` | 只放消息和系统卡片；派发/审批卡不再进 `.dshc-panel-body` |
| 协议消息 | `[dispatch-confirm]` 用户消息 | 渲染成默认折叠的「决策记录」（动作/目标/时间），点开才看原始协议文本；不再当普通蓝色气泡 |
| 派发等待条 | `dispatchSent` + `actionSent` | 只在等 Host 回执时显示；中性背景 + 成功色文字的短 chip，不用高饱和绿横幅；pending 清空即消失 |
| 处理抽屉 | `pendingDispatch` + `pendingApprovals` | 新 pending 派发自动展开；审批只更新 FAB/球角标，不自动弹层 |
| 待处理 FAB | 可操作数 = 未发送的 pending 派发 + 待审批数 | 抽屉打开/无待处理时隐藏；位于输入框上方 |
| 抽屉里的派发卡 | `PendingDispatchView` | 复用 `DispatchConfirmCard`；`compact` 时候选目标折进 `<details>`，主信息与操作仍可见 |
| 抽屉里的审批卡 | `PendingApproval`（官方实例） | 复用 `ApprovalFloatCard`；平铺全部、隐藏队列翻页与 disabled「总是允许」；只保留 打开会话/拒绝/允许 |
| 悬浮球 | 角标 = 可操作总数（否则回退 review/blocked 计数）；`connection`；`busy` | 去掉红 badge/常驻绿点/深色外描边；琥珀计数；仅连接降级时出琥珀点；忙时脉冲 |
| 球 hover 标签 | 指挥官 + 可操作数/等待指令/处理中/连接文案 | 面板打开时隐藏；球拖到左侧时标签自动换到右侧 |
| 抽屉高度 | — | 80%（生产卡片比原型高；74% 时审批操作会被裁掉） |

## 2. 交互与契约边界

- **派发先确认**：新 `pendingDispatch` 自动开面板 + 抽屉；卡上操作仍只通过 `POST /commander/message` 发 `[dispatch-confirm]`。
- **审批只在界面层**：只读官方 `sessionStatus.pendingInteraction`，`answer()` 前走 `answerable` 守卫；抽屉脚注明确「不进入指挥官上下文」。不自动弹抽屉，避免打断对话；球角标/FAB 提示。
- **候选折叠**：抽屉里的派发卡默认折叠候选行（`<details>` 可展开），避免遮住审批操作；卡片仍显示建议目标、置信度、阈值、原因与三个操作。
- **审批平铺**：C 的抽屉里所有待审批卡平铺，`showQueue={false}`；移除原先 disabled 的「总是允许」（当前只支持允许本次/拒绝，官方卡内处理总是允许）。
- **状态条不造数据**：快照没有指挥官会话标题，生产显示 `已绑定 · …sess_1`（短 id）；绑定 id/工作区/模型/连接在浮层里展开。任务没有 `progress.pct` 字段，只用状态计数，不显示假进度。
- **抽屉自动收起**：Host 清空 `pendingDispatch` 且审批为 0 后 900ms 收起；派发已发送、等 Host 回执期间保持打开并显示等待行。
- **悬浮球计数**：`deriveCommanderBadge` 的 kind 继续用于颜色/标题，但显示数字改为可操作总数（与 FAB/抽屉一致）；没有可操作项时回退 review/blocked 计数。
- **i18n**：新增 C 的状态条/浮层/抽屉/球标签/短连接文案，zh/en 两份字典同改；`locales.test` 通过。
- **样式**：全部走 DSH `--dsw-alias-*` token；球用品牌色渐变 + 内高光，badge 用 `state-warn-primary`；无外部资源。

## 3. 验证

- `pnpm --filter dsh-commander typecheck` → PASS
- `pnpm --filter dsh-commander test` → **258/258 PASS**
- `pnpm --filter dsh-commander build` → PASS（`lib/client.js` 326,797 B）
- `DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules node packages/dsh-commander/tests/client/harness/run-harness.mjs` → **smoke 43/43 + interact 160/160 PASS**
  - 新增 C 断言：FAB 打开抽屉、审批卡不在 transcript、抽屉脚注、状态条→指挥状态浮层、球标签存在且无旧状态点、候选折叠 disclosure、审批卡无 disabled「总是允许」、zh 抽屉文案。
- 本地浏览器渲染（真实 `Overlay.tsx` + 假 store + 近似 DSH token，不是 live 走查）：
  - 抽屉（派发卡 + 审批卡，审批操作可见）：![C 抽屉](./assets/client-c-panel-sheet.png)
  - 收起抽屉后的纯对话 + 决策记录 + 待处理 FAB：![C 对话](./assets/client-c-panel-chat.png)
  - 派发等待条（只在等回执时出现，中性 chip 而非绿色横幅）：![C 等待条](./assets/client-c-waiting.png)
  - 新悬浮球 hover（品牌蓝 / 琥珀计数 / 文字标签）：![新悬浮球](./assets/client-c-ball-hover.png)
- 未覆盖：live DSH 真实 token、明暗主题、窄窗口、真实审批/派发数据；需要用户硬刷新后走查。

## 4. 部署

纯 Client 改动：`pnpm --filter dsh-commander build` 后**硬刷新**（Cmd+Shift+R）即可；不需要重装插件或重启 DSH。若 live 仍显示旧面板，再按仓库流程重装快照并重启。
