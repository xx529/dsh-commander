# M2/M3 构建 / 隔离验证 / live 重载验收

- 结论：**隔离侧 GO**（最终 build/typecheck/test/verify-bundle 全绿；M2/M3 隔离验证 **exit 0、65 ASSERT PASS、0 FAIL**；含 HIGH-1 空 acceptance 拒绝断言）。**live 侧待重装+重载后再判定**（见 §4/§5）——live 文件集已一致（42=42，Lead 已重装过 M1R 时点），但运行中进程仍是旧模块（`metrics` 缺 `projectionUnavailable`），需按 `m1r-live-reload.sh` 流程再 remove+install+set_plugin 重载。
- 执行人 / 时间：devops / 2026-11-18 09:5x–10:2x（task-55）
- 环境：隔离 `PROBE_ROOT=/tmp/dsh-commander-m2m3-final`（web 模板 + 本地包 + stub LLM + workspace fixture，`COMMANDER_BOARD_MERGE_MS=2000` 缩短合并窗口）；**未写 live profile、未重启 DSH**
- 证据：`docs/validation/m2m3-artifacts/`（`commands.log` 65 PASS/0 FAIL、各 curl 原文、`m2m3-final.log`、`m2m3-reload-preflight.log`）

## 1. 最终构建（backend HIGH-1/MEDIUM2 修复后重跑）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter dsh-commander build` | **0** | `lib/client.js` **223,026B**、sha256 `3657c2564becd9abfdb8b2ca0e6d85005776d60a59110a9252064ac995353669` |
| `pnpm --filter dsh-commander typecheck` | **0** | host + client 0 error |
| `pnpm --filter dsh-commander test` | **0** | **201/201 pass、0 fail** |
| `node tools/dev/verify-bundle.mjs …` | **0** | 9 项契约 PASS |

## 2. 隔离验证（`tools/dev/check-m2m3.sh`，新 home，exit 0，65 PASS/0 FAIL）

### M2（看板人工改板/回收站/注入）
| 断言 | 实测 |
|---|---|
| `PATCH /commander/board/tasks/:id` title/priority | 200；`task.title`/`priority` 更新；返回 `boardEdit.editId`；`duplicate:false` |
| 重复 `editId` | 200 且 `duplicate:true`（幂等） |
| `PATCH` status=done（带 editId） | **409 conflict**，message 提示走 accept/archive |
| `PATCH` 非法字段 | **400 invalid_request** |
| task detail `boardEdits` | 顶层 `boardEdits[]`（≥2），合并 flush 后 **`injectedAt` 全部非空**（注入成功证据） |
| `[board-edit]` 合并注入 | `COMMANDER_BOARD_MERGE_MS=2000` + 2 次 PATCH → 指挥官会话收到 **恰好 1 条** `[board-edit]`（含 title/priority 两字段，`injectedAt` 均在窗口后写入） |
| archive（draft） | **409 conflict**（"只能从 review\|done\|cancelled 归档"）——契约正确 |
| archive（done 后） | **200**，`archivedAt` 写入；`state.tasks` 排除；`GET /commander/archive` 200 且列表含任务（`ok/tasks/nextCursor/rev`）；restore **200** 后 `state.tasks` 重新包含 |
| state 新字段 | `tasks[].stale`（布尔）、`version`（number）、`archiveSummary` 存在、`metrics`（injections/deduped/pendingSkipped/injectFailures/**projectionUnavailable** 均为 number） |

### M3（验收/返工/整理报告/回合注入）
| 断言 | 实测 |
|---|---|
| attach 派发（复用 M1R 流程） | 首次 needs_confirmation → confirmTarget attach → dispatched；task 有 `primarySessionId`=工作会话；`sessions[]` 记录 `role:"work"` |
| 工作会话 turn（stub 回复）→ turn/end 注入 | 指挥官会话收到 `[session-reply]` 注入；`metrics.injections>=1`；`state.workSessions` 含工作会话 |
| `organize_report`（delivered + 1 acceptance） | 工具执行；任务 **status=review**；task detail 顶层 `acceptance[]` ≥1（`state:"insufficient"`，因隔离 stub 报告证据有限，属预期） |
| **HIGH-1**：`organize_report`（delivered + **空 acceptance**） | 工具返回 **`invalid_request`**（"review requires at least 1 acceptance item…"）；**任务未进入 review**（状态不变量保持） |
| `POST /commander/tasks/:id/rework`（review→running） | **200**，status=running（工作会话 prompt 接受） |
| 再次 organize → review → `accept` | **200**，status=**done**；accept 幂等（done 再 accept duplicate） |
| rework 非 review | **409 conflict** |
| `GET /commander/tasks/:id` 不存在 | **404** |
| 回归 | health 200、`GET /commander/sessions?workspaceId` 200 无回归 |

> 已知限制（隔离环境）：Jev 不可用（`no_key`）→ 首次 dispatch `reason=jev_unavailable`、候选 score 0；工作会话为 stub 模型，`acceptance.state=insufficient` 属证据不足而非失败。UI 层（看板/确认卡/通知栏）由 tester 走查。

## 3. live 预检

- `bash tools/dev/m1r-live-reload.sh`（dry-run）→ **exit 0**：repo/live `lib` **42=42** 一致、dependency=`file:/Users/…/packages/dsh-commander`、bundleListed=true、bundleCount=42（Lead 已在 M1R 时点重装过，新增文件已在副本中）。
- 但 live 运行进程仍是**旧模块**：`GET /commander/state` 的 `metrics` 缺 `projectionUnavailable`（当前 `{injections,deduped,pendingSkipped,injectFailures}`）→ **必须重载**（remove_bundle+install_bundle+set_plugin），刷新/重启 Host 不足以加载新 JS 内容（安装快照语义 + 进程内缓存）。
- devops 沙箱不能写 `~/.dsh` → 重载由 Lead 执行（脚本已 REFUSE 指引）。

## 3.1 live 重装+重载后只读验收（PASS，2026-11-18 10:2x）

- 重载方式（Lead 执行，**无需整机重启**）：`plugin_manager remove_bundle` → `install_bundle file:<repo>/packages/dsh-commander` → `set_plugin enabled=true`；随后 devops 只读复查。
- `bash tools/dev/m1r-live-reload.sh --post-verify`（`DSH_WEB_URL=http://127.0.0.1:64918`）→ **exit 0**；证据 `docs/validation/m2m3-artifacts/live/{reload-postverify-run.log,post-health.json,post-state.json,post-config.json,post-jev-test.json,post-verify-live.txt}`。
- 只读验收（证据 `docs/validation/m2m3-artifacts/live/{acceptance-summary.json,state.json,health.json,config.json,sessions.json,archive.json,jev-test.json}`）：
  - `/commander/health` **200** `{ok:true,version:"0.1.0",panel:"present",binding:"bound"}`
  - `/commander/state` **200**：`workSessions[]`（**3**）、`archiveSummary`（object）、`tasks[]`（4，`stale` 布尔齐全）、`pendingDispatch:null`、`workspaces:29`
  - `metrics`：`{injections:0,deduped:0,pendingSkipped:0,injectFailures:0,**projectionUnavailable:0**}`（**新字段已生效**）
  - `GET /commander/sessions?workspaceId=<state.workspaces[0].id>` → **200**（`ok/sessions[]/rev`）
  - `GET /commander/archive?limit=5` → **200**（`ok/tasks[]/nextCursor/rev`）
  - `GET /commander/config` → **200**；`POST /commander/jev/test` → **200 `ok:true`**（model `jev-1.14.0`、latency 978ms、hasApiKey true）
  - **全部只读断言通过（ALL_READONLY_CHECKS_PASS=true）**
- 页面 boot graph：**SKIP**（无 token URL；页面 401 属 token fence，需浏览器地址栏完整 URL 复验 inject 三项/immediately）——不阻塞 Host 面验收。

## 4. live 重装+重载步骤（Lead 执行；无需整机重启）

```bash
# 0) 构建（devops 已完成：build exit 0，client 223,026B sha 3657c256…）
cd /Users/lzx/Documents/GitHub/dsh-commander && pnpm --filter dsh-commander build
# 1) 重装（快照更新到最新 lib）
plugin_manager action=remove_bundle target=dsh-commander
plugin_manager action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
# 2) 重载插件（不重启整机 DSH）
plugin_manager action=set_plugin target=dsh-commander enabled=true
# 3) devops 只读验收
DSH_WEB_URL=http://127.0.0.1:<PORT> bash tools/dev/m1r-live-reload.sh --post-verify
```

重载后只读验收点（devops 执行）：`/commander/health` 200 `{panel:"present",binding:"bound"}`；`/commander/state` 200 且含 `workSessions[]`、`metrics{injections,deduped,pendingSkipped,injectFailures,projectionUnavailable}`、`archiveSummary`、`tasks[].stale`；`/commander/config` 200；`/commander/sessions?workspaceId=…` 200；`/commander/jev/test` 200；`GET /commander/archive` 200；页面 boot graph（含 token URL 时）inject 三项 + immediately。

## 5. Go / No-Go 与未验证项

- **Go（条件）**：隔离侧全绿；live 重载 + 上述只读验收 PASS 后 GO。
- 未验证/需 tester 覆盖：
  1. UI 层：看板 PATCH 拖拽/状态迁移交互、确认卡自定义 attach、回收站视图、通知/toast、accept/rework 按钮与 loading/错误态；
  2. 注入边界：pending 过滤（审批中跳过）、去重（同 turn 重复注入）、8KB 截断的真实长文本、`pendingSkipped` 计数触发；
  3. rework 失败路径 `502 delivery_failed`（隔离 stub 均接受 prompt，未造失败场景）；
  4. 真模型下 `organize_report` 的 acceptance 证据质量（`insufficient` 判定）；
  5. M2 合并窗口生产值 30s（本轮用 2000ms 缩短测试）。
- 回滚：`plugin_manager action=remove_bundle target=dsh-commander`（域数据保留）；回旧构建 = checkout → build → install_bundle → set_plugin 重载。

## 6. 与 tester 共享

- 复跑：`PROBE_ROOT=/tmp/<x> OUTDIR=/tmp/<y> bash tools/dev/check-m2m3.sh`（会自动 build + 隔离 profile + stub 模型 + fixture workspace；`COMMANDER_BOARD_MERGE_MS=2000`）。
- 工具扩展：`tools/dev/spike/m1-tools-driver.mjs` 新增 `PROBE_M3_ORGANIZE`（delivered+acceptance）、`PROBE_M3_EMPTY`（空 acceptance，HIGH-1 拒绝）、`PROBE_M3_WORK`（工作会话回合触发 turn/end 注入）、`/m1e2e/create-session`、`/m1e2e/agents`。
- 证据：`docs/validation/m2m3-artifacts/{commands.log,49-drive-organize-empty.json,49b-events-organize-empty.json,50-drive-organize.json,52-task-detail-review.json,58*.json,m2m3-final.log}`。

## 7. i18n 修复（task-63）client 重建与 live 交付（2026-11-18 10:4x）

- 背景：frontend 修复 i18n 缺失 key（zh/en 各 +81，字典 237），live 此前 key 直出。
- devops 重建（仅 client 变化）：
  - `pnpm --filter dsh-commander build` → **exit 0**；`lib/client.js` **231,116 B**、sha256 `23a2407ae92f89684c33c6c7e429d58f72c6baed172d5173e6d6d8026e4c537a`（与 frontend 交付一致）
  - `verify-bundle` **exit 0**（9 项 PASS）；`pnpm --filter dsh-commander test` → **206/206 pass**
- **live 磁盘已同步（hardlink 未断）**：repo 与 live 的 `lib/client.js` **同一 inode（193756017）、同 sha（23a2407…）**；`lib/**/*.js` 42=42；`host/index.js`、`host/board/service.js`、`host/trigger/injection.js` sha 全一致 → **Host 未变**。
- **交付动作**：**用户硬刷新页面即可**（client 内容经 hardlink 已更新；Host 无变更 → 不需要 remove/install/set_plugin，也不需要重启 DSH）。已确认当前 live origin `http://127.0.0.1:49359`：health 200、state 200（rev=8、tasks=5、workSessions=3、metrics 含 projectionUnavailable）。
- 只读复查：`verify-live-m0.mjs --origin http://127.0.0.1:49359` → **exit 0（15 PASS + 1 SKIP：页面 boot graph 需 token URL）**；页面文案效果由用户硬刷新后验收（tester 走查）。
- 证据：`docs/validation/m2m3-artifacts/i18n/{client-live-sha.txt,health.json,state.json,verify-live-after-i18n.txt}`。

## 8. 设置页「选择已有会话」绑定选择器（task-64）client 重建与 live 交付（2026-11-18 10:56）

- 背景：frontend 把设置页绑定卡占位替换为完整绑定选择器（工作区 → `GET /commander/sessions?workspaceId=…` → 列表标题/最近活动/上下文水位、已绑定高亮、loading/空态/错误重试/路由缺失降级，选中后 `store.bind({mode:'select',workspaceId,sessionId})`，成功刷新绑定）。
- devops 重建（仅 client）：
  - `pnpm --filter dsh-commander build` → **exit 0**；`lib/client.js` **239,758 B**、sha256 `8ceecdf8af41021acc7b5c803dd683bc21037e8097a3dcf117de965978b3e076`（与 frontend 交付一致）
  - `verify-bundle` **exit 0**（9 项 PASS）；`pnpm --filter dsh-commander test` → **209/209 pass**
- **live 磁盘已同步（hardlink 未断）**：repo 与 live 的 `lib/client.js` 同 inode `193756017`、同 sha `8ceecdf8…`；`lib/**/*.js` 42=42（Host 无变更）→ **用户硬刷新页面即可**（无需重装/重载/重启 DSH）。
- live 只读复查（origin `http://127.0.0.1:49359`）：health 200；state 200（rev=12、tasks=5、workSessions=3、binding=`workspaceId=c83dde64…`/`sessionId=session-59d99d5b…`、metrics 含 projectionUnavailable）；`GET /commander/sessions?workspaceId=…` 已在 §3.1 验证 200（本选择器依赖该路由）。
- `verify-live-m0.mjs --origin` → **exit 0（15 PASS + 1 SKIP：页面 boot graph 需 token URL）**；页面交互（打开设置页→选择已有会话→确认绑定）由用户硬刷新后/tester 走查。
- 证据：`docs/validation/m2m3-artifacts/binding-selector/{client-live-sha.txt,health.json,state.json,verify-live-after-binding-selector.txt}`。

## 9. task-65（绑定会话修复）+ task-66（选择器可读化）构建与验证（2026-11-18 11:1x）

### 9.1 构建（Host task-65 + Client task-66 一起重建）
- `pnpm --filter dsh-commander build` → **exit 0**；`lib/client.js` **245,969 B**、sha256 `6350e37019f91e8a1f3e25a1ca559888756d3c50a9cdd2934d5b238647dada3b`（与 frontend task-66 交付一致）；`verify-bundle` **exit 0**；`pnpm test` → **219/219 pass**。
- **live 安装副本缺新文件**：repo `lib` 43 个 .js vs live 42 个，缺 `host/session/session-records.js` → **Host 必须重装+重载（不是刷新/重启）**；client 部分则经 hardlink 已同步（同 sha），重载后用户硬刷新即可。
- 当前 live 有新旧两个实例（`http://127.0.0.1:58121` 页面 200、`58149` 页面 401，commander/health 均 200）；重载前 `/commander/sessions` 现状（bug 证据）：`title` 全空、无 `createdAt`（8 个会话全如此）——见 `live-before/sessions.json`。

### 9.2 隔离验证（`tools/dev/check-binding-select.sh`，新 home，exit 0，23 ASSERT PASS / 0 FAIL）
流程：boot1 注册两个 fixture 工作区 + 建 ws1 会话并跑一次 stub 回合（产标题快照）→ **重启同 home（会话变冷）** → boot2 验证：
- `GET /commander/sessions?workspaceId=<ws1>` → **200**；含冷会话；**`title` 非空（来自 readTitleSnapshots，示例「订单导出 · 流式改造」）**、`createdAt>0`、`lastActiveAt` 数字字段存在；
- 未知 id `POST /commander/binding {mode:'select'}` → **404**，message 含「可用会话 N 个」；
- 跨工作区（ws2 会话 + `workspaceId=ws1`）→ **409 `workspace_conflict`**；
- **冷会话** `{mode:'select',sessionId}`（不传 workspaceId）→ **200 bound**，workspace 自动推断=ws1；`/commander/state.binding` 持久该冷会话；
- 已绑定后切换（显式 workspaceId=ws2）→ **200**，binding 切换正确。
- 证据：`docs/validation/bindsel-artifacts/{commands.log,11-sessions.json,12-bind-unknown.json,14-bind-cross.json,15-bind-cold.json,16-state-bound.json,17-bind-switch.json,live-before/sessions.json}`。

### 9.3 live 重载后验收（PASS，2026-11-18 11:3x；Lead 已 remove_bundle+install_bundle+set_plugin）

- 重载后（origin `http://127.0.0.1:54132`，`m1r-live-reload.sh --post-verify` → **exit 0**；health 200 `{panel:"present",binding:"bound"}`；state 200 rev=11、tasks=6；`jev/test ok:true` model `jev-1.14.0` 981ms）：
  - `GET /commander/sessions?workspaceId=c83dde64…&limit=5` → **200**，4 行**全部有真实标题**（`Greeting`/`Greeting`/`指挥官`/`Greeting`），`createdAt`/`lastActiveAt` 全为数字，`truncated:false`；
  - `GET /commander/sessions?workspaceId=ebf3d6d3…(agent-workspace)&limit=5` → **200**，5 行中 **4 行有标题**、1 行为空标题（无 title snapshot，前端按设计显示「未命名会话」），`createdAt`/`lastActiveAt` 全为数字，`truncated:true`；
  - `title/createdAt/lastActiveAt` 字段与 task-65 修复目标一致；**冷会话 bindSelect 未在 live 由 devops 执行**（会改变 live 绑定；建议用户在设置页 UI 验证或 tester 走查；隔离侧 23 断言已 PASS，见 §9.2）。
- task-66（选择器可读化）为 client-only：`lib/client.js` sha `6350e370…` 与 live 同 inode/sha，**用户硬刷新页面**即可（本文件 §8/§9.1）。
- 证据：`docs/validation/perf-artifacts/live-after-reload/{post-verify-live.txt,reload-postverify-run.log,sessions-commander-limit5.json,sessions-agent-workspace-limit5.json,shape-result.json}`；Lead 侧 `tests/artifacts/m1/live/t65-bind/`。

### 9.4 交付动作（Lead 已执行，留档）
1. `plugin_manager action=remove_bundle target=dsh-commander` → `action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander` → `action=set_plugin enabled=true`（**重装，不能只刷新/重启**：缺 `host/session/session-records.js` 新文件且运行进程为旧模块）。
2. 重载后：devops 跑 `m1r-live-reload.sh --post-verify` + 只读 `GET /commander/sessions?workspaceId=…`（断言 title 非空/createdAt）；**冷会话绑定 POST 会改变 live 绑定**，建议由用户/Lead 在设置页 UI 验证或明确授权 devops 执行后回绑。
3. 用户硬刷新页面（task-66 选择器可读化/错误文案生效）。

## 10. task-67（sessions 性能回归修复）构建与 live 性能复测（2026-11-18 11:26）

### 10.1 构建与 live 差异
- `pnpm --filter dsh-commander build` → **exit 0**；`pnpm test` → **223/223 pass**；client 未变（sha `6350e370…`，task-67 为 Host-only 修复）。
- live 磁盘：repo/live `lib/**/*.js` **43=43**，`host/session/session-records.js`、`host/session/binding.js`、`host/dispatch/candidates.js`、`host/api/routes/handlers.js` 两侧 sha 相同（磁盘已是最新产物）→ **运行进程仍是旧模块，需 `plugin_manager remove_bundle+install_bundle+set_plugin` 重载（无需整机重启）**。

### 10.2 重载前基线（旧进程；复现回归）
- `GET /commander/sessions?workspaceId=<commander ws>&limit=5` **首次调用 52.9s**（HTTP 200；标题快照缓存冷，复现 backend 报告的 40s+ 量级）；随后同进程多次调用 0.23–0.89s（缓存热）。
- 证据：`docs/validation/perf-artifacts/{baseline-note.json,baseline-cold-sessions-commander.json,perf.log,result.json}`。

### 10.3 复测工具
`tools/dev/check-live-sessions-perf.sh`（新增）：
- `ORIGIN=http://127.0.0.1:<port> MAX_MS=2000 RUNS=3 bash tools/dev/check-live-sessions-perf.sh`
- 自动测 3 个工作区（commander / dsh-commander / agent-workspace）× `limit=5/50`，输出 median/p95/max 与 PASS/FAIL（p95<2s 为达标口径，`result.json` 落盘）。
- 注意：重载后的**首个请求**才是真正的"冷缓存"验证点；建议记录首调用耗时 + 随后 3 次 p95。

### 10.4 重载后性能复测（PASS，2026-11-18 11:3x；RUNS=5，MAX_MS=2000）

`ORIGIN=http://127.0.0.1:54132 MAX_MS=2000 RUNS=5 bash tools/dev/check-live-sessions-perf.sh` → **exit 0（failedCount=0）**；`result.json` 落盘。

| 工作区 | limit | 首调用(cold first) | median | p95 | max | 响应大小 |
|---|---|---|---|---|---|---|
| commander (`c83dde64…`) | 5 | **0.178s**（Lead 重载后首测 0.230s） | 0.154s | 0.178s | 0.178s | 841 B (4 行) |
| commander | 50 | 0.169s | 0.166s | 0.304s | 0.304s | 841 B |
| dsh-commander (`425e43bd…`) | 5 | 0.213s | 0.184s | 0.213s | 0.213s | 1,097 B |
| dsh-commander | 50 | 0.441s | 0.448s | 0.522s | 0.522s | 3,246 B |
| agent-workspace (`ebf3d6d3…`) | 5 | 0.328s（Lead 首测 0.310s） | 0.269s | 0.328s | 0.328s | 1,127 B (5 行) |
| agent-workspace | 50 | 0.946s | 0.917s | **1.986s** | 1.986s | 10,175 B |

- **对比旧进程**：冷首调用 **52.9s → 0.23–0.33s（约 160–230× 改善）**；稳态全部 <2s（agent-workspace limit=50 的 p95 1.986s 接近阈值，若后续会话数增长需 backend 分页/裁剪，属已知余量）。
- 口径说明（按 backend）：p95 取稳态（首调用单列）；本次首调用已非严格冷（Lead 已先命中过 commander/agent-workspace），故同时引用 Lead 重载后首测值。
- 响应形状（`shape-result.json`）：commander 4 行 **4/4 有标题**；agent-workspace 5 行 **4/5 有标题 + 1 空标题**（前端「未命名会话」兜底）；两工作区 `createdAt`/`lastActiveAt` 全部为数字、`ok:true`、`rev` 数字。
- `dispatch_task` live 往返计时：未由 devops 在 live 触发（避免消耗模型回合/改任务）；以 isolated 护栏（listSessions 0 次、mock 17ms/2.7ms）+ Lead/tester 走查计时为准（见 §10.5 留档说明）。

### 10.4b RUNS=5 / coldFirst 单列 + fresh-workspace 复测（2026-11-18 11:3x）

口径：`RUNS=5`；`coldFirst` 单列；p95 取**后 4 次**稳态。命令：
`WORKSPACES="commander:…;dsh-commander:…;agent-workspace:…;capability-settings:…;quick-action:…" ORIGIN=$DSH_WEB_URL MAX_MS=2000 RUNS=5 bash tools/dev/check-live-sessions-perf.sh`

**核心工作区（PASS）**

| 工作区 | limit | coldFirst | median | p95 | max |
|---|---|---|---|---|---|
| commander (c83dde64…) | 5 | 0.228s | 0.188s | **0.191s** | 0.191s |
| commander | 50 | 0.274s | 0.194s | 0.195s | 0.195s |
| dsh-commander (425e43bd…) | 5 | 0.245s | 0.263s | 0.286s | 0.286s |
| dsh-commander | 50 | 0.882s | 0.476s | 0.507s | 0.507s |
| agent-workspace (ebf3d6d3…) | 5 | 0.211s | 0.184s | 0.186s | 0.186s |
| agent-workspace | 50 | 0.860s | 1.021s | 1.023s | 1.023s |

- **旧进程冷首调用 52.9s → 新 0.21–0.27s**（核心工作区，约 200–250×）；稳态 p95 全部远低于 2s。
- Lead 用“从未查询过的工作区”验证：dsh-commander 0.324s、.dsh 0.262s（排除缓存，冷调用已消除）。

**fresh 工作区（发现 1 个 >2s 场景，需 backend 进一步判断）**

| 工作区（会话数） | limit | coldFirst | 复测（×3/×2） | 结论 |
|---|---|---|---|---|
| capability-settings (56 会话) | 5 | 0.649s | 1.08s / 1.12s / 1.37s | <2s |
| capability-settings | 50 | 2.658s | **3.85s / 5.30s** | **>2s（约 50 条标题快照，~4–5s）** |
| quick-action (8 会话) | 5 | 2.041s | 0.91s / 1.00s / 1.47s | 首测受 Host 负载影响，复测 <2s |
| quick-action | 50 | 2.672s | 1.75s / 1.94s | <2s（8 会话） |

- `result-runs5-fresh.json`：3/10 组 p95>=2s（均为 fresh workspace 的 limit=50 / 首测高负载样本）。
- **归因**：同一时段核心工作区也从 ~0.19s 升到 0.56–0.98s → live Host 当时有其它 agent 会话在跑模型，存在**全局负载抖动**；但 capability-settings limit=50 稳定 3.85–5.30s 且随 limit 线性放大（56 会话读取 50 条标题快照，约 70–100ms/条）→ **大工作区 + limit=50 仍有真实成本**。
- 建议（待 lead/backend 决定，devops 未改实现）：① UI 侧固定较小 limit（如 20）；② backend 对 `readTitleSnapshots` 按 limit 前截断并考虑短 TTL 缓存/索引（backend 已列 3 个候选优化）；③ 监控触发条件：工作区会话数 > ~50 且 UI 需要 limit=50 时。

### 10.5 若后续仍慢的采集口径
① `check-live-sessions-perf.sh` 输出（本机已落盘）；② 目标工作区 registry `sessionIds` 数量；③ Host stderr `[commander]` 行；④ `/commander/sessions` 响应大小/行数（本轮：841B/4、1097B/5、1127B/5）。


1. Lead 执行重装+重载（task-67 Host 修复生效）。
2. devops 立即跑 §10.3；记录 commander/dsh-commander/agent-workspace 的 limit=5/50 首调用与 p95/max。
3. `dispatch_task` 首次 needs_confirmation 耗时需真实模型回合（建议 tester/Lead 走查时计时，或授权 devops 在 live 由模型触发一次）；isolated 侧已有 backend 性能护栏测试（listSessions 0 次、标题只读 limit 个 ids、mock 17ms/2.7ms）。
4. 若仍慢：把 `[commander]` Host 日志与该工作区会话数量发 backend（可能需分页/裁剪）。

## 11. task-68（sessions limit=20）+ task-67 并发优化（client/host 重建，2026-11-18 11:4x）

### 11.1 构建
- `pnpm --filter dsh-commander build` → **exit 0**；`pnpm test` → **229/229 pass**；`verify-bundle` **exit 0**。
- `lib/client.js` **246,540 B**、sha256 `07d9af06a984e58388531bc47574abd6376204dcffa833b6e746c97e6c3dd8cf`（= frontend task-68 交付）；repo/live 同 inode/sha（hardlink 已同步）。
- Host task-67 并发优化：`host/session/session-records.js` repo/live sha 相同（`4e6e929f…`），实现 `COMMANDER_SESSION_TITLE_CONCURRENCY`（默认 4 路，1..8；>8 ids 分块并行 `readTitleSnapshots`）；**运行进程仍旧，需 set_plugin 重载**（磁盘已最新，无需 remove/install）。

### 11.2 task-68（client-only，limit=20）
- `fetchSessions` 统一显式 `limit=20`（`BINDING_SESSION_LIMIT=20`，设置页绑定选择器与 M1R attach 卡共用）；`truncated:true` 时列表底部「仅显示最近 20 个会话」提示。
- 交付：**用户硬刷新页面即可**（client-only，无需重载 Host）；Host 的 task-65/67 修复仍按 Lead 安排重载。
- 证据：`lib/client.js` sha（上方）、verify-bundle；frontend 单测 76/76、harness interact 129/129（其侧记录）。

### 11.3 重载前基线（旧进程，limit=20/50；`pre-reload-concurrency/`）
| 工作区 | limit=20 | limit=50 |
|---|---|---|
| capability-settings (56 会话) | **0.99s**（truncated:true，20 行） | 2.83s（>2s） |
| quick-action (8 会话) | 0.81s | 0.98s |

- 说明：task-68 将 UI 请求固定为 limit=20 后，即使旧进程 capability-settings 也在 1s 量级；task-67 并发优化（重载后）应进一步降低 cold/limit50。

### 11.4 待 Lead 重载后复测
`WORKSPACES="capability-settings:cf882f1a…;quick-action:28a9ad76…;commander:c83dde64…;dsh-commander:425e43bd…;agent-workspace:ebf3d6d3…" ORIGIN=$DSH_WEB_URL MAX_MS=2000 RUNS=5 bash tools/dev/check-live-sessions-perf.sh`；重点 limit=20（新 UI 口径）与 limit=50（压力口径）/limit=100；若 limit50 仍 >2s，再用 `COMMANDER_SESSION_TITLE_CONCURRENCY=8` 启动 Host 复测（需 Lead 配合）。

## 12. 最终收口：task-65/66/67/68 live 全量验收（2026-11-18 11:4x）

### 12.1 最终部署与用户确认
- Lead 完成最终 `remove_bundle + install_bundle + set_plugin`（部署 task-68 limit=20 + backend 标题并发优化）；只读复核：health 200、binding 保持 `session-5e70318d…`、state 0.95ms、`GET /commander/sessions?limit=20` **0.181s**（4 行，标题正常：M1R attach 自定义派发验收 / Greeting / 指挥官）。
- **用户实机确认「绑定和切换可以了」——设置页绑定选择器 PASS**（task-64/65/66 收口）。
- 当前 build：client **246,540 B** sha `07d9af06…`（task-68）；Host 含 task-65/67 + M2/M3；`lib/**/*.js` 43 个，repo/live 同 inode/sha。

### 12.2 最终 live 性能（RUNS=5；coldFirst 单列，p95 取后 4 次；origin `http://127.0.0.1:54132`）

**A) UI 主口径 limit=20（PASS，全部 <2s）**

| 工作区 | coldFirst | median | p95 | max | 结果 |
|---|---|---|---|---|---|
| commander (c83dde64…) | 0.186s | 0.224s | 0.367s | 0.367s | PASS |
| dsh-commander (425e43bd…) | 0.950s | 0.963s | 1.089s | 1.089s | PASS |
| agent-workspace (ebf3d6d3…) | 1.044s | 1.041s | 1.363s | 1.363s | PASS |
| capability-settings (cf882f1a…, 56 会话) | 1.868s | 1.622s | 1.649s | 1.649s | PASS |
| quick-action (28a9ad76…) | 0.672s | 0.928s | 1.003s | 1.003s | PASS |

- `result.json`：**ok=true / failedCount=0**；task-68 的 limit=20 改动使大工作区从旧 limit50 的 3.85–5.30s 降到 **cold 1.87s / p95 1.65s** 量级。

**B) 压力口径 limit=50/100（如实记录，后续优化项，不阻塞收口）**

| 工作区 | limit | coldFirst | median | p95 | max | 结论 |
|---|---|---|---|---|---|---|
| capability-settings | 50 | 3.261s | 3.016s | **3.479s** | 3.479s | p95>2s（后续优化） |
| capability-settings | 100 | 3.802s | 3.798s | **4.005s** | 4.005s | p95>2s（后续优化） |
| quick-action | 50 | 2.370s | 1.082s | 1.537s | 1.537s | 稳态 <2s（首调冷抖动） |
| quick-action | 100 | 0.806s | 0.866s | 0.948s | 0.948s | PASS |
| commander | 50 | 0.166s | 0.158s | 0.160s | 0.160s | PASS |
| commander | 100 | 0.158s | 0.162s | 0.249s | 0.249s | PASS |

- 并发优化（`COMMANDER_SESSION_TITLE_CONCURRENCY` 默认 4）对 capability-settings limit50 仍有 ~3.0–4.0s（较优化前 3.85–5.30s 略降）→ 单条 title 快照读取成本仍是瓶颈；因 UI 已固定 limit=20，**该压力场景不影响用户主路径**，列为后续优化（backend 候选：分页/短 TTL+事件失效缓存/按需索引，需 Lead 同意）。
- 旧进程对比：冷首调用 52.9s（commander ws limit5）→ 最终 limit20 所有工作区 coldFirst ≤1.87s（**约 28×+ 改善，且 UI 口径全 PASS**）。
- 证据：`docs/validation/perf-artifacts/final/limit20/{perf.log,result.json,...}`、`docs/validation/perf-artifacts/final/pressure/{perf.log,result.json,...}`；用户确认绑定/切换 PASS（Lead 记录）。

### 12.3 pressure 口径后续优化选项（**Lead 决策：本轮不做，保留为 future backlog / known limitation**；不阻塞收口）

| 选项 | 内容 | 风险/成本 | 决策条件 |
|---|---|---|---|
| a) 分页 | `GET /commander/sessions` 增加 `cursor`（按 sessionId/createdAt），UI 每页 ≤20 | 低风险、无缓存失效；需 backend+frontend 改动 | Lead 要求 pressure 也 <2s 时优先 |
| b) 短 TTL + 事件失效缓存 | 仅缓存 title 快照，TTL 30s；`session/event` 收到该 session 事件立即失效 | 需 Lead 批准（避免缓存掩盖变更）；冷启动首读仍慢 | 允许缓存时 |
| c) 索引/预计算 | 由 `dsh-session-title` 侧长期解决 | 不在本插件范围 | 长期 |

- 8 路并发复测（`COMMANDER_SESSION_TITLE_CONCURRENCY=8`）：需 Lead 用该 env 重启同一 Host；收益受 `dsh-session-query` 内部 `projectMany` worker 总数限制（预期 50 条 3.0–3.5s → ~2s 附近，非严格线性）。是否安排由 Lead 决定。
- 当前状态：UI 主路径（limit=20）全 PASS，pressure 口径（limit50/100 capability-settings 3.0–4.0s）如实记录；backend/ frontend 无其他待办。
- **决策记录（Lead，2026-11-18）**：pressure limit50/100 优化**本轮不做**——UI 主路径 limit=20 全 PASS、无产品需求；**不分页 / 不加缓存 / 不做 8 路复测**，不再需要 reload。§12.3 作为 future backlog/known limitation 保留；若用户后续要求展示 >20 会话，再启动方案 a（分页）。
