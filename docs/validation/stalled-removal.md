# 看板「停滞」标记移除记录（2026-11-24）

> 基线：`4ae9865` + 工作区现有未提交改动（board-redesign）。本轮**只改本功能相关代码/测试/文档**，未触碰其它未提交改动（见 §6）。
> 关联：移除前的行为审计见 `docs/validation/stalled-marker-audit.md`（该文件已加「已移除」横幅）；变更摘要另见 `docs/HANDOVER.md` §12。

## 0. 结论

看板不再有「停滞 / 疑似停滞」判断与展示：`STALE_AFTER_MS`、`taskIsStale`/`staleOf`、`stale` 派生字段（快照/详情/SSE/工具行/回收站列表）、Client 兜底重算与徽标、样式与两份文案字典全部删除。看板其余信息（标题/工作区/轮次/优先级/能力/受阻/依赖/待确认/会话数/时间）不受影响。

`lastActivityAt` 字段保留（仍用于列排序与卡片时间显示），只是不再参与任何「停滞」判断。

## 1. Host 侧改动

| 文件 | 改动 |
|---|---|
| `packages/dsh-commander/src/host/config.ts` | 删除 `STALE_AFTER_MS`（原 130–131 行）。现 `ARCHIVE_LIST_MAX` 之后直接是 `BOARD_TITLE_MAX`（125–131 为 board merge/edits/archive 常量） |
| `packages/dsh-commander/src/host/board/service.ts` | 删除 `taskIsStale()` 判定、`BoardService.staleOf` 接口与实现、`STALE_AFTER_MS` import；头注释去掉 stale 描述 |
| `packages/dsh-commander/src/host/api/state.ts` | `TaskView.stale` 字段删除（现 36 行 `evidenceInsufficientCount` 后即 `archivedAt`）；`buildTaskView` 去掉仅为 stale 存在的 `at` 参数；快照调用同步简化 |
| `packages/dsh-commander/src/host/query/tasks.ts` | `TaskListRow.stale` 删除（现 242 行 `acceptanceCount` 后即 `createdAt`）；移除 `taskIsStale` import 与投影 |
| `packages/dsh-commander/src/host/api/routes/handlers.ts` | 详情（现 138 行 `boardEdits` 后直接 `archivedAt`）、任务摘要、回收站列表三处 `stale` 下线；`taskSummary` 去掉只为 stale 传的 `now` 参数与 5 处调用点实参 |
| `packages/dsh-commander/src/host/tools/index.ts` | `commander_task_list` 输出 schema 删 `stale`（required），render 行删 `stale: task.stale` |
| `packages/dsh-commander/src/host/index.ts` | `buildTaskView` 调用去掉 `Date.now()` 实参；5b 注释去掉 stale |

SSE 无需单独改：`task.updated` 推的是 `buildTaskView()` 整行（`src/host/index.ts:83-89`），字段删除即自动不再下发。

## 2. Client 侧改动

| 文件 | 改动 |
|---|---|
| `packages/dsh-commander/src/client/board.ts` | 删除 `isStaleTask()`（原 153–161，含客户端第二份 20min 阈值默认参数） |
| `packages/dsh-commander/src/client/BoardPage.tsx` | 卡片头删除停滞徽标 `<span className="dshc-board-stale">`；`isStaleTask` import 与只为它存在的 `const now = Date.now()` 一并删除（现卡片头只有标题，296–304 行） |
| `packages/dsh-commander/src/client/types.ts` | `TaskView.stale`、`TaskDetailView.stale` 删除 |
| `packages/dsh-commander/src/client/state.ts` | `normalizeTaskDetail` 不再透传 `stale`（快照任务仍按原样保留 Host 字段） |
| `packages/dsh-commander/src/client/styles.ts` | 删除 `.dshc-board-stale` 样式块 |
| `packages/dsh-commander/src/client/locales.ts` | 删除 zh/en 的 `board.card.stale` 与 `board.card.staleBadge`（4 行） |

全仓检索确认无其它消费方（`grep -rn "isStaleTask|dshc-board-stale|board.card.stale"` 仅剩测试里的「不得出现」断言）。

## 3. 测试改动

| 文件 | 改动 |
|---|---|
| `packages/dsh-commander/tests/integration/m2-board.test.ts` | 删除 `STALE_AFTER_MS` import 与旧的 `stale===true` 断言；**新增**：PATCH 返回 `'stale' in body.task === false`；详情/快照用例改为「种子任务 `running` 且 21min 无活动 → `'stale' in detailBody === false`、`'stale' in view === false`」 |
| `packages/dsh-commander/tests/client/harness/interact.mjs` | fixture 去掉 `stale: true`（该卡 `lastActivityAt: 2` 天然是长静默 running）；断言由「显示徽标」改为**「长静默 running 卡不渲染停滞徽标」**（`.dshc-board-stale` 数量为 0 且不含 `board.card.staleBadge`） |
| `packages/dsh-commander/tests/unit/query-tools.test.ts` | `commander_task_list` 用例加入长静默 `running` 任务（`lastActivityAt` 远早于 now）：**新增**「每行不含 `stale` 键、render 文本不含 `"stale"`」断言 |
| `packages/dsh-commander/tests/client/board.test.ts` | 删除 `isStaleTask` 单测与 import（徽标语义改由 harness/DOM 覆盖） |
| `packages/dsh-commander/tests/e2e/m23-e2e.mjs` | 删除「M2 stale … UNVERIFIED」INFO 项与头注释中的 stale 未覆盖说明 |
| `packages/dsh-commander/tests/client/harness/README.md` | 「停滞与受阻 badge」→「受阻 badge」 |

## 4. 文档改动

- `docs/architecture/m2m3-contract-patch.md`：§2.2（两列去掉 stale 徽标）、§2.3（示例与字段说明改为「已移除」并注明日期）、§2.5 行字段、§2.7 详情示例、§1 概览、W2/W3/必测清单。
- `docs/architecture/implementation-plan.md`：§8.3 派生字段、详情路由、`commander_task_list` 行字段、M2-4 验收项、§13「不做 scheduler」口径。
- `docs/architecture/task-state-machine-final.md`：§5.8 工具行字段、§5.7 `queued` 列说明。
- `docs/architecture/task-query-design.md`：行字段表删 `stale` 行、示例 JSON、复用函数清单。
- `docs/ARCHITECTURE.md` §7 失败模式行、`docs/PRODUCT-DESIGN.md` §巡检、`docs/NEXT-PHASE.md` §2 冻结决策 4 与 M2 范围。
- `docs/HANDOVER.md`：SSE/快照字段说明、UNVERIFIED 清单、M2 状态行；新增 **§12 变更记录**。
- `docs/validation/stalled-marker-audit.md`：顶部加「已被移除」横幅（保留为历史审计）。

未改写的历史结论：`docs/architecture/m2m3-review.md`、`docs/validation/{audit-m2,m2-accept,m2-m3-build,m4-p1-native-shell}.md`、`docs/architecture/task-state-machine-contract-patch.md`（已被 final 取代的讨论稿）保持原样。

## 5. 验证证据

| 命令 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS（host+client 两套 tsc，无输出错误） |
| `pnpm --filter dsh-commander test` | **420/420 PASS**（含新增的 no-stale 断言） |
| `pnpm --filter dsh-commander build` | PASS（host tsc + client tsdown + window bundle） |
| `DSH_COMMANDER_HARNESS_MODULES=… node packages/dsh-commander/tests/client/harness/run-harness.mjs` | smoke **51/51**、interact **195/195**，`PASS long-silent running card shows no stall badge` |
| `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26 PASS / 0 FAIL / 2 INFO**（原 3 个 INFO，去掉 stale 项） |
| `grep -rn "board\.card\.stale\|isStaleTask\|taskIsStale\|STALE_AFTER_MS\|dshc-board-stale" packages/dsh-commander/src` | 0 命中（仅测试里的「不得出现」断言与历史文档） |

## 6. 边界（未触碰）

- 工作区原有 39 个未提交改动（board-redesign：依赖高亮、回收站分组、`commander_workspace_update` 等）保持原状；本轮新增/修改仅限上表文件，`git status` 由 39 → 47 项全部可回溯到本功能（含 1 个新文件 `docs/validation/stalled-marker-audit.md`）。
- `prototype/board-redesign/app.js` 是设计原型（非插件代码），其中 `task.stale` 演示未动；不影响运行期行为。
- `lastActivityAt` 语义与写入点未改；`task_stale_revision`（版本号 CAS）与本次的「停滞」无关，未动。
- 状态机迁移图、派发、注入、归档/回收站逻辑未改。

## 7. 部署提示

Host 与 Client 均有改动 → `pnpm --filter dsh-commander build` 后**重装插件 + 重启 DSH**，页面**硬刷新**（只刷新生效不了 Host 字段下线）。
