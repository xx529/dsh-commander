# Jev dispatch evaluation（LIVE · layered）

- cases: 50（layerCounts={"should-ask":5,"old-session":10,"new-session":6,"capability":5,"ambiguous":12,"obvious":12}）
- mode: layered（B 两层）
- run: live
- endpoint: https://api.typesafe.ai/v1/systemone
- model: jev-latest
- requests: 100（2.00/case）
- tokens: input=518046 / output=23135
- latency/case: p50=857ms p95=1692ms max=3997ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 值 | 门禁 |
|---|---:|---|
| 工作区 Top-1 | 35.6% | ≥85% |
| 会话 Top-1（attach 案例） | 13.6% | ≥70% |
| 模式（new/attach） | 62.2% | ≥85% |
| 目标全对（workspace∧mode∧session，无冲突） | 17.8% | — |
| workspace/session 冲突 | 0 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | 其中 served | correct | precision(served) | precision(含 should-ask 泄漏惩罚) | coverage | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 0 | 0 | — |
| 0.5–0.6 | 7 | 0 | 0.0% |
| 0.6–0.7 | 11 | 0 | 0.0% |
| 0.7–0.8 | 4 | 1 | 25.0% |
| 0.8–0.9 | 11 | 1 | 9.1% |
| 0.9–1.0 | 12 | 6 | 50.0% |

## should-ask 层（期望 needs_confirmation）

- v5-01-should-ask: pW=0.57 pS=0.94
- v5-02-should-ask: pW=0.98 pS=0.96
- v5-03-should-ask: pW=0.91 pS=0.84
- v5-04-should-ask: pW=0.24 pS=0.83
- v5-05-should-ask: pW=0.67 pS=0.52

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-should-ask | should-ask | agent-workspace / new / — | agent-workspace / new / — | should-ask | 0.57 | 0.94 |
| v5-02-should-ask | should-ask | htdot-project / new / — | ai.miraclips.com - mira-prod / attach / …54f5c74e | should-ask | 0.98 | 0.96 |
| v5-03-should-ask | should-ask | dsh-shell-cmd / attach / …721c12aa | dsh-terminal-panel / attach / …3c570d74 | should-ask | 0.91 | 0.84 |
| v5-04-should-ask | should-ask | htdot-project / attach / …d9dc1d72 | miraclip_ai / new / — | should-ask | 0.24 | 0.83 |
| v5-05-should-ask | should-ask | agent-workspace / attach / …a40ae44d | agent-workspace / attach / …a40ae44d | should-ask | 0.67 | 0.52 |
| v5-06-old-session | old-session | Research / attach / …6d59bf8a | dsh-capability-settings / attach / …fe419d29 | ❌ | 0.65 | 0.32 |
| v5-07-old-session | old-session | dsh-trace-inspect / attach / …4facc18a | dsh-task-gantt / attach / …b5a13efd | ❌ | 0.67 | 0.60 |
| v5-08-old-session | old-session | Research / attach / …4377215f | .dsh / new / — | ❌ | 0.64 | 0.48 |
| v5-09-old-session | old-session | Research / attach / …91b08025 | .dsh / new / — | ❌ | 0.37 | 0.59 |
| v5-10-old-session | old-session | dsh-terminal-panel / attach / …3c570d74 | dsh-terminal-panel / attach / …3c570d74 | ✅ | 0.87 | 0.95 |
| v5-11-old-session | old-session | dsh-capability-settings / attach / …ffdbf402 | miraclip_ai / new / — | ❌ | 0.85 | 0.77 |
| v5-12-old-session | old-session | Research / attach / …329cfab8 | dsh-capability-settings / attach / …adff6886 | ❌ | 0.61 | 0.57 |
| v5-13-old-session | old-session | dsh-htdot-bridge / attach / …72fee03f | ai.miraclips.com - mira-prod / attach / …bbdfc10a | ❌ | 0.54 | 0.49 |
| v5-14-old-session | old-session | Research / attach / …7fef6603 | .dsh / attach / …be5654e7 | ❌ | 0.40 | 0.82 |
| v5-15-old-session | old-session | dsh-capability-settings / attach / …246a8eaa | htdot-order-demand-skill / attach / …fc336ece | ❌ | 0.41 | 0.85 |
| v5-16-new-session | new-session | dsh-capability-settings / new / — | dsh-capability-settings / attach / …f70aadec | ❌ | 0.99 | 0.50 |
| v5-17-new-session | new-session | Research / new / — | dsh-terminal-panel / new / — | ❌ | 0.45 | 0.55 |
| v5-18-new-session | new-session | agent-workspace / new / — | dsh-htdot-bridge / attach / …72fee03f | ❌ | 0.64 | 0.51 |
| v5-19-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.42 | 0.97 |
| v5-20-new-session | new-session | Research / new / — | Evoke / attach / …37414c4b | ❌ | 0.66 | 0.82 |
| v5-21-new-session | new-session | Evoke / new / — | Research / new / — | ❌ | 0.50 | 0.85 |
| v5-22-capability | capability | Research / attach / …d0179c43 | agent-workspace / attach / …e0639598 | ❌ | 0.67 | 0.55 |
| v5-23-capability | capability | dsh-trace-inspect / attach / …ca93933c | dsh-task-gantt / attach / …e56f6a99 | ❌ | 0.82 | 0.55 |
| v5-24-capability | capability | Research / attach / …ece00f86 | .dsh / new / — | ❌ | 0.44 | 0.67 |
| v5-25-capability | capability | dsh-capability-settings / attach / …4f2ab113 | dsh-capability-settings / attach / …4f2ab113 | ✅ | 0.55 | 0.93 |
| v5-26-capability | capability | dsh-capability-settings / attach / …1f11e2bb | .dsh / attach / …1231d97d | ❌ | 0.70 | 0.49 |
| v5-27-ambiguous | ambiguous | htdot-order-demand-skill / new / — | miraclip_ai / new / — | ❌ | 0.89 | 0.79 |
| v5-28-ambiguous | ambiguous | dsh-terminal-panel / attach / …e422d47b | dsh-terminal-panel / attach / …e422d47b | ✅ | 0.61 | 0.72 |
| v5-29-ambiguous | ambiguous | 192.168.98.152 - mira-ai / attach / …17174809 | ai.miraclips.com - mira-prod / new / — | ❌ | 0.90 | 0.37 |
| v5-30-ambiguous | ambiguous | LiveShopping / new / — | Research / new / — | ❌ | 0.65 | 0.93 |
| v5-31-ambiguous | ambiguous | Research / attach / …f8c0a57b | dsh-trace-inspect / new / — | ❌ | 0.26 | 0.54 |
| v5-32-ambiguous | ambiguous | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.43 | 0.58 |
| v5-33-ambiguous | ambiguous | dsh-capability-settings / attach / …a2b61a6e | dsh-capability-settings / new / — | ❌ | 0.55 | 0.32 |
| v5-34-ambiguous | ambiguous | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …8f39b8e4 | ❌ | 0.66 | 0.54 |
| v5-35-ambiguous | ambiguous | Research / attach / …7e8122fa | dsh-capability-settings / new / — | ❌ | 0.79 | 0.58 |
| v5-36-ambiguous | ambiguous | dsh-capability-settings / attach / …4c23a5aa | dsh-task-gantt / attach / …2ec6ddd7 | ❌ | 0.34 | 0.89 |
| v5-37-ambiguous | ambiguous | Research / new / — | .dsh / new / — | ❌ | 0.55 | 0.61 |
| v5-38-ambiguous | ambiguous | dsh-capability-settings / attach / …ddea291c | dsh-capability-settings / new / — | ❌ | 0.86 | 0.31 |
| v5-39-obvious | obvious | dsh-commander / new / — | dsh-commander / new / — | ✅ | 1.00 | 1.00 |
| v5-40-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …5c0f9ca3 | ❌ | 0.71 | 0.57 |
| v5-41-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …8f39b8e4 | ❌ | 0.61 | 0.52 |
| v5-42-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 0.55 | 0.55 |
| v5-43-obvious | obvious | LiveShopping / new / — | miraclip_ai / new / — | ❌ | 1.00 | 0.74 |
| v5-44-obvious | obvious | LiveShopping / new / — | miraclip_ai / new / — | ❌ | 1.00 | 0.71 |
| v5-45-obvious | obvious | gpu-omnijev-ollama_test / new / — | gpu-omnijev-ollama_test / new / — | ✅ | 1.00 | 1.00 |
| v5-46-obvious | obvious | dsh-quick-action / new / — | miraclip_ai / new / — | ❌ | 0.47 | 0.87 |
| v5-47-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / new / — | ✅ | 0.97 | 0.66 |
| v5-48-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.75 | 0.81 |
| v5-49-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / new / — | ✅ | 0.86 | 0.90 |
| v5-50-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …aa3acbd3 | ❌ | 0.55 | 0.60 |
