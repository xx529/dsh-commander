# V1–V4 独立复跑与证据审计（V5 引用既有审计）

> 角色：**tester**（独立复核；只读 devops 证据与 `~/.dsh`，只写 `tests/**` 与 `docs/validation/audit-*.md`；未改 `docs/validation/v{1,2,3,4}-*` 与 `tools/validation/**`）。
> 任务：`task-6`（Lead 2026-11-17 指令：V1–V4 独立复跑与证据审计，25 分钟时间盒，聚焦门禁关键断言）。
> 交付：本文件 + `tests/validation/run-all.mjs`（一条命令复跑/断言）+ `tests/validation/repro/**`（独立复跑脚本副本与 patch）+ `tests/validation/runs/**`（复跑输出）。
> 结论（二值）：**V1 = PASS、V2 = PASS、V3 = PASS、V4 = PASS（文档结论与证据一致、关键断言可复现）；V5 = FAIL 不变（见 `docs/validation/audit-V5-v2.md`，本文件不重复裁定）。**
> 严重级别计数：**HIGH 0 / MEDIUM 2 / LOW 3**。
> 独立复跑结果：**4/4 run 脚本 exit 0；30/30 断言 PASS；与 devops 证据 parity 30/30（0 mismatch）**（`tests/validation/runs/assertions-{devops,rerun,diff}.json`）。

## 0. 复核对象与方法

- **证据审计（只读）**：逐份核对 `docs/validation/v{1,2,3,4}-*.md` 的结论与 `v{1,2,3,4}-artifacts/` 原始证据（`commands.log` 的 http/curl/Host 退出码、关键 JSON 字段、live 前后基线 diff）。把关键判据写成 **30 条可执行断言**（V1 8 / V2 5 / V3 7 / V4 4 / V5 6），全部以 artifact JSON 为输入，不读文档结论。
- **独立复跑（隔离环境）**：`tests/validation/repro/` 是 `tools/validation/scripts/{setup-probe-env,run-v1..v4}.sh` 的**副本改造**（原脚本写死 `docs/validation/vN-artifacts`，直接跑会覆盖 devops 证据，违反本任务约束）：
  - `PROBE_ROOT` → `tests/validation/.probe-tester`（全新隔离 `DSH_HOME/DSH_AGENTS_HOME`，不触碰 live Desktop / `~/.dsh`；`live-state.sh` 前后快照仍在各 run 目录）；
  - `OUTDIR` → `tests/validation/runs/vN/`；patch 副本的 `.probe` 路径同步重写；
  - key 仅在进程内 `source /tmp/dsh-commander-probe/jev.env`（未打印/未落盘）。
- **V5**：冻结案例 schema/输入完整性/harness mock 由本脚本断言；live 指标引用 task-12 独立复跑证据（`tests/v5-audit/live/summary-v2-layered-rerun.json`，与 backend 同结论），V5 二值裁定见 `audit-V5-v2.md`（**FAIL**）。

复跑/断言命令：

```bash
node tests/validation/run-all.mjs            # 断言 devops 证据（只读）
node tests/validation/run-all.mjs --run      # 独立复跑（setup + v1..v4 → tests/validation/runs/**）后断言
node tests/validation/run-all.mjs --base rerun   # 断言 tester 独立复跑输出
```

## 1. 证据审计（devops artifacts，只读断言）

`node tests/validation/run-all.mjs` → **30/30 PASS，0 FAIL**（逐条证据见 §4 表）。要点：

| 版本 | 文档结论 | 证据审计关键项（全部为 artifact 直接可核） |
|---|---|---|
| V1 | PASS（C1–C5） | A1 面板禁用回退 `{mode:inherit,reason:panel_unavailable}`、panelResolved=false；B0 工厂 thunk 解析 `panelRawType=function,version=1.19.3`；B2 rank `ok+items=8`；B3 冷会话 apply `pending:true,applied:0`；B5 `create({sessionId})` 返回同 id；B7 `pendingOutcome.applied=1`；B8 `probe-e2e-testing.enabledInSession=true`；B11/B12/B14/B15 disable→enable 往返一致。`commands.log` 全步 http=200/curl_exit=0、Host exit=0、boot err 0 字节；`live-state-diff.txt` 0 字节 |
| V2 | PASS（C1–C5） | plain `decisionAtEnd.shouldInject=true/lastSeq=17`、inject1 `injected:true`、inject2 `duplicate`；approval-wait `released=false`+`decisionDuringWait.shouldInject=false`+`pendingApprovals=1`；release `approvalPairs[0].outcome=allowed-once`+一次注入+duplicate；cross-turn `decisionAfter.turnId=2` 新键可注入。`commands.log` http=200 全过、Host exit 0、boot.err 0 字节、live diff 0 |
| V3 | PASS（C1–C6） | create-cwd `cwdMatches=true`；create-both `rejected=true`；bad-preset `rejected=true,error=Unknown agent preset`；selectModel `probe-stub/stub-1`；prompt `turnEnd.completed`+assistant 1 条；before-restart `lastSeq=20,turnEnds=[turn1]`；resume `sessionIdUnchanged=true,turnEnd.turn=2,agentsAfter` 含同 id（无新会话）。`commands.log` 全 http=200、两次 boot err 0、live diff 0 |
| V4 | PASS（按 Lead 裁定的 `board_edits` 口径；C1–C7） | `v4-run-renamed.json`：`tables` 含 `board_edits`，10 个 case 全 `ok:true`（C1_open/C2_roundtrip/C3_keys/C4_update/C5_concurrent/C5b/C5c/C4b/C8b/close）；C3 非法 key 拒绝且 sanitize/域不脏；restart-check `ok:true,task.version=6`、configSingleton 完整；**缺陷证据保留**：`v4-run-blueprint.json` 原名 `boardEdits` 实测 C1 FAIL（`invalid table name`） |

## 2. 发现清单（严重级别）

### HIGH（0）
未发现“文档结论与证据矛盾”或“关键门禁断言不可复现”。V1–V4 文档结论均被 artifact 逐项支持；V4 改名属 Lead 裁定的 schema 修正、且两段式证据（FAIL→裁定→PASS）完整保留，不构成结论矛盾。

### MEDIUM（2）

**M1 `tools/validation/scripts/setup-probe-env.sh` 不能复现文档声明的探针 profile（证据可复现性缺口）。**
- 事实：脚本 `PROFILE=scout`，只初始化 `@deepseek-ai/dsh-base`（无 `@deepseek-ai/dsh-web-app`、无 `probe` profile）；而 `docs/validation/v1-capability-panel.md` §1 与 `run-v{1..4}.sh` 均使用 **profile=`probe` = base + web-app + dsh-capability-settings**。在全新 `PROBE_ROOT` 上执行该 setup 后 `profiles/probe` 不存在（实测输出 `profile=…/profiles/scout`），run 脚本无法启动 Host（本次独立复跑因此改用具名 profile 复制，见 §3）。
- 影响：**按仓库脚本从零复现 V1–V4 证据链不成立**；文档“幂等 setup + 一键复跑”的声明与实现不一致。归 owner：**devops**（补建 probe profile 或更正文档；本审计已在 `tests/validation/repro/setup-probe-env.tester.sh` 补建，供复跑使用）。
- 严重级别判定：MEDIUM（不推翻 V1–V4 结论，但影响“独立复跑”的证据强度）。

**M2 V1–V4 run 脚本写死输出目录为 `docs/validation/v*-artifacts`，无 `OUTDIR` 支持。**
- 事实：`run-v{1..4}.sh` 中 `ART="$REPO/docs/validation/vN-artifacts"`；直接按文档复跑会**覆盖 devops 原始证据**（本任务明令禁止）。已在 `tests/validation/repro/*.tester.sh` 副本改为 `${OUTDIR:-…}`；建议上游脚本加 `OUTDIR=${OUTDIR:-docs/validation/vN-artifacts}`（owner：devops）。
- 影响：若不改，任何第三方复跑都会破坏证据链（与 protocol §6.2A“禁止覆盖证据”精神冲突）。MEDIUM。

### LOW（3）
- **L1** V2/V3 使用探针 **stub LLM provider**（`probe-stub/stub-1`，不联网、非真实模型）——文档已显著声明并留 M0 真 provider 验收，不构成缺陷，仅提示门禁外推需谨慎。
- **L2** V4 文档写“C1–C7”，artifact `v4-run-renamed.json` 实际含 10 个 case（含 C4b/C5b/C5c/C8b）；文档粒度略滞后于证据，不影响结论。
- **L3** V1 `B10` prompt 在隔离 home 报 `MISSING_CREDENTIAL`（无 provider 凭据）——文档 §6.3 已解释为隔离环境限制、非缺陷。

## 3. 独立复跑（tester；本轮实测）

| 项 | 结果 |
|---|---|
| 环境 | `PROBE_ROOT=tests/validation/.probe-tester`（全新隔离 home；因 M1，profile 复制自 devops 已验证的 `probe`，未重新联网安装/未从零 setup——首次按仓库 setup 实测只建出 `scout` profile，run-v1 boot 失败，印证 M1）；`DSH_HOME` 内无 devops 的 sessions/storages，输出全部写入 `tests/validation/runs/**`；4 个 run 均 exit 0（耗时 17:36:31→17:46:49；V1 2m40s、V2 2m31s、V3 2m28s、V4 2m39s） |
| V1 | 见 §4 复跑断言结果 |
| V2 | 见 §4 复跑断言结果 |
| V3 | 见 §4 复跑断言结果 |
| V4 | 见 §4 复跑断言结果 |
| live 隔离基线 | 每次 run 均执行 `live-state.sh` 前后快照：`tests/validation/runs/v{1..4}/live-state-diff.txt` **全部 0 字节**（live Desktop 树 hash/`.env` stat/顶层 mtime 前后一致） |

复跑断言（`node tests/validation/run-all.mjs --base rerun --emit` → `tests/validation/runs/assertions-rerun.json`）：

| 版本 | 关键断言 | devops 证据 | 独立复跑 | 复跑证据（rerun artifacts） |
|---|---|---|---|---|
| V1 | C5 面板禁用回退 | PASS | PASS | fallback={"mode":"inherit","reason":"panel_unavailable"} panelResolved=false |
| V1 | C1 工厂 thunk | PASS | PASS | panelResolved=true rawType=function version=1.19.3 |
| V1 | C2 冷会话 rank | PASS | PASS | ok=true items=8 model=jev-1.14.0 |
| V1 | C3 冷会话 apply 入队 | PASS | PASS | result={"pending":true,"applied":0} |
| V1 | create({sessionId}) | PASS | PASS | sessionId=session-v1cold-f3a396b0-0364-49a7-9340-471cb150b4bd requested=session-v1cold-f3a396b0-0364-49a7-9340 |
| V1 | 排队计划重放 | PASS | PASS | pendingOutcome={"applied":1,"failed":0,"errors":[],"at":1794908272250} |
| V1 | 二次 rank | PASS | PASS | probe-e2e-testing enabledInSession=true score=0.99 |
| V1 | C4 会话级 enable/disable | PASS | PASS | disable=1/false enable=1/true |
| V2 | C1 plain | PASS | PASS | decision=true lastSeq=17 injected=true |
| V2 | C2 去重 | PASS | PASS | inject2={"shouldInject":false,"reason":"duplicate"} |
| V2 | C3 未配对 approval | PASS | PASS | released=false duringWait.shouldInject=false pendingApprovals=1 |
| V2 | C3 放行后一次注入 | PASS | PASS | outcome=allowed-once inject1=true inject2=duplicate |
| V2 | C4 跨 turn | PASS | PASS | decisionAfter={"shouldInject":true,"turnId":2,"dedupeKey":"session-d95ba308-dcfa-414e-94f8-97ce586b890d:2:35"} |
| V3 | C1 create({cwd}) | PASS | PASS | headerCwd=/Users/lzx/Documents/GitHub/dsh-commander/tests/validation/.probe-tester/ws-v3 cwdMatches=true |
| V3 | C3 bad preset | PASS | PASS | rejected=true error=Unknown agent preset: probe-nonexistent-preset |
| V3 | C4 selectModel | PASS | PASS | selected={"selected":{"provider":"probe-stub","model":"stub-1"}} |
| V3 | C4 stub prompt | PASS | PASS | turnEnd={"seq":20,"turn":1,"reasonKind":"completed"} assistant=1 |
| V3 | C5 重启前 | PASS | PASS | lastSeq=20 turnEnds=[{"seq":20,"turn":1,"reasonKind":"completed"}] |
| V3 | C5/C6 重启后 resume | PASS | PASS | sessionIdUnchanged=true turnEnd={"seq":31,"turn":2,"reasonKind":"completed"} agentsAfter=["session-1c2fd526-6c |
| V4 | C1–C7 裁定后 | PASS | PASS | cases=C1_open,C2_roundtrip,C3_keys,C4_update,C5_concurrent,C5b_update_throw,C5c_version_retry,C8b_schema_preva |
| V4 | C6 重启持久 | PASS | PASS | version=6 configSingleton={"commanderSessionId":"sess_commander_0001","jevModel":"jev-latest"} |
| V4 | C3 非法 key | PASS | PASS | C3={"ok":true,"compoundKeyOk":true,"badKeyError":"unit 'commander': per-record key 'bad/key:1' is not path-saf |
| V4 | 缺陷证据 | PASS | PASS | blueprint.ok=false |

**与 devops 证据的差异**：`assertions-diff.json` → parity **30/30、0 mismatch**；非判据差异仅为随机 sessionId/时间戳/端口（如 cold id `session-v1cold-…`、resume 会话 id）与 cwd 前缀（`.probe` vs `.probe-tester`）。未发现 devops=PASS/rerun=FAIL 的关键项。

## 4. 逐项裁定与断言明细

全部 30 条断言（devops 证据 vs tester 独立复跑；parity 30/30、mismatches 0，见 `tests/validation/runs/assertions-diff.json`）：

| 版本 | 断言 | devops | 独立复跑 | devops 证据（rerun 同类证据见 runs/vN） |
|---|---|---|---|---|
| V1 | C5 面板禁用回退 inherit/panel_unavailable | PASS | PASS | fallback={"mode":"inherit","reason":"panel_unavailable"} panelResolved=false |
| V1 | C1 工厂 thunk 解析（panelResolved=true, function） | PASS | PASS | panelResolved=true rawType=function version=1.19.3 |
| V1 | C2 冷会话 rank 正向返回（ok, items>0, 真 key） | PASS | PASS | ok=true items=8 model=jev-1.14.0 |
| V1 | C3 冷会话 apply 入队 pending:true, applied:0 | PASS | PASS | result={"pending":true,"applied":0} |
| V1 | C3 create({sessionId}) 建出同一 id | PASS | PASS | sessionId=session-v1cold-38b38f19-0cb4-424c-b9e4-59018826545f requested=session-v1cold-38b38f19-0cb4-424c-b9e4-590188265 |
| V1 | C3 排队计划重放 applied:1 | PASS | PASS | pendingOutcome={"applied":1,"failed":0,"errors":[],"at":1794905603292} |
| V1 | C3 二次 rank 计划内能力 enabledInSession=true | PASS | PASS | probe-e2e-testing enabledInSession=true score=0.99 |
| V1 | C4 会话级 enable/disable 往返（disabled:1→false；enabled:1→true） | PASS | PASS | disable=1/false enable=1/true |
| V2 | C1 plain turn/end + 最后 assistant seq + 注入一次 | PASS | PASS | decision=true lastSeq=17 injected=true |
| V2 | C2 去重：二次 shouldInject=false reason=duplicate | PASS | PASS | inject2={"shouldInject":false,"reason":"duplicate"} |
| V2 | C3 未配对 approval/asked → 不注入（pendingInteraction） | PASS | PASS | released=false duringWait.shouldInject=false pendingApprovals=1 |
| V2 | C3 放行后一次注入 + duplicate（allowed-once 配对） | PASS | PASS | outcome=allowed-once inject1=true inject2=duplicate |
| V2 | C4 跨 turn 新键 → 可再次注入（dedupeKey turn2） | PASS | PASS | decisionAfter={"shouldInject":true,"turnId":2,"dedupeKey":"session-818ea82d-a6e7-4f19-85b0-664710769d72:2:35"} |
| V3 | C1 create({cwd}) headerCwd 落点正确 | PASS | PASS | headerCwd=/Users/lzx/Documents/GitHub/dsh-commander/.probe/ws-v3 cwdMatches=true |
| V3 | C2 参数互斥被拒（workspaceId+cwd） | PASS | PASS | rejected=true error=session.create accepts workspaceId or cwd, not both |
| V3 | C3 bad preset 失败路径明确 | PASS | PASS | rejected=true error=Unknown agent preset: probe-nonexistent-preset |
| V3 | C4 selectModel 生效（probe-stub/stub-1） | PASS | PASS | selected={"selected":{"provider":"probe-stub","model":"stub-1"}} |
| V3 | C4 stub prompt 唤醒 turn/end completed | PASS | PASS | turnEnd={"seq":20,"turn":1,"reasonKind":"completed"} assistant=1 |
| V3 | C5 重启前持久快照（cursor/turnEnds） | PASS | PASS | lastSeq=20 turnEnds=[{"seq":20,"turn":1,"reasonKind":"completed"}] |
| V3 | C5/C6 重启后 resume 同 id、无新会话、turn2 completed | PASS | PASS | sessionIdUnchanged=true turnEnd={"seq":31,"turn":2,"reasonKind":"completed"} agentsAfter=["session-db2a4b0e-1572-4d0e-a6 |
| V4 | C1–C7 裁定后（board_edits）全部 ok | PASS | PASS | cases=C1_open,C2_roundtrip,C3_keys,C4_update,C5_concurrent,C5b_update_throw,C5c_version_retry,C8b_schema_prevalidate,C4b |
| V4 | C6 重启持久（version/task/session/config） | PASS | PASS | version=6 configSingleton={"commanderSessionId":"sess_commander_0001","jevModel":"jev-latest"} |
| V4 | C3 非法 key 拒绝且 sanitize 可写、域不脏 | PASS | PASS | C3={"ok":true,"compoundKeyOk":true,"badKeyError":"unit 'commander': per-record key 'bad/key:1' is not path-safe (must ma |
| V4 | 缺陷证据保留：蓝图原名 boardEdits 实测 C1 FAIL | PASS | PASS | blueprint.ok=false |
| V5 | C1 冻结案例 50 条过 schema | PASS | PASS | validate-cases exit 0 |
| V5 | C1 A1–A12 输入完整性 violations=0（复跑） | PASS | PASS | audit-cases exit 0（未改 backend 产物） |
| V5 | C1 冻结副本完整性（verify --manifest） | PASS | PASS | manifest/cases sha 一致 |
| V5 | harness --mock 报告口径可跑通（非门禁） | PASS | PASS | mock summary 已生成 |
| V5 | C2–C4 live 门禁指标独立复跑可复现（task-12 证据，Δ≤5pp） | PASS | PASS | tester rerun vs backend gate 最大 Δ=3.6pp（n=28；工作区 14.3%、attach 5.6%、全对 7.1%） |
| V5 | V5 结论 FAIL（gate 工作区 14.3% ≪ 85%，阈值无组合达标） | PASS | PASS | backend gates.C2=false；详见 audit-V5-v2.md |

| 版本 | 独立复跑 | 证据审计 | 裁定 |
|---|---|---|---|
| V1 | 8/8 PASS（真实 key rank/apply/replay/enable-disable 全复现） | 8/8 | **PASS** |
| V2 | 5/5 PASS（plain/tool/approval-wait/approval-release/cross-turn 全复现） | 5/5 | **PASS** |
| V3 | 7/7 PASS（create-cwd/both/bad-preset/selectModel/prompt/重启 resume 全复现；workspaceId 分支 BLOCKED 文档已声明） | 7/7 | **PASS** |
| V4 | 4/4 PASS（board_edits 下 C1–C7 全 ok、restart version=6、非法 key/sanitize、蓝图失败证据保留） | 4/4 | **PASS** |
| V5（引用 task-12） | live 指标独立复跑复现（Δ≤3.6pp） | 6/6 | **FAIL**（gate 工作区 14.3% ≪85%、无阈值组合达标） |

## 5. 限制

1. 时间盒 25 分钟：独立复跑受 M1 阻塞，采用“复制 devops 已验证的 profile + 全新隔离 home”方式完成（未从零 `setup` 安装 bundles）；这已是仓库脚本可支撑的最强隔离复跑，但仍不是“零手工步骤”。
2. 未重跑 V5 live（task-12 已完成一次独立 live 复跑，证据在 `tests/v5-audit/live/`）；本文件只做 V5 抽样/口径断言与引用。
3. 未碰 live Desktop：未重启/关闭 Desktop、未写 `~/.dsh`；复跑前后基线由仓库 `live-state.sh` 记录（仅只读哈希与 stat）。
4. 不修改被审计文档/证据：`docs/validation/v{1,2,3,4}-*` 与 `docs/validation/v{1,2,3,4}-artifacts/**` 全程未写；`tools/validation/**` 未改；改造仅存在于 `tests/validation/repro/**` 副本。
5. 未读取/打印 `~/.dsh/.env`；key 仅进程内 source。
