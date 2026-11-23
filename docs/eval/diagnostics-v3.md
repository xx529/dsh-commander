# V5 FAIL 诊断实验 v3（非门禁 · 只回答“FAIL 是否可救”）

> **性质：非门禁诊断**。V5 v2 已按 `docs/architecture/validation-protocol.md` §6.7 判 FAIL 并停止在验证阶段；本文只做根因诊断，**不改变 frozen 案例、不覆盖 v2 报告、不产出/修改任何门禁结论或阈值**。
> 输入（只读）：`docs/eval/frozen/cases.real.v2.jsonl`（caseSha256=`872cb12d7c557db905f441542be05479d2017d3710fb5c2c4e9d70038fc7aad6`）、`docs/eval/summary-v2-layered.json`（28-way 基线与 D4 复用）、`/tmp/dsh-commander-probe/jev.env`（进程内 source，未打印 key）。
> 脚本（可复跑）：`tools/eval/diagnostics/lib.mjs`、`tools/eval/diagnostics/run.mjs`。
> 原始响应：`tools/eval/diagnostics/artifacts/`（d1/d2/d3-raw.jsonl + run-summary.json，sha 见 §6）。
> 预算：**138 请求**（上限 150）：D1 28×2=56、D2 8×8=64、D3 18；D2 因预算从“前 10 案例”降为 8 案例（每案例 8 候选不变）。
> 生成：2026-11-17 18:22（Asia/Shanghai），model=`jev-latest`，endpoint=`https://api.typesafe.ai/v1/systemone`；实测时延 p50 **432ms** / p95 **609ms** / max 1217ms（138 次）。

## 0. 一句话结论

**FAIL 的根因不是“会话选不好”，而是工作区选择在“28 路 candidate 过载 + 候选信息稀疏”下崩掉；但缩短候选也到不了 85%（4 路仅 71.4%），逐候选打分排序不比单次 choice 好，置信度还反向误导（错答 pMax 更高）→ 当前 Jev 用法无法达到门禁量级，不存在“换个问法就能救”的现成路径。**

- 28-way choice：**14.3%**（远低于 85%）
- 8-way：57.1%；4-way：**71.4%**（仍低于 85%）
- 逐候选打分排序：**25%**（8 候选，8 案例）< 同候选集单次 choice 37.5%
- 会话层（oracle 工作区隔离）：会话 Top-1 **61.1%**（<70 但同量级）、模式 **83.3%**（<85 但同量级）→ 会话层可救性明显高于工作区层
- 置信度/abstention：错答 pMax 均值 0.79 > 正确 0.59；按 pMax 取覆盖 40% 的 precision = **0%** → 无法用 abstention 救

## D1 候选规模敏感性（28 → 8 → 4 路 workspace choice）

**假设**：若 Jev 只是“28 路太多分不清”，缩短候选应显著提升 Top-1，接近 85%。

**方法**：对 gate 案例（non-named-cue、非观测、非 should-ask，n=28）：28 路基线复用 v2 live 结果（不重复请求）；8 路 = expected + 7 个 `sha1(seed:caseId:wsId)` 确定性抽样的其它工作区；4 路 = expected + 3 个。compact criteria（与 v2 harness 一致），每案例 2 个新请求。

**命令**：
```bash
set -a; . /tmp/dsh-commander-probe/jev.env; set +a; export JEV_API_KEY="$TYPESAFE_API_KEY"
node tools/eval/diagnostics/run.mjs \
  --cases docs/eval/frozen/cases.real.v2.jsonl \
  --summary docs/eval/summary-v2-layered.json \
  --out-dir tools/eval/diagnostics/artifacts
```
**结果**（原始：`d1-raw.jsonl`）：

| 候选数 | 正确/总数 | Top-1 | 与门禁 85% |
|---|---:|---:|---|
| 28（复用 v2 live） | 4/28 | **14.3%** | -70.7pp |
| 8（实跑） | 16/28 | **57.1%** | -27.9pp |
| 4（实跑） | 20/28 | **71.4%** | -13.6pp |

分层（正确/总数）：

| 层 | 28-way | 8-way | 4-way |
|---|---:|---:|---:|
| old-session (n=10) | 1/10 | 4/10 | 5/10 |
| new-session (n=6) | 1/6 | 5/6 | 5/6 |
| ambiguous (n=12) | 2/12 | 7/12 | 10/12 |

**解释**：候选规模是**主要**放大器（28→8 提升 +42.8pp；8→4 再 +14.3pp），但 4 路仍差 13.6pp——即“只剩 4 个候选且其中必有正确项”时仍有 ~29% 选错，说明除了 candidate 过载，工作区**职责语义信息不足**也是天花板（v2 工作区摘要为 as-of 历史标题启发式，非职责描述）。
**对重开 V5 的含义**：坐实“28 路直接 choice 不可行”；但仅靠“缩候选”也救不回 85%，必须同时提升候选信息（职责摘要/能力签名/最近任务）并做召回-精排两段，且要接受 4 路仍可能 <85% 的现实。

## D2 逐候选 noul 打分排序（vs 单次 choice）

**假设**：官方 rank 路径的“逐候选打分取 max”可能比一次 choice 更稳。

**方法与口径说明**：本机没有可直接读取的 `lib/jev/rank.js` 副本（research clone 未含源码），无法复刻原生 noul question type；本实验用**noul 近似**：对每个候选单独发一次 choice，criteria = `{this: 候选工作区, none: 以上都不合适}`，取 `probabilities.this` 作为该候选分数，按分数排序取 Top-1。与 D1 的 8-way 单次 choice（完全相同的候选集）对比。每案例 8 候选 = 8 请求。

**结果**（原始：`d2-raw.jsonl`、`run-summary.json → d2`）：

| 方法 | Top-1（n=8 cases） |
|---|---:|
| 逐候选打分排序 | **2/8 = 25.0%** |
| 同候选集单次 8-way choice | **3/8 = 37.5%** |

逐案例：8 例中 7 例两者选中同一工作区；唯一分歧 v5-20 单次 choice 对、打分排序错。Top1-Top2 分差中位数 ~0.185（范围 0.03–0.30），分数区分度弱。

**解释**：逐候选打分没有优于单次 choice，且分数间隔小、不可靠；可能因每次请求的 state 里塞了“候选+7 个其它工作区”，各次请求上下文不一致、模型无法横向比较。
**对重开 V5 的含义**：不要把“noul/打分排序”当作现成救法；若要用排序，需要一次请求内多候选且标准化分数（类似官方分片 rank 契约），这属于 M1 之外的新设计，需单独立项验证。

## D3 会话能力隔离（oracle 工作区下只问会话 + new）

**假设**：若工作区选对，会话层本身是否达标？用于区分“工作区错误拖累”与“会话能力不足”。

**方法**：18 条 gate attach 案例，给 **oracle 工作区**（期望工作区），state.sessions 仅该工作区会话，question 只问 session（criteria = 该工作区全部会话 + `new`）；算会话 Top-1 与模式（attach）准确率。每案例 1 请求。

**结果**（原始：`d3-raw.jsonl`）：

| 指标 | 值 | 门禁 | 差距 |
|---|---:|---|---|
| 会话 Top-1（attach） | **11/18 = 61.1%** | ≥70% | -8.9pp |
| 模式（attach） | **15/18 = 83.3%** | ≥85% | -1.7pp |

分层：old-session 会话 6/10、模式 9/10；ambiguous 会话 5/8、模式 6/8。

**解释**：在 oracle 工作区下，会话层已到**门禁同量级**（61% vs 70%、83% vs 85%），与 28-way 场景的 5.6% 形成鲜明对比——**会话层不是主因，工作区判派错误是**。差距主要来自 old-session 层的“期望 attach 旧会话”回放语义与 ambiguous 层固有的歧义。
**对重开 V5 的含义**：会话/模式层有可救性；若工作区能达到高准确率（例如现实白名单+职责摘要后），会话层值得用更充分的候选信息（会话标题/最近任务/上下文）单独调优，可能逼近 70/85。

## D4 置信度 / abstention 可用性（离线复用 v2 live summary）

**假设**：即使 Top-1 不高，若 confidence 校准，可用高置信子集做 auto（coverage 40% + precision 95%）。

**方法**：复用 `summary-v2-layered.json` 的 gate caseResults（n=28，不新增请求），按 pMax=max(pWorkspace,pSession) 排序；计算不同 coverage 下“取 pMax 最高前 k 条”的 precision；pMax 分桶正确率；正确/错误样本的 pMax 均值。

**结果**：

| coverage（按 pMax 排序取前 k） | k | precision |
|---|---:|---:|
| 10% | 3 | 0% |
| 20% | 6 | 0% |
| **40%** | 11 | **0%** |
| 60% | 17 | 0% |
| 80% | 22 | 4.5% |

| pMax 桶 | n | accuracy |
|---|---:|---:|
| <0.6 | 1 | 100% |
| 0.6–0.7 | 6 | 16.7% |
| 0.7–0.8 | 6 | 0% |
| 0.8–0.9 | 11 | 0% |
| 0.9–1.0 | 4 | 0% |

- 错答 pMax 均值 **0.794**，正确样本 pMax 均值 **0.590** → **置信度反向**（越自信越可能错，样本小但方向明确）。
- **对重开 V5 的含义**：abstention/转人工救不了当前 Jev 用法——40% coverage 时 precision 上限为 **0%**；任何“高置信才自动派发”的策略在本数据上都会放过错答。必须先修工作区候选/输入信息，confidence 才有意义。

## 5. 三问结论（任务要求）

| 问题 | 结论 | 证据 |
|---|---|---|
| **28-way choice 能否达到 85% 量级？** | **不能**（14.3%），且 8/4 路仍仅 57.1%/71.4% | D1 |
| **逐候选 noul 排序能否优于单次 choice / 达到 85%？** | **不能**：25% < 同候选集 choice 37.5%，分数间隔小 | D2 |
| **会话层能否达到 70%/85% 量级？** | **oracle 工作区下接近**：会话 61.1%、模式 83.3%（差 8.9pp/1.7pp），是三项里最接近门槛的 | D3 |
| 天花板原因 | **数据/输入信息不足 + candidate 规模过载** 为主，模型能力为次：28 路时靠名字乱选；4 路时仍错 ~29% 说明缺职责语义；confidence 不可校准是独立缺陷 | D1–D4 |

**对 V5 重开的建议（不改门禁结论）**：① 架构层面先做候选召回+职责摘要/能力签名（不是调 prompt/阈值）；② 4 路仍 <85% 是硬信号——需先证明 shortlist 质量能把正确工作区召回率做到 >95%（本实验强制含正确项也只到 71.4% 选对，说明精排也弱）；③ 会话层可留作二期独立优化目标（oracle 下 61/83 已接近）；④ confidence 校准必须重新设计（当前反向）。在这些完成前，维持“每次确认、不自动派发”。

## 6. 证据与产物

| 文件 | sha256 |
|---|---|
| `tools/eval/diagnostics/run.mjs` | `07ad823f7bd8e01edc72a157e0fc2a7c063c3a32f245c0702a42309b4d5fa703` |
| `tools/eval/diagnostics/lib.mjs` | `e797ed188ec8ef869d9af62777cb989f86e429e87f6171546e05771b6b8eb54d` |
| `tools/eval/diagnostics/artifacts/run-summary.json` | `8d52cdd542c30cd50f77ed5a9a82d962e91538085d32231f45468b91d576ae4d`（含时延/分层补充字段） |
| `tools/eval/diagnostics/artifacts/d1-raw.jsonl` | `e948b10ad7441580276ba4fd4223f8a804767834d59d49f50c0e5938bb791232` |
| `tools/eval/diagnostics/artifacts/d2-raw.jsonl` | `53d6552fd8f3633466d259b8a09c93c3192ac9c2afdfb33365675a18b786a94d` |
| `tools/eval/diagnostics/artifacts/d3-raw.jsonl` | `563cde8d081a1988de076612acdfafd0bb2aa9f656097658f4eb15280ce77a41` |

- 原始 JSON 含真实工作区名/会话标题（本地生成、含用户真实数据，**不外发**；`tools/eval/diagnostics/artifacts/` 与既有真实数据同口径处理，建议不入库）。
- 未修改：`docs/eval/frozen/**`、`docs/eval/report-v2*.md`、`summary-v2-*.json`、`docs/architecture/**`、`tests/v5-audit/**`、任何阈值/门禁结论。
- 复跑：见 D1 命令（138 请求、~63s；需 key，不打印）。
