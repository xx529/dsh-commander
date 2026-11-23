# M2 独立复核审计（tester，task-57）

> 范围：M2 看板（PATCH/boardEdits/注入/archive/stale/Client 看板）。契约：`docs/architecture/m2m3-contract-patch.md` §2。

## 0. 裁定
**M2 = PASS（自动化/契约 + live Host 只读）；live UI 交互 UNVERIFIED（物理输入环境限制）。**
- M2/M3 e2e **25/25 PASS**（隔离真实 Host + stub 真实工具调用；`tests/artifacts/m2/e2e/run.log`）。
- 单测 **201/201 PASS**、client harness **smoke 43/43 + interact 92/92 PASS**（独立复跑）。
- **live Host 只读 PASS**：health/state/archive/sessions；rev12、tasks5、workSessions3、metrics 含 `projectionUnavailable`、pending=null；client 223,026B sha `3657c256…`（证据 `tests/artifacts/m2/live/**`）。
- **UNVERIFIED（不阻断，环境限制）**：① stale 的 e2e（需 20min 时钟；单测/集成覆盖）；② live UI 看板点击/拖拽/回收站（Lead 已尝试硬刷新+AX/System Events/DOM 点击，均无法触发 web 内容；外部 JS 报错非应用异常）。
- **严重级别：HIGH 0 / MEDIUM 0 / LOW 0**（2 项 UNVERIFIED 属环境/工具限制）。

## 1. 覆盖与证据
| 契约点 | 断言 | 证据 |
|---|---|---|
| §2.4 PATCH 合法 | priority=high 200，task 更新 | `m2/e2e/10-patch-priority.json` |
| §2.4 非法 | done→409 conflict；非法 priority→400 | e2e summary |
| §2.4 幂等 | 同 editId 重复 PATCH，boardEdits 不重复 | `12-patch-replay.json` |
| §2.6 注入 | `[board-edit]` 注入 commander session；20ms 合并窗口→1 条 | `13-board-edit-injection.json` |
| §2.5 归档 | archive（done）→archived；GET archive 含；restore→draft；archiveSummary | `20/21/22/23-*.json` |
| §2.3 stale | UNVERIFIED e2e；单测/集成覆盖 | — |
| Client 看板 | harness：入口/五列/徽标/抽屉/拖拽 PATCH/done 拒绝/回收站/返回 | `tests/artifacts/m1r/harness.log`（最终 bundle 独立复跑） |

## 2. 质量关注
- e2e 通过 probe `/m1r/events` 读取 commander 会话事件确认 `[board-edit]` 注入（非只看接口 200）；合并窗口用 20ms 加速，生产 30s 语义由单测时钟覆盖（UNVERIFIED 真实时长）。
- 无实现缺陷发现；e2e 迭代中的失败均为测试侧问题（fixture/标记串行/断言口径），已修正。

## 3. 结论与下一步
- **M2 可 PASS（自动化/契约；2 项 UNVERIFIED 注记）**。
- live 走查批次：硬刷新→面板「看板」→五列/卡片/停滞徽标→抽屉→拖拽 PATCH（toast+指挥官 `[board-edit]`）→归档/回收站→返回对话；截图/点击表落 `tests/artifacts/m2/live/**` 后回填 `m2-accept.md §4`。
