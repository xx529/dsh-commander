# M1R 独立复核审计（tester，task-56）

> 范围：M1 余项「自定义确认 attach」——`GET /commander/sessions` 只读路由 + `confirmTarget{mode:'attach',sessionId}`。契约：`docs/architecture/m2m3-contract-patch.md` §1。
> 裁定时间：2026-11-18 上午。

## 0. 裁定

**M1R 自动化/契约验收 = PASS。**
- e2e **33/33 PASS**（隔离真实 Host + stub 模型真实工具调用 + fake Jev/panel；`tests/artifacts/m1r/e2e-run4.log`）。
- 单测 **200/200 PASS**、client harness **smoke 43/43 + interact 92/92 PASS**、client dispatch 模板单测 **13/13**（`tests/artifacts/m1r/{unit-test.log,harness.log}`）。
- live Host 新路由/字段只读取证 PASS；**live 自定义 attach 全链路 PASS**：硬刷新后确认卡渲染（`tests/artifacts/m1r/live/22d-custom-picker.png`）→ 等效 `[dispatch-confirm] 自定义` 消息（卡片自身逐字模板）→ task `queued`、`primarySessionId/assignments` 指向所选会话、`dispatch.outcome=overridden`、`finalTarget.mode=attach`、sessions link `role=work/mode=attach`、pending=null（`25/26/27-*.json/png`）。
- **UNVERIFIED（不阻断）**：① archived 会话 attach 拒绝的 e2e fixture（隔离 Host 无公开归档 API；集成测试 `m1r-attach.test.ts` 覆盖）；② live「自定义选择」**物理点击**未触发（Lead AX/DOM 尝试失败，console 外部 JS 错误非应用异常），以等效消息完成，物理点击 UNVERIFIED。
- **严重级别：HIGH 0 / MEDIUM 0 / LOW 0**（2 项 UNVERIFIED 属环境/批次安排，非缺陷）。

## 1. 方法

- 新增 `packages/dsh-commander/tests/e2e/m1r-e2e.mjs`：复用 `tests/e2e/probes/m1-e2e-probe.mjs`（3 工作区、fake Jev/panel、stub 模型真实 `task_create`/`dispatch_task`、`/m1r/create-session` fixture 会话 + `workspace.attachSession`）；按消息串行（等 commander idle）驱动全链路。
- 独立复跑测试与 harness；live 只读 curl 取证（不重启、不写 live）。

## 2. 覆盖矩阵（PASS 项）

| 契约点 | 断言 | 证据 |
|---|---|---|
| §1.1 形状 | `ok/workspaceId/sessions[]/truncated/rev`；row `sessionId/title/lastActiveAt/archived:false`；可选 contextUsage/model | e2e `10/22-*.json`；live `10-sessions-live.json` |
| §1.1 错误 | 缺参 400 invalid_request；未知 ws 404 not_found；limit=0 400；空工作区 200 `[]` | e2e summary；live `11/12-*.json` |
| §1.1 截断 | limit=1 → 1 条 + truncated=true | e2e |
| §1.2 校验/派发 | attach 成功 dispatched；link role=work/mode=attach；assignments/primarySessionId；sessionCreated=false；未新建会话 | `30-task2-attach-detail.json` |
| §1.2.4 多任务 | 同会话第二任务 attach 允许，assignments 均存在 | `31-task3-second-attach.json` |
| §1.2 失败 | 不存在/跨工作区/指挥官自身 → invalid_target；task 仍 proposed；拒绝后同 decision 可继续有效 attach | `40/41/42/43-*.json`、boot 日志 Rejected 原文 |
| §1.2.5 面板 | attach 全程 panel rank/apply delta=0 | e2e summary |
| §1.3 模板 | `[dispatch-confirm] 自定义\ndecisionId=… taskId=…\ntarget=workspaceId:…;mode:attach;sessionId:…` 逐字 | client `dispatch.test.ts` 13/13；harness interact 92/92 |

## 3. 质量关注（非缺陷）

- **测试有效性**：e2e 使用 stub 模型驱动真实工具往返（非直接调 service），并断言 sessions/panel 计数等宿主副作用；单测/集成另覆盖 archived/幂等/过期。客户端模板由纯函数单测逐字锁定，harness 覆盖交互态。
- **脚本迭代中发现的测试侧问题（已修正，不是实现缺陷）**：fixture 会话必须 `workspace.attachSession` 登记（否则 GET sessions/attach 校验不可见）；多消息需等 commander idle 串行；自定义 attach 目标 ≠ recommendation 时契约期望 outcome=`overridden`（已按契约修断言）。
- **live API**：Host 新路由/新快照字段已在 live 只读验证；client bundle 需硬刷新后走查（UNVERIFIED）。

## 4. 五维（interaction 等）

| 维度 | 结果 |
|---|---|
| 交互 | **PASS（隔离 harness + Host e2e + live 等效消息链路）**；live 自定义按钮物理点击 UNVERIFIED（以卡片逐字消息替代） |
| 视觉/样式 | PASS（隔离渲染，沿用确认卡样式）；live UNVERIFIED |
| 原型/截图审美 | UNVERIFIED（未并排对照/无 live 截图） |

## 5. 结论与下一步

- **M1R 可 PASS（自动化/契约；2 项 UNVERIFIED 注记）**；无 HIGH/严重缺陷，无需修复项。
- 下一步：live 统一硬刷新批次（M1R 自定义卡 + M2 看板 + M3 审批卡）由 tester 执行截图/点击走查，回填 `m1r-accept.md §4`；archived e2e 如 Host 提供归档 fixture/API 可补（当前集成覆盖足够）。
- 文档：`m1r-accept.md`（验收清单）、本审计；证据 `tests/artifacts/m1r/**`。
