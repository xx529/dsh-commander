# M1R 构建 / 隔离验证 / live 更新预检

- 结论：**构建与隔离验证 PASS**（build/typecheck/test/verify-bundle 全绿；`GET /commander/sessions` 形状 + attach 确认派发隔离验证 PASS）；**live 更新预检 FAIL（预期）**——live 安装副本缺少 M1R/M2/M3 新增的 3 个 lib 文件，**必须 remove_bundle+install_bundle+重载**后才能验收，单纯刷新/重启不够。
- 执行人 / 时间：devops / 2026-11-18 09:23–09:45（task-54）
- 环境：隔离 `PROBE_ROOT=/tmp/dsh-commander-m1r-final`（web 模板 + 本地包 + stub LLM + workspace fixture）；**未写 live profile、未重启 DSH**
- 证据：`docs/validation/m1r-artifacts/`（`commands.log`、`02-verify-bundle.json`、`05-boot.*`、`13-sessions*`、`20-binding.json`、`25~30-*.json`、`m1r-*.log`）

## 1. 构建 / 类型 / 测试（最终状态）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter dsh-commander build` | **0** | `lib/client.js` **196,481B**（build 时快照）；host 产物同 build 生成 |
| `pnpm --filter dsh-commander typecheck` | **0** | host + client 0 error |
| `pnpm --filter dsh-commander test` | **0** | **189/189 pass、0 fail** |
| `node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander` | **0** | 9 项契约检查全 PASS（`02-verify-bundle.json`） |

> 说明：首次执行时（09:2x）恰好撞上队友 M1R/M2 代码在编辑中，typecheck 曾报 `src/host/index.ts(218,40) TS2345`、test 曾 159/164；确认是**并发编辑的瞬态**（同一分钟重跑即恢复），最终状态如上。阶段验收以最终代码重跑为准。

## 2. 隔离验证（`tools/dev/check-m1r.sh`，新 home，exit 0）

| 断言 | 实测 |
|---|---|
| boot | stderr 仅 `[commander] host ready (...)`；fixture workspace 注册成功 |
| `GET /commander/state` | 200；fixture workspace 可见 |
| `PUT /commander/workspaces` | 200（allowed=true/summary/policy） |
| `GET /commander/sessions?workspaceId=<id>` | **200**；`{ok,workspaceId,workspaceName,sessions[],truncated,rev}`；含新建工作会话，row 字段 `sessionId/title/lastActiveAt/archived:false` 符合契约（`13-sessions-check.txt`） |
| `GET /commander/sessions`（缺 workspaceId） | **400** `invalid_request` |
| `GET /commander/sessions?workspaceId=ws_unknown_probe` | **404** `not_found` |
| `GET /commander/sessions?workspaceId=<id>&limit=0` | **400**（limit 1..100） |
| 绑定 + stub 模型 | binding 200、`selectModel(probe-stub/stub-1)` 200 |
| `dispatch_task` 首次（candidate attach） | 回合完成 + `tool/call`/`tool/result`；`state.pendingDispatch` 非空（含 `decisionId` + `candidates[]`） |
| `dispatch_task` 二次（decisionId + `confirmTarget{mode:'attach',sessionId}`） | 回合完成；`pendingDispatch:null`；任务状态 `queued|running`；**`primarySessionId` = 目标工作会话**；`GET /commander/tasks/:id` 读回一致 |
| attach 语义 | **不新建工作会话**（agents 数前后一致=2）；同会话可承载任务 |
| 结果 | `RESULT: PASS`（canonical 证据 `docs/validation/m1r-artifacts/commands.log`） |

> 说明：隔离 Home 的 Jev 不可用（`reason=jev_unavailable`），首次 `dispatch_task` 的候选列表为默认推荐（mode=new，score 0）；**M1R 的“用户自定义 attach”由二次 confirmTarget 生效**（本验证即按该路径通过），与 live（Jev 可用）行为不冲突。attach 后会 prompt 目标会话，任务可能立即从 queued 变 running（断言接受两者）。

## 3. live 更新预检（预检 FAIL = 预期，需重装）

`bash tools/dev/m1r-live-reload.sh` / `bash tools/dev/install-live-m0.sh` 预检均 **FAIL**，原因一致：

```
live 副本缺 3 个新 lib 文件：./host/board/service.js  ./host/tasks/actions.js  ./host/trigger/injection.js
→ 必须 remove_bundle+install_bundle（或 dsh plugin remove/add）后重载；单纯重启/刷新不会同步新文件
```

- 这是**安装快照语义**导致（新增 lib 文件不会自动进入已装副本；`tsc` 原子重写还会断开 hardlink），与 M1 事故同因（`m0-live-install.md` §7.7/§7.8、`m1-boot.md` §7.9/§7.10）。
- **M1R/M2/M3 Host 变更结论：必须 `remove_bundle` + `install_bundle file:<绝对包路径>` + `set_plugin` 重载（不重启整机 DSH）**；CLI 等价：`dsh plugin --profile desktop remove dsh-commander && add <绝对包路径>`（用户终端）。

**需要 Lead/用户执行**（devops 沙箱不能写 `~/.dsh`，脚本已 REFUSE 并给指引）：

```bash
# 0) 构建（devops 侧已完成；最终验收前用最终代码重跑）
cd /Users/lzx/Documents/GitHub/dsh-commander && pnpm --filter dsh-commander build
# 1) 重装（快照更新，带上新 lib）
plugin_manager action=remove_bundle target=dsh-commander
plugin_manager action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
# 2) 重载插件（无需整机重启）
plugin_manager action=set_plugin target=dsh-commander enabled=true
# 3) 只读复查
bash /Users/lzx/Documents/GitHub/dsh-commander/tools/dev/m1r-live-reload.sh --post-verify
node /Users/lzx/Documents/GitHub/dsh-commander/tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:<PORT>/?token=…'
```

回滚：`plugin_manager action=remove_bundle target=dsh-commander`（域数据保留）；回旧构建 = checkout 目标 commit → build → install_bundle → set_plugin。验收后 `GET /commander/health` 不可达即回滚成功。

## 4. 证据清单（`docs/validation/m1r-artifacts/`）

`commands.log`（所有 curl/断言 + http 码）、`02-verify-bundle.json`、`05-boot.out/.err`、`10-state-initial.json`、`13-sessions.json`、`13-sessions-check.txt`、`14/15/16-sessions-*.json`（400/404/limit）、`20-binding.json`、`21-prepare.json`、`22/29-agents-*.json`、`23-drive-task.json`、`25-drive-attach.json`、`26-state-pending.json`、`27-drive-confirm.json`、`28-state-final.json`、`30-task-by-id.json`、`m1r-canonical.log`、`m1r-reload-preflight.log`、`m1r-install-preflight.log`。

## 5. 交接

- **tester**：可用 `PROBE_ROOT=/tmp/<x> OUTDIR=/tmp/<y> bash tools/dev/check-m1r.sh` 复跑隔离验证（stub 配方含在 `tools/dev/spike/m1-tools-driver.mjs`）；live e2e 需先由 Lead 完成 §3 的重装+重载。
- **Lead**：执行 §3 三动作后跑 `m1r-live-reload.sh --post-verify` + 含 token 的 verify；随后 tester 做 M1R live 走查（自定义 attach 卡）。
- M2/M3 Host 代码也已进入当前 build（backend 009:3x 通知：PATCH/archive/restore/accept/rework/board-edit 合并/organize_report/注入）；**M2/M3 的专项隔离验证归 task-55**（本文件仅覆盖 M1R）。
