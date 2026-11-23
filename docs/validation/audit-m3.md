# M3 独立复核审计（tester，task-57）

> 范围：M3 闭环（turn/end 注入、organize_report、accept/rework、审批悬浮卡、播报派生）。契约：`docs/architecture/m2m3-contract-patch.md` §3。

## 0. 裁定
**M3 = PASS（自动化/契约 + live Host 只读）；live UI 交互 UNVERIFIED（物理输入环境限制 + 真实审批难触发）。**
- M2/M3 e2e **25/25 PASS**（隔离真实 Host + stub 真实工具调用；`tests/artifacts/m3/e2e/run.log`）。
- 单测 **201/201 PASS**；client harness **smoke 43/43 + interact 92/92 PASS**（审批卡/角标/accept/rework UI 独立复跑）。
- **live Host 只读 PASS**：health 200、state rev12、workSessions=3、metrics 含 `projectionUnavailable`、pending=null；client 223,026B sha `3657c256…`（`tests/artifacts/m3/live/**`）。
- **UNVERIFIED（不阻断，环境/工具限制）**：① 8KB 截断的 e2e（工作会话未产出 assistant 文本，走 EMPTY_REPLY_TEXT；单测/集成 truncateInjectionText 覆盖）；② 审批 pending 跳过注入 e2e（集成覆盖）；③ live 审批卡/accept/rework/角标 UI 点击（AXPress/System Events/DOM 均无法触发 web 内容，外部 JS 报错非应用异常；真实审批难稳定触发）。
- **严重级别：HIGH 0 / MEDIUM 0 / LOW 0**。

## 1. 覆盖与证据
| 契约点 | 断言 | 证据 |
|---|---|---|
| §3.1 注入格式 | `[session-reply] …\n---\ntaskId=… sessionId=… turnId=… seq=… truncated=…` | `m3/e2e/21-session-reply-injection.json` |
| §3.1 无文本 | EMPTY_REPLY_TEXT 兜底 | 同上 |
| §3.1 去重/pending/截断/合并 | e2e 部分（截断/pending UNVERIFIED）；单测/集成覆盖 + 代码核对 | e2e INFO |
| §3.1 metrics | `metrics.injections ≥1` | `22-state-metrics.json` |
| §3.2 organize_report | 真实工具调用 → review + acceptance + evidence_present；空 acceptance→invalid_request（devops 隔离验证） | `23-task1-review.json`、`docs/validation/m2-m3-build.md` |
| §3.3 accept | review→done + timeline accept | `24-accept.json` |
| §3.3 rework | review→running + brief 投递 + timeline rework | `30-rework.json` + probe 事件 |
| §3.4 审批卡 | harness：同 PendingApproval answer、answerable 守卫、后答 settled、请求结束消失、不注册第二 answerer；「总是允许」按官方 API 置灰 | harness 92/92 |
| §3.4 角标/hint | harness 派生优先级/count 断言 | harness |
| live | UNVERIFIED（待统一硬刷新） | — |

## 2. 质量关注
- e2e 注入断言初版误把 system prompt 中的 `[session-reply]` 示例当注入（已改为过滤 `"role":"user"` + taskId/sessionId/truncated），最终 PASS 项基于真实注入事件。
- e2e 的 rework/accept timeline 断言按实际响应 `body.task.timeline` 校正（契约字段正确）。
- 未发现实现缺陷；2 项注入边界 UNVERIFIED 由单测/集成覆盖，建议后续 live/真实回合补。

## 3. 结论与下一步
- **M3 可 PASS（自动化/契约；3 项 UNVERIFIED 注记）**。
- live 走查批次：球角标/hint→review 抽屉 accept/rework→（如能触发真实审批）审批卡允许/打开会话；截图/点击表落 `tests/artifacts/m3/live/**` 后回填 `m3-accept.md §4`。
