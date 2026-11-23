> ⚠️ **v1 方法学不成立（lead 裁定）：终态标题泄漏 / S9 自相矛盾 / obvious 自证；本文件仅作无效基线，不得作为 V5 门禁证据。权威 v2 见 `docs/eval/report-v2.md`。**

# V5 · Jev 派发评估报告（50 案例 / 阈值门禁）

> 口径：`docs/eval/jev-dispatch-eval.md`（V5 设计）、`docs/architecture/validation-protocol.md` §6（判据）。
> 案例集：`docs/eval/cases.real.jsonl`（50 条真实快照；规则见 `docs/eval/labels.md`）
> 工具：`tools/jev-eval.mjs`（零依赖，Node 18+；本轮扩展 `--mode layered`、tokens/p50/p95、校准分桶）
> 执行：backend（task-5）；数据只读 `~/.dsh`；未打印/落盘任何 key。
> **mock ≠ live**：`report-mock-*.md` 是 harness 自检（含故意注入的确定性噪声），**不是**模型能力结果；本报告的 V5 门禁数字全部来自 live（`report-layered.md` + `summary-layered.json`）。

## 0. 结论（一句话）

**V5 = FAIL。** live（layered 模式，50 案例/100 请求）：工作区 Top-1 **40.0%**、会话 Top-1(attach) **4.5%**、模式 **55.6%**、目标全对 **15.6%**；阈值扫描在 **precision≥95% 且 coverage≥40% 下无任何可用组合**；校准严重过自信（pMax≥0.9 的样本准确率仅 50%）。另：**全量模式（A）在 live 下不可用**（API 单请求 400 `max_tokens_exceeded`，估算 27.8k tokens > 24k 预算）。
→ 按 `validation-protocol.md` §6.7 映射 **NEXT-PHASE §7.3：默认“每次派发都确认”，M1 不做自动派发**。未为通过而调整标签或阈值。

## 1. 环境与命令

| 项 | 值 |
|---|---|
| 环境 | 本机 `~/.dsh`（DSH live 数据，只读）；未启动/未重启任何 DSH |
| 端点 | `https://api.typesafe.ai/v1/systemone`，`model=jev-latest` |
| key | `/tmp/dsh-commander-probe/jev.env`（umask 600）→ 进程内 source 后 `JEV_API_KEY`（未打印、未落盘） |
| 案例 | 50 条，schema 全过；分层 12/12/10/6/5/5（`node tools/eval/validate-cases.mjs` 退出码 0） |
| 运行时间 | 2026-11-17T08:48:44Z（layered live）；生成时间 2026-11-17T08:43:23Z |

```bash
# 1) 案例（本地生成；含真实数据，不提交远端）
node tools/eval/build-cases.mjs --out docs/eval/cases.real.jsonl --labels-out docs/eval/labels.cases.md
node tools/eval/validate-cases.mjs docs/eval/cases.real.jsonl        # exit 0

# 2) live B 模式（两层）
set -a; . /tmp/dsh-commander-probe/jev.env; set +a
export JEV_API_KEY="$TYPESAFE_API_KEY"
node tools/jev-eval.mjs docs/eval/cases.real.jsonl --mode layered \
  --out docs/eval/report-layered.md --summary-out docs/eval/summary-layered.json --gate
# 实测退出码：1（--gate 检测到 C2/C3/C4/C5/C6 不达标）

# 3) live A 模式（全量）→ 被 API 拒绝（见 §5）
node tools/jev-eval.mjs docs/eval/cases.real.jsonl --mode full
# 退出码：1；错误：Jev 400 {"detail":{"error_type":"max_tokens_exceeded"}}

# 4) mock 自检（≠ live）
node tools/jev-eval.mjs docs/eval/cases.real.jsonl --mode full --mock    --out docs/eval/report-mock-full.md
node tools/jev-eval.mjs docs/eval/cases.real.jsonl --mode layered --mock --out docs/eval/report-mock-layered.md
```

## 2. 指标（live · layered）

口径：should-ask 层（5 条，期望 `needs_confirmation`）不计入 Top-1 分母（分母 45）；attach 案例 22 条。

| ID | 指标 | 目标 | 实测 | 判定 |
|---|---|---|---:|---|
| V5-C1 | 案例集 | 50 条 / schema / 分层 12/12/10/6/5/5 | 50 / 全过 / 12/12/10/6/5/5 | ✅（P3 人工复核未完成，见 §7） |
| V5-C2 | 工作区 Top-1 | ≥85% | **40.0%**（18/45） | ❌ |
| V5-C3 | 会话 Top-1（attach） | ≥70% | **4.5%**（1/22） | ❌ |
| V5-C4 | 模式（new/attach） | ≥85% | **55.6%**（25/45） | ❌ |
| V5-C5 | 自动派发 precision | ≥95% | **无组合达标；含 should-ask 惩罚的最高 precision = 80.0%** | ❌ |
| V5-C6 | 自动派发 coverage | ≥40% | **最高 75.6%（但该点 precision 低）；precision=100%（served）时 coverage 仅 8.9%** | ❌ |
| V5-C7 | 时延/预算 | p95<3s；全量 tokens≤24k | layered p95 **1.44s**（p50 0.84s，max 2.32s）；layered 13.7k tokens/案例（6.8k/请求） | ✅（B）；**A 全量不可用**（§5） |
| V5-C8 | 校准 | 分桶单调不降、无严重过自信 | 见 §3：pMax≥0.9 的 14 条准确率 50%，低桶全 0 → 过自信 | ❌ |
| V5-C9 | 全量 vs 两层结论 | 有明确结论并落到默认模式 | A 被 API 拒绝且超预算 → **默认 B（layered）**；但 B 指标不达标 | ✅（结论明确） |

补充：目标全对（workspace∧mode∧session 且无冲突）**15.6%**（7/45）；workspace/session 冲突 0；66 条判定中低置信。

## 3. 阈值扫描（pWorkspace × pSession × confidenceFloor）

网格：pWorkspace/pSession ∈ {0.5,0.6,0.7,0.75,0.8,0.85,0.9,0.95}，confidenceFloor ∈ {0.3,0.4,0.5,0.6,0.7}。门控放行 = 两问 top 概率与 confidence 同时过阈。
precision 有两种口径：**served**（只数被放行且非 should-ask 的样本中目标正确率）与**含 should-ask 泄漏惩罚**（should-ask 被放行一律计错；门禁采用后者）。

| pWorkspace | pSession | confFloor | auto 案例 | served | correct | precision(served) | precision(含 should-ask 惩罚) | coverage | should-ask 泄漏 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.90 | 0.50 | 0.70 | 5 | 4 | 4 | 100% | **80.0%** | 8.9% | 1 |
| 0.90 | 0.70 | 0.30 | 5 | 4 | 4 | 100% | 80.0% | 8.9% | 1 |
| 0.70 | 0.50 | 0.30 | 19 | 18 | 6 | 33.3% | 31.6% | 40.0% | 1 |
| 0.50 | 0.50 | 0.30 | 31 | 29 | 7 | 24.1% | 22.6% | 64.4% | 2 |

- **没有任何组合同时满足 precision≥95%（含惩罚）与 coverage≥40%**（`summary-layered.json` 的 `thresholdRows` 为空）。
- 唯一“served precision=100%”的点：`pWorkspace≥0.90、pSession≥0.50、confidenceFloor≥0.70`，但只放行 5 条（coverage 8.9%），且实际放行 1 条 should-ask（precision 含惩罚 80%）。
- 把 coverage 放宽到 40% 时，served precision 只剩 33.3%。

## 4. 校准分桶（pMax = max(pWorkspace, pSession)，不含 should-ask）

| pMax 桶 | n | correct | accuracy |
|---|---:|---:|---:|
| <0.5 | 1 | 0 | 0% |
| 0.5–0.6 | 9 | 0 | 0% |
| 0.6–0.7 | 4 | 0 | 0% |
| 0.7–0.8 | 6 | 0 | 0% |
| 0.8–0.9 | 11 | 0 | 0% |
| 0.9–1.0 | 14 | 7 | 50% |

结论：**严重过自信**——86%（14/45 高桶 + 部分）落在高概率区但准确率仅 50%；中低概率区几乎全错。模型 confidence 不能当“正确概率”用（与设计 §1 的警告一致）。

## 5. 全量 vs 两层（A vs B）

| 项 | A 全量一波（`--mode full`） | B 两层（`--mode layered`） |
|---|---|---|
| live 可行性 | ❌ **不可用**：第 1 条请求即 `Jev 400 {"detail":{"error_type":"max_tokens_exceeded"}}`（证据 `docs/validation/evidence-v5-full-mode-failure.log`） | ✅ 100 请求全部成功 |
| 单案例请求数 | 1 | 2 |
| 单案例 tokens（输入） | 估算 **27,805**（`report-mock-full` 同口径估算；>24k 预算，与 API 拒绝一致） | 实测 **13,656**（6,828/请求） |
| p50 / p95 时延 | 未获得（请求被拒） | **0.84s / 1.44s** |
| 准确率 | 无 live 数据（**不得用 mock 冒充**） | 工作区 40.0% / attach 会话 4.5% / 模式 55.6% |
| 结论 | 超预算且 API 硬限制 → 淘汰 | **默认 B**；但 B 仍不达标 → 默认“每次确认” |

## 6. 分层表现（live · layered，供设计回退用）

| 层 | n | 工作区对 | 模式对 | 目标全对 | 观察 |
|---|---:|---:|---:|---:|---|
| obvious | 12 | **12/12** | 6/12 | 6/12 | 工作区选得极准；但 6 条“首条消息→new”被模型 attach 到同工作区相似会话（回放语义 vs 真实意图的差距） |
| ambiguous | 12 | 4/12 | 7/12 | 0/12 | 工作区歧义层几乎全错，符合“歧义”预期，但说明模型对多工作区线索无鉴别力 |
| old-session | 10 | **0/10** | 5/10 | 0/10 | 旧会话（7–30 天前）全部被忽略，去往其它工作区/新建 → “不按时间过滤”目标完全未达成 |
| new-session | 6 | 1/6 | 3/6 | 0/6 | 启发式标签 + 无上下文水位，模型倾向 attach；该层标签本身待人工复核 |
| capability | 5 | 1/5 | 4/5 | 1/5 | 无能力签名（降级层），结果不能作为能力路由结论 |
| should-ask | 5 | — | — | — | 不计 Top-1；5 条中 pW=0.99/0.73/0.68 的会被高阈值放行 → 是 C5 的泄漏来源 |

## 7. mock 自检（≠ live，只证明 harness 口径）

| 运行 | 工作区 Top-1 | 模式 | attach 会话 Top-1 | 目标全对 | 达标组合 | 说明 |
|---|---:|---:|---:|---:|---|---|
| `report-mock-full.md` | 97.8% | 97.8% | 100% | 95.6% | 1 个（coverage 95.6%） | 仅 1 条注入的确定性错误；C7-tokens 失败（估算 27.8k>24k，与 A 模式实际不可行一致） |
| `report-mock-layered.md` | 97.8% | 95.6% | 95.5% | 95.6% | 1 个（coverage 95.6%） | 同上，分层/两层链路与扫描口径已验证 |

mock 的作用仅限：schema/分层计数、两层请求拆分（workspace→session 候选域）、阈值扫描/校准/should-ask 惩罚、tokens/时延统计**管线正确**。**mock 数字不进入 V5 门禁**。

## 8. 失败原因分析（不改标签的前提下）

1. **候选信息不足（结构性）**：真实 `workspace.json` 没有职责 `summary`、也没有 `capabilityDigest`；harness 只能给 Jev “名称 + 路径 + 最近 5 条会话标题”。工作区 Top-1 只有 40%、obvious 层却 12/12，说明模型主要靠名称词面，缺乏职责语义判断能力。**这不是调阈值能解决的**，需要 M0/M1 补工作区摘要/能力签名后重测。
2. **新旧会话判断与真实意图错位**：模型倾向“有相似会话就 attach”，而本案例集的 new/attach 是**回放语义**（首条→new、非首条→attach），且快照是“此刻”（历史任务文本 + 当前会话列表）。obvious 层 6 条 new 被判成 attach 正是此偏差；old-session 层 0/10 则是模型完全按“新近/名称”走。→ 需人工/LLM 复核标签（38/50 待复核）后重跑，不能靠调阈值。
3. **过自信**：pMax≥0.9 的 14 条只对 50% → confidence 不可用于自动放行。
4. **全量模式不可用**：单请求 27.8k tokens 触发 API `max_tokens_exceeded`；即使 API 放宽也超 24k 预算。设计必须按两层（B）落地，且 B 的 session 请求只带一个工作区的会话（实测 6.8k tokens/请求）。
5. **should-ask 泄漏**：低信息任务上模型仍给 0.99 概率（v5-02），高阈值也会放行 → 自动派发必须默认关闭。

## 9. 最终 threshold / confidenceFloor 建议（写回位置）

- **V5 FAIL → 不启用自动派发**：M1 默认 `autoDispatch = false`（每次派发都确认），这是 §6.7 / NEXT-PHASE §7.3 的强制降级，不是可选建议。
- 若为后续 UI “预填/提示”保留候选值（**不用于放行**）：`threshold = 0.90`、`confidenceFloor = 0.70`。依据：这是本轮唯一 served precision=100% 的扫描点，但 coverage 仅 8.9% 且仍泄漏 1 条 should-ask，远不满足 C5/C6。
- 写回位置：`ConfigRecord.jev.threshold` / `ConfigRecord.jev.confidenceFloor` 的**默认常量**（`docs/architecture/implementation-plan.md` §4 蓝图默认值），由 architect/backend 在 M1 落地；本任务不改生产代码。
- 重新开门的条件：①工作区摘要/能力签名接入；②`labels.md` §6 的 38 条人工复核完成并重生成/重标；③在 B 模式下把“模式/会话”判据与真实派发意图对齐后重跑，C2–C6 全过才允许把 autoDispatch 打开。

## 10. 证据清单

| 文件 | 内容 |
|---|---|
| `docs/eval/cases.real.jsonl` | 50 条真实快照（本地生成、含真实数据；**勿外发/提交**，见 labels.md §8） |
| `docs/eval/labels.md` | 选样/标签规则、风险、人工复核清单 |
| `docs/eval/labels.cases.md` | 逐条标注清单（id/源会话/规则/置信度/需复核） |
| `docs/eval/report-layered.md` | **live B 模式**完整报告（含逐条 expected vs chosen） |
| `docs/eval/summary-layered.json` | live B 模式机读指标（含全量扫描表与逐条结果） |
| `docs/eval/report-mock-full.md` / `report-mock-layered.md` | mock 自检（≠ live） |
| `docs/validation/v5-jev-dispatch.md` | V5 门禁判定与停止条件映射 |
| `docs/validation/evidence-v5-layered-live.log` | live B 模式 stderr 日志（退出码 1） |
| `docs/validation/evidence-v5-full-mode-failure.log` | live A 模式 API 400 证据 |

**已知未完成**：`labels.md` §6 的 38 条人工复核（lead 抽样仲裁 + tester 独立审计）尚未执行；本报告结论已足以触发 §6.7 的 FAIL 降级，人工复核用于后续整改而非翻案。
