# M3 闭环验收清单与实测（tester，task-57）

> 契约：`docs/architecture/m2m3-contract-patch.md` §3。方法：隔离真实 Host + stub 模型真实工具调用 + probe 事件取证；证据 `tests/artifacts/m3/e2e/**`，live 待走查（§4）。

## 0. 状态总览

| 验收项 | 结果 | 证据 |
|---|---|---|
| 工作会话 turn/end → 指挥官收到 `[session-reply]`（格式 taskId/sessionId/turnId/seq/truncated） | **PASS**（2026-11-18 复查：注入带工作会话最后一条真实文本，事件源 `sessionQuery.readSession`） | `m3/e2e/21-session-reply-injection.json` |
| 无文本回复 → `EMPTY_REPLY_TEXT`（`[session-reply] 本轮无文本回复`） | **PASS（单测；e2e 工作会话有真实文本，走截断分支）** | `tests/unit/injection.test.ts` |
| 8KB 截断（6KB 头+2KB 尾+`truncated=true`+截断标记，整条 ≤8192 可投递） | **PASS**（9KB `HEAD-…-TAIL` → 头尾保留、`[truncated N chars]`、`truncated=true`、`injections=1/injectFailures=0`） | `m3/e2e/21-session-reply-injection.json`、`22-state-metrics.json` |
| metrics.injections ≥1 | **PASS** | `m3/e2e/22-state-metrics.json` |
| organize_report（真实工具层）→ review + acceptance + evidence_present | **PASS** | `23-task1-review.json` |
| accept（review→done + timeline accept）；非 review→conflict | **PASS** | `24-accept.json` |
| rework（review→running + `[commander-rework]` brief 投递原会话 + timeline rework） | **PASS** | `30-rework.json`、probe 事件 |
| 审批 pending 时跳过注入 | **UNVERIFIED（隔离难造 PendingApproval）**；集成测试覆盖 | e2e INFO |
| 审批悬浮卡（同 PendingApproval/answerable 守卫/后答 already settled/不注册第二 answerer） | **PASS（隔离 harness interact）**；live UNVERIFIED | client harness 92/92 |
| 球角标/hint 派生（待确认>待审批>待验收>受阻） | **PASS（隔离 harness）**；live UNVERIFIED | client harness |
| live Host 只读（state 新字段/metrics/workSessions） | **PASS** | `tests/artifacts/m3/live/{01-health.json,02-state-live.json}`（rev12、workSessions3、metrics 含 projectionUnavailable、pending=null；client 223,026B sha `3657c256…`） |
| live 审批卡/accept/rework 点击走查 | **UNVERIFIED（物理输入环境限制 + 真实审批难触发）** | 硬刷新/面板渲染成功；AX/System Events/DOM 点击无法触发 web 内容（外部 JS 报错非应用异常）；隔离 harness 已覆盖答案路径；复跑见 §4 |

## 1. 自动化结果
- M2/M3 e2e **25/25 PASS，0 FAIL，3 INFO**（`tests/artifacts/m3/e2e/run.log`、`summary.json`）。
- 独立复跑：`pnpm --filter dsh-commander test` **232/232**；client harness **43/43+92/92**（审批卡答案路径/answerable 守卫/请求结束消失/review accept/rework/角标均在 interact 覆盖）。
- 说明：e2e 注入取证经 probe `/m1r/events` 读取 commander 会话事件；2026-11-18 复跑后注入带真实文本（原「本轮无文本回复」是 `session.events` 恒空的读取缺陷，已修）。

## 2. 五维（闭环 UI）
| 维度 | 结果 |
|---|---|
| 交互 | **PASS（隔离 harness：审批卡/角标/accept/rework）**；live 点击 UNVERIFIED |
| 视觉/样式 | PASS（隔离渲染；审批卡「仅在界面处理」文案、金色/提示样式） |
| 原型/截图审美 | UNVERIFIED（待 live） |

## 4. Live 部分（Host 只读 PASS；UI 物理交互 UNVERIFIED）
- live `http://127.0.0.1:64918`：client 223,026B sha `3657c256…`（审批卡/角标/accept/rework/系统消息样式已加载）；health 200；state rev12、workSessions=3、metrics 含 `projectionUnavailable`、pending=null（`tests/artifacts/m3/live/**`）。
- **live UI = UNVERIFIED（物理输入环境限制 + 审批需真实工作会话触发）**：Lead 尝试 AXPress/System Events/DOM 点击均不能触发 web 内容（外部 JS Syntax/TypeError 非应用异常）；审批卡现实触发依赖真实工作会话 PendingApproval，未稳定复现。替代取证：隔离 harness（43/43+92/92：审批卡渲染/answer 同实例/answerable 守卫/请求结束消失/accept/rework/角标）+ 单测 232/232 + e2e 25/25。复跑命令同上。

## 3. 限制
- 真模型 acceptance 质量、生产 30s/去重/pending 过滤时序：e2e 用 stub/加速窗口，UNVERIFIED 真实时长；单测/集成覆盖逻辑。
- live 审批卡依赖真实工作会话审批（官方 answerer 同实例）；若无法稳定触发，走查时标 UNVERIFIED 并给命令。
