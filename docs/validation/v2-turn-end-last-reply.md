# V2 会话停止、最后回复、pendingInteraction 与去重

- **结论：PASS**（V2-C1 ∧ C2 ∧ C3 ∧ C4 ∧ C5；模型为探针 **stub provider**，审批为探针注入 answerer，headless 差异见 §6）
- 执行人 / 执行时间：devops / 2026-11-17 17:14–17:27（Asia/Shanghai）
- 环境：隔离探针 Host（`DSH_HOME=/Users/lzx/Documents/GitHub/dsh-commander/.probe/home`、`DSH_AGENTS_HOME=…/.probe/agents`、profile=`probe`）；live Desktop 未触碰（§7）
- 协议依据：`docs/architecture/validation-protocol.md` §3；决策口径：`docs/architecture/implementation-plan.md` §7

> **模型限制（必须随结论读）**：隔离探针 Home 无 provider 凭据（V1 已实测 `MISSING_CREDENTIAL`）。为验证 turn/tool/审批链路，探针在 Host 内注册了一个**确定性 stub LLM provider**（`probe-stub` / `stub-1`，见 `tools/validation/probes/stub-llm.mjs`），它按用户文本标记返回文本或 `bash` 工具调用，**不联网、不产生计费、不是真实模型**。真实 provider 的端到端行为（真实模型产出、真实 token、真实工具调用分布）留 M0 验收。

---

## 1. 目标与探针形态

**P-A Host 探针插件** `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v2.mjs`：
- 订阅 `session/event`（压成 `{seq,type,turn,reasonKind,role,text*}`；`assistant/message` 保留全文用于逐字比对）与 `agent/status`（仅记录，不用于判定）；
- 实现**与实现蓝图 §7 同口径的决策纯函数**（`turn/end` 触发、turn 区间最后一个 `assistant/message`、8KB 头 6KB+尾 2KB 截断、未配对 `approval/asked`/`userQuestions` 判 pending、去重键 `<sessionId>:<turnId>:<lastSeq>`），可经 `/probe/v2/decide` 对任意 `{sessionId,turn,endSeq}` 求值而**不真正注入**；
- 审批 answerer：`ctx.on('approval/request', …, prepend=true)` 注册测试 answerer——收到请求后**挂起等待**，由 `/probe/v2/release` 放行/拒绝，从而制造"审批等待窗口"；
- 路由：`/probe/v2/{health,scenario,approval,release,next-turn,decide,inject,session,quit}`。

`run-v2.sh` 用 curl 逐步驱动并把原始返回落盘（`commands.log` 记录每条命令 + http 状态 + curl 退出码 + Host 退出码）。

---

## 2. 精确步骤与原始返回

完整命令与退出码：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v2-artifacts/commands.log`（所有 `/probe/v2/*` 均 http=200、curl_exit=0；Host 退出码 0；`boot.err` 0 字节）。

### 2.1 普通完成回合（`GET /probe/v2/scenario?mode=plain`）

- 会话 `session-…`，`selectModel(probe-stub/stub-1)`，prompt `PROBE_V2_PLAIN 只回一句`；
- `turnStarts=[{seq:5,turn:1}]`、`turnEnds=[{seq:20,turn:1,reasonKind:"completed"}]`；
- `assistantMessages=[{seq:17,blockTypes:["text"],textLength:17,textHead:"probe-v2-plain-ok"}]`；
- 决策：`decisionAtEnd={shouldInject:true,reason:"idle",dedupeKey:"<sid>:1:17",lastSeq:17,turnStartSeq:5}`；`decisionTextEqualsLastAssistant:true`；
- `inject1={injected:true}`（模拟投递成功并写 `lastInjected={turnId:1,seq:17}`）；`inject2={shouldInject:false,reason:"duplicate"}`。

### 2.2 工具回合（`GET /probe/v2/scenario?mode=tool`）

- stub 先返回 `bash` 工具调用（工具参数 `echo probe-v2-tool-ok`），工具执行后再返回文本；
- `assistantMessages=[{seq:17,blockTypes:["tool-call"],textLength:0},{seq:24,blockTypes:["text"],textLength:18,textHead:"probe-v2-tool-done"}]`；
- `toolEvents=[{seq:18,type:"tool/call",turn:1},{seq:21,type:"tool/result",turn:1}]`；
- 回合内逐步求值（`midTurnEvaluations`）：`assistant/message@17`、`tool/call@18`、`tool/result@21`、`assistant/message@24` 时刻 `turnEndedBeforeEvaluation:false`、`injectableByEventType:false`；
- 回合结束后决策 `lastSeq=24`、`text="probe-v2-tool-done"`、`decisionTextEqualsLastAssistant:true` → **中间 tool/call、tool/result、空文本 assistant 片段都不是"最后回复"**。

### 2.3 审批等待（`GET /probe/v2/approval`，返回时仍在等待）

```json
{
  "approvalWait": {"toolName":"bash","callId":"call_probe_…","released":false},
  "approvalAsked": {"seq":19,"type":"approval/asked","approvalId":"…","toolName":"bash"},
  "approvalDecided": null,
  "turnEndedWhileWaiting": false,
  "pendingInteractionSnapshot": {"unpairedApprovals":[{"approvalId":"…","seq":19,"toolName":"bash"}],"userQuestionsActive":0},
  "decisionDuringWait": {"shouldInject":false,"reason":"pending_interaction","dedupeKey":"<sid>:null:17","lastSeq":17}
}
```

→ **审批等待期没有 `turn/end`、判定不注入**（reason=`pending_interaction`），与 Client `useSessionStatus().pendingInteraction` 非空同源（见 §6）。

### 2.4 放行后（`GET /probe/v2/release?action=allow`）

```json
{
  "approvalPairs": [{"approvalId":"…","askedSeq":19,"decidedSeq":20,"outcome":"allowed-once"}],
  "turnEnd": {"seq":29,"turn":1,"reasonKind":"completed"},
  "decisionAfterEnd": {"shouldInject":true,"reason":"idle","dedupeKey":"<sid>:1:26","lastSeq":26,"text":"probe-v2-tool-done"},
  "inject1": {"shouldInject":true,"injected":true},
  "inject2": {"shouldInject":false,"reason":"duplicate"}
}
```

→ 审批恢复后回合结束、**仅注入一次**；同键第二次 `duplicate`；`approval/asked seq19` 与 `approval/decided seq20` 按 `approvalId` 成对。

### 2.5 跨 turn 不误杀（`GET /probe/v2/next-turn?sessionId=…`）

- 同会话第二回合：`turnEnds=[{seq:29,turn:1,completed},{seq:37,turn:2,completed}]`；
- `previousLastInjected={turnId:1,seq:26}`；
- 决策：`{shouldInject:true,reason:"idle",dedupeKey:"<sid>:2:35"}` —— 新 turn/新 lastSeq 构成新键，**跨 turn 不被误去重**。

---

## 3. 判据核对（二值）

| ID | 判据 | 实测 | 结论 |
|---|---|---|---|
| **V2-C1** | turn 边界稳定 | 两场景均恰 1 个 `turn/start` + 1 个 `turn/end`；plain `start.turn=1=end.turn`、tool 同样；`reason.kind` 实测枚举到 `completed`（另在 V1 探针中实测到 `error`） | **PASS** |
| **V2-C2** | 最后回复可唯一确定 | 决策取 turn 区间内**最后** `assistant/message`（plain seq17、tool seq24）；决策文本与最后 assistant 文本 **逐字相等**（`decisionTextEqualsLastAssistant:true`）；tool 场景中间空文本 tool-call assistant（seq17）被跳过 | **PASS** |
| **V2-C3** | 中间事件不注入 | 回合内 `assistant/message`/`tool/call`/`tool/result` 时刻求值均非可注入（无 `turn/end`）；只有 `turn/end` 后 `shouldInject:true` | **PASS** |
| **V2-C4** | pending 不注入 | 审批等待：未配对 `approval/asked`(seq19) 存在、`turnEndedWhileWaiting:false`、决策 `pending_interaction`；放行后配对 `asked19→decided20`、回合结束、决策 true | **PASS（Host 侧口径）** |
| **V2-C5** | 去重正确 | 同键二次 `duplicate`；去重键明文 `<sessionId>:<turnId>:<lastSeq>`；跨 turn 新键 `shouldInject:true` | **PASS** |

**V2 总判据 = C1∧C2∧C3∧C4∧C5 = PASS。**

---

## 4. 关键结论（给实现）

1. `turn/end` 与"最后一条 assistant 回复"的对应关系**稳定**：以 `turn/end.data.turn` 定位同 turn 的最近 `turn/start`，区间内最后一个 `assistant/message` 即最后回复；写实现时用**事件日志**而不是轮询。
2. **pending 过滤是必要的**：审批等待期确实没有新的 `turn/end`，但若实现误把"回合中某次 assistant 输出"当停止，就会在审批未完成时注入；未配对 `approval/asked` 必须在判定里排除。
3. **去重键 `<sessionId>:<turnId>:<lastSeq>` 充分**：同键二次注入被拦、跨 turn 新键放行；`lastInjected` 写 `{turnId,seq,at}` 即可（对应 V4 的 `SessionLinkRecord.lastInjected` 落盘语义）。
4. 8KB 截断逻辑单元（头 6KB+尾 2KB+`…[truncated N bytes]…`）已按蓝图 §7.2 实现并在决策函数内；本轮 stub 回复短，未覆盖 >8KB 分支（见 §6 残余项）。

---

## 5. 停止条件映射

本轮 **PASS，不触发 NEXT-PHASE §7.2**。若后续真实链路出现下列现象，按映射处置：

| 现象 | 结论 | 映射 |
|---|---|---|
| `turn/end` 缺失 / 一回合多次 / 无法定位最后 assistant | V2 FAIL（C1/C2） | §7.2 回到设计，禁止轮询硬凑 |
| 审批等待期仍 `shouldInject:true`，或 Host 与 Client 判定不一致 | V2 FAIL（C4） | §7.2；检查是否用 agent/status 轮询 |
| 同键重复注入或跨 turn 误去重 | V2 FAIL（C5） | 修去重键实现后重测 |

---

## 6. 与真实 Desktop 的差异（如实标注，不掩盖）

1. **模型是 stub**：`probe-stub` 返回固定文本/固定 `bash` 工具调用；真实模型的流式分片、空回复、超长回复（>8KB）分支未在真实模型上覆盖。→ 残余项，M0 验收用真实 provider 复跑 `run-v2.sh`（仅需替换 stub 为真实 provider）。
2. **审批 answerer 是探针注入的**：探针用 `ctx.on('approval/request', …, prepend)` 挂起/放行，模拟真实 UI 的"等待→作答"。差异：真实 Desktop 的作答来自浏览器 Client（`connection` + approval UI），探针不注册第二个 UI answerer、不改审批所有权。
3. **pendingInteraction 用 Host 侧等价信号**：headless 探针没有浏览器，无法读 `useSessionStatus(sessionId).pendingInteraction`。探针记录的"未配对 `approval/asked`"是 Client 该字段的**上游同源数据**（`dsh-client-ui-session` 的 pendingInteraction 由各域 publisher 基于会话事件发布，`dsh-client-ui-approval` 在 `approval/asked` 时发布、`approval/decided` 时撤销；源码：`<CLI>/node_modules/@deepseek-ai/dsh-client-ui-session/src/client/index.ts:64,107-127`、`dsh-client-ui-approval/src/client/index.ts`）。→ 判为 PASS（Host 判定正确），但"真实浏览器 UI 上 pendingInteraction 非空"这一条属 **UNVERIFIED**，需在 Desktop/V2 的 P-C 形态补一次只读快照（协议 §12.4 允许）。
4. `userQuestions.active` 在探针会话中为 0（未构造用户提问场景）；判定逻辑已实现（取投影快照）但本轮未触发非空分支。

---

## 7. tester 独立复跑步骤

> 第三方复跑：请用 `PROBE_ROOT=<tmp> bash tools/validation/scripts/setup-probe-env.sh` 建环境，并用 `OUTDIR=<tmp>/v2 bash tools/validation/scripts/run-v2.sh` 落盘；**默认路径会写 `docs/validation/v2-artifacts` 证据目录，请勿覆盖**。（M1/M2 已由 task-17 修复：setup 会幂等创建 `probe`(web) profile，run 脚本支持 OUTDIR 覆盖。）

前置：仓库 `/Users/lzx/Documents/GitHub/dsh-commander`、`dsh` 在 PATH。**不需要 Jev key / provider key**（stub 不联网）。

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
rm -rf .probe && bash tools/validation/scripts/setup-probe-env.sh     # 幂等，exit 0
bash tools/validation/scripts/run-v2.sh                                # exit 0
cd docs/validation/v2-artifacts
grep -A8 "## assertions" commands.log                                  # 五条断言
node -e 'const p=require("./v2-scenario-plain.json"),t=require("./v2-scenario-tool.json"); console.log(p.turnStarts,p.turnEnds,p.decisionTextEqualsLastAssistant,t.toolEvents,t.decisionAtEnd.lastSeq)'
node -e 'const j=require("./v2-approval-wait.json"); console.log(j.approvalAsked.seq,j.approvalDecided,j.turnEndedWhileWaiting,j.decisionDuringWait.reason)'
node -e 'const j=require("./v2-approval-release.json"); console.log(JSON.stringify(j.approvalPairs),j.inject1.injected,j.inject2.reason)'
node -e 'const j=require("./v2-cross-turn.json"); console.log(j.turnEnds,j.decisionAfter.shouldInject,j.decisionAfter.dedupeKey)'
diff <(grep -v '^#' live-pre.txt) <(grep -v '^#' live-post.txt) && echo live-identical
```

---

## 8. live 隔离基线

`live-pre.txt` vs `live-post.txt`：除时间戳头外逐行一致（desktop profile 树 hash、顶层 mtime hash、`~/.dsh/.env` stat `858|1791515016`、node_modules 380 条）。未重启/关闭 Desktop、未写 `~/.dsh`。

---

## 9. 证据文件（绝对路径，均在 `/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v2-artifacts/`）

| 文件 | 内容 |
|---|---|
| `commands.log` | 全部 curl 命令 + http/curl 退出码 + Host 退出码 + 5 条断言 |
| `env-versions.txt` | CLI/Desktop/node/路径/stub 说明/git rev |
| `boot.out` / `boot.err` | 启动 URL；stderr 0 字节 |
| `v2-health.json` | 服务面 + stub provider 已注册 |
| `v2-scenario-plain.json` / `v2-scenario-tool.json` | 普通/工具回合：turn 边界、assistant 序列、mid-turn 求值、决策/注入/去重 |
| `v2-approval-wait.json` | 审批等待：asked 未配对、无 turn/end、pending 判定 |
| `v2-approval-release.json` | 放行后：asked/decided 配对、turn/end、注入一次、二次 duplicate |
| `v2-cross-turn.json` | 跨 turn 新键放行 |
| `v2-session-approval.json` | 审批会话全事件（seq/type/turn） |
| `v2-probe-summary.json` | 探针进程内全量事件与 stub 调用记录 |
| `live-pre.txt` / `live-post.txt` / `live-state-diff.txt` | live 隔离基线 |

探针与驱动脚本：`/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v2.mjs`、`stub-llm.mjs`、`probe-v2.patch.yml`、`tools/validation/scripts/run-v2.sh`。

---

## 10. 交接

- 本文件待 tester 独立复跑并追加审计签名；执行人未自审。
- 残余（不阻塞 V2 结论）：真实 provider 的 >8KB 截断分支、真实浏览器 pendingInteraction 快照、`userQuestions.active>0` 分支 —— 建议 M0/Desktop 验收补。
