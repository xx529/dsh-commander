# Jev dispatch evaluation（MOCK 自检 · full）

- cases: 50（layerCounts={"should-ask":5,"old-session":10,"new-session":6,"capability":5,"ambiguous":12,"obvious":12}）
- mode: full（A 全量一波）
- run: **mock（harness 自检，不是 live 结果，禁止写入门禁）**
- endpoint: mock
- model: mock
- requests: 50（1.00/case）
- tokens: input=1390266（含估算，响应无 usage） / output=0
- latency/case: p50=1ms p95=1ms max=1ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 值 | 门禁 |
|---|---:|---|
| 工作区 Top-1 | 97.8% | ≥85% |
| 会话 Top-1（attach 案例） | 100.0% | ≥70% |
| 模式（new/attach） | 97.8% | ≥85% |
| 目标全对（workspace∧mode∧session，无冲突） | 95.6% | — |
| workspace/session 冲突 | 2 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | 其中 served | correct | precision(served) | precision(含 should-ask 泄漏惩罚) | coverage | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5 | 0.5 | 0.3 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.5 | 0.4 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.5 | 0.5 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.5 | 0.6 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.6 | 0.3 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.6 | 0.4 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.6 | 0.5 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.6 | 0.6 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.7 | 0.3 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |
| 0.5 | 0.7 | 0.4 | 43 | 43 | 43 | 100.0% | 100.0% | 95.6% | 0 |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 0 | 0 | — |
| 0.5–0.6 | 0 | 0 | — |
| 0.6–0.7 | 0 | 0 | — |
| 0.7–0.8 | 0 | 0 | — |
| 0.8–0.9 | 1 | 0 | 0.0% |
| 0.9–1.0 | 44 | 43 | 97.7% |

## should-ask 层（期望 needs_confirmation）

- v5-01-should-ask: pW=0.90 pS=0.42 → 最优阈值下被门控拦下（正确）
- v5-02-should-ask: pW=0.90 pS=0.42 → 最优阈值下被门控拦下（正确）
- v5-03-should-ask: pW=0.90 pS=0.42 → 最优阈值下被门控拦下（正确）
- v5-04-should-ask: pW=0.90 pS=0.42 → 最优阈值下被门控拦下（正确）
- v5-05-should-ask: pW=0.90 pS=0.42 → 最优阈值下被门控拦下（正确）

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-should-ask | should-ask | agent-workspace / new / — | agent-workspace / new / — | should-ask | 0.90 | 0.42 |
| v5-02-should-ask | should-ask | htdot-project / new / — | htdot-project / new / — | should-ask | 0.90 | 0.42 |
| v5-03-should-ask | should-ask | dsh-shell-cmd / attach / …721c12aa | dsh-shell-cmd / attach / …721c12aa | should-ask | 0.90 | 0.42 |
| v5-04-should-ask | should-ask | htdot-project / attach / …d9dc1d72 | htdot-project / attach / …d9dc1d72 | should-ask | 0.90 | 0.42 |
| v5-05-should-ask | should-ask | agent-workspace / attach / …a40ae44d | agent-workspace / attach / …a40ae44d | should-ask | 0.90 | 0.42 |
| v5-06-old-session | old-session | Research / attach / …6d59bf8a | Research / attach / …6d59bf8a | ✅ | 0.90 | 0.88 |
| v5-07-old-session | old-session | dsh-trace-inspect / attach / …4facc18a | dsh-trace-inspect / attach / …4facc18a | ✅ | 0.90 | 0.88 |
| v5-08-old-session | old-session | Research / attach / …4377215f | Research / attach / …4377215f | ✅ | 0.90 | 0.88 |
| v5-09-old-session | old-session | Research / attach / …91b08025 | Research / attach / …91b08025 | ✅ | 0.90 | 0.88 |
| v5-10-old-session | old-session | dsh-terminal-panel / attach / …3c570d74 | dsh-terminal-panel / attach / …3c570d74 | ✅ | 0.90 | 0.88 |
| v5-11-old-session | old-session | dsh-capability-settings / attach / …ffdbf402 | dsh-capability-settings / attach / …ffdbf402 | ✅ | 0.90 | 0.88 |
| v5-12-old-session | old-session | Research / attach / …329cfab8 | Research / attach / …329cfab8 | ✅ | 0.90 | 0.88 |
| v5-13-old-session | old-session | dsh-htdot-bridge / attach / …72fee03f | dsh-htdot-bridge / attach / …72fee03f | ✅ | 0.90 | 0.88 |
| v5-14-old-session | old-session | Research / attach / …7fef6603 | Research / attach / …7fef6603 | ✅ | 0.90 | 0.88 |
| v5-15-old-session | old-session | dsh-capability-settings / attach / …246a8eaa | dsh-capability-settings / attach / …246a8eaa | ✅ | 0.90 | 0.88 |
| v5-16-new-session | new-session | dsh-capability-settings / new / — | dsh-capability-settings / new / — | ✅ | 0.90 | 0.88 |
| v5-17-new-session | new-session | Research / new / — | Research / new / — | ✅ | 0.90 | 0.88 |
| v5-18-new-session | new-session | agent-workspace / new / — | agent-workspace / new / — | ✅ | 0.90 | 0.88 |
| v5-19-new-session | new-session | Research / new / — | Research / new / — | ✅ | 0.90 | 0.88 |
| v5-20-new-session | new-session | Research / new / — | Research / new / — | ✅ | 0.90 | 0.88 |
| v5-21-new-session | new-session | Evoke / new / — | Evoke / new / — | ✅ | 0.90 | 0.88 |
| v5-22-capability | capability | Research / attach / …d0179c43 | Research / attach / …d0179c43 | ✅ | 0.90 | 0.88 |
| v5-23-capability | capability | dsh-trace-inspect / attach / …ca93933c | dsh-trace-inspect / attach / …ca93933c | ✅ | 0.90 | 0.88 |
| v5-24-capability | capability | Research / attach / …ece00f86 | miraclip_ai / attach / …ece00f86 | ❌ | 0.45 | 0.88 |
| v5-25-capability | capability | dsh-capability-settings / attach / …4f2ab113 | dsh-capability-settings / attach / …4f2ab113 | ✅ | 0.90 | 0.88 |
| v5-26-capability | capability | dsh-capability-settings / attach / …1f11e2bb | dsh-capability-settings / attach / …1f11e2bb | ✅ | 0.90 | 0.88 |
| v5-27-ambiguous | ambiguous | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
| v5-28-ambiguous | ambiguous | dsh-terminal-panel / attach / …e422d47b | dsh-terminal-panel / attach / …e422d47b | ✅ | 0.90 | 0.88 |
| v5-29-ambiguous | ambiguous | 192.168.98.152 - mira-ai / attach / …17174809 | 192.168.98.152 - mira-ai / attach / …17174809 | ✅ | 0.90 | 0.88 |
| v5-30-ambiguous | ambiguous | LiveShopping / new / — | LiveShopping / new / — | ✅ | 0.90 | 0.88 |
| v5-31-ambiguous | ambiguous | Research / attach / …f8c0a57b | Research / attach / …f8c0a57b | ✅ | 0.90 | 0.88 |
| v5-32-ambiguous | ambiguous | Research / new / — | Research / attach / …b2102ceb | ❌ | 0.90 | 0.45 |
| v5-33-ambiguous | ambiguous | dsh-capability-settings / attach / …a2b61a6e | dsh-capability-settings / attach / …a2b61a6e | ✅ | 0.90 | 0.88 |
| v5-34-ambiguous | ambiguous | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
| v5-35-ambiguous | ambiguous | Research / attach / …7e8122fa | Research / attach / …7e8122fa | ✅ | 0.90 | 0.88 |
| v5-36-ambiguous | ambiguous | dsh-capability-settings / attach / …4c23a5aa | dsh-capability-settings / attach / …4c23a5aa | ✅ | 0.90 | 0.88 |
| v5-37-ambiguous | ambiguous | Research / new / — | Research / new / — | ✅ | 0.90 | 0.88 |
| v5-38-ambiguous | ambiguous | dsh-capability-settings / attach / …ddea291c | dsh-capability-settings / attach / …ddea291c | ✅ | 0.90 | 0.88 |
| v5-39-obvious | obvious | dsh-commander / new / — | dsh-commander / new / — | ✅ | 0.90 | 0.88 |
| v5-40-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
| v5-41-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
| v5-42-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
| v5-43-obvious | obvious | LiveShopping / new / — | LiveShopping / new / — | ✅ | 0.90 | 0.88 |
| v5-44-obvious | obvious | LiveShopping / new / — | LiveShopping / new / — | ✅ | 0.90 | 0.88 |
| v5-45-obvious | obvious | gpu-omnijev-ollama_test / new / — | gpu-omnijev-ollama_test / new / — | ✅ | 0.90 | 0.88 |
| v5-46-obvious | obvious | dsh-quick-action / new / — | dsh-quick-action / new / — | ✅ | 0.90 | 0.88 |
| v5-47-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / new / — | ✅ | 0.90 | 0.88 |
| v5-48-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.90 | 0.88 |
| v5-49-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / new / — | ✅ | 0.90 | 0.88 |
| v5-50-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.90 | 0.88 |
