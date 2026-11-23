# Jev dispatch evaluation（LIVE · full）

- cases: 50（layerCounts={"obvious":5,"should-ask":2,"new-session":5,"capability":4,"ambiguous":5}）
- caseSha256: `872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`
- manifest: generatorRev=`0db97fbd8da1a3ca` seed=`v5` summaryMode=`semantic` manifestCaseSha256=`872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`（一致）
- dispatchTime: 2026-10-08T11:21:08.533Z – 2026-11-17T09:06:35.059Z（per-case as-of；逐条见 _provenance.dispatchAt）
- violations: 0（manifest.leakViolations / auditResult；冻结前 audit-cases A1–A12）
- mode: full（A 全量一波）
- run: replay（复用原 live summary 的 caseResults 重算，未重新调用 API）
- endpoint: https://api.typesafe.ai/v1/systemone
- model: jev-latest
- requests: 21（1.00/case）
- tokens: input=465044 / output=26618
- latency/case: p50=522ms p95=992ms max=1255ms

## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）

| 指标 | 门禁口径（non-named-cue） | 报告口径（含 named-cue easy 层） |
|---|---:|---:|
| n | 10 | 15 |
| 工作区 Top-1 | 40.0%（≥85%） | 53.3% |
| 会话 Top-1（attach） | 50.0%（≥70%） | 50.0% |
| 模式（new/attach） | 40.0%（≥85%） | 40.0% |
| 目标全对 | 0.0% | 6.7% |
| should-ask / named-cue / observational / derived-needs-confirm | 2 / 5 / 4 / 0 | — |
| workspace/session 冲突 | 4 | 0 |

## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）

| pWorkspace | pSession | confidenceFloor | auto(cases) | served(gate) | served(coverage) | correct | precision(gate served) | precision(含 should-ask 惩罚) | coverage=served/labeled(45) | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |

## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 1 | 0 | 0.0% |
| 0.5–0.6 | 0 | 0 | — |
| 0.6–0.7 | 4 | 0 | 0.0% |
| 0.7–0.8 | 3 | 0 | 0.0% |
| 0.8–0.9 | 1 | 0 | 0.0% |
| 0.9–1.0 | 1 | 0 | 0.0% |

## should-ask 层（期望 needs_confirmation）

- v5-13-should-ask: pW=0.66 pS=0.26
- v5-14-should-ask: pW=0.68 pS=0.96

## 逐条案例（expected vs chosen）

| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |
|---|---|---|---|---|---:|---:|
| v5-01-obvious | obvious | dsh-terminal-panel / new / — | dsh-terminal-panel / new / — | ✅ | 0.88 | 0.66 |
| v5-05-obvious | obvious | LiveShopping / new / — | LiveShopping / attach / …6e41c60d | ❌ | 0.96 | 0.96 |
| v5-07-obvious | obvious | dsh-shell-cmd / new / — | dsh-shell-cmd / attach / …60cc822e | ❌ | 0.94 | 0.73 |
| v5-08-obvious | obvious | Macmini - RemoteTTS / new / — | Macmini - dsh-setup / new / — | ❌ | 0.89 | 0.53 |
| v5-12-obvious | obvious | dsh-capability-settings / new / — | dsh-capability-settings / attach / …f020ec61 | ❌ | 0.97 | 0.91 |
| v5-13-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / attach / …3c570d74 | should-ask | 0.66 | 0.26 |
| v5-14-should-ask | should-ask | — / undefined / — | dsh-shell-cmd / new / — | should-ask | 0.68 | 0.96 |
| v5-28-new-session | new-session | Research / new / — | dsh-capability-settings / new / — | ❌ | 0.73 | 0.54 |
| v5-29-new-session | new-session | Research / new / — | Research / attach / …d063bc51 | ❌ | 0.35 | 0.60 |
| v5-31-new-session | new-session | Research / new / — | Research / attach / …c0f74ccb | ❌ | 0.49 | 0.69 |
| v5-32-new-session | new-session | Research / new / — | Research / attach / …77ae266f | ❌ | 0.71 | 0.21 |
| v5-33-new-session | new-session | Research / new / — | Research / attach / …77ae266f | ❌ | 0.59 | 0.65 |
| v5-35-capability | capability | Research / new / — | Research / new / — | ✅ | 0.48 | 0.50 |
| v5-36-capability | capability | Research / attach / …3b0a1647 | .dsh / attach / …91219343 | ❌ | 0.90 | 0.97 |
| v5-37-capability | capability | dsh-capability-settings / attach / …b8ddcfdd | dsh-capability-settings / new / — | ❌ | 0.42 | 0.39 |
| v5-38-capability | capability | Research / new / — | dsh-capability-settings / attach / …e86f913d | ❌ | 0.62 | 0.33 |
| v5-39-ambiguous | ambiguous | agent-workspace / attach / …8e7a31ea | .dsh / attach / …8e7a31ea | ❌ | 0.74 | 0.74 |
| v5-42-ambiguous | ambiguous | agent-workspace / attach / …beb7d356 | Evoke / new / — | ❌ | 0.38 | 0.67 |
| v5-45-ambiguous | ambiguous | Research / attach / …bf8399b1 | agent-workspace / new / — | ❌ | 0.25 | 0.40 |
| v5-46-ambiguous | ambiguous | Research / attach / …e669e056 | .dsh / attach / …e669e056 | ❌ | 0.60 | 0.88 |
| v5-49-ambiguous | ambiguous | agent-workspace / new / — | Research / new / — | ❌ | 0.58 | 0.95 |
