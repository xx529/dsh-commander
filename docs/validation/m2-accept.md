# M2 看板验收清单与实测（tester，task-57）

> 契约：`docs/architecture/m2m3-contract-patch.md` §2。方法：隔离真实 Host + stub 模型真实工具调用 + fake Jev/panel（`COMMANDER_BOARD_MERGE_MS=20`）；证据 `tests/artifacts/m2/e2e/**`，live 待走查（§4）。

## 0. 状态总览

| 验收项 | 结果 | 证据 |
|---|---|---|
| 任务 proposed→queued→running（派发链路） | **PASS**（复用 M1/M1R e2e + M2/M3 e2e） | `tests/artifacts/m1/e2e/**`、`m1r/e2e/**`、`m2/e2e/20-*` |
| `PATCH /commander/board/tasks/:id` 合法（priority=high、status） | **PASS**（200，task 字段更新） | `m2/e2e/10-patch-priority.json` |
| 非法迁移：status=done→conflict（提示 accept/archive）、非法 priority→400 | **PASS** | e2e summary（409 conflict / 400 invalid_request） |
| `boardEdits` 写盘：`GET tasks/:id` 摘要含记录 | **PASS** | `11-task-detail-board-edits.json` |
| 同 `editId` 幂等（重复 PATCH 不重复写 edits） | **PASS** | `12-patch-replay.json` |
| `[board-edit]` 注入指挥官 + 合并窗口（`COMMANDER_BOARD_MERGE_MS=20` 一批一次） | **PASS**（session-event 证据 1 条） | `13-board-edit-injection.json` |
| archive（done→archived）/ `GET /commander/archive` / restore（archived→draft） | **PASS** | `20-archive.json`、`21-archive-list.json`、`22-restore.json` |
| `archiveSummary`（archivedCount/cancelledCount） | **PASS** | `23-final-state.json` |
| stale（running 且 lastActivityAt>20min，只读不改状态） | **UNVERIFIED（e2e 无法推进 20min 时钟）**；单测/集成覆盖 | 说明见 e2e INFO |
| live Host 只读（health/state/archive/sessions 新字段） | **PASS** | `tests/artifacts/m2/live/{01-health.json,02-state-live.json,03-archive-live.json,04-sessions-live.json}`（rev12、tasks5、workSessions3、metrics 含 projectionUnavailable、pending=null；client 223,026B sha `3657c256…`） |
| live UI 走查（看板五列/卡片/拖拽/抽屉/回收站/返回） | **UNVERIFIED（物理输入环境限制）** | 硬刷新成功/面板渲染成功；Lead 的 AXPress/System Events/DOM 点击均无法触发 web 内容（外部 JS 报 Syntax/TypeError，非应用异常）；替代取证与复跑见 §4 |

## 1. 自动化结果
- M2/M3 e2e：**25/25 PASS，0 FAIL，4 INFO**（`tests/artifacts/m2/e2e/run.log`、`summary.json`）。
- 独立复跑：`pnpm --filter dsh-commander test` **201/201 PASS**；client harness **smoke 43/43 + interact 92/92 PASS**（含看板按钮→五列/卡片/停滞受阻徽标→抽屉六分区→拖拽 PATCH→done 列拒绝→回收站恢复→返回对话）。
- 说明：生产 30s 合并窗口在 e2e 用 20ms 加速；真实 30s 时序 UNVERIFIED（契约由单测注入时钟覆盖）。

## 2. 五维（看板）
| 维度 | 结果 |
|---|---|
| 交互 | **PASS（隔离 harness：看板入口/抽屉/拖拽 PATCH/回收站/返回）**；live 点击 UNVERIFIED |
| 视觉/样式 | PASS（隔离渲染，暗色 token、五列横向滚动、徽标/状态条） |
| 原型/截图审美 | UNVERIFIED（待 live 截图与 prototype 对照） |

## 4. Live 部分（Host 只读 PASS；UI 物理交互 UNVERIFIED）
- 环境：live DSH `http://127.0.0.1:64918`；client 223,026B sha `3657c256…`（含看板/审批卡/自定义卡）；Host 已重载最终 build。
- **Host 只读 PASS**：health 200 `panel:present/binding:bound`；state rev12、tasks=5、workSessions=3、archiveSummary、metrics 含 `projectionUnavailable`、pending=null；`GET /commander/archive` 200；`GET /commander/sessions?workspaceId=…` 200（证据上表）。
- **live UI = UNVERIFIED（物理输入环境限制，不伪造）**：硬刷新与面板/确认卡渲染成功；但 Lead 的 agent-desktop AXPress（delivered 无效果）、System Events 坐标点击（web 内容不触发）、DevTools DOM 点击（外部 JS SyntaxError/TypeError，非应用异常）均无法完成看板点击/拖拽。替代取证：隔离 harness（43/43+92/92）+ e2e + Host API；复跑命令 `node packages/dsh-commander/tests/e2e/m23-e2e.mjs`、`DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules node packages/dsh-commander/tests/client/harness/run-harness.mjs`。

## 3. 限制
- e2e stub 非真实模型；board-edit 注入用 probe session-event 取证（等价于消息注入）。
- live 页面级走查需硬刷新后与 M1R/M3 统一批次执行。
