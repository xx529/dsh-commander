# DSH Commander · 下一阶段交接（验证 → M0/M1）

> 日期：2026-11-17
> 基线：产品设计 v1.8（`docs/PRODUCT-DESIGN.md`）、架构设计 v2.4（`docs/ARCHITECTURE.md`）、原型 v3（`prototype/`）
> 本阶段只做：**关键假设验证 + M0 骨架 + M1 派发**。不做原生壳、不做二期。

---

## 1. 一句话目标

用最小可运行插件验证三件事——**指挥官能正常对话并调工具**、**Jev 派发在真实数据上达到精度门槛**、**能力面板的 rank/apply 能在新会话上跑通**；验证通过后再把任务、看板、结果回注补齐到可日常使用。

---

## 2. 已经冻结、不要改的决策

1. **指挥官是普通 DSH 会话**：由 system prompt 约束，不硬编码对话流程；Host 只提供工具、事件触发、存储。
2. **指挥官不拆分工作、不评估结果**：只澄清、派发、维护看板、整理工作会话产出。
3. **只在工作会话停止时注入最后一条助手回复**：中间 `tool/result`、进度、审批、提问都不注入；按 `sessionId + turnId + seq` 去重；有 `pendingInteraction` 时不注入。
4. **没有 scheduler、没有结果轮询**；非空闲超 20 分钟只显示“疑似停滞”徽标（只读）。
5. **任务记录就是唯一真相**：一条 `tasks` 记录含状态 + 有界 timeline；没有事件表、没有投影、没有回放。
6. **Jev 只判工作区/会话**：预算内全量工作区 + 全部非归档会话一波过；超出 24k 才两层（先工作区，再该工作区全部会话）；不做 Top-K/时间过滤。
7. **能力选择完全交给能力面板**：
   - 策略只有 `inherit` / `auto`；
   - auto 时：创建新会话 → `capabilityPanel.jev.rank({sessionId,draft,cwd})` → `capabilityPanel.jev.apply({sessionId,plan,cwd})` → 再 prompt；
   - 指挥官只写 `capabilityNeeds`，不接触目录、阈值、映射；
   - 面板不可用/失败 → 回退 inherit，不阻塞派发。
8. **审批只在界面层**：不进指挥官上下文、不进看板；同一 `PendingApproval` 双处渲染，`answerable` 守卫，不注册第二个 answerer。
9. **看板自主维护 + 人工改动注入**；只有验收必须人触发。
10. **一期只在 DSH 内**：`shell.overlay` + 看板页 + 设置页；系统级悬浮留二期。

---

## 3. 先验证，再写功能（V0 门禁）

按顺序做，任何一项失败先停下来改设计或找替代方案。

### V1. 能力面板服务（最高优先）

- 目标：确认 `ctx.get("capabilityPanel")` 可用，且 `service.jev.rank` / `service.jev.apply` 存在（当前安装 v1.19.2）。
- 方法：
  1. 写一个最小 Host 插件 `inject: ["capabilityPanel"]`，日志打印 service 的键；
  2. 用 `sessionController.create` 建一个冷会话；
  3. 调 `jev.rank({sessionId, draft:"需要单测和浏览器自动化", cwd})`，记录 plan；
  4. 调 `jev.apply({sessionId, plan, cwd})`，看返回 `enabled/disabled/elapsedMs`；
  5. 再 prompt 一句话，确认会话里对应能力已生效。
- 通过标准：rank 在冷会话可用；apply 成功或按冷会话队列在 `agent/created` 后重放；失败可回退 inherit。
- 失败备选：先 prompt 一个极短“准备中”回合再 rank；或只在 `agent/created` 后 rank/apply。
- 记录：`docs/validation/v1-capability-panel.md`（命令、返回、结论）。

### V2. 会话停止与最后回复

- 目标：确认 `turn/end` 事件与“最后一条 assistant 消息”的对应关系；确认等审批/提问时不会误注入。
- 方法：
  1. 订阅 `turn/end`、`session/event`，记录 payload、turnId、最后 assistant seq；
  2. 触发一次审批（bash 需要审批），观察是否有 `turn/end`、`pendingInteraction` 是否非空；
  3. 恢复审批后结束回合，确认只在空闲时注入一次；
  4. 故意重复触发，验证 `sessionId+turnId+seq` 去重。
- 通过标准：中间工具调用不触发注入；审批等待期间不注入；同一回合只注入一次。

### V3. 会话创建与 prompt

- 目标：`sessionController.create({workspaceId|cwd, agentPreset})`、`selectModel`、`prompt({mode:'queue'})` 全链路可用。
- 通过标准：新会话出现在指定工作区；模型可指定；prompt 能唤醒一轮；`resume` 后指挥官会话可继续。

### V4. 存储

- 目标：`storageDomain` 域 `commander`（per-record）能声明、写入、读取、更新；key 符合 `[a-zA-Z0-9_-]+`；`version` 乐观并发可用。
- 通过标准：重启 Host 后任务记录仍在；key 含 `__` 正常；并发 update 冲突可重试。

### V5. Jev 派发 50 案例

- 目标：用真实工作区/会话快照跑 `tools/jev-eval.mjs`，校准阈值。
- 通过标准：auto precision ≥ 95%、coverage ≥ 40%；工作区 Top-1 ≥ 85%；会话 Top-1 ≥ 70%；全量 vs 两层有对比结论。
- 产出：`docs/eval/report.md` + 最终 `threshold / confidenceFloor` 写回默认配置。
- 失败处理：达不到就收紧为“每次确认”，不带病上线。

### V6. 审批双处渲染

- 目标：`useSessionStatus().pendingInteraction` 可读；`answer()` 可结算；后答者被 `answerable` 拦下。
- 通过标准：悬浮层与主窗口都渲染同一请求；先答者生效，另一处自动消失；不抛 `already settled`。

### V7. Host → Client 推送

- 目标：`ctx.webServer` 注册 `/commander/*` + SSE，在 Desktop `dsh-app://app` 下可达。
- 通过标准：面板/看板能实时收到任务与状态；刷新页面可重连。

### V8. 插件重载

- 目标：插件升级/重载后指挥官会话仍可 `resume`，任务记录不丢。
- 通过标准：重载后不新建重复会话；旧会话可按 id 恢复。

> V0 门禁：V1–V5 全过才进入 M0/M1；V6–V8 可在 M0 并行做。

---

## 4. 开发阶段与验收

### M0 · 骨架（先能跑）

范围：
- bundle 双半：Host（`package.json dsh.bundle.patch`）+ Client（`dsh.client`）；
- Host：`commanderDomain`（config/workspaces/commands/tasks/dispatches/boardEdits/sessions）；`storageDomain` open；`capabilityPanel` inject（软依赖）；
- 指挥官会话：首次创建/绑定、`sessionId` 持久化、启动 resume；
- Client：`shell.overlay` 悬浮球 + 空面板；设置页骨架（指挥官 / 工作区 / 派发与 Jev / 外观）；
- SSE：`/commander/state` 最小快照。

验收：
- 安装插件、刷新 DSH，球出现；
- 能打开面板并发一条消息，指挥官正常回复；
- 重启 DSH 后绑定不丢；
- 能力面板不存在时插件仍能启动（inherit 降级）。

### M1 · 派发（核心价值）

范围：
- `task_create` / `dispatch_task` / `task_update` / `board_query` 工具；
- Jev 客户端（TypeSafe `/v1/systemone`，env/凭据，超时/重试）；
- 候选构造：全量优先（20 工作区 + 全部非归档会话），>24k 两层；
- 门控：工作区/会话分别门控；`needs_confirmation` + 二次调用确认；
- 能力：创建会话 → panel rank/apply（auto）→ prompt；失败回退 inherit；
- 确认卡：采用建议 / 自定义 / 取消（自定义 UI 可后置）。

验收（固定脚本）：
1. 明显工作区任务：auto 派发成功，任务 `queued→running`；
2. 低置信任务：返回 `needs_confirmation`，二次确认后派发；
3. auto 能力：panel 返回 enabled/disabled，会话里能力生效；
4. panel 不可用：回退 inherit，派发仍成功并记录 fallback；
5. 50 案例指标达标。

### M2 · 看板

范围：
- 五列投影、卡片、任务详情抽屉；
- 任务记录 CRUD；人工改动 `boardEdits` + 异步注入指挥官；
- 归档/回收站最小实现；
- 疑似停滞徽标（只读）。

验收：
- 一条命令从 `proposed` 走到 `queued/running`；
- 重启后看板不变；
- 人工拖卡后指挥官收到 `[board-edit]`，不重复注入。

### M3 · 闭环

范围：
- `turn/end` 最后回复注入（去重、过滤 pending）；
- `organize_report` 整理验收 + 证据；
- 审批悬浮卡（含打开会话）；
- 人专用 accept/rework 路由；
- 播报/提醒（由消息与状态派生，无 brief_user）。

验收：
- 工作会话结束后，指挥官自动收到最后回复并更新看板；
- 不打开会话即可完成审批与验收；
- 审批不进指挥官上下文/任务记录；
- 返工能生成续做 brief 并发回原会话。

### M4 · 之后（本阶段不做）

原生壳、系统级悬浮、全局热键、Windows、语音、周报。

---

## 5. 代码结构建议

```
packages/dsh-commander/
├── package.json            # dsh.bundle.patch + dsh.client 双半
├── cordis.patch.yml
├── src/
│   ├── host/
│   │   ├── index.ts        # apply/inject、domain open、capabilityPanel 软依赖
│   │   ├── domain.ts       # defineDomain v1, per-record
│   │   ├── store/          # task/workspace/command/dispatch/boardEdit/session 仓储
│   │   ├── tools/          # task_* / dispatch_task / organize_report / follow_up / board_query
│   │   ├── dispatch/       # 候选构造、门控、能力调用、会话创建
│   │   ├── jev/            # 派发 Jev 客户端（与能力面板的 Jev 分离）
│   │   ├── trigger/        # turn/end → 最后回复注入 + 去重
│   │   ├── session/        # 指挥官绑定/resume、工作会话驱动
│   │   └── api/            # /commander/* + SSE
│   └── client/
│       ├── overlay.tsx     # 球 + 面板 + 审批卡
│       ├── board/          # 看板页 + 详情
│       ├── settings/       # 设置
│       └── state.ts        # SSE/视图状态
├── tests/
│   ├── unit/               # domain、门控、去重、截断
│   ├── integration/        # capabilityPanel mock、session mock
│   └── e2e/                # 固定脚本（M1/M2/M3）
```

约束：
- Host 是唯一写者；Client 只发命令。
- 不新增会话日志事件类型。
- 不重复实现能力面板的 Jev/目录/阈值。
- 审批不注册第二个 answerer。

---

## 6. 每个阶段的“完成定义”（DoD）

- 有可复现的验证记录（命令、返回、结论）。
- 有至少一个自动化测试覆盖关键路径（门控、去重、回退、状态迁移）。
- 失败路径有明确降级：Jev 超时→确认、能力失败→inherit、会话失败→blocked、注入失败→补一次。
- 不引入未验证的新概念（投影、scheduler、catalog、brief_user 等已删）。
- 文档只改事实，不改已冻结的边界。

---

## 7. 停止条件（出现就停）

1. `capabilityPanel.jev.rank` 无法在冷会话调用，且没有可行替代 → 暂停 M1 auto，先做 inherit 版本。
2. `turn/end` 无法稳定拿到“最后一条 assistant 回复” → 回到设计，别用轮询硬凑。
3. 50 案例达不到 precision 95% → 默认全确认，不自动派发。
4. `storageDomain` per-record 不可用或 key 限制无法满足 → 先 SQLite 路由或改 key 结构。
5. 审批无法安全双处渲染 → 一期只做主窗口审批，悬浮卡降级为跳转。

---
