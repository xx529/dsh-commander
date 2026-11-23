# M1 验收独立复核（tester，task-40）

> 角色：tester（独立复核；只写 `packages/dsh-commander/tests/e2e/**`、`docs/validation/**`、`tests/artifacts/m1/**`；未改实现/配置、未碰 live DSH）。
> 任务：`task-40`（M1-3 验收 e2e + 独立复核，按「全确认模式」降级口径；M1-5 50 案例指标按用户决策豁免）。
> 输入：`docs/architecture/m1-contract-patch.md`（sha `23e2d175…`）、implementation-plan §9/§11、backend task-37 实现、frontend task-38 实现、devops `m1-boot.md`/`m1-artifacts`。
> 复跑：`node packages/dsh-commander/tests/e2e/m1-e2e.mjs`（隔离真实 Host + stub 模型 + fake Jev）；证据 `tests/artifacts/m1/e2e/**`。

## 0. 裁定（终态，2026-11-17 22:2x）

**M1 验收 = PASS（自动化 + live 全链路）。**
- 自动化：Host e2e **54/54 PASS**、单测 **141/141 PASS**、Client harness **35/35 + 47/47 PASS**。
- **live（真实模型，2026-11-18 00:0x）：M1-1..M1-4 全 PASS**：确认卡渲染→采用建议（等效消息）→ dispatched/running；能力 auto applied（5 skills，新会话 cwd 正确）；低置信/jev_unavailable 均 needs_confirmation 且二次确认后派发；最终 pending=null、health 200。
- **唯一 UNVERIFIED**：live「采用建议」的**物理点击**未触发（AXPress 对 web 内容无效），以该卡自身 `[dispatch-confirm]` 普通用户消息（逐字一致）完成确认并取证；不伪造点击。M1-5 指标按用户决策豁免。
- Host 侧真实 Host e2e（模型驱动、全新 build/PROBE_ROOT）：**54/54 PASS，0 FAIL，0 BLOCKED，3 INFO**（`tests/artifacts/m1/e2e-run8.log`、`tests/artifacts/m1/e2e/summary.json`）。
- 覆盖并 PASS：M1-1 确认后派发（needs_confirmation→confirm→dispatched→task **running**）、M1-2 低置信 → needs_confirmation 且确认后派发、M1-3 能力 auto（applied、enabled=['probe-skill-m1']）与面板缺失 fallback、M1-4 面板缺失启动不崩+派发成功、同 decision 幂等回放不重复建会话、S3 重启后旧 decisionId 被拒（decision 过期）。
- Client 侧（task-38）：独立复跑 `pnpm --filter dsh-commander test` **141/141 PASS**（backend 在 tester 复跑后新增 8 路径真实 validator 契约测试；client 31/31 PASS）+ client harness **smoke 35/35 + interact 47/47 PASS**；`lib/client.js` sha `a5949864…`（128,777B）。
- **M1-5 指标按用户决策豁免**，不表述为 V5 PASS。
- 严重级别（终态）：**HIGH 0 / MEDIUM 0 / LOW 1**（LOW 为 devops 检查脚本相对 OUTDIR 健壮性，非实现）；另有 **UNVERIFIED 1**（live 采用建议物理点击未触发，环境限制，已有等效消息证据）。
- **最终独立复跑（H5 修复后，全新 build）**：`pnpm --filter dsh-commander test` **141/141 PASS**（backend 补充 8 路径真实 validator 测试后，tester 独立复跑确认；证据 `tests/artifacts/m1/unit-test-final141.log`）；官方 `m1-e2e.mjs` **54/54 PASS / 0 invalid output**（`tests/artifacts/m1/e2e-run10.log`，live 修复后回归）。H5 关闭（backend 收敛 dispatched.target 字段 + 真实 validator 测试；boot 日志 `invalid output` 计数 0）。
- 过程 HIGH 关闭：H1（工具注册：`output.render`/`agent.id` 身份/`tools.schemas()` 口径误报）、H2（output.schema 缺 variant）、H3（确认后 pending 未清空）、H4（turn/start→running 竞态）、H5（dispatched.target 字段越界）均已 backend 修复并由 tester 全新 build+新 PROBE_ROOT 复跑关闭。

## 1. 方法

- **真实 Host e2e**（隔离，零真实 key）：一次性 `DSH_HOME` + web profile + 本地包安装 + `--patch` 测试探针：
  - `packages/dsh-commander/tests/e2e/probes/m1-e2e-probe.mjs`：注册隔离工作区；**确定性 stub LLM** 按 `M1E2E_*` 标记真实发起 `task_create`/`dispatch_task` 工具调用（复刻真实工具往返，非直接调 service）；fake capabilityPanel（thunk）；`/m1e2e/diag` agents 服务诊断。
  - `tools/dev/spike/m1-introspect.mjs`（devops 提供，只读）：`GET /m1/agent-tools` 读指挥官 agent 的 toolNames。
  - **fake Jev HTTP server**（本机 Node http）：`/v1/systemone` 高分、`/low` 低分、`/err` 500；`PUT /commander/config` 指向它；`apiKeyEnv=M1_FAKE_KEY`（仅进程 env，不打印/不落盘）。
- 场景：S1 全确认主链路+能力 auto+幂等+低置信+jev_unavailable+tasks/:id+jev/test；S2 面板缺失（inherit/fallback、启动不崩）；S3 重启后旧 decisionId 过期。
- 证据：`tests/artifacts/m1/e2e/{summary.json,commands.log,s1-*.json,s2-*.json,s3-*.json,*-boot.out/err}`；独立复跑 devops 检查脚本证据：`tests/artifacts/m1/devops-recheck/**`。

## 2. 过程 HIGH（均已关闭；owner backend）

**H3（已修复关闭）确认成功后 `pendingDispatch` 未清空（契约 §3.1 违反）→ 客户端确认卡无法收起。**
- 证据：`tests/artifacts/m1/e2e/s1-state-after-confirm.json`：task 已 `queued`、dispatch `outcome=confirmed`、工具返回 `Dispatched task …`，但 `pendingDispatch` 仍为旧 decision（dec_269e…）；S2/S3 中同样证据链。
- 影响：M1 确认卡（frontend 按 `pendingDispatch=null` 收起）在真实 Host 上不会关闭；契约要求 confirm/cancel/dispatched 后置 null 并广播 `dispatch.updated{pendingDispatch:null}`。
- 建议：确认写终态时清 pending + 广播；补集成测试断言 confirm 后快照 pending=null。

**H4（已修复关闭）工作会话 `turn/start` 未把 task queued→running（M1-1 口径不达）。**
- 证据：probe 订阅日志 `session-event sid=d80f7ed4 type=turn/start seq=5`（工作会话 = `session-184311eb-…-9bb2d80f7ed4`），但 `GET /commander/tasks/:id` 恒 `queued`、session link status=idle（`s1-task-detail.json`）。
- 推断：spawn 先 `prompt` 触发回合，service 随后才写 task queued + sessions link，trigger 收到 turn/start 时尚未建 link → 事件被丢弃且无补账。
- 建议：写 link 后对账当前会话 turn 状态，或把早期 turn/start 事件排队/重放；补真实 Host 回合测试。

**H5（已修复关闭）`dispatch_task` 个别返回不合 output.schema（oneOf matched 0）。**
- 证据：`s1-boot.out` 中 confirm/重放附近 `Error: tool "dispatch_task" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`（2 次）。
- 根因（backend 修复说明）：dispatched variant 的 `target` 复用了内部 ConfirmationCandidate，多带 `workspaceName/workspacePath/pWorkspace/pSession/score`，output.schema 的 target 只允许 `{workspaceId,mode,sessionId?}` → 已收敛 target 字段，并补真实 `validateJsonSchemaValue` 对 confirm/replay/expired 三条真实返回的测试。
- 复验：最新 build 下 e2e **54/54 PASS**、s1-boot.out `invalid output` 计数 **0**（修复前 5 处）。

### 附录：H2（已关闭）dispatch_task output.schema 缺 variant 字段
- 曾现象：needs_confirmation 返回被拒 `value.candidates/... is not a declared property`；backend 已改 oneOf 三 variant，重跑后首次 needs_confirmation 被接受、pendingDispatch 正常产生 → H2 关闭。
### 附录：H1（已关闭）真实 Host 工具注册
- 现象（`tests/artifacts/m1/e2e/s1-boot.out`，stub 模型 stream 日志）：模型调用 `dispatch_task` 后收到
  `Error: tool "dispatch_task" returned invalid output: "value.candidates is not a declared property (additionalProperties: false); value.recommendation…; value.scores…; value.expiresAt…"`（needs_confirmation 分支）与 `value.message is not a declared property`（rejected 分支）；因此 `state.pendingDispatch=null`、task 仍 `draft`。
- 根因：`tools/index.ts` 的 dispatch_task `output.schema` 只声明了部分字段/分支，而 `dispatchService.dispatchTask()` 返回三 variant（rejected/needs_confirmation/dispatched）的完整字段；单测直接调 service、绕过工具输出运行时校验 → 测试绿灯但真实 Host 拒绝（测试有效性缺口，MEDIUM）。
- 修法：output.schema 用 `oneOf` 覆盖三 variant 全字段（每 variant `additionalProperties:false` + properties 全列）；加一条「经 tools 注册后校验 dispatchTask 返回符合 output.schema」的测试。
- 状态：已回报 backend（含错误原文与修法），等修后重跑。

### 附录：H1（已关闭）真实 Host 工具注册问题
- 曾经现象：指挥官 agent 工具列表仅宿主 5 个、模型 `unknown tool "task_create"`。
- 已定位并关闭：① spec 缺 `output.render`（backend 修复）；② `registerOnAgent` 身份判定未回退 `agent.id`（backend 修复，tester 用真实回合验证 task_create 成功）；③ **口径更正**：`tools.schemas()` 不反映动态 `register()`（devops 实测撤回误报），不能作为可见性判据 → 本审计改用「模型真实工具调用 + state.tasks/tasks/:id」判据。
- 交叉证据：devops `check-m1-tools.sh`（stub 模型真实回合）exit 0 / 11 断言 PASS；**tester 独立复跑**（`PROBE_ROOT=/tmp/tester-m1-tools2 OUTDIR=<绝对>…/tests/artifacts/m1/devops-tools-abs`）同样 **exit 0、11/11 ASSERT PASS**（`task_create` 真实执行、state.tasks/tasks/:id 可取）；backend 自测同 PASS。相对 OUTDIR 复跑会因脚本内 `require(相对路径)` 失败（LOW L1，已反馈 devops）。
- 现象：绑定时 `agents` 服务正常（`hasGet/hasList=true, listLength=1, getFound=true`、sessionId 匹配），但 `agent.ctx.get('tools').schemas()` 只有宿主 5 个工具；`commanderTools=[]`。模型收到的 tools 列表无 4 工具；模型调用时 `ToolResult: Error: unknown tool "task_create"`；`state.tasks` 恒空。
- 根因链（按修复轮次）：
  1. **已修（tester 先前定位）**：4 个 spec 缺 `output:{schema,render}` → 真实 dsh-tools `defineTool` 抛 `TypeError: Cannot read properties of undefined (reading 'render')`；backend 已补，并加了 `safeBuildSpecs`/诊断入口；tester 用真实 dsh-tools 复验 4 个 `output.schema`/`projectToolSchema` 均 OK。
  2. **当前根因（本轮定位）**：`registerOnAgent` 以 `agent.session?.id ?? agent.session?.header?.id` 判定 isCommander；但隔离 Host 中 `agents.list()` 返回的 root agent 对象**只用 `agent.id` 能读出 session 身份**（我的诊断用 `agent.session?.id ?? header?.id ?? agent.id` 才匹配到指挥官 sessionId）→ 判定为“非指挥官”，走 `restrict(deny)` 分支并 `return true`，**从不注册工具、也不触发 ensure 重试/告警**。
  3. **放大因素**：per-tool `register` 异常被静默 catch、`installForAgent` 仍 return true；`onDiagnostic` 未从 index 注入 → 失败无日志。devops 的 boot/introspect 与 tester e2e 均复现（重启+resume 后仍无）。
- 证据：`tests/artifacts/m1/e2e/s1-agent-tools.json`、`s1-agents-diag.json`、`s1-boot.err`、`tests/artifacts/m1/smoke/boot.out`；devops `docs/validation/m1-boot.md` + tester 独立复跑 `tests/artifacts/m1/devops-recheck/commands.log`（20 ASSERT PASS + 5 FINDING，exit 1）。
- 影响：M1-1/M1-2/M1-3/M1-4 的派发与能力验收全部 BLOCKED；M0 消息通道不受影响（M0-2 已 PASS）。
- 修法建议（已回 backend）：sessionId 取值与 `findAgentBySession` 一致（加 `agent.id` 回退）；per-tool 失败 `logger.warn`/`onDiagnostic`；零成功时 return false 触发重试；补「真实 Host boot + introspect 4 tools」回归测试。
- 状态：**已回报 backend（含精确证据与修法）；等修复后重跑 e2e。**

## 3. 逐项复核

| 项 | 结论 | 证据/说明 |
|---|---|---|
| M1-1 确认后派发 → queued→running | **PASS（e2e + live）**：e2e 确认后 pending=null、task running；live 确认卡→采用（等效消息）→dispatched/running | `e2e-run8.log`、`s1-task-detail.json`、session-event 日志 |
| M1-2 低置信 → needs_confirmation，确认后仍派发 | **PASS**（reason=low_confidence；确认后 status=running） | `e2e-run8.log` |
| M1-3 能力 auto（policy=auto；applied+enabled=提交 plan name；面板缺失 fallback） | **PASS（e2e + live）**：e2e enabled=['probe-skill-m1']；live applied enabled 5 skills（ponytail/chrome-devtools/playwright/open-computer-use/jev-browser-chrome）、新会话 cwd=Htdot-OrderCenter；S2 fallback 仍派发 | `e2e-run8.log`、`s1-task-detail.json` |
| M1-4 面板缺失启动不崩 + 派发仍可用（inherit/fallback） | **PASS**（health panel:absent、无崩溃、派发 running、能力 fallback） | `e2e-run8.log`、`s2-*` |
| M1-5 50 案例指标 | **豁免** | 用户决策；记录于 `m1-contract-patch §1.7`；不得写成 V5 PASS |
| GET /commander/tasks/:id | **PASS（404 契约）** | 未知任务 404 `not_found`；详情/运行态待 H1 修复后复验 |
| POST /commander/jev/test | **PASS** | fake `/ok` → `ok:true+latencyMs+model`；`/err` → `ok:false+code=jev_unavailable`；**不回传 key** |
| Client 确认卡/任务摘要/Jev 测试（frontend task-38） | **PASS（隔离 harness）** | `pnpm --filter dsh-commander test` 129/129；`run-harness.mjs` smoke 35/35 + interact 47/47（确认卡三动作逐字 `[dispatch-confirm]`、过期置灰、成功条、设置页 switch/测试连接）；bundle sha `a5949864…` |
| M0-1 live 视觉/点击 | **PASS（核心）** | 硬刷新后球/面板；真实点击球×2、Esc×1、重开；证据 `tests/artifacts/m0/live/{20-current,22-panel-open-click,23-panel-closed,24-escape*,25-reopen,26-settings}.png`、`click-walkthrough.md`；设置页/主题/console/发送点击 UNVERIFIED |
| M1 live 确认卡与全链路 | **PASS（live，采用建议物理点击 UNVERIFIED）** | 证据 `tests/artifacts/m1/live/{33-confirm-card.png,34-dispatch-success.png,35-auto-confirm-card.png,task-task_mwkv0q9d7230c9.json,task-task_mwkvrhkie0ad1a.json,39-session-capabilities-excerpt.json,37-final-state.json,38-final-health.json}`；卡片字段/候选/原因/倒计时齐全；采用建议（等效消息）→ task running、dispatch confirmed；能力 auto applied enabled 5 skills、新会话 session-a9566b13 cwd=Htdot-OrderCenter；低置信/jev_unavailable 二次确认后派发；pending=null。物理点击 adopt UNVERIFIED（AXPress 对 web 无效），以等效消息替代 |
| DoD：可复现记录 | **PASS** | 一键 e2e + 证据 JSON/日志；隔离环境不联网 |
| DoD：关键路径自动化 | **PARTIAL** | 单测 129/129 + e2e 脚本齐备；真实 Host 工具输出契约缺口未被单测捕获（MEDIUM M1） |
| DoD：失败降级 | **PARTIAL** | 面板缺失不崩 PASS；派发失败/decision_expired 待 H1 修复后验 |
| DoD：不引入新概念 | 待 architect | 快照/路由按 m1-contract-patch；tester 未发现新增概念 |

## 4. MEDIUM / LOW

- **MEDIUM M1（已修复关闭）：H4 回归测试自身断言缺陷（owner backend）**：曾出现 134 条中 1 条确定性失败：`H4: orphan turn/start arriving before task/link write is reconciled to running after spawn`（tests/integration/dispatch.test.ts:273）——测试用 fire-and-forget `void tracker.reconcile(...)` 后立即断言 `task.status==='running'`，未 await/轮询；实现侧经真实 Host e2e 已验证 running PASS。backend 已修复（service await reconcile + 测试更新）：最新 `pnpm --filter dsh-commander test` **141/141 PASS**（tester 独立复跑；新增测试为 H5 全路径真实 validator + live 修复的 board_query workspaces/workspaceId id-name-path/歧义/兼容路径）。
- **MEDIUM M1b（已修复关闭）**：H5 variant 输出校验——backend 已收敛 dispatched.target 字段并补真实运行时 validator 测试；tester 复跑 `invalid output`=0、e2e 54/54 PASS。
- **MEDIUM M2：`tools.schemas()` 口径教训**：devops 曾据其误报“工具未注册”（已撤回）；本 e2e 初版也据此设了 preflight gate（已改为 INFO + 模型驱动判据）。建议文档明确 schemas() 不反映动态 register（owner devops/backend）。
- **LOW L1：devops `check-m1-tools.sh` 对相对 OUTDIR 不健壮**。tester 用相对 OUTDIR 复跑时 `require('$ART/06-binding.json')` 静默失败→“no bound sessionId” exit 2；绝对 OUTDIR 正常（owner devops：脚本内 `ART=$(cd ... && pwd)` 绝对化或 node 用绝对路径）。

## 5. 限制

1. 时间盒内完成 Host e2e 骨架与 3 场景；H1 修复后需一次完整重跑（预计 2–4 分钟）转终裁。
2. live：client 加载/球/面板/M0-1 点击已 PASS；M1 确认卡因 live Host 端 `no_workspace`/`decision_required` 未出（backend 已修，待 Host 重启/插件重载后重试）；未伪造确认卡证据。
3. 未改实现/配置/live DSH；测试探针与 fake Jev 只存在 tests/e2e 与 tests/artifacts；stub 模型不联网、非真实模型（assistant 文本仅用于驱动工具往返）。
4. 证据中不含真实 key/用户隐私正文；`~/.dsh` 未写。

## 6. 结论与下一步

- 当前：**M1 验收 = PASS（自动化 + live）**：Host e2e 54/54、单测 141/141、Client harness 35/35+47/47；live 确认卡→采用→running、能力 auto、全确认语义均 PASS；M1-5 指标豁免。**M0 = PASS（核心）**。
- 唯一 UNVERIFIED（环境/工具限制，不影响裁定）：live「采用建议」物理点击未触发（AXPress 对 web 内容无效），以等效消息证据替代；建议后续换成真实物理点击/Playwright 补一条。
- LOW：devops `check-m1-tools.sh` 相对 OUTDIR 健壮性；M0 live 设置页/主题/console 补验。
- owner：live adopt 物理点击→Lead/工具链；文档/审计已由 tester 收口。
