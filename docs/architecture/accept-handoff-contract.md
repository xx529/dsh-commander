# 验收交接说明 + 指挥官有条件验收 实现契约

> 日期：2026-11-27
> 状态：实现中（Host/Client 改造）
> 本文是 `task-state-machine-final.md` 的**补丁**：冲突以本文为准。
> 需求来源：用户 2026-11-27 提出的依赖链痛点（A→B→C 时验收 A 与交接 B 割裂）。

---

## 0. 一句话方案

1. 验收动作（人 **和** 指挥官）都可以携带一段**交接说明**（`acceptNote`），验收后 `[task-unblocked]` 注入把它原文带给指挥官，由指挥官写进下游任务的 `prompt`。
2. 新增模型工具 `commander_task_accept`：**仅当被验收任务存在未终结的后继任务时**允许指挥官执行 `review→done`；没有后继则拒绝，要求人去看板验收。
3. 设置项 `commander.allowCommanderAccept`（默认开）可整体关闭指挥官验收。

**产品取舍**：指挥官拆解的任务可以自己验收并推进链路；链尾（无后继）必须由人验收，人始终握最后一关。

---

## 1. 数据字段（`schema.ts`）

`TaskRecord` 新增两个可选字段：

```ts
/** 验收时写下的交接说明/结论；仅在有下游时才可能非空。 */
acceptNote?: { text: string; at: number; round?: number }
/** 最近一次验收由谁完成：人（看板）或指挥官（工具）。 */
acceptedBy?: 'user' | 'commander'
```

- 校验：`text` 非空字符串；`at` 数字；`round` 可选整数；`acceptedBy` 二值枚举。
- 旧记录无这两个字段，读取侧按「人验收、无交接说明」处理。

## 2. 人验收路由

```
POST /commander/tasks/:id/accept
Body: { note?: string }        // 可选；≤1000 字（与 rework 同口径），空白视为无
```

- `note` 非空时写 `acceptNote = { text, at, round }`，并在 timeline `accept` 文本里带摘要（≤200）。
- 无论有无 note 都写 `acceptedBy = 'user'`。
- 幂等：已 `done` 返回 `duplicate=true`，**不覆盖**已有 `acceptNote`。
- 人验收不受「是否有下游」限制（人可随时验收任意 review 任务）。
- 校验失败（note 非字符串/超长）→ `invalid_request`，不落状态。

## 3. 指挥官验收工具 `commander_task_accept`

```
commander_task_accept({ taskId: string, note?: string, expectedRevision?: number })
```

| 守卫 | 结果 |
|---|---|
| 调用者不是指挥官会话 | `rejected(code='forbidden_scope')` |
| 任务不存在 | `rejected(code='unknown_task')` |
| `commander.allowCommanderAccept === false` | `rejected(code='accept_disabled', message='指挥官验收已关闭，请由人在看板验收')` |
| 任务已是 `done` | `ok: true, duplicate: true`（幂等，不覆盖 note） |
| 任务不是 `review` | `rejected(code='invalid_status')` |
| **无未终结后继** | `rejected(code='no_dependents', message='该任务没有后续任务，请由人在看板验收')`，不建确认卡、不改状态 |
| `expectedRevision` 不匹配 | `rejected(code='task_stale_revision')` |

成功返回：`{ taskId, status:'done', version, acceptedBy:'commander', dependents: string[] }`。

- actor 使用**新增的** `TransitionActor = 'commander_accept'`；`review>done` 的 actor 白名单扩展为 `['user_accept', 'commander_accept']`。
- 仍走 `transitionTask` 唯一写入口；成功后与人的 accept 一样：`onTaskSettled` 清未决确认、`dependencyNotifier.afterAccepted` 入队提醒。
- 「有未终结后继」判定（`hasPendingDependents`）：`dependentsOf(tasks, taskId).some(t => t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'archived')`。
  - **宽松版**（用户 2026-11-27 确认）：多依赖场景 A 验收时 B 可能还在等 X，只要有后继未终结即允许。

## 4. 设置项 `commander.allowCommanderAccept`

- 类型 `boolean`，缺省 `true`（旧配置无此字段视为开）。
- `PUT /commander/config` 的 `commander` 段接受该字段；`GET /commander/config` 回显。
- 关闭后工具直接拒绝；人验收通道不受影响。

## 5. 注入文案（`tasks/notifications.ts`）

`[task-unblocked]` 尾部追加（仅当被验收任务有 `acceptNote` 时）：

```
用户在验收时留下的交接说明（请原文写进下一任务的 prompt）：
<acceptNote.text>
```

无 note 时维持现有文案。多下游共享同一条说明（每条提醒各带一份）。

## 6. 派生字段

- `TaskView.hasPendingDependents: boolean`：由 `buildTaskView` 用全表计算，供看板判断「验收时是否弹交接说明框」。
- `TaskView.acceptedBy?: 'user' | 'commander'`：看板展示「指挥官验收」标识。
- `GET /commander/tasks/:id` 与 `taskSummary` 透出 `acceptNote` / `acceptedBy`。

## 7. 客户端行为

- 抽屉验收：点「验收通过」后，若 `hasPendingDependents === true` 显示确认条 + 可选文本框；否则维持现有确认条（无文本框）。
- 确认时 `POST /accept { note }`；`note` 为空串不写字段。
- `done` 任务抽屉展示交接说明与验收来源（人/指挥官）。
- 设置页「指挥官」卡片新增开关 `allowCommanderAccept`，默认开。

## 8. 指挥官 system prompt

- 收到 `[task-unblocked]` 且含交接说明时：必须把说明原文写进下游 `prompt`。
- `commander_task_accept` 仅在有下游时可调；无下游会被拒；不要用 `commander_task_update` 绕过。

## 9. 改动清单

| 层 | 文件 |
|---|---|
| 契约 | 本文 + `task-state-machine-final.md` 补充说明 |
| Host | `schema.ts`、`tasks/state-machine.ts`、`tasks/dependencies.ts`、`tasks/actions.ts`、`tasks/notifications.ts`、`tools/index.ts`、`api/routes/handlers.ts`、`api/server.ts`、`api/validation.ts`、`api/state.ts`、`session/prompt.ts` |
| Client | `state.ts`、`store.ts`、`board.ts`(如需)、`BoardPage.tsx`、`SettingsSection.tsx`、`types.ts`、`locales.ts` |
| 测试 | `unit/state-machine`、`unit/dependencies`、`unit/notifications`、`integration/m3-actions`、`integration/task-update-tools`、client locales |

## 10. 验证

- `pnpm --filter dsh-commander typecheck`
- `pnpm --filter dsh-commander test`
- `pnpm --filter dsh-commander build`
- `node packages/dsh-commander/tests/client/harness/run-harness.mjs`
