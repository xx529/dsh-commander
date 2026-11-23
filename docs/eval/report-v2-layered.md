# Jev dispatch evaluation（LIVE · layered）

- cases: 50（layerCounts={"obvious":12,"should-ask":5,"old-session":10,"new-session":6,"capability":5,"ambiguous":12}）
- caseSha256: `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`
- manifest: generatorRev=`0db97fbd8da1a3ca` seed=`v5` summaryMode=`semantic` manifestCaseSha256=`872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`（一致）
- dispatchTime: 2026-10-08T11:21:08.533Z – 2026-11-17T09:06:35.059Z（per-case as-of；逐条见 _provenance.dispatchAt）
- violations: 0（manifest.leakViolations / auditResult；冻结前 audit-cases A1–A12）
- mode: layered（B 两层）
- run: replay（复用原 live summary 的 caseResults 重算，未重新调用 API）
- endpoint: https://api.typesafe.ai/v1/systemone
- model: jev-latest
- requests: 100（2.00/case）
- tokens: input=486042 / output=22458
- latency/case: p50=871ms p95=1454ms max=2977ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 门禁口径（non-named-cue） | 报告口径（含 named-cue easy 层） |
|---|---:|---:|
| n | 28 | 40 |
| 工作区 Top-1 | 14.3%（≥85%） | 30.0% |
| 会话 Top-1（attach） | 5.6%（≥70%） | 5.6% |
| 模式（new/attach） | 50.0%（≥85%） | 52.5% |
| 目标全对 | 7.1% | 12.5% |
| should-ask / named-cue / observational / derived-needs-confirm | 5 / 12 / 5 / 0 | — |
| workspace/session 冲突 | 0 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | served(gate) | served(coverage) | correct | precision(gate served) | precision(含 should-ask 惩罚) | coverage=served/labeled(45) | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 0 | 0 | — |
| 0.5–0.6 | 1 | 1 | 100.0% |
| 0.6–0.7 | 6 | 1 | 16.7% |
| 0.7–0.8 | 6 | 0 | 0.0% |
| 0.8–0.9 | 11 | 0 | 0.0% |
| 0.9–1.0 | 4 | 0 | 0.0% |

## should-ask 层（期望 needs_confirmation）

- v5-13-should-ask: pW=0.47 pS=0.47
- v5-14-should-ask: pW=0.62 pS=1.00
- v5-15-should-ask: pW=0.42 pS=0.70
- v5-16-should-ask: pW=0.98 pS=0.98
- v5-17-should-ask: pW=0.40 pS=0.76

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.87 | 0.59 |
| v5-02-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …5c0f9ca3 | ❌ | 0.72 | 0.91 |
| v5-03-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 0.77 | 0.89 |
| v5-04-obvious | obvious | htdot-order-demand-skill / new / — | htdot-order-demand-skill / attach / …bbcdad94 | ❌ | 0.82 | 0.66 |
| v5-05-obvious | obvious | LiveShopping / new / — | LiveShopping / attach / …6e41c60d | ❌ | 0.95 | 0.95 |
| v5-06-obvious | obvious | htdot-order-demand-skill / new / — | Htdot-OrderCenter / new / — | ❌ | 0.51 | 1.00 |
| v5-07-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / new / — | ✅ | 0.92 | 0.86 |
| v5-08-obvious | obvious | Macmini - RemoteTTS / new / — | Macmini - dsh-setup / new / — | ❌ | 0.85 | 0.77 |
| v5-09-obvious | obvious | htdot-order-demand-skill / new / — | Htdot-OrderCenter / new / — | ❌ | 0.73 | 1.00 |
| v5-10-obvious | obvious | dsh-commander / new / — | dsh-commander / new / — | ✅ | 0.90 | 1.00 |
| v5-11-obvious | obvious | htdot-order-demand-skill / new / — | Htdot-OrderCenter / new / — | ❌ | 0.63 | 1.00 |
| v5-12-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / attach / …f020ec61 | ❌ | 0.96 | 0.79 |
| v5-13-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / attach / …dda36b3f | should-ask | 0.47 | 0.47 |
| v5-14-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / new / — | should-ask | 0.62 | 1.00 |
| v5-15-should-ask | should-ask | — / undefined / — | .dsh / attach / …b76022b2 | should-ask | 0.42 | 0.70 |
| v5-16-should-ask | should-ask | — / undefined / — | ai.miraclips.com - mira-prod / attach / …54f5c74e | should-ask | 0.98 | 0.98 |
| v5-17-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / new / — | should-ask | 0.40 | 0.76 |
| v5-18-old-session | old-session | Research / attach / …1eaf2154 | .dsh / attach / …f0c15e88 | ❌ | 0.79 | 0.40 |
| v5-19-old-session | old-session | dsh-task-gantt / attach / …e56f6a99 | .dsh / attach / …91219343 | ❌ | 0.58 | 0.84 |
| v5-20-old-session | old-session | Research / attach / …9543eb3d | .dsh / new / — | ❌ | 0.88 | 0.39 |
| v5-21-old-session | old-session | Research / attach / …62ebb8d5 | .dsh / attach / …91219343 | ❌ | 0.88 | 0.91 |
| v5-22-old-session | old-session | dsh-capability-settings / attach / …4bf942ae | .dsh / new / — | ❌ | 0.60 | 0.37 |
| v5-23-old-session | old-session | agent-workspace / attach / …cc00e7e2 | .dsh / attach / …91219343 | ❌ | 0.72 | 0.61 |
| v5-24-old-session | old-session | Research / attach / …4377215f | .dsh / new / — | ❌ | 0.61 | 0.66 |
| v5-25-old-session | old-session | Research / attach / …06c818ca | .dsh / new / — | ❌ | 0.67 | 0.73 |
| v5-26-old-session | old-session | Research / attach / …d063bc51 | .dsh / attach / …91219343 | ❌ | 0.93 | 0.96 |
| v5-27-old-session | old-session | Research / attach / …0bc665f9 | Research / attach / …0bc665f9 | ✅ | 0.43 | 0.51 |
| v5-28-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.71 | 0.61 |
| v5-29-new-session | new-session | Research / new / — | .dsh / new / — | ❌ | 0.63 | 0.47 |
| v5-30-new-session | new-session | dsh-capability-settings / new / — | dsh-task-gantt / attach / …2ec6ddd7 | ❌ | 0.40 | 0.77 |
| v5-31-new-session | new-session | Research / new / — | agent-workspace / new / — | ❌ | 0.35 | 0.82 |
| v5-32-new-session | new-session | Research / new / — | Research / attach / …28bc9017 | ❌ | 0.60 | 0.36 |
| v5-33-new-session | new-session | Research / new / — | .dsh / attach / …f0c15e88 | ❌ | 0.49 | 0.66 |
| v5-34-capability | capability | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.52 | 0.45 |
| v5-35-capability | capability | Research / new / — | .dsh / attach / …be5654e7 | ❌ | 0.35 | 0.54 |
| v5-36-capability | capability | Research / attach / …3b0a1647 | .dsh / attach / …91219343 | ❌ | 0.88 | 0.98 |
| v5-37-capability | capability | dsh-capability-settings / attach / …b8ddcfdd | miraclip_ai / new / — | ❌ | 0.40 | 0.92 |
| v5-38-capability | capability | Research / new / — | dsh-capability-settings / attach / …2c971dca | ❌ | 0.54 | 0.48 |
| v5-39-ambiguous | ambiguous | agent-workspace / attach / …8e7a31ea | .dsh / attach / …91219343 | ❌ | 0.82 | 0.74 |
| v5-40-ambiguous | ambiguous | agent-workspace / attach / …2e0f3e10 | .dsh / new / — | ❌ | 0.53 | 0.83 |
| v5-41-ambiguous | ambiguous | Research / new / — | Research / attach / …f8c0a57b | ❌ | 0.46 | 0.83 |
| v5-42-ambiguous | ambiguous | agent-workspace / attach / …beb7d356 | Evoke / new / — | ❌ | 0.35 | 0.85 |
| v5-43-ambiguous | ambiguous | Research / attach / …d5e0165c | .dsh / new / — | ❌ | 0.42 | 0.85 |
| v5-44-ambiguous | ambiguous | Research / new / — | Research / new / — | ✅ | 0.44 | 0.67 |
| v5-45-ambiguous | ambiguous | Research / attach / …bf8399b1 | Evoke / new / — | ❌ | 0.31 | 0.82 |
| v5-46-ambiguous | ambiguous | Research / attach / …e669e056 | .dsh / attach / …91219343 | ❌ | 0.91 | 0.78 |
| v5-47-ambiguous | ambiguous | Research / attach / …b081ad6b | agent-workspace / new / — | ❌ | 0.78 | 0.46 |
| v5-48-ambiguous | ambiguous | htdot-project / attach / …054e1645 | Research / new / — | ❌ | 0.84 | 0.69 |
| v5-49-ambiguous | ambiguous | agent-workspace / new / — | Research / new / — | ❌ | 0.54 | 1.00 |
| v5-50-ambiguous | ambiguous | Research / new / — | .dsh / new / — | ❌ | 0.53 | 0.84 |
