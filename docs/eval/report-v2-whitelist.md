# Jev dispatch evaluation（LIVE · layered）

- cases: 50（layerCounts={"obvious":12,"should-ask":5,"old-session":10,"new-session":6,"capability":5,"ambiguous":12}）
- caseSha256: `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`
- manifest: generatorRev=`0db97fbd8da1a3ca` seed=`v5` summaryMode=`semantic` manifestCaseSha256=`872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`（一致）
- mode: layered（B 两层）
- run: replay（复用原 live summary 的 caseResults 重算，未重新调用 API）
- endpoint: https://api.typesafe.ai/v1/systemone
- model: jev-latest
- requests: 100（2.00/case）
- tokens: input=401210 / output=19598
- latency/case: p50=851ms p95=1263ms max=1452ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 门禁口径（non-named-cue） | 报告口径（含 named-cue easy 层） |
|---|---:|---:|
| n | 26 | 36 |
| 工作区 Top-1 | 26.9%（≥85%） | 44.4% |
| 会话 Top-1（attach） | 5.9%（≥70%） | 5.9% |
| 模式（new/attach） | 34.6%（≥85%） | 33.3% |
| 目标全对 | 11.5% | 16.7% |
| should-ask / named-cue / observational / derived-needs-confirm | 5 / 12 / 5 / 5 | — |
| workspace/session 冲突 | 0 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | served(gate) | served(coverage) | correct | precision(gate served) | precision(含 should-ask 惩罚) | coverage=served/labeled(45) | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 0 | 0 | — |
| 0.5–0.6 | 2 | 0 | 0.0% |
| 0.6–0.7 | 4 | 1 | 25.0% |
| 0.7–0.8 | 8 | 0 | 0.0% |
| 0.8–0.9 | 8 | 2 | 25.0% |
| 0.9–1.0 | 4 | 0 | 0.0% |

## should-ask 层（期望 needs_confirmation）

- v5-13-should-ask: pW=0.69 pS=0.40
- v5-14-should-ask: pW=0.80 pS=0.99
- v5-15-should-ask: pW=0.57 pS=0.45
- v5-16-should-ask: pW=0.30 pS=0.71
- v5-17-should-ask: pW=0.28 pS=0.66

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.87 | 0.59 |
| v5-02-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …5c0f9ca3 | ❌ | 0.98 | 0.94 |
| v5-03-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 1.00 | 0.90 |
| v5-04-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 1.00 | 0.64 |
| v5-05-obvious | obvious | LiveShopping / new / — | LiveShopping / attach / …6e41c60d | ❌ | 0.99 | 0.95 |
| v5-06-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …c8818e2d | ❌ | 0.87 | 0.65 |
| v5-07-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / new / — | ✅ | 0.96 | 0.85 |
| v5-08-obvious | obvious | Macmini - RemoteTTS / new / — | dsh-htdot-bridge / attach / …72fee03f | ❌ | 0.67 | 0.82 |
| v5-09-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / new / — | ✅ | 0.97 | 0.84 |
| v5-10-obvious | obvious | dsh-commander / new / — | Research / attach / …a3fe7bc2 | ❌ | 0.55 | 0.79 |
| v5-11-obvious | obvious | htdot-order-demand-skill / new / — | agent-workspace / attach / …606e9235 | ❌ | 0.62 | 0.75 |
| v5-12-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / attach / …f020ec61 | ❌ | 0.99 | 0.80 |
| v5-13-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / attach / …dda36b3f | should-ask | 0.69 | 0.40 |
| v5-14-should-ask | should-ask | — / undefined / — | .dsh / new / — | should-ask | 0.80 | 0.99 |
| v5-15-should-ask | should-ask | — / undefined / — | dsh-capability-settings / attach / …f63d6697 | should-ask | 0.57 | 0.45 |
| v5-16-should-ask | should-ask | — / undefined / — | Research / new / — | should-ask | 0.30 | 0.71 |
| v5-17-should-ask | should-ask | — / undefined / — | Research / new / — | should-ask | 0.28 | 0.66 |
| v5-18-old-session | old-session | Research / attach / …1eaf2154 | dsh-capability-settings / new / — | ❌ | 0.65 | 0.78 |
| v5-19-old-session | old-session | dsh-task-gantt / attach / …e56f6a99 | Macmini - dsh-setup / attach / …c9cf0e4b | ❌ | 0.63 | 0.51 |
| v5-20-old-session | old-session | Research / attach / …9543eb3d | dsh-capability-settings / new / — | ❌ | 0.47 | 0.88 |
| v5-21-old-session | old-session | Research / attach / …62ebb8d5 | dsh-capability-settings / new / — | ❌ | 0.53 | 0.84 |
| v5-22-old-session | old-session | dsh-capability-settings / attach / …4bf942ae | Macmini - dsh-setup / new / — | ❌ | 0.60 | 0.54 |
| v5-23-old-session | old-session | agent-workspace / attach / …cc00e7e2 | dsh-capability-settings / new / — | ❌ | 0.59 | 0.85 |
| v5-24-old-session | old-session | Research / attach / …4377215f | dsh-capability-settings / new / — | ❌ | 0.54 | 0.68 |
| v5-25-old-session | old-session | Research / attach / …06c818ca | dsh-capability-settings / new / — | ❌ | 0.43 | 0.93 |
| v5-26-old-session | old-session | Research / attach / …d063bc51 | Macmini - dsh-setup / attach / …c9cf0e4b | ❌ | 0.59 | 0.76 |
| v5-27-old-session | old-session | Research / attach / …0bc665f9 | Research / attach / …0bc665f9 | ✅ | 0.65 | 0.49 |
| v5-28-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.72 | 0.64 |
| v5-29-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.65 | 0.51 |
| v5-30-new-session | new-session | dsh-capability-settings / new / — | dsh-capability-settings / new / — | ✅ | 0.81 | 0.44 |
| v5-31-new-session | new-session | Research / new / — | Research / attach / …c0f74ccb | ❌ | 0.53 | 0.59 |
| v5-32-new-session | new-session | Research / new / — | Research / attach / …28bc9017 | ❌ | 0.92 | 0.33 |
| v5-33-new-session | new-session | Research / new / — | Research / attach / …77ae266f | ❌ | 0.91 | 0.41 |
| v5-34-capability | capability | dsh-terminal-panel / new / — | dsh-shell-cmd / attach / …721c12aa | ❌ | 0.99 | 0.85 |
| v5-35-capability | capability | Research / new / — | Research / new / — | ✅ | 0.68 | 0.48 |
| v5-36-capability | capability | Research / attach / …3b0a1647 | .dsh / attach / …91219343 | ❌ | 0.99 | 0.98 |
| v5-37-capability | capability | dsh-capability-settings / attach / …b8ddcfdd | dsh-capability-settings / attach / …b8ddcfdd | ✅ | 0.53 | 0.68 |
| v5-38-capability | capability | Research / new / — | dsh-capability-settings / attach / …2c971dca | ❌ | 0.67 | 0.52 |
| v5-39-ambiguous | ambiguous | agent-workspace / attach / …8e7a31ea | .dsh / attach / …91219343 | ❌ | 0.96 | 0.76 |
| v5-40-ambiguous | ambiguous | agent-workspace / attach / …2e0f3e10 | dsh-capability-settings / new / — | ❌ | 0.73 | 0.77 |
| v5-41-ambiguous | ambiguous | Research / new / — | Research / attach / …f8c0a57b | ❌ | 0.77 | 0.78 |
| v5-42-ambiguous | ambiguous | agent-workspace / attach / …beb7d356 | Evoke / new / — | ❌ | 0.48 | 0.83 |
| v5-43-ambiguous | ambiguous | Research / attach / …d5e0165c | dsh-shell-cmd / new / — | ❌ | 0.40 | 0.53 |
| v5-44-ambiguous | ambiguous | Research / new / — | Research / new / — | ✅ | 0.84 | 0.65 |
| v5-45-ambiguous | ambiguous | Research / attach / …bf8399b1 | agent-workspace / new / — | ❌ | 0.76 | 0.57 |
| v5-46-ambiguous | ambiguous | Research / attach / …e669e056 | .dsh / attach / …91219343 | ❌ | 0.86 | 0.77 |
| v5-47-ambiguous | ambiguous | Research / attach / …b081ad6b | agent-workspace / new / — | ❌ | 0.89 | 0.46 |
| v5-48-ambiguous | ambiguous | htdot-project / attach / …054e1645 | Research / new / — | ❌ | 0.73 | 0.71 |
| v5-49-ambiguous | ambiguous | agent-workspace / new / — | Research / new / — | ❌ | 0.79 | 1.00 |
| v5-50-ambiguous | ambiguous | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.76 | 0.58 |
