# 原型 v3（修订）· DSH 指挥官（DSH 内嵌形态）

OpenDesign 生成的高保真桌面原型，1440×900，六屏。一期只存在于 DSH Web GUI 内部。

## 打开

- 本地：直接双击 `prototype/app/index.html`（依赖同目录 `styles.css` / `app.js`）。
- 主题：右上角「浅色 / 深色 / 跟随系统」，默认深色。

## 六屏

| 屏 | 内容 | 可交互 |
|---|---|---|
| **工作台** | DSH 界面（侧栏、会话、对话流、输入框）+ 悬浮球 + 审批卡（含「打开会话」）+ 播报 + 球体状态 | 点球进面板；审批允许 / 打开会话 |
| **指挥面板** | 对话 → Jev 派发确认卡（62%、阈值 80%、3 候选、原因）→ **自定义选择**（工作区 + 新建/已有会话）→ 成功态 + Jev 91% 自动派发条 | 采用建议 / 自定义选择 / 确认派发 |
| **看板** | 五列：待派发确认 / 进行中 / 受阻 / 待验收 / 已完成；只有任务，无审批/提问；hover 只有「打开会话」 | 筛选、进详情、人工改动 toast |
| **任务详情** | 概览 / 决策记录 / **验收内容（指挥官整理）** / 关联会话 / 时间线 / 交付物 | 滚动、关闭 |
| **设置** | 指挥官（会话绑定、模型、能力面板入口）/ **工作区（白名单 + 摘要）** / 派发与 Jev（环境变量 Key、阈值、并发说明、判定输入）/ 看板 / 外观 / 关于 | 子导航、下拉、滑块、开关 |
| **组件** | DSH 明暗 token、按钮、pill、任务卡、派发卡、审批卡（带打开会话）、输入区、设置控件 | —— |

## 本轮（v3）关键表达

1. **职责边界**：指挥官不拆分工作、不评估结果；工作会话只产出与汇报，指挥官整理成验收内容并更新看板，人只做确认。
2. **派发可自定义**：确认卡除「采用建议」外，可展开选工作区 + 选已有会话/新建会话，记录为 override。
3. **审批可跳转**：审批卡有「打开会话」，且仍然只在界面处理、不进指挥官上下文。
4. **工作区可控**：白名单勾选 + 每个工作区摘要（人工编辑 / 模型生成），摘要进入 Jev 判定输入。
5. **指挥官可重绑**：设置里显示当前工作区 + 会话，支持「绑定到新会话 / 选择已有会话」。
6. **能力复用**：不重复列工具白名单，改为「打开能力面板」跳转 DSH 能力设置。
7. **Jev**：API Key 支持环境变量（推荐）或手动填写；删除并发上限/同工作区串行，改为固定说明「不同会话并行、同一会话排队」。
8. **看板无催办按钮**：是否追问由指挥官策略决定，不由用户手动催。
9. **能力策略两档**：继承工作区 / 自动选择；指挥官只出能力需求建议；自动选择完全调用 DSH 能力面板的 jev.rank/apply，只对本次会话生效；派发卡展示结果摘要。

## 设计令牌（DSH）

```
浅色  bg #FFFFFF / module #F5F6F7 / card #FAFAFA
      text #0F1115 · #61666B · #81858C
      border rgba(0,0,0,.10)
深色  bg #151517 / module #232324 / card #212123
      text #F9FAFB · #CFD3D6 · #ADB2B8
      border rgba(255,255,255,.12)
语义  brand #4176E6 · success #22C55E · warning #F59E0B · danger #EF4444 · violet #A78BFA
圆角  4 / 8 / 12 / 16 / 20 / 28
动效  0.2s cubic-bezier(.4,0,.2,1)
```

## 截图

| 文件 | 说明 |
|---|---|
| `shots/v3-final-1-workbench.png` | 工作台 + 悬浮球 + 审批卡（打开会话） |
| `shots/v3-final-2-panel.png` | 派发确认卡 |
| `shots/v3-final-2-panel-custom.png` | 自定义选择展开 |
| `shots/v3-final-2-panel-custom-mira.png` | 切到 Mira 后能力策略联动 |
| `shots/v3-final-2-panel-done.png` | 自定义派发成功态 |
| `shots/v3-final-3-board.png` | 看板（深色） |
| `shots/v3-final-3-board-light.png` | 看板（浅色） |
| `shots/v3-final-3-board-1280.png` | 1280 宽 |
| `shots/v3-final-4-detail.png` | 任务详情（指挥官整理验收） |
| `shots/v3-final-4-detail-bottom.png` | 任务详情 · 时间线（指挥官整理并更新任务板） |
| `shots/v3-final-5-settings-commander.png` | 设置 · 指挥官会话绑定 |
| `shots/v3-final-5-settings-workspace.png` | 设置 · 工作区白名单、摘要与能力策略 |
| `shots/v3-final-5-settings-jev.png` | 设置 · 派发与 Jev |
| `shots/v3-final-5-settings-jev-input.png` | 设置 · 判定输入 |
| `shots/v3-final-6-components.png` | 组件与 token |

## 已知限制

- 一期不做系统级悬浮；球只在 DSH 页面内可见。
- 面板消息区可滚动；初始聚焦派发卡，自定义时收起候选列表，派发后展示完整对话。
- 审批卡为窄版，短标签「总是允许」；完整语义「本工作区总是允许」在文档中说明。
- 数据为示例（HtDot / Mira / Live），不含真实 token 或内部信息。

## 另见

- `panel-redesign/`：2026-11-18 指挥官面板交互重设计（A/B/C 三方案，**C 为默认**：动作坞 / 双栏收件栏 / 处理抽屉），含悬浮球重做；`?variant=A|B|C`、`?ball=ink`。
- `task-detail/`：2026-11-18 任务详情抽屉 A–D 方案（D 编年审阅为生产基础）；`?variant=A|B|C|D`。
- `task-detail-multiround/`：2026-11-19 多轮任务详情设计（标题优先 + 轮次编年 + 用户原话/派发原文进时间线 + 继续派发 composer）；`?expand=1` / `?compose=1`，配套 `docs/architecture/m5-continue-dispatch.md`。
- `task-detail-materials/`：2026-11-20 多轮任务详情的「依据与材料」设计（结论下的链接 / 文档 / 图片、来源与未校验标记、验收项 chips、图片预览与文件动作单）；`?materials=all` / `?focus=materials` / `?lightbox=1` / `?sheet=1`。
- `task-detail-materials-per-item/`：方案 B · 每条验收项独立材料表（报告级材料块移除，材料跟着验收走）。
- `task-detail-materials-compare/`：方案 A（报告级）vs B（逐项）并排对比 + 取舍表 + 推荐 C（默认 A、逐项按需展开 B）。
