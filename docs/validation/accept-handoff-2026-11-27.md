# 验收：验收交接说明 + 指挥官有条件验收

- 日期：2026-11-27
- 范围：① 人验收时可写「交接说明」，随 `[task-unblocked]` 注入原文带给指挥官；② 新增模型工具 `commander_task_accept`，**仅当任务存在未终结后继**时允许指挥官执行 `review→done`，链尾任务仍必须由人在看板验收；③ 设置项 `commander.allowCommanderAccept`（默认开）可整体关闭指挥官验收。
- 契约：`docs/architecture/accept-handoff-contract.md`（补丁）；`task-state-machine-final.md` 头部已标注冲突以补丁为准；`implementation-plan.md` §9 补丁注记已同步。

## 改动

**Host**
- `schema.ts`：`TaskRecord.acceptNote {text,at,round?}`、`acceptedBy 'user'|'commander'` 及校验器；`CommanderConfig.allowCommanderAccept?`。
- `tasks/state-machine.ts`：新增 `commander_accept` actor；`review>done` 白名单扩展。
- `tasks/dependencies.ts`：新增 `hasPendingDependents`（宽松版：任何未终结后继；done/cancelled/archived 不算）。
- `tasks/actions.ts`：抽出 `performAccept`，人路由与工具共用；`note` 与状态迁移同一次 CAS 写入。
- `tasks/notifications.ts`：`[task-unblocked]` 注入在被验收任务有 `acceptNote` 时原文携带交接说明。
- `tools/index.ts`：新增第 10 个工具 `commander_task_accept`（schema/render/execute）；拒绝码 `accept_disabled`/`no_dependents`/`invalid_status`/`task_stale_revision`/`forbidden_scope`。
- `api/*`：accept 路由接收 `{note}`（非字符串或 >1000 字 → 400）；`configView`/`PUT config` 支持 `allowCommanderAccept`；`TaskView` 新增派生 `hasPendingDependents` 与 `acceptedBy`。
- `session/prompt.ts`：更新 4a/4g/4h，新增 4k（有条件验收与 note 用法）。

**Client**
- 抽屉验收确认条：`hasPendingDependents === true` 时显示可选交接说明输入框（≤1000 字），确认随 `POST /accept {note}` 提交。
- `done` 任务抽屉展示交接说明卡片与「指挥官验收」标识。
- 设置页「指挥官」卡片新增「允许指挥官验收有下游的任务」开关。
- `locales.ts` 中英同增 5 个 key。

## 验证结果（本机，隔离环境）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm --filter dsh-commander typecheck` | PASS |
| 单测/集成 | `pnpm --filter dsh-commander test` | **486/486 PASS** |
| 构建 | `pnpm --filter dsh-commander build` | PASS |
| Client harness | `DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules node packages/dsh-commander/tests/client/harness/run-harness.mjs` | **52/52 + 197/197 + 6/6 PASS** |
| M1 e2e | `node packages/dsh-commander/tests/e2e/m1-e2e.mjs` | **54/54 PASS** |
| M2/M3 e2e | `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS**（2 项既有 UNVERIFIED） |

新增/更新的关键测试：
- `tests/unit/state-machine.test.ts`：`commander_accept` 可 `review→done`，其它 actor 仍拒绝。
- `tests/unit/dependencies.test.ts`：`hasPendingDependents` 对 done/cancelled/archived 返回 false。
- `tests/unit/notifications.test.ts`：`buildUnblockedText` 与 pump 注入携带交接说明原文。
- `tests/integration/m3-actions.test.ts`：人验收带 note 落库、幂等不覆盖、长度/类型校验、详情透出。
- `tests/integration/commander-accept-tool.test.ts`：有/无下游、开关关闭、幂等、非 review、越权调用。
- `tests/unit/tools.test.ts` / `tests/integration/m1-tools-scope.test.ts`：工具清单 9 → 10。

## 已知限制

- 人验收的交接说明只在任务有未终结后继时提供输入框；无下游任务不展示该字段（交互取舍，字段仍可经 API 写入）。
- `hasPendingDependents` 是快照派生值：下游被取消后，已打开抽屉需要重拉详情才会刷新（详情接口实时计算）。
- 关闭 `allowCommanderAccept` 只影响工具；人验收通道不受影响。
