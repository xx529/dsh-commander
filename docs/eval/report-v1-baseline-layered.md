# Jev dispatch evaluation（LIVE · layered）

- cases: 50（layerCounts={"should-ask":5,"old-session":10,"new-session":6,"capability":5,"ambiguous":12,"obvious":12}）
- mode: layered（B 两层）
- run: live
- endpoint: https://api.typesafe.ai/v1/systemone
- model: jev-latest
- requests: 100（2.00/case）
- tokens: input=682773 / output=22790
- latency/case: p50=840ms p95=1444ms max=2316ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 值 | 门禁 |
|---|---:|---|
| 工作区 Top-1 | 40.0% | ≥85% |
| 会话 Top-1（attach 案例） | 4.5% | ≥70% |
| 模式（new/attach） | 55.6% | ≥85% |
| 目标全对（workspace∧mode∧session，无冲突） | 15.6% | — |
| workspace/session 冲突 | 0 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | 其中 served | correct | precision(served) | precision(含 should-ask 泄漏惩罚) | coverage | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 1 | 0 | 0.0% |
| 0.5–0.6 | 9 | 0 | 0.0% |
| 0.6–0.7 | 4 | 0 | 0.0% |
| 0.7–0.8 | 6 | 0 | 0.0% |
| 0.8–0.9 | 11 | 0 | 0.0% |
| 0.9–1.0 | 14 | 7 | 50.0% |

## should-ask 层（期望 needs_confirmation）

- v5-01-should-ask: pW=0.50 pS=0.74
- v5-02-should-ask: pW=0.99 pS=0.99
- v5-03-should-ask: pW=0.68 pS=0.90
- v5-04-should-ask: pW=0.24 pS=0.91
- v5-05-should-ask: pW=0.48 pS=0.74

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-should-ask | should-ask | agent-workspace / new / — | agent-workspace / new / — | should-ask | 0.50 | 0.74 |
| v5-02-should-ask | should-ask | htdot-project / new / — | ai.miraclips.com - mira-prod / attach / …54f5c74e | should-ask | 0.99 | 0.99 |
| v5-03-should-ask | should-ask | dsh-shell-cmd / attach / …721c12aa | dsh-terminal-panel / attach / …3c570d74 | should-ask | 0.68 | 0.90 |
| v5-04-should-ask | should-ask | htdot-project / attach / …d9dc1d72 | dsh-shell-cmd / new / — | should-ask | 0.24 | 0.91 |
| v5-05-should-ask | should-ask | agent-workspace / attach / …a40ae44d | agent-workspace / attach / …a40ae44d | should-ask | 0.48 | 0.74 |
| v5-06-old-session | old-session | Research / attach / …6d59bf8a | dsh-capability-settings / attach / …fe419d29 | ❌ | 0.77 | 0.50 |
| v5-07-old-session | old-session | dsh-trace-inspect / attach / …4facc18a | .dsh / new / — | ❌ | 0.48 | 0.70 |
| v5-08-old-session | old-session | Research / attach / …4377215f | test / new / — | ❌ | 0.37 | 0.52 |
| v5-09-old-session | old-session | Research / attach / …91b08025 | .dsh / new / — | ❌ | 0.42 | 0.52 |
| v5-10-old-session | old-session | dsh-terminal-panel / attach / …3c570d74 | dsh-task-gantt / attach / …10b8ee57 | ❌ | 0.43 | 0.52 |
| v5-11-old-session | old-session | dsh-capability-settings / attach / …ffdbf402 | miraclip_ai / new / — | ❌ | 0.71 | 0.96 |
| v5-12-old-session | old-session | Research / attach / …329cfab8 | miraclip_ai / new / — | ❌ | 0.57 | 0.80 |
| v5-13-old-session | old-session | dsh-htdot-bridge / attach / …72fee03f | ai.miraclips.com - mira-prod / attach / …54f5c74e | ❌ | 0.54 | 0.57 |
| v5-14-old-session | old-session | Research / attach / …7fef6603 | dsh-task-gantt / attach / …b5a13efd | ❌ | 0.30 | 0.85 |
| v5-15-old-session | old-session | dsh-capability-settings / attach / …246a8eaa | htdot-order-demand-skill / attach / …fc336ece | ❌ | 0.66 | 0.84 |
| v5-16-new-session | new-session | dsh-capability-settings / new / — | dsh-capability-settings / attach / …f70aadec | ❌ | 1.00 | 0.61 |
| v5-17-new-session | new-session | Research / new / — | dsh-terminal-panel / new / — | ❌ | 0.56 | 0.55 |
| v5-18-new-session | new-session | agent-workspace / new / — | dsh-htdot-bridge / attach / …72fee03f | ❌ | 0.71 | 0.76 |
| v5-19-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.53 | 0.98 |
| v5-20-new-session | new-session | Research / new / — | Evoke / attach / …37414c4b | ❌ | 0.77 | 0.76 |
| v5-21-new-session | new-session | Evoke / new / — | Research / new / — | ❌ | 0.57 | 0.85 |
| v5-22-capability | capability | Research / attach / …d0179c43 | agent-workspace / attach / …a40ae44d | ❌ | 0.59 | 0.53 |
| v5-23-capability | capability | dsh-trace-inspect / attach / …ca93933c | .dsh / new / — | ❌ | 0.44 | 0.65 |
| v5-24-capability | capability | Research / attach / …ece00f86 | .dsh / attach / …b76022b2 | ❌ | 0.60 | 0.51 |
| v5-25-capability | capability | dsh-capability-settings / attach / …4f2ab113 | dsh-capability-settings / attach / …4f2ab113 | ✅ | 0.46 | 0.91 |
| v5-26-capability | capability | dsh-capability-settings / attach / …1f11e2bb | .dsh / attach / …1231d97d | ❌ | 0.81 | 0.54 |
| v5-27-ambiguous | ambiguous | htdot-order-demand-skill / new / — | miraclip_ai / new / — | ❌ | 0.85 | 0.87 |
| v5-28-ambiguous | ambiguous | dsh-terminal-panel / attach / …e422d47b | dsh-terminal-panel / new / — | ❌ | 0.54 | 0.61 |
| v5-29-ambiguous | ambiguous | 192.168.98.152 - mira-ai / attach / …17174809 | ai.miraclips.com - mira-prod / attach / …54f5c74e | ❌ | 0.90 | 0.75 |
| v5-30-ambiguous | ambiguous | LiveShopping / new / — | Research / new / — | ❌ | 0.59 | 0.95 |
| v5-31-ambiguous | ambiguous | Research / attach / …f8c0a57b | dsh-task-gantt / attach / …2ec6ddd7 | ❌ | 0.43 | 0.86 |
| v5-32-ambiguous | ambiguous | Research / new / — | dsh-capability-settings / attach / …a7989f5c | ❌ | 0.53 | 0.71 |
| v5-33-ambiguous | ambiguous | dsh-capability-settings / attach / …a2b61a6e | dsh-capability-settings / new / — | ❌ | 0.55 | 0.56 |
| v5-34-ambiguous | ambiguous | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …8f39b8e4 | ❌ | 0.83 | 0.86 |
| v5-35-ambiguous | ambiguous | Research / attach / …7e8122fa | dsh-capability-settings / attach / …adff6886 | ❌ | 0.58 | 0.50 |
| v5-36-ambiguous | ambiguous | dsh-capability-settings / attach / …4c23a5aa | dsh-task-gantt / attach / …2ec6ddd7 | ❌ | 0.38 | 0.76 |
| v5-37-ambiguous | ambiguous | Research / new / — | .dsh / attach / …be5654e7 | ❌ | 0.45 | 0.42 |
| v5-38-ambiguous | ambiguous | dsh-capability-settings / attach / …ddea291c | dsh-capability-settings / attach / …a7989f5c | ❌ | 0.86 | 0.48 |
| v5-39-obvious | obvious | dsh-commander / new / — | dsh-commander / new / — | ✅ | 0.94 | 1.00 |
| v5-40-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …5c0f9ca3 | ❌ | 0.82 | 0.91 |
| v5-41-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …8f39b8e4 | ❌ | 0.78 | 0.84 |
| v5-42-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 0.65 | 0.83 |
| v5-43-obvious | obvious | LiveShopping / new / — | LiveShopping / attach / …448d925e | ❌ | 0.58 | 0.58 |
| v5-44-obvious | obvious | LiveShopping / new / — | LiveShopping / attach / …6e41c60d | ❌ | 0.55 | 0.66 |
| v5-45-obvious | obvious | gpu-omnijev-ollama_test / new / — | gpu-omnijev-ollama_test / new / — | ✅ | 1.00 | 1.00 |
| v5-46-obvious | obvious | dsh-quick-action / new / — | dsh-quick-action / new / — | ✅ | 1.00 | 0.71 |
| v5-47-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / new / — | ✅ | 1.00 | 0.68 |
| v5-48-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.96 | 0.83 |
| v5-49-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / new / — | ✅ | 0.99 | 0.79 |
| v5-50-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …aa3acbd3 | ❌ | 0.75 | 0.92 |
