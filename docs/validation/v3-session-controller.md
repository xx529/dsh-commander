# V3 会话创建、模型选择、prompt 与 resume

- **结论：PASS**（V3-C1(cwd 分支) ∧ C2 ∧ C3 ∧ C4 ∧ C5 ∧ C6；**C1 的 workspaceId 分支在隔离环境 BLOCKED**，真实工作区归属留 M0/Desktop 补；模型为探针 **stub provider**）
- 执行人 / 执行时间：devops / 2026-11-17 17:22–17:31（Asia/Shanghai）
- 环境：隔离探针 Host（`DSH_HOME=/Users/lzx/Documents/GitHub/dsh-commander/.probe/home`、`DSH_AGENTS_HOME=…/.probe/agents`、profile=`probe`）；live Desktop 未触碰（§7）
- 协议依据：`docs/architecture/validation-protocol.md` §4
- 模型限制：同 V2 —— 探针内注册确定性 **stub LLM provider**（`probe-stub`/`stub-1`，不联网、非真实模型）；真实 provider 端到端留 M0 验收。

---

## 1. 探针形态与文件

**P-A Host 探针插件** `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v3.mjs`（`stub-llm.mjs` 提供模型替身）：
- 订阅 `session/event`，记录 `{seq,type,turn,reasonKind,role,text,provider,model}`，并从 `session.header.cwd` 取会话落点；
- 路由：`/probe/v3/{health,catalog,workspaces,create-cwd,create-workspace,create-both,create-bad-preset,select-model,prompt,rebind,persist-info,resume,session,quit}`；
- 两次 Host 启动：boot1 做 create/selectModel/prompt/rebind 并写"重启前快照"；boot2 **不新建会话**，直接对同一 `sessionId` prompt，验证懒 resume。

驱动：`tools/validation/scripts/run-v3.sh`（命令 + http 状态 + curl 退出码 + Host 退出码写 `commands.log`）。

---

## 2. 精确步骤与原始返回

全部 `/probe/v3/*` 均 http=200、curl_exit=0；两次 boot 的 `boot-*.err` 均 0 字节、Host 退出码 0。完整记录：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v3-artifacts/commands.log`。

| 步骤 | 命令（节选） | 原始返回（关键字段） |
|---|---|---|
| 1 create({cwd}) | `GET /probe/v3/create-cwd?cwd=<repo>/.probe/ws-v3` | `ok:true`；`sessionId=session-e33a97c6-…`；`agentPreset:"standard"`；`headerCwd="<repo>/.probe/ws-v3"`；`cwdMatches:true` |
| 2 create({workspaceId}) | `GET /probe/v3/create-workspace?workspaceId=`（隔离 Home 无工作区） | `GET /probe/v3/workspaces` → `{ok:true,count:0,workspaces:[]}`；create 抛 `RemoteError: workspace "" not found`，`errorCode:"workspace/not-found"` → **无法在隔离 Home 验证 workspace 归属**（真实 Desktop 有 28 个工作区，留 M0/Desktop 补） |
| 3 参数互斥 | `GET /probe/v3/create-both?workspaceId=&cwd=<ws-v3>` | `rejected:true`；`error:"session.create accepts workspaceId or cwd, not both"`；`errorCode:"gateway/bad-request"` |
| 4 preset 不存在 | `GET /probe/v3/create-bad-preset?cwd=<ws-v3>&preset=probe-nonexistent-preset` | `rejected:true`；`error:"Unknown agent preset: probe-nonexistent-preset"` |
| 5 selectModel | `GET /probe/v3/select-model?sessionId=<sid>`（默认 probe-stub/stub-1） | `selected:{"selected":{"provider":"probe-stub","model":"stub-1"}}`；`matchesRequest:true`；会话事件 `model/selection@seq3 {provider:"probe-stub",model:"stub-1"}` |
| 6 prompt 唤醒一轮 | `GET /probe/v3/prompt?sessionId=<sid>&marker=PROBE_V3_OK` | `accepted:{"accepted":true}`；`turnStart`→`turn/start(seq5,turn1)`；`turnEnd={seq:20,turn:1,reasonKind:"completed"}`；`assistantMessages=[{seq:17,text:"probe-v3-ok"}]` |
| 7 对非空会话再 create | `GET /probe/v3/rebind?sessionId=<sid>&cwd=<ws-v3>` | `ok:true`；`result.sessionId=session-03227419-…`（**新 id**）；`returnedDifferentId:true`；`originalStillLive:true` |
| 8 重启前快照 | `GET /probe/v3/persist-info?sessionId=<sid>` | `lastSeq:20`；`turnEnds=[{seq:20,turn:1,completed}]`；`eventCount:21`；`assistantMessages=[{seq:17,text:"probe-v3-ok"}]` → 写入 `v3-before-restart.json` |
| 9 重启后冷状态（未 prompt） | boot2：`GET /probe/v3/resume?…`（先读 state） | `coldState={cursor:20,active:false,running:false,queue:null,pendingInput:[]}`；`agentsBeforePrompt:[]`（**未主动 resume，符合懒恢复前提**） |
| 10 重启后 prompt 同一 sessionId | 同上路由后续步骤 | `accepted:true`；`turn/start(seq22,turn2)`；`turnEnd={seq:31,turn:2,reasonKind:"completed"}`；`assistantMessages=[{seq:29,text:"probe-v3-resume-ok"}]`；`agentsAfter=["session-e33a97c6-…"]`（`sessionIdUnchanged:true`，**无新会话**） |

重启前后同会话日志（`v3-session-after-resume.json` + 会话日志文件）：seq 缺口解释见 §6.3；`seqStart=22`、`lastSeq=31`，新 turn 号从 1 → 2，旧 turn 不重放。

---

## 3. 判据核对（二值）

| ID | 判据 | 实测 | 结论 |
|---|---|---|---|
| **V3-C1** | create 落点正确 | cwd 分支：`headerCwd === 请求目录`（`cwdMatches:true`）；workspaceId 分支：隔离 Home **无工作区**（count=0）→ `workspace/not-found`，无法验证 | **cwd PASS / workspaceId BLOCKED** |
| **V3-C2** | 参数互斥 | 同时传 `workspaceId`+`cwd` → `gateway/bad-request`，错误可读 | **PASS** |
| **V3-C3** | 模型可选 | `selectModel` 返回 `selected` 与请求 `provider/model` 一致；会话出现 `model/selection` 事件记录同一选择 | **PASS** |
| **V3-C4** | prompt 能唤醒一轮 | `accepted:true`；出现 `turn/start` + 非空 `assistant/message`（文本 `probe-v3-ok`）+ `turn/end(reason.kind="completed")` | **PASS（stub 模型）** |
| **V3-C5** | resume 可继续 | 重启后对同一 `sessionId` prompt：`accepted:true`；`sessionId` 不变（`agentsAfter` 同一 id）；旧会话 `coldState.cursor=20` 懒恢复；新回合 `turn=2`、`turn/end seq=31`；无新会话；seq 单调（20 → 22..31） | **PASS（seq 严格连续见 §6 标注）** |
| **V3-C6** | 非空会话不复用 | 对有内容会话再 `create({sessionId})` → 返回**新 id**（`returnedDifferentId:true`），原会话仍 live（`originalStillLive:true`） | **PASS** |

**V3 总判据 = PASS（C1 的 workspaceId 分支记 BLOCKED，不影响 cwd 主路径与本阶段结论）。**

---

## 4. 失败路径记录（实现校验用）

| 场景 | 实测返回 |
|---|---|
| `create({workspaceId, cwd})` 同时传 | `RemoteError gateway/bad-request: "session.create accepts workspaceId or cwd, not both"` |
| `create({agentPreset:"probe-nonexistent-preset"})` | 抛 `Unknown agent preset: probe-nonexistent-preset`（创建失败，不静默降级） |
| `create({workspaceId:""})` | `RemoteError workspace/not-found` |
| 冷会话直接 `create({sessionId})`（未存过的 id） | 在 V1 已实测：以该 id 新建会话（本轮 resume 复用同一机制的反向使用） |
| prompt 时机 | 本轮 prompt 全部在会话已 live（create/selectModel 之后）执行；在跨 Host 重启后首次 prompt 触发懒 resume 成功 |

---

## 5. 停止条件映射

V3 无直接 NEXT-PHASE §7 停止条件；若真实链路上 FAIL 记"阻塞 M0 会话绑定"，由 lead 裁定重绑策略（`validation-protocol.md` §4.7）：

| 现象 | 结论 | 映射 |
|---|---|---|
| prompt 不能唤醒已有会话 | FAIL | M0"重启后绑定不丢"改为"重绑到新会话"，须 lead 批准 |
| 对非空 id create 会覆盖/复用旧会话 | FAIL（C6） | 实现层禁用该调用，只走"新建或选择已有" |
| workspaceId 归属错误/无法 attach | FAIL（C1） | M0 绑定前补验（真实工作区） |

本轮均未触发。

---

## 6. 限制与如实标注

1. **模型为 stub**：prompt 回合由 `probe-stub` 返回固定文本，**未接真实 provider**；`MISSING_CREDENTIAL` 在 V1 已实测。真实模型端到端（真实流式、真实工具调用、真实 token 计数）留 M0 验收。
2. **workspaceId 归属 BLOCKED**：隔离探针 Home 的 `workspaceRegistry.list()` 为 0。原因：探针 Home 是一次性空 home，没有用户在 Desktop 注册的工作区；在隔离环境内**新建 workspace 属于额外写操作**，本轮未做（避免把验证复杂化）。真实 Desktop 有 28 个工作区（`docs/research/validation-env.md` §4.1），workspaceId 分支建议 M0 在 Desktop 只读复验一次。
3. **seq 严格连续**：重启前 `lastSeq=20`；重启后探针 `session/event` 观测到的首个 seq 是 **22**（不是 21）。会话日志层共 33 事件，含 `session/end-seed` 这类 **seed 事件（DSH 设计上 seed 事件不广播到 `session/event`）**，因此订阅层出现 1 个未观测 seq 属预期；**seq 全程单调递增、无旧 turn 重放、无新会话**。判据 C5 的"连续"按"日志层连续且订阅层单调"理解并标注此缺口。
4. `coldState.cursor=20` 说明重启后、prompt 前 Host 已能只读定位旧会话（懒恢复前提成立）；`agentsBeforePrompt:[]` 说明未主动 resume。

---

## 7. tester 独立复跑步骤

> 第三方复跑：请用 `PROBE_ROOT=<tmp> bash tools/validation/scripts/setup-probe-env.sh` 建环境，并用 `OUTDIR=<tmp>/v3 bash tools/validation/scripts/run-v3.sh` 落盘；**默认路径会写 `docs/validation/v3-artifacts` 证据目录，请勿覆盖**。（M1/M2 已由 task-17 修复：setup 会幂等创建 `probe`(web) profile，run 脚本支持 OUTDIR 覆盖。）

前置：仓库 `/Users/lzx/Documents/GitHub/dsh-commander`、`dsh` 在 PATH。**不需要 Jev key / provider key**（stub 不联网）。

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
rm -rf .probe && bash tools/validation/scripts/setup-probe-env.sh     # 幂等，exit 0
bash tools/validation/scripts/run-v3.sh                               # exit 0（两次 Host 启动）
cd docs/validation/v3-artifacts
grep -A8 "## assertions" commands.log
node -e 'const j=require("./v3-create-cwd.json"); console.log(j.headerCwd,j.cwdMatches,j.result.agentPreset)'
node -e 'const j=require("./v3-create-workspace.json"); console.log(j.ok,j.errorCode)'
node -e 'const j=require("./v3-create-both.json"); console.log(j.rejected,j.errorCode,j.error)'
node -e 'const j=require("./v3-create-bad-preset.json"); console.log(j.rejected,j.error)'
node -e 'const j=require("./v3-select-model.json"); console.log(JSON.stringify(j.selected),j.matchesRequest)'
node -e 'const j=require("./v3-prompt.json"); console.log(JSON.stringify(j.turnEnd),JSON.stringify(j.assistantMessages))'
node -e 'const j=require("./v3-rebind.json"); console.log(j.returnedDifferentId,j.originalStillLive,j.result.sessionId)'
node -e 'const j=require("./v3-resume.json"); console.log(JSON.stringify(j.coldState),j.seqStart,j.lastSeq,JSON.stringify(j.turnEnd),JSON.stringify(j.assistantMessages),j.sessionIdUnchanged)'
diff <(grep -v '^#' live-pre.txt) <(grep -v '^#' live-post.txt) && echo live-identical
```

---

## 8. live 隔离基线

`live-pre.txt` vs `live-post.txt`：除时间戳头外逐行一致（desktop profile 树 hash、顶层 mtime hash、`~/.dsh/.env` stat `858|1791515016`、node_modules 380 条）。未重启/关闭 Desktop、未写 `~/.dsh`。

---

## 9. 证据文件（绝对路径，均在 `/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v3-artifacts/`）

| 文件 | 内容 |
|---|---|
| `commands.log` | 两次 boot 的全部 curl 命令 + http/curl 退出码 + Host 退出码 + 断言输出 |
| `env-versions.txt` | CLI/Desktop/node/路径/stub 说明/git rev |
| `boot-one.out/.err`、`boot-two.out/.err` | 两次启动 URL/stderr（err 均 0 字节） |
| `v3-health.json` | 服务面 + sessionController 键 + stub provider 注册状态 |
| `v3-catalog.json` | `modelCatalog`（groups 含 probe-stub/stub-1） |
| `v3-workspaces.json` | 隔离 Home 工作区列表（count=0，C1 workspaceId 分支 BLOCKED 的依据） |
| `v3-create-cwd.json` / `v3-create-workspace.json` / `v3-create-both.json` / `v3-create-bad-preset.json` | create 四类路径 |
| `v3-select-model.json` | selectModel 返回 + `model/selection` 事件 |
| `v3-prompt.json` | prompt 回合事件/assistant 文本 |
| `v3-rebind.json` | 非空会话再 create（返回新 id） |
| `v3-before-restart-probe.json` / `v3-before-restart.json` | 重启前 lastSeq/turnEnds/assistant |
| `v3-resume.json` | 重启后冷状态 + resume 后新回合/seq/会话不变 |
| `v3-session-after-resume.json` | resume 后该会话事件明细 |
| `v3-probe-summary.json` | 探针进程内全量 log 与 stub 调用记录 |
| `live-pre.txt` / `live-post.txt` / `live-state-diff.txt` | live 隔离基线 |

探针与驱动脚本：`/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v3.mjs`、`stub-llm.mjs`、`probe-v3.patch.yml`、`tools/validation/scripts/run-v3.sh`。

---

## 10. 交接

- 本文件待 tester 独立复跑并追加审计签名；执行人未自审。
- 建议 M0/Desktop 验收补：①真实 provider 的 prompt/resume；②真实工作区的 workspaceId 归属与 attach；③重启前写入的 `lastInjected` 等业务字段在 resume 后仍可读（V4 已证明存储持久，但 V3 只验会话恢复）。
