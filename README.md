# DSH Commander · 指挥官

> 跑在 DSH 里的 AI 指挥官：一句话下命令，它澄清、用 Jev 判定派发目标、交给合适的工作区会话、维护看板，并把工作会话的产出整理成任务与验收内容；只有派发置信度不足和最终验收才需要你拍板。

当前阶段：**产品设计 v1.8 + 原型 v3（DSH 内嵌形态）**（未开始编码）。

---

## 交付物

| 文件 | 内容 |
|---|---|
| [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) | 产品设计 v1.8：职责边界、Jev 派发、自定义目标、工作区白名单与摘要、指挥官整理验收、设置页、DSH 主题规格、数据模型、里程碑 |
| [`docs/NEXT-PHASE.md`](docs/NEXT-PHASE.md) | 下一阶段交接：V0 验证门禁、M0/M1 范围、验收标准、停止条件 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构设计 v2.4：最后回复注入触发、无投影的任务记录、指挥官工具与 Jev 预筛、任务状态机 |
| [`docs/eval/jev-dispatch-eval.md`](docs/eval/jev-dispatch-eval.md) | Jev 派发 50 案例评估方案（开发前门禁）与阈值校准 |
| [`research/RESEARCH.md`](research/RESEARCH.md) | 同类插件与技术路线调研总览：样本矩阵、可借鉴点、必须自研项、Jev 选型 |
| [`research/notes/jarvis.md`](research/notes/jarvis.md) | 贾维斯：Swift 悬浮窗、审批处理、会话托管、模型复用（766 行，含行号证据） |
| [`research/notes/stardeck.md`](research/notes/stardeck.md) | stardeck：指挥链角色、状态机、验收门、治理教训（429 行） |
| [`research/notes/kanban-commander.md`](research/notes/kanban-commander.md) | Super Kanban + lxl-commander：任务提取、看板模型、委派协议（604 行） |
| [`research/notes/float-tech.md`](research/notes/float-tech.md) | 系统级悬浮窗技术选型：Swift / Tauri / Electron / Win32 对比（390 行） |
| [`research/notes/dsh-capabilities.md`](research/notes/dsh-capabilities.md) | DSH 插件扩展点核对：槽位、会话、审批、调度、持久化（462 行） |
| [`prototype/README.md`](prototype/README.md) | 原型 v3 说明：六屏、交互、DSH 设计令牌、截图索引 |
| `prototype/app/` | 可交互原型源码（index.html / styles.css / app.js） |
| `prototype/shots/` | 六屏截图 + 浅色/1280/交互态 |

---

## 职责边界（本轮最重要的修订）

| 角色 | 做 | 不做 |
|---|---|---|
| **指挥官** | 澄清、派发、维护看板状态、**整理工作会话产出为验收内容并更新看板**、播报 | **不拆分工作、不评估**、不执行、不碰审批 |
| **工作会话** | 自己拆分工作、执行、交付、在会话里说明产出 | 不定义验收流程、不写清单、不维护看板、不做派发决策 |
| **Jev** | 对"派到哪个工作区/会话"给出带置信度的判定 | 不生成任务、不评估结果 |
| **你** | 低置信度派发确认（可采用/自定义）、审批、验收、人工改看板 | —— |

---

## 五个核心结论

1. **没有现成插件同时满足四条核心能力。** 最接近的组合是贾维斯 × Super Kanban × stardeck × lxl-commander；本项目与 Super Kanban **无任何数据或能力对齐**。
2. **一期做在 DSH 内部。** `shell.overlay` 做悬浮球与面板，看板做整页/侧栏 tab；系统级置顶留到二期原生壳。
3. **派发由 Jev 门控。** 模型只提候选，`dispatch_task` 调用 Jev 打分；置信度 < 80% 或判定不一致 → 不派发，返回 clarify；用户可采用建议，也可**自定义工作区 + 会话**。
4. **验收由指挥官整理、工作会话产出、人确认。** 指挥官不拆解、不评估，只把产出整理成清单与证据并更新看板。
5. **审批只在界面层。** 审批卡可「打开会话」，但不进指挥官上下文、不进看板、不落任务账本。

---

## 设计要点

- **工作区可控**：白名单勾选 + 每个工作区摘要（人工/模型），摘要进入 Jev 判定输入。
- **指挥官可重绑**：它本身是某工作区的一个 session，设置里可「绑定到新会话 / 选择已有会话」。
- **能力复用**：不重复列工具，跳转 DSH 能力面板。
- **看板自主维护**：指挥官增删改不需要确认；你的人工改动通过注入消息反向同步，不弹窗。
- **无催办按钮**：是否追问由指挥官策略决定。
- **Jev Key**：优先环境变量（如 `JEV_API_KEY`），也可手动填写存凭据库；无并发上限配置，不同会话并行、同一会话排队。
- **能力策略**：每个工作区只有"继承 / 自动选择"两档；指挥官只提能力需求建议，能力范围由 DSH 能力面板配置决定；自动选择只在范围内补充、会话级生效。

---

## 下一步

1. 评审 `docs/PRODUCT-DESIGN.md`，确认 §19 的 4 个开放问题（阈值分档、会话承载、看板位置、日结）。
2. 原型定稿后进入 M0：Client 插件 shell.overlay + 指挥官会话绑定 + 设置页骨架。
3. 写代码前先验证 `research/notes/dsh-capabilities.md` 附录的 6 项待实测。
