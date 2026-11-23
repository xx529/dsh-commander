# M1R 验收清单与实测（自定义确认 target=attach）

> 角色：tester（task-56）。范围：M1 余项「自定义确认 attach」——`GET /commander/sessions` 只读会话列表 + `confirmTarget{mode:'attach',sessionId}` 派发校验。契约：`docs/architecture/m2m3-contract-patch.md` §1。
> 约束：隔离真实 Host + stub 模型真实工具调用 + fake Jev/panel；未改实现/配置；live 仅只读 API 取证（client 页面走查等统一硬刷新，见 §4）。

## 0. 状态总览

| 验收项 | 结果 | 证据 |
|---|---|---|
| M1R-1 `GET /commander/sessions?workspaceId` 形状（ok/workspaceId/sessions[]/truncated/rev；row sessionId/title/lastActiveAt/archived:false） | **PASS（e2e + live Host）** | `tests/artifacts/m1r/e2e/{summary.json,10-sessions-a-initial.json,22-sessions-a-after-fixtures.json}`；live `tests/artifacts/m1r/live/10-sessions-live.json` |
| M1R-2 错误分支：缺 workspaceId→400、未知 workspace→404、非法 limit→400、空工作区→200 `sessions:[]` | **PASS（e2e + live Host）** | e2e summary；live `11-sessions-missing.json`、`12-sessions-unknown.json` |
| M1R-3 attach 派发：首次 needs_confirmation → 二次 `confirmTarget{mode:'attach',sessionId}` → dispatched、task queued/running、`sessionCreated=false`、sessions link role=work/mode=attach、assignments/primarySessionId 正确 | **PASS（e2e 33/33 + live）** | e2e `30-task2-attach-detail.json`；live `tests/artifacts/m1r/live/{20-pending-live.json,21-sessions-target-ws.json,25-state-after-custom-confirm.json,26-task-after-custom-confirm.json,27-after-attach.png}`（outcome=overridden、mode=attach、primarySessionId=所选会话、pending=null） |
| M1R-4 同会话多任务 attach 允许（不因占用拒绝，契约 §1.2.4） | **PASS（e2e）** | `31-task3-second-attach.json` |
| M1R-5 拒绝：不存在会话 / 跨工作区 / 指挥官自身会话 → `invalid_target`，task 保持 proposed、无 link；拒绝后同 decision 仍可成功 attach | **PASS（e2e）** | `40-reject-missing-session.json`、`41-reject-cross-workspace.json`、`42-reject-commander-session.json`、`43-task4-valid-after-rejects.json` |
| M1R-6 attach **不调用能力面板**（fake panel rank/apply 计数 delta=0） | **PASS（e2e）** | e2e summary（before/after panelCalls） |
| M1R-7 客户端自定义卡消息模板逐字：`[dispatch-confirm] 自定义 … target=workspaceId:<ws>;mode:attach;sessionId:<sid>` | **PASS（client 单测 13/13 + harness）** | `packages/dsh-commander/tests/client/dispatch.test.ts`（custom template carries the picked attach target / custom attach card action）；`tests/artifacts/m1r/harness.log` |
| M1R-8 客户端自定义选择交互（模式 new/attach、会话列表加载/空/错误/重试/截断、未选会话不可确认、选择后可确认） | **PASS（隔离 harness interact 92/92）** | `tests/artifacts/m1r/harness.log` |
| archived 会话 attach 拒绝 | **UNVERIFIED（e2e fixture 缺失）**；集成测试覆盖 | `tests/integration/m1r-attach.test.ts`（archived → invalid_target） |
| live UI 自定义卡走查（真机点击） | **PASS（卡片渲染 + 等效消息完成自定义 attach）；物理点击 UNVERIFIED** | 卡片截图 `22/22b/22c/22d-custom-picker.png`；Lead 尝试 DOM/AX 点击未生效（console SyntaxError/TypeError，非应用错误）；最终以卡片自身逐字一致的 `[dispatch-confirm] 自定义` 普通消息完成，证据 `25/26/27-*.json/png` |

## 1. 方法

- e2e 脚本（新增，可复跑）：`node packages/dsh-commander/tests/e2e/m1r-e2e.mjs`
  - 隔离 `DSH_HOME` + web profile + 本地包 + `--patch tests/e2e/probes/m1-e2e-probe.mjs`：probe 注册 **3 个工作区**（A/B/空 C）；fake Jev（/v1/systemone 高分）；fake capabilityPanel（thunk，带 rank/apply 计数）；stub LLM 按 `M1E2E_*` 标记真实调用 `task_create`/`dispatch_task`；新增 `/m1r/create-session?cwd=` 用 `sessionController.create({cwd})` + `workspace.attachSession` 造真实 fixture 会话（同 devops 配方）。
  - 证据：`tests/artifacts/m1r/e2e/**`（summary.json、commands.log、各步骤 JSON、boot 日志）。
- 独立复跑：`pnpm --filter dsh-commander test` **200/200 PASS**；client harness **smoke 43/43 + interact 92/92 PASS**（`tests/artifacts/m1r/{unit-test.log,harness.log}`）；client dispatch 单测 **13/13**。
- live Host 只读：`http://127.0.0.1:64918` → `GET /commander/sessions?workspaceId=425e43bd…` 200 形状正确；缺参 400、未知 404；state 含 `workSessions/archiveSummary/metrics`（`tests/artifacts/m1r/live/10..13-*.json`）。

## 2. e2e 结果（33/33 PASS + 1 INFO）

摘要：`summary: 33/33 PASS, 0 FAIL, 1 INFO`（`tests/artifacts/m1r/e2e-run4.log`）。覆盖：
- sessions 形状/错误分支/空工作区/limit=1 truncated；
- new 派发（能力 auto applied，panel 计数 +1）；
- 2 个 fixture 会话出现在 sessions 列表；
- attach 派发（link mode=attach、assignments、sessionCreated=false、no panel、未新建会话）；
- 同会话第二任务 attach；
- 3 类 `invalid_target` 拒绝 + 同 decision 后续有效 attach；
- 最终 `pendingDispatch=null`。

唯一 INFO：archived 会话 e2e 无 fixture（DSH 隔离 Host 无公开归档 API）→ UNVERIFIED，由集成测试 `m1r-attach.test.ts` 覆盖。

## 3. 客户端自定义卡（隔离 harness）

- 模板逐字（`dispatch.ts` + `dispatch.test.ts`）：`[dispatch-confirm] 自定义\ndecisionId=… taskId=…\ntarget=workspaceId:<ws>;mode:attach;sessionId:<sid>`；`mode:new` 不带 sessionId。
- harness interact：自定义选择→工作区下拉（allowed）→`GET /commander/sessions?workspaceId=` 加载→会话行（标题/上下文）→未选禁用确认→选中启用→确认发送模板消息；空/错误/截断/重试态均断言。
- 复跑：`DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules node packages/dsh-commander/tests/client/harness/run-harness.mjs`。

## 4. Live 部分（Host 已重载；页面走查待统一刷新）

- live Host 已重载新代码：`GET /commander/sessions?workspaceId` 200、缺参 400、未知 404；`GET /commander/state` 含 `workSessions:3`、`archiveSummary`、`metrics` 新字段；health 200 `panel:present/binding:bound`。证据 `tests/artifacts/m1r/live/10..13-*.json`。
- **live UI 自定义卡：PASS（卡片渲染 + 等效消息完成 attach）；物理点击 UNVERIFIED。**
  - 硬刷新后 live 面板出现确认卡（`22d-custom-picker.png`：M1R live 自定义 at…｜每次派发需人工确认｜剩余 25:09｜建议 Research/新建会话｜pMax 50%｜候选 Research/agent-workspace｜原因 置信度较低｜按钮 自定义选择/采用建议/取消）。
  - 卡片「自定义选择」物理点击：Lead 尝试 AX/DOM 点击未触发（DevTools console 报 `SyntaxError`/`TypeError`，为外部 JS 操作错误，非应用异常）→ **UNVERIFIED**；按契约用卡片自身逐字一致的普通消息（`[dispatch-confirm] 自定义 decisionId=dec_6be56c… taskId=task_mwlgvocje955ce target=workspaceId:c5980907…;mode:attach;sessionId:session-40d34fc9…`）完成自定义 attach。
  - 结果（`26-task-after-custom-confirm.json`）：task `queued`、`primarySessionId=session-40d34fc9…`、`assignments=[该会话]`、`dispatch.outcome=overridden`、`finalTarget={mode:'attach',sessionId:…}`、sessions link `role=work/mode=attach/status=queued`；`pendingDispatch=null`；面板消息显示「已派发：任务 task_mwlgvocje955ce → Research 工作区·attach 已有会话…状态 queued（自定义选择已生效）」。
- 复跑命令：`curl 'http://127.0.0.1:64918/commander/sessions?workspaceId=<ws>'`、`GET /commander/tasks/<id>`；e2e 命令同上 §1。

## 5. 五维（interaction 等）

| 维度 | 结果 | 说明 |
|---|---|---|
| 交互 | **PASS（隔离 harness + Host e2e）**；live 点击 UNVERIFIED | 自定义模式切换/会话加载/选择确认/模板发送；Host attach 派发链路 e2e 全 PASS |
| 视觉 | 隔离 harness 渲染 PASS；live UNVERIFIED | 自定义卡沿用 M1 确认卡样式（与设置页一致） |
| 样式 | PASS（隔离） | 无溢出/遮挡，暗色 token |
| 原型 | UNVERIFIED | 未做 prototype 并排对照 |
| 截图审美 | UNVERIFIED | 待 live 截图后评审 |

## 6. 限制与 DoD

- DoD：可复现记录 PASS（e2e + 日志 + JSON）；关键路径自动化 PASS（e2e 33/33 + 单测 200/200 + harness 43/43+92/92）；失败降级 PASS（invalid_target 分支）；不引入新概念（复用 `[dispatch-confirm]`、只读 GET 路由）。
- 限制：archived 会话 e2e 无 fixture（集成覆盖）；live 页面级走查待统一硬刷新批次；e2e stub 非真实模型（真实模型路径由 M1 live 已验证，M1R live 以 API+后续走查补）。
