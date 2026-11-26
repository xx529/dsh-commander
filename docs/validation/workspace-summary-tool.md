# 验收：工作区摘要写工具（commander_workspace_update）

- 日期：2026-11-24
- 范围：新增模型工具 `commander_workspace_update`，让指挥官维护工作区摘要；与设置页「工作区 → 摘要」写同一个 `WorkspaceRecord.summary` 字段，人类仍经 `PUT /commander/workspaces` 改同一字段。
- 契约：`docs/architecture/task-state-machine-final.md` §5.1/§5.9/§12#17；`docs/architecture/implementation-plan.md` §10.3/§10.4。

## 改动

- `src/host/tools/index.ts`：新增第 9 个工具（schema/render/execute）；作用域同其它指挥官工具；`workspaceId` 接受 id/名称/路径并防歧义；`summary` ≤500 字（trim，空串清空）；只写 summary/summarySource/summaryUpdatedAt，`allowed`/`capabilityPolicy` 不开放。
- `src/host/store/workspaces.ts`：新增 `put` 与字段级原子 `patch`；摘要写入用 `patch`，避免覆盖人类并发保存的白名单/策略。
- `src/host/api/server.ts` + `src/host/index.ts`：`CommanderApi.snapshot()`；工具写成功后向 SSE 广播整帧 `snapshot`（与人类保存同一条显示路径，设置页打开时同步）。
- `src/host/session/prompt.ts`：prompt 增加 4j，说明该工具与设置页同一字段、写稳定说明、不写临时任务要求。
- 测试：`tests/unit/workspace-update-tool.test.ts`、`tests/integration/workspace-summary.test.ts`、`tests/unit/store.test.ts`；工具清单断言 8 → 9。

## 验证结果（本机，隔离环境）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm --filter dsh-commander typecheck` | PASS |
| 单测/集成 | `pnpm --filter dsh-commander test` | **421/421 PASS** |
| 构建 | `pnpm --filter dsh-commander build` | PASS |
| Host e2e（M1） | `node packages/dsh-commander/tests/e2e/m1-e2e.mjs` | **54/54 PASS**，0 FAIL，3 INFO |
| Host e2e（M2/M3 回归） | `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS**，0 FAIL，3 INFO |

新增测试覆盖：

1. 工具写摘要后 `summarySource='model'`、`summaryUpdatedAt` 更新，`allowed`/`capabilityPolicy`（含 `lastSelection`）保持不变；
2. 空串清空摘要并移除 `summaryUpdatedAt`；
3. registry-only 工作区首次写入会创建默认记录（`allowed=false`）；
4. 未知/歧义工作区、超长摘要、未知参数、非指挥官会话均被拒绝；
5. 人类 `PUT /commander/workspaces` → 工具改 → 人类再改 → 工具再改，`/commander/state` 始终反映最后一次写入，`summarySource` 在 manual/model 间切换；
6. 工具写入后，已连接的 SSE 客户端收到含新摘要的整帧 `snapshot`；
7. 工作区仓储 `patch` 只改目标字段，不动白名单/策略。

备注：M1 e2e 多次复跑中，“确认前 task.status=proposed” 断言偶发读到 `draft`（同一次运行其它 53 项全 PASS，复跑即 54/54）。原因是 e2e 以 `pendingDispatch` 出现作为等待条件，而决策先于任务 `draft→proposed` 落盘可见（既有竞态，未改 e2e 脚本，与本工具无关）。

## 部署

Host 改动（无新增 `lib/` 文件）：`pnpm --filter dsh-commander build` 后由用户**重装 + 重启 DSH**。Client 未改，不需要硬刷新。

未做：live 环境走查（安装/重启由用户执行；未写 `~/.dsh`）。设置页与指挥官同时写同一摘要的并发冲突按“字段级原子 patch + 最后一次写入生效”处理，未新增版本号或冲突提示。
