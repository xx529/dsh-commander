# M1 验收清单与实测（tester 维护，task-40）

> 用途：M1（NEXT-PHASE §4 M1，按「全确认模式」降级口径）的验收清单、执行步骤与实测结果。
> 依据：`docs/architecture/m1-contract-patch.md`（sha `23e2d175…`）、`docs/architecture/implementation-plan.md` §9/§11、用户 2026-11-17 决策（autoDispatch=false；V5 指标豁免）、`docs/architecture/m0-review.md`。
> 约束：隔离 profile 自动化（不碰 live DSH）；live 确认卡走查需用户重启+刷新后执行。
> 时间：2026-11-17 21:4x–22:0x。

## 0. 状态总览

| 验收项 | 原口径 | M1 调整后口径（全确认） | 当前状态 |
|---|---|---|---|
| M1-1 | 明显任务 auto 派发成功 queued→running | **确认后派发成功**：首次 needs_confirmation → 二次 decisionId+confirmTarget → dispatched → queued→running | **PASS**（e2e 54/54 + **live PASS**：确认卡→采用→task running，证据 `tests/artifacts/m1/live/{33-confirm-card.png,34-dispatch-success.png,task-task_mwkv0q9d7230c9.json}`） |
| M1-2 | 低置信 → needs_confirmation，二次确认后派发 | 保持；全确认下所有任务走此路径，低置信作为其中一个 case | **PASS（到 queued）**：reason=low_confidence，确认后 status=queued |
| M1-3 | 能力 auto（panel rank/apply） | 保持；只对 mode=new + policy=auto；失败 fallback 继续派发 | **PASS**：applied enabled=['probe-skill-m1']；面板缺失 fallback 仍派发 |
| M1-4 | 面板不可用回退 inherit | 保持 | **PASS**：面板缺失 boot/health `panel:absent`、无崩溃、派发成功、能力 fallback=panel_unavailable |
| M1-5 | 50 案例指标达标 | **豁免**（用户决策：V5 指标豁免；以「每次确认」替代 auto 派发门禁） | **N/A（已豁免，记录于 m1-contract-patch §1.7）**，不表述为 V5 PASS |
| Client 半（确认卡/任务摘要/Jev 测试） | — | frontend task-38 | **PASS（隔离 harness 独立复跑 + live 确认卡渲染）**；live「采用建议」物理点击 UNVERIFIED（以等效 `[dispatch-confirm]` 消息证据替代，见 §4） |

## 1. 执行环境与方法

- **Host e2e**（tester 新增，可复跑）：`node packages/dsh-commander/tests/e2e/m1-e2e.mjs`
  - 隔离 `DSH_HOME`（`tests/artifacts/m1/e2e/s1|s2|s3/probe-root`）；`dsh --profile m1e2e --from-default-profile web` + 本地包 `dsh plugin add` + `--patch`：
    1. **测试探针** `packages/dsh-commander/tests/e2e/probes/m1-e2e-probe.mjs`：注册隔离工作区、**确定性 stub LLM**（按 `M1E2E_*` 标记真实发起 `task_create`/`dispatch_task` 工具调用）、fake capabilityPanel（thunk）；
    2. **工具注册 introspect**：复用 `tools/dev/spike/m1-introspect.mjs`（`GET /m1/agent-tools`）读取指挥官 agent 作用域 toolNames；
    3. **fake Jev HTTP server**（本地 Node http，无网络/无真实 key）：`/v1/systemone` 返回高分、`/low/...` 返回低分、`/err/...` 返回 500；并 `PUT /commander/config` 指向它。
  - 证据：`tests/artifacts/m1/e2e/**`（`summary.json`、`commands.log`、各步骤 JSON、boot.out/err）。
- **单测独立复跑**：`pnpm --filter dsh-commander test` → **129/129 PASS**（unit+integration 98 + client 31）。
- **Client harness 独立复跑**：`pnpm --filter dsh-commander build:client`（exit 0，`lib/client.js` sha256 `a5949864…`、128,777B）→ `run-harness.mjs` → **smoke 35/35 + interact 47/47 PASS，exit 0**；确认卡三动作消息逐字断言（`[dispatch-confirm] 采用建议/自定义/取消`）、过期置灰、`pendingDispatch=null` 收起、Jev 测试连接渲染等。
- **devops 检查脚本独立复跑**：`PROBE_ROOT=/tmp/... OUTDIR=tests/artifacts/m1/devops-recheck bash tools/dev/check-m1-increment.sh` → 20 ASSERT PASS + **5 FINDING（commander 工具未注册）**，exit 1；与本 e2e 结论一致。

## 2. Host e2e 实测结果（当前 build）

`summary: 54/54 PASS, 0 FAIL, 0 BLOCKED, 3 INFO`（终态，模型驱动；H1–H5 全部修复后 s1/s2/s3 boot 的 `invalid output` 均为 0；证据 `tests/artifacts/m1/e2e-run9.log`；单测 135/135 `unit-test-final135.log`）。

| # | 步骤/断言 | 期望 | 实际 | 证据 |
|---|---|---|---|---|
| S1-1 | boot + health | 200 `panel:present` | PASS | `s1-health.json` |
| S1-2 | probe 工作区/白名单/模型+Jev 配置 | 200 | PASS | `s1-workspaces-put.json`、`s1-config-put.json` |
| S1-3 | 绑定指挥官会话 | 200 bound | PASS（session-…） | `s1-binding.json` |
| S1-4 | **指挥官工具可见性（模型视角）** | stub 模型 tools 列表含 4 工具、可真实执行 | **PASS**：模型 tools 含 task_create/dispatch_task/…；`task_create` 真实执行 → state.tasks draft | `s1-boot.out`（stream tools=…）、`s1-task-before-confirm.json` |
| S1-4b | agents 服务身份诊断 | list/get 可见同一 session | PASS（agent.id 可读；backend 已按此修复 isCommander 判定） | `s1-agents-diag.json`；`tools.schemas()` 不反映动态 register（devops 更正，仅 INFO） |
| S1-5 | `POST /commander/jev/test`（fake /ok） | 200 `ok:true,latencyMs,model` | PASS | `s1-jev-test-ok.json` |
| S1-6 | jev/test 不回传 key | 无 key 明文 | PASS | 同上 |
| S1-7 | jev/test（fake 500） | 200 `ok:false,code` | PASS | `s1-jev-test-err.json` |
| S1-8 | `GET /commander/tasks/:id` 未知 | 404 `not_found` | PASS | 同终端记录 |
| S1-5b | `dispatch_task` 首次调用（needs_confirmation） | 模型收到合法输出、state.pendingDispatch 出现 | **FAIL（HIGH#2）**：工具运行时拒绝输出 `value.message/candidates/recommendation/scores/expiresAt is not a declared property (additionalProperties:false)` → pendingDispatch=null、task 仍 draft | `s1-boot.out`、`s1-pending.json` |
| S1-9.. | 全确认链路（confirm→dispatched→running、能力 auto、幂等、低置信、Jev 不可用） | — | **FAIL**（H2 前置） | — |
| S2-1 | 面板缺失 boot | 200 `panel:absent`、不崩 | PASS | `s2-health.json`、`s2-boot.err` |
| S2-2 | 面板缺失工具链路 | 模型可调工具 | **PASS（工具可见）**；派发仍受 H2 影响 | — |
| S2-3 | 面板缺失仍可派发（inherit/fallback） | dispatched | **BLOCKED** | — |
| S3 | 决策过期（重启后旧 decisionId） | decision_expired、task 不变 | **BLOCKED**（工具链前置失败） | s3-* |

> 结论：**M1 Host 验收当前被 HIGH#2 阻断**——工具注册已确认可用（模型可调 task_create 并真实执行；devops `check-m1-tools.sh` 交叉 PASS、`tools.schemas()` 属误报口径已更正），但 `dispatch_task` 的工具输出违反自身 output schema，DSH 运行时拒绝 needs_confirmation 返回 → pendingDispatch 无法产生，全确认/能力 auto/幂等/过期/running 均无法验收。详见 `docs/validation/audit-m1.md` §HIGH#2。

## 3. 已通过/已验证（不依赖工具注册的部分）

- 插件启动/health/state/config/workspaces/binding（S1-2/S1-3；S2-1 面板缺失）。
- `GET /commander/tasks/:id` 404 契约（S1-8）；`POST /commander/jev/test` 成功/失败与「不回传 key」（S1-5..S1-7）。
- Client 确认卡与设置页（隔离 harness 35/35 + 47/47；证据 `tests/artifacts/m1/harness.log`）。
- 129 单测全绿（包含 backend 新增真实 defineTool 契约测试；但该测试未覆盖「真实 Host 中 agent tools 注册结果」——见 audit-m1 MEDIUM）。

## 4. Live 验收（2026-11-17 23:30–00:05，真实模型全链路 PASS）

- **环境**：live DSH origin `http://127.0.0.1:49921`；`GET /commander/health` → 200 `{panel:'present',binding:'bound'}`（`38-final-health.json`）；client `lib/client.js` sha256 `e82b4d16…`（131,141B），硬刷新后球/面板正常。
- **真实模型链路（非 stub）**：`POST /commander/message` → commander 真实调用 `board_query`/`task_create`/`dispatch_task` → `pendingDispatch` → 确认 → dispatched/running。
- **证据与结果**：

| 步骤 | 证据 | 结果 |
|---|---|---|
| 真实模型派发触发 → 确认卡 | `tests/artifacts/m1/live/33-confirm-card.png` | **PASS**：卡片「派发确认 · HtDot 订单导出加…｜每次派发需人工确认｜剩余 29:11」、建议目标 Htdot-OrderCenter/新建会话、Jev pMax 0%、候选表（Htdot-OrderCenter/htdot-project/htdot-prod-root + 还有更多候选(3)）、原因「Jev 不可用，按模型候选请你确认」、按钮「自定义选择/采用建议/取消」 |
| 采用建议 → dispatched/running | `34-dispatch-success.png`、`task-task_mwkv0q9d7230c9.json` | **PASS**：task status=**running**、primarySessionId=`session-1f49f230…`、dispatch outcome=confirmed、sessions link role=work/status=running、timeline dispatch 在册 |
| 能力 auto（workspace policy=auto） | `35-auto-confirm-card.png`、`task-task_mwkvrhkie0ad1a.json`、`39-session-capabilities-excerpt.json` | **PASS**：capability `{status:'applied', enabled:['ponytail','chrome-devtools','playwright','open-computer-use','jev-browser-chrome'], durationMs:982}`；新建工作会话 `session-a9566b13…` cwd=`/Users/lzx/Documents/sunteng/Htdot-OrderCenter`（toolsCount 8/mcpCount 6/skillsCount 190），panel 的 session-capabilities 已写入 |
| 全确认语义（低置信/jev_unavailable） | `33/35`、`37-final-state.json` | **PASS**：均返回 needs_confirmation，二次确认（等效消息）后派发；最终 pendingDispatch=null |
| 最终状态 | `37-final-state.json`、`38-final-health.json` | **PASS**：pending=null、tasks=[running×2,draft]、health 200 panel present/bound |

- **操作方式如实记录**：确认卡「采用建议」实质动作由 Lead 发送该卡自身的 `[dispatch-confirm] 采用建议 decisionId=… taskId=… target=…` 普通用户消息完成（与点击按钮产生的消息逐字一致）；Lead 的 AX 点击对 web 内容返回 delivered 但未触发 → **adopt 物理点击 = UNVERIFIED（以等效消息证据替代）**；「取消/自定义选择」物理点击同样未执行（UNVERIFIED）。球/面板点击此前已真实点击验证（M0-1）。
- **五维裁定（M1 确认卡 live）**：
  - 视觉 **PASS**：卡片标题/tag/倒计时、建议目标、pMax 刻度、候选表、原因、按钮分层清晰，暗色 token 与 DSH 一致。
  - 交互 **PASS（渲染+消息动作）**：pending 出现即展示、采用建议（等效消息）后卡片收起且任务 running、倒计时正常（29:11/29:42）；物理点击 adopt **UNVERIFIED**。
  - 样式 **PASS**：候选表/按钮/原因文案风格一致，无溢出遮挡。
  - 原型 **UNVERIFIED**：未做 prototype 并排对照（无 Figma，仓库原型参照）。
  - 截图审美 **PARTIAL**（主观，需 Lead/UX 复核）。
- **裁定：M1-1..M1-4 live PASS；M1-5 豁免；M1 live = PASS（adopt 物理点击 UNVERIFIED，以等效 `[dispatch-confirm]` 消息证据替代）；M1 整体 = 自动化 PASS + live PASS。**

## 5. 待办与 owner

| 阻断 | owner | 下一步 |
|---|---|---|
| dispatch_task 输出 schema 与三 variant 不一致（HIGH#2） | backend | 修 output.schema（oneOf 覆盖 rejected/needs_confirmation/dispatched 全字段）后通知 tester 重跑 e2e；期望 22/28→全 PASS（含 running/能力/幂等/过期） |
| 真实 Host 工具注册契约测试缺口（MEDIUM） | backend | 加「真实 dsh-tools + 真实 Host 路径」测试，或 boot smoke 断言 introspect 4 tools |
| devops 检查脚本 introspect 时序（MEDIUM） | devops | `agentFound=false/systemPrompt absent` 在 tester 复跑出现（devops 记录为 true），建议轮询等待再断言 |
| M1 live adopt 物理点击（UNVERIFIED，工具限制） | Lead/工具 | AXPress 对 web 内容未触发；已有等效 `[dispatch-confirm]` 消息证据；如后续可物理点击可补 |
| M0 live 设置页四组/Jev 测试连接/主题 | Lead/用户 | 补截图后关闭 M0 UNVERIFIED 项 |
