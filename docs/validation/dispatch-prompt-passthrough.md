# 派发消息原样透传（取消 brief 模板）· 验证记录

- 日期：2026-11-26
- 契约：`docs/architecture/dispatch-prompt-passthrough.md`（取代 `implementation-plan.md` §9.5、`m5-continue-dispatch.md` §6）
- 范围：Host 派发链路（tools/service/spawn/decisions/schema）+ 指挥官 system prompt + 注入文案 + Client 类型；**未动 live**。
- 需求来源：用户 2026-11-26 —— 程序不得再拼接派发内容；指挥官给什么就派发什么；标题/目标/验收提示/约束/上轮结论/上轮验收不由程序添加，不自动截断。

## 1. 改动要点

| 位置 | 改动 |
|---|---|
| `src/host/dispatch/brief.ts` | **删除**（模板退役），`DISPATCH_BRIEF_MAX_CHARS` 同步删除 |
| `src/host/dispatch/spawn.ts` | 直接 `prompt({content:[{type:'text', text: input.prompt}]})`；删除 round/instruction/previous* 入参 |
| `src/host/dispatch/service.ts` | `DispatchTaskArgs.prompt`；缺 prompt（且确认卡无存档）→ `rejected('invalid_prompt')`；确认可省略 prompt（复用 `PendingDecision.prompt`）；`DispatchRecord.brief` = 原文，不再写 `instruction` |
| `src/host/tools/index.ts` | `commander_task_dispatch` 参数 `prompt`（首派必填）替换 `instruction`；`commander_task_get` 增 `goal/acceptance/acceptanceHistory/reportSummary/pendingInstruction` |
| `src/host/session/prompt.ts` | 2b/2c/2d/4c/4d 改为「你自己写 prompt，Host 原样投递；批注原文必须写进去」 |
| `src/host/tasks/{actions,notifications}.ts` | `[task-continue]` / `[task-unblocked]` 提示改为 `prompt=<你写给工作会话的全文>` |

## 2. 回归用例（旧代码必失败）

| 用例 | 断言 |
|---|---|
| `tests/integration/dispatch.test.ts`「prompt verbatim」 | 首派 `prompt` 含前后空白与多行 → 工作会话收到逐字相同文本；`DispatchRecord.brief` 相同；记录无 `instruction` |
| 同上「>8KB kept intact」 | 9000+ 字符不截断（旧代码 `clip(…, 8192)` 会失败） |
| 同上「without prompt is rejected」 | `invalid_prompt`，不建确认卡、不投递、任务保持 draft |
| 同上「confirm may replace」 | 确认调用可覆盖确认卡里的原文 |
| `tests/integration/m5-continue.test.ts` | 续派 `brief` == 指挥官给的原文；不再出现「本轮要求/上一轮结论/目标/验收提示/约束」程序段 |
| `tests/integration/task-update-tools.test.ts` | `commander_task_get` 返回 `goal/acceptance/acceptanceHistory/reportSummary/pendingInstruction` |
| `tests/unit/tools.test.ts` | dispatch 参数面含 `prompt`、不含 `instruction` |

## 3. 验证结果

| 项 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS |
| `pnpm --filter dsh-commander test`（unit+integration+client） | **463/463 PASS** |
| `pnpm --filter dsh-commander build`（host + client + window） | PASS |
| `node packages/dsh-commander/tests/e2e/m1-e2e.mjs` | **54/54 PASS**（0 FAIL / 0 BLOCKED / 3 INFO） |
| `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS**（0 FAIL / 2 INFO） |
| `commander_task_get` 输出用真实 `validateJsonSchemaValue` 校验 | VALID |

说明：m1 e2e 的 probe 现在自己带 `prompt`（`M1E2E_WORKER…`），工作会话侧靠该标记识别；确认调用省略 prompt，覆盖「复用确认卡原文」路径。

## 4. 部署要求与本次实测（2026-11-26 23:1x）

- 已 `build`；`bash tools/dev/install-live-m0.sh` 预检 PASS（artifacts + client bundle 契约 + profile 状态）。
- **desktop profile 由 Electron 独占管理**：`dsh plugin --profile desktop …` 与 `dsh --profile desktop --dump-config` 都返回 `profile "desktop" is managed exclusively by the Electron application`；`plugin_manager install_bundle(file:…)` 返回 `already-installed`（changed=false）。**应用内插件管理是唯一重装入口**。
- 本次**无需重装**：profile 的 `node_modules/dsh-commander` 与仓库 `lib/` 是 pnpm 的 **hardlink**（同 inode），`tsc` 原地重写 → 已装副本逐文件 SHA256 与构建产物一致（`lib/host/dispatch/service.js`、`lib/host/tools/index.js`、`lib/client.js` 均 SAME，mtime 同为 build 时刻）。本次没有新增 `lib/` 文件，所以**用户重启 DSH 即可加载新 Host 代码**；旧 `lib/host/dispatch/brief.js` 作为死文件残留（无人 import），下次「应用内重装」时消失。
- Client 仅删了一个未使用字段（`DispatchRecord.instruction`），重启后**硬刷新**即可。
- 存储零迁移：`DispatchRecord.instruction` 不再写；旧记录残留该字段被读取侧忽略，`brief` 语义不变。
- 生效判据（重启后）：`commander_task_dispatch` 参数含 `prompt`；看板「派发内容」显示的就是指挥官原文，不再出现「任务：/目标：/验收提示：/约束：」模板行。

## 5. 已知限制（用户明确取舍）

- 指挥官漏写任务定义或漏抄看板批注 → 工作会话真的收不到，Host 不再兜底。
- 看板批注不做「必须出现在 prompt 里」的强校验（避免 Host 再次介入文本）。
- `prompt` 无长度上限；超长导致 `sessionController.prompt` 失败时按 `delivery_failed` 处理（任务 blocked，可重试）。
