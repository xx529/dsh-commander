# M0-2 面板消息通道 API 形状验证（隔离 profile）

- **结论：PASS**（两个 binding 成功分支 + message 200 + 幂等 + user echo + SSE + V4 式持久化，**41/41 断言 PASS，exit 0**；全新隔离 home）
- 执行人 / 执行时间：devops / 2026-11-17 21:20–21:24（最新一轮，`PROBE_ROOT=/tmp/dsh-commander-m0-api3`）
- 环境：一次性 `DSH_HOME=/tmp/dsh-commander-m0-api3-{wsid,cwd}`（web 模板 + 本包 + fixture 工作区），**未装 live desktop、未写 `~/.dsh`**
- 证据：`docs/validation/m0-artifacts-api/`（`commands.log` 41 条 ASSERT PASS / 0 FAIL；脚本 `tools/dev/check-m0-api.sh`）
- 复跑：`PROBE_ROOT=/tmp/dsh-commander-m0-apiN bash tools/dev/check-m0-api.sh`（建议换新 N；第三方复跑加 `OUTDIR=/tmp/...` 避免覆盖证据）

## 1. 覆盖范围与结果

### case A：`binding mode=new + workspaceId`（隔离 Home 先注册一个工作区，fixture `tools/dev/spike/m0-workspace-fixture.mjs`）

| 断言 | 实测 |
|---|---|
| boot | `[commander] host ready (version=0.1.0, domainVia=defineDomain, configInitialized=true, panel=absent)` 可见（`COMMANDER_BOOT_LOG=warn` → **stderr**）；fixture 工作区注册成功 |
| `GET /commander/state` | 200；workspaces=1（fixture） |
| `POST /commander/binding {mode:new, workspaceId}` | **200** `{"ok":true,"binding":{"workspaceId":"…","workspacePath":"/private/tmp/…","sessionId":"session-…"},"commanderStatus":"bound","rev":…}` |
| `GET /commander/config` | 200，含 `jev.threshold` |
| `POST /commander/message` | **200** `{"ok":true,"accepted":true,"messageId":"req_msg_smoke_1","sessionId":"session-…",…}` |
| 同 requestId 重发 | **200**，`messageId` 相同（幂等） |
| `GET /commander/state` after message | 200；`messages` 含 user echo（`messageId=req_msg_smoke_1`、`role=user`） |
| SSE（先开流再发新消息） | 首帧 `event: snapshot`；随后 `event: commander.message` 且 payload `"role":"user"` |
| `PUT /commander/config {jev.threshold:0.66}` | 200 |
| `PUT /commander/workspaces [{id,allowed:false,summary:'m0-persist-probe',policy:'inherit'}]` | 200 |
| **重启同 home（第二次 boot）** | `GET /commander/config` → `jev.threshold=0.66` 持久；`GET /commander/state` → `binding.sessionId` 不变、`workspaces[0]={summary:"m0-persist-probe",allowed:false}` 持久 |

### case B：`binding mode=new + cwd`（无注册工作区，cwd-only 合同分支）

| 断言 | 实测 |
|---|---|
| `GET /commander/state`（fresh home） | 200；workspaces=0（走 cwd-only 分支） |
| `POST /commander/binding {mode:new, cwd}` | **200**，`sessionId` 已建、`commanderStatus:"bound"` |
| `POST /commander/message` | **200** `accepted:true`、`messageId=req_msg_smoke_1` |
| 幂等 / user echo / SSE user | 同上均 PASS |

> 两条 binding 分支现在都严格「workspaceId 或 cwd 二选一」（backend 已修 HIGH bug；`workspaceId` 分支不再同传 cwd，隔离 Home 注册表按 id 解析）。

## 2. 隔离环境限制（如实标注）

- **无模型 provider key**：`message` 会 `accepted:true` 后 prompt 在 provider 处失败（`MISSING_CREDENTIAL`）。因此「真实 assistant 回合 / `commanderBusy` true→false / SSE `role=assistant`」不在本轮范围，留 live desktop 验收（live 已装，见 `docs/validation/m0-live-install.md`）。
- `panel:"absent"` 是隔离 Home 预期（未装能力面板）；desktop 实测 `panel:"present"`。

## 3. live-state 差异说明（非 devops 写 live）

本轮 `live-pre` vs `live-post` 的 desktop profile 树 hash 不同，原因已定位（frontend 复核 + devops 实测 inode）：

- **主因：live 包与 repo 是 hardlink（同一 inode）**，脚本启动时会跑 `pnpm --filter dsh-commander build` 重建 repo `packages/dsh-commander/lib/**`，**同一 inode 的 live 文件 mtime/size 随之变化**（实测 client.js ino=193756017、sha 692ceede…，mtime=21:22:55，落在我这轮 21:20–21:23 窗口内）；
- 次要：`~/.dsh/mobile-stats.json`（Desktop 运行时写入）。

devops **未写 `~/.dsh` 的配置类文件**（profile `package.json`/`pnpm-lock`/bundles 未变；只有 hardlink 指向的构建产物文件随 repo build 变化）。该差异不影响 M0-2 结论（脚本中只作提示、不作断言）。**后续做 live 隔离基线时**，以 `desktop/package.json` + `pnpm-lock.yaml` 的 sha 或 hardlink 解释为判据。

## 4. 本轮修复历史（与 backend 联调）

| 发现 | 根因 | 状态 |
|---|---|---|
| `message` 502 `throwIfAborted` | `sessionController.prompt(request)` 漏传 `signal` | backend 已修（`prompt(request, new AbortController().signal)`） |
| `binding` 500 `session.create accepts workspaceId or cwd, not both` | bindNew 同时传两参 | backend 已修（严格二选一，fake 同步按真实合同校验） |
| `message` 502 `Cannot read properties of undefined (reading 'ctx')` | 解构 `controller.prompt` 丢 receiver | backend 已修（保留 controller receiver） |
| 持久化布局 `single` vs `per-record` | `commanderDomainSpec` 漏 `layout:'per-record'` | backend 已修；本轮用**全新 home** 重测持久化 PASS |
| boot ready 行不可见 | `logger.warn` 被 boot 层吸收 | backend 改为同时 `console.error`；本轮在 **stderr** 可见 |
| 旧脚本 PUT 路由用 POST 调（405） | 脚本 helper 只发 POST | 本轮已修：新增 `put()` helper |

## 5. 证据清单（`docs/validation/m0-artifacts-api/`）

`00-run-summary.txt`、`01-build.log`、`02-default-config-*.yml`、`03-plugin-add-*.log`、`04-boot-*.out/.err`、`05-boot-commander-lines-*.txt`、`10-state-initial-*.json`、`11-config.json`、`12-binding-wsid.json`/`12-binding-cwd.json`、`14-message-*.json`、`15-message-repeat-*.json`、`16-state-after-message-*.json`、`17-sse-*.txt`/`17b-message-sse-*.json`、`18-put-config.json`/`18b-put-workspaces.json`、`19-config-after-restart.json`/`19b-state-after-restart.json`、`commands.log`、`live-pre/post.txt`、`live-state-diff.txt`。
